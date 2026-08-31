import { describe, expect, it } from "vitest";
import { strToU8, unzipSync, zipSync } from "fflate";
import {
	BACKUP_FORMAT,
	BACKUP_VERSION,
	buildBackupZip,
	parseBackupZip,
	parseLegacyBackupZip,
	type BackupManifest,
} from "../../src/backup/backup-zip";
import { MarinMindDatabase } from "../../src/db/database";
import { MemoryAdapter } from "../helpers/memory-adapter";

function sampleManifest(overrides: Partial<BackupManifest> = {}): BackupManifest {
	return {
		format: BACKUP_FORMAT,
		version: BACKUP_VERSION,
		storage: "markdown",
		appVersion: "0.1.0",
		exportedAt: "2026-08-27T00:00:00.000Z",
		documentCount: 2,
		cardCount: 5,
		assetCount: 1,
		...overrides,
	};
}

function sampleContent() {
	return {
		notes: [
			{ path: "强化学习.md", bytes: strToU8("---\nmarinmind: book\n---\n内容") },
			{ path: "脑图/学习图.md", bytes: strToU8("---\nmarinmind: mindmap\n---\n- 节点") },
		],
		documents: [
			{ path: "books/rl.pdf", bytes: new Uint8Array([9, 9, 9]) },
			{ path: "扫描版.pdf", bytes: new Uint8Array([7]) },
		],
		assets: [{ path: "abc-123.png", bytes: new Uint8Array([1, 2, 3]) }],
	};
}

describe("备份 zip 组包/解包（v2 markdown）", () => {
	it("build → parse 往返：字节一致、清单完整、条目分类正确", () => {
		const content = sampleContent();
		const manifest = sampleManifest();
		const zipped = buildBackupZip(content, manifest);

		const parsed = parseBackupZip(zipped);
		expect(parsed.manifest).toEqual(manifest);
		expect(parsed.notes.map((n) => n.path)).toEqual(["强化学习.md", "脑图/学习图.md"]);
		expect(strFromU8Bytes(parsed.notes[0].bytes)).toBe(strFromU8Bytes(content.notes[0].bytes));
		expect(parsed.documents.map((d) => d.path)).toEqual(["books/rl.pdf", "扫描版.pdf"]);
		expect([...parsed.documents[0].bytes]).toEqual([9, 9, 9]);
		expect(parsed.assets.map((a) => a.path)).toEqual(["abc-123.png"]);
	});

	it("往返产物可再次组包（幂等）", () => {
		const content = sampleContent();
		const z1 = buildBackupZip(content, sampleManifest());
		const parsed = parseBackupZip(z1);
		const z2 = buildBackupZip(parsed, parsed.manifest);
		// zip 含时间戳等元数据，不作字节全等断言；以再次解包内容一致为准
		const parsed2 = parseBackupZip(z2);
		expect(parsed2.notes).toHaveLength(2);
		expect(parsed2.documents.length).toBe(2);
		expect(strFromU8Bytes(parsed2.notes[1].bytes)).toBe(strFromU8Bytes(content.notes[1].bytes));
	});

	it("缺 manifest.json 拒绝；空 notes 包合法（零卡片用户）", () => {
		const onlyNotes = zipSync({ "notes/书.md": strToU8("x") });
		expect(() => parseBackupZip(onlyNotes)).toThrow(/manifest/);

		const empty = buildBackupZip({ notes: [], documents: [], assets: [] }, sampleManifest());
		expect(parseBackupZip(empty).notes).toEqual([]);
	});

	it("v1 旧包（含 marinmind.db 条目）拒绝并给出迁移指引", () => {
		const v1 = zipSync({
			"manifest.json": strToU8(
				JSON.stringify(sampleManifest({ version: 1, storage: undefined })),
			),
			"marinmind.db": new Uint8Array([1, 2, 3]),
		});
		expect(() => parseBackupZip(v1)).toThrow(/旧版本/);

		// version 字段为 1 但没有 db 条目同样按 v1 拒绝（形态不明）
		const v1NoDb = zipSync({
			"manifest.json": strToU8(
				JSON.stringify(sampleManifest({ version: 1, storage: undefined })),
			),
		});
		expect(() => parseBackupZip(v1NoDb)).toThrow(/旧版本/);
	});

	it("zip-slip：含 .. 段 / 绝对路径 / 前缀不符的条目拒绝", () => {
		const mk = (entries: Record<string, Uint8Array>) =>
			zipSync({
				"manifest.json": strToU8(JSON.stringify(sampleManifest())),
				...entries,
			});
		expect(() => parseBackupZip(mk({ "documents/../evil.pdf": new Uint8Array() }))).toThrow();
		expect(() => parseBackupZip(mk({ "/etc/passwd": new Uint8Array() }))).toThrow();
		expect(() => parseBackupZip(mk({ "other/file.bin": new Uint8Array() }))).toThrow();
		// 空段（连续 //）同样拒绝
		expect(() => parseBackupZip(mk({ "assets//a.png": new Uint8Array() }))).toThrow();
		// notes/ 下的目录穿越变体
		expect(() => parseBackupZip(mk({ "notes/../../evil.md": new Uint8Array() }))).toThrow();
	});

	it("version 高于当前拒绝", () => {
		const higher = buildBackupZip(sampleContent(), sampleManifest({ version: BACKUP_VERSION + 1 }));
		expect(() => parseBackupZip(higher)).toThrow(/更新版本/);
	});

	it("format 不符拒绝", () => {
		const alien = buildBackupZip(sampleContent(), sampleManifest({ format: "someone-else" }));
		expect(() => parseBackupZip(alien)).toThrow(/未知的备份格式/);
	});

	it("坏 zip 字节解析失败抛错（不静默）", () => {
		expect(() => parseBackupZip(new Uint8Array([1, 2, 3, 4]))).toThrow();
	});
});

