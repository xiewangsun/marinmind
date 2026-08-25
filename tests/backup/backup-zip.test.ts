import { describe, expect, it } from "vitest";
import { strToU8, zipSync } from "fflate";
import { SCHEMA_VERSION } from "../../src/db/schema";
import {
	BACKUP_FORMAT,
	BACKUP_VERSION,
	buildBackupZip,
	parseBackupZip,
	type BackupManifest,
} from "../../src/backup/backup-zip";

function sampleManifest(overrides: Partial<BackupManifest> = {}): BackupManifest {
	return {
		format: BACKUP_FORMAT,
		version: BACKUP_VERSION,
		schemaVersion: SCHEMA_VERSION,
		appVersion: "0.1.0",
		exportedAt: "2026-08-25T00:00:00.000Z",
		documentCount: 1,
		cardCount: 2,
		assetCount: 1,
		...overrides,
	};
}

function sampleContent() {
	return {
		dbBytes: new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]),
		documents: [
			{ path: "books/rl.pdf", bytes: new Uint8Array([9, 9, 9]) },
			{ path: "扫描版.pdf", bytes: new Uint8Array([7]) },
		],
		assets: [{ path: "abc-123.png", bytes: new Uint8Array([1, 2, 3]) }],
	};
}

describe("备份 zip 组包/解包", () => {
	it("build → parse 往返：字节一致、清单完整、条目分类正确", () => {
		const content = sampleContent();
		const manifest = sampleManifest();
		const zipped = buildBackupZip(content, manifest);

		const parsed = parseBackupZip(zipped, SCHEMA_VERSION);
		expect(parsed.manifest).toEqual(manifest);
		expect([...parsed.dbBytes]).toEqual([...content.dbBytes]);
		expect(parsed.documents.map((d) => d.path)).toEqual(["books/rl.pdf", "扫描版.pdf"]);
		expect([...parsed.documents[0].bytes]).toEqual([9, 9, 9]);
		expect(parsed.assets.map((a) => a.path)).toEqual(["abc-123.png"]);
	});

	it("往返产物可再次组包（幂等）", () => {
		const content = sampleContent();
		const z1 = buildBackupZip(content, sampleManifest());
		const parsed = parseBackupZip(z1, SCHEMA_VERSION);
		const z2 = buildBackupZip(parsed, parsed.manifest);
		// zip 含时间戳等元数据，不作字节全等断言；以再次解包内容一致为准
		const parsed2 = parseBackupZip(z2, SCHEMA_VERSION);
		expect([...parsed2.dbBytes]).toEqual([...content.dbBytes]);
		expect(parsed2.documents.length).toBe(2);
	});

	it("缺 manifest.json 或 marinmind.db 拒绝", () => {
		const onlyDb = zipSync({ "marinmind.db": new Uint8Array([1]) });
		expect(() => parseBackupZip(onlyDb, SCHEMA_VERSION)).toThrow(/manifest/);
		const onlyManifest = zipSync({
			"manifest.json": strToU8(JSON.stringify(sampleManifest())),
		});
		expect(() => parseBackupZip(onlyManifest, SCHEMA_VERSION)).toThrow(/marinmind\.db/);
	});

	it("zip-slip：含 .. 段 / 绝对路径 / 前缀不符的条目拒绝", () => {
		const mk = (entries: Record<string, Uint8Array>) =>
			zipSync({
				"manifest.json": strToU8(JSON.stringify(sampleManifest())),
				"marinmind.db": new Uint8Array([1]),
				...entries,
			});
		expect(() => parseBackupZip(mk({ "documents/../evil.pdf": new Uint8Array() }), SCHEMA_VERSION)).toThrow();
		expect(() => parseBackupZip(mk({ "/etc/passwd": new Uint8Array() }), SCHEMA_VERSION)).toThrow();
		expect(() => parseBackupZip(mk({ "other/file.bin": new Uint8Array() }), SCHEMA_VERSION)).toThrow();
		// 空段（连续 //）同样拒绝
		expect(() => parseBackupZip(mk({ "assets//a.png": new Uint8Array() }), SCHEMA_VERSION)).toThrow();
	});

	it("schemaVersion 高于当前拒绝，等于/低于放行", () => {
		const content = sampleContent();
		const higher = buildBackupZip(content, sampleManifest({ schemaVersion: SCHEMA_VERSION + 1 }));
		expect(() => parseBackupZip(higher, SCHEMA_VERSION)).toThrow(/更新版本/);

		const lower = buildBackupZip(content, sampleManifest({ schemaVersion: 1 }));
		expect(() => parseBackupZip(lower, SCHEMA_VERSION)).not.toThrow();
	});

	it("format 不符拒绝", () => {
		const content = sampleContent();
		const alien = buildBackupZip(content, sampleManifest({ format: "someone-else" }));
		expect(() => parseBackupZip(alien, SCHEMA_VERSION)).toThrow(/未知的备份格式/);
	});

	it("坏 zip 字节解析失败抛错（不静默）", () => {
		expect(() => parseBackupZip(new Uint8Array([1, 2, 3, 4]), SCHEMA_VERSION)).toThrow();
	});
});