describe("v1 旧包解包（SQLite 形态，㉚ 兼容导入）", () => {
	/** 构造一个真实 v1 包：内存 SQL 库落盘字节 + manifest + documents/assets */
	async function makeV1Package() {
		const adapter = new MemoryAdapter();
		const db = await MarinMindDatabase.open({ adapter, path: "marinmind.db" });
		db.run(
			`INSERT INTO documents (id, title, file_path, created_at, updated_at) VALUES
			('d1', '旧书', 'books/old.pdf', 1, 1)`,
		);
		db.run(
			`INSERT INTO cards (id, document_id, page, rects, excerpt_type, excerpt_text,
				excerpt_ref, note, color, tags, polygon, created_at, updated_at) VALUES
			('c1', 'd1', 3, '[]', 'text', '旧卡', NULL, NULL, NULL, '[]', NULL, 2, 2)`,
		);
		await db.flush();
		db.close();
		const dbBytes = new Uint8Array(adapter.files.get("marinmind.db")!);
		const manifest = sampleManifest({ version: 1, storage: undefined });
		const zipped = zipSync({
			"manifest.json": strToU8(JSON.stringify(manifest)),
			"marinmind.db": dbBytes,
			"documents/books/old.pdf": new Uint8Array([9, 9]),
			"assets/a.png": new Uint8Array([1]),
		});
		return { zipped, dbBytes, manifest };
	}

	it("v1 包解包：库字节原样取出，documents/assets 分类正确", async () => {
		const { zipped, dbBytes, manifest } = await makeV1Package();
		const parsed = parseLegacyBackupZip(zipped);
		expect(parsed.manifest.documentCount).toBe(manifest.documentCount);
		expect([...parsed.dbBytes]).toEqual([...dbBytes]);
		expect(parsed.documents.map((d) => d.path)).toEqual(["books/old.pdf"]);
		expect(parsed.assets.map((a) => a.path)).toEqual(["a.png"]);
	});

	it("缺 marinmind.db / 缺 manifest 拒绝；v2 包交给 parseLegacyBackupZip 也拒绝", async () => {
		const onlyDb = zipSync({ "marinmind.db": new Uint8Array([1]) });
		expect(() => parseLegacyBackupZip(onlyDb)).toThrow(/manifest/);

		const noDb = zipSync({ "manifest.json": strToU8(JSON.stringify(sampleManifest({ version: 1 }))) });
		expect(() => parseLegacyBackupZip(noDb)).toThrow(/marinmind\.db/);

		// v2 包（无 db 条目）走 legacy 解析器 → 同样报缺 db 条目
		const v2 = buildBackupZip(sampleContent(), sampleManifest());
		expect(() => parseLegacyBackupZip(v2)).toThrow(/marinmind\.db/);
	});

	it("v1 包 zip-slip 拒绝（意外前缀与穿越段）", async () => {
		const { zipped } = await makeV1Package();
		const unzipped = unzipSync(zipped);
		const evil = zipSync({
			...unzipped,
			"notes/../../evil.md": new Uint8Array(),
		} as Record<string, Uint8Array>);
		expect(() => parseLegacyBackupZip(evil)).toThrow(/意外条目/);
	});
});

function strFromU8Bytes(bytes: Uint8Array): string {
	return new TextDecoder().decode(bytes);
}
