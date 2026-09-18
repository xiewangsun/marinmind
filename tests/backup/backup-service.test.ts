/**
 * backup-service 编排层单测（139-E）：导出（数据根 md + 库内文档 + 附件 → zip，
 * 库外/失联文档分流）与导入落地（快照旧树 → 停写 → 清空 → 写入 → 恢复 → 重载）。
 * obsidian 以 vi.mock 替身（Notice 类含 hide 桩 + Platform/TFile/TFolder 桩）；
 * ConfirmModal 替身为「open 即确认」自动执行（导入管线直达 doImport）；
 * 数据根与备份目录用 MemoryAdapter；导出侧 store/documents/cards 用真实件。
 */
import { describe, expect, it, vi } from "vitest";

/** Notice 调用记录（类桩：duration 0 进度条需要 hide 方法）；vi.hoisted 供提升后的 mock 工厂引用 */
const { notices } = vi.hoisted(() => ({ notices: [] as string[] }));

vi.mock("obsidian", () => ({
	Notice: class {
		static calls = notices;
		constructor(message: string) {
			notices.push(message);
		}
		hide(): void {}
	},
	Platform: { isDesktopApp: true },
	TFile: class {},
	TFolder: class {},
}));

vi.mock("../../src/mindmap/confirm-modal", () => {
	const instances: unknown[] = [];
	return {
		ConfirmModal: class {
			static instances = instances;
			private cb: () => void;
			constructor(_app: unknown, _title: string, _msg: string, cb: () => void) {
				this.cb = cb;
				instances.push(this);
			}
			open(): void {
				this.cb();
			}
		},
	};
});

import { TFile } from "obsidian";
import { strToU8 } from "fflate";
import { MarinMindStore } from "../../src/store/marinmind-store";
import { DocumentRepository } from "../../src/db/repositories/document-repo";
import { CardRepository } from "../../src/db/repositories/card-repo";
import { exportBackup, importBackupFromBytes } from "../../src/backup/backup-service";
import {
	BACKUP_FORMAT,
	BACKUP_VERSION,
	buildBackupZip,
	parseBackupZip,
	type BackupManifest,
} from "../../src/backup/backup-zip";
import { ConfirmModal } from "../../src/mindmap/confirm-modal";
import { MemoryAdapter, writeText } from "../helpers/memory-adapter";
import { SNAPSHOT_DIR } from "../../src/constants";
import type MarinMindPlugin from "../../src/main";

/** 假 vault：existing 内路径视为已存在文件（TFile 实例）；createBinary/createFolder 记录调用 */
function fakeVault(existing: readonly string[] = []) {
	const set = new Set(existing);
	const binaries = new Map<string, Uint8Array>();
	const created: string[] = [];
	const folders: string[] = [];
	return {
		getAbstractFileByPath: (p: string) => (set.has(p) ? new TFile() : null),
		adapter: {
			readBinary: (p: string) => {
				const b = binaries.get(p);
				if (!b) return Promise.reject(new Error(`文件不存在: ${p}`));
				return Promise.resolve(b.slice().buffer as ArrayBuffer);
			},
		},
		createBinary: (p: string, data: ArrayBuffer) => {
			created.push(p);
			binaries.set(p, new Uint8Array(data));
			set.add(p);
			return Promise.resolve();
		},
		createFolder: (p: string) => {
			folders.push(p);
			return Promise.resolve();
		},
		put: (p: string, bytes: Uint8Array) => binaries.set(p, bytes),
		created,
		folders,
	};
}

/** 导出侧 rig：真实 store/repos（1 书 2 卡）+ 手写脑图 md/附件/快照残留 + 3 形态文档 */
async function makeExportRig() {
	const dataAdapter = new MemoryAdapter();
	const store = await MarinMindStore.open(dataAdapter);
	const documents = new DocumentRepository(store);
	const cards = new CardRepository(store);
	const doc = documents.upsertByPath("books/a.pdf", "书A");
	cards.create({
		documentId: doc.id,
		page: 1,
		rects: [],
		excerptType: "text",
		excerptText: "t1",
	});
	cards.create({
		documentId: doc.id,
		page: 2,
		rects: [],
		excerptType: "text",
		excerptText: "t2",
	});
	documents.upsertByPath("books/gone.pdf", "失联书"); // vault 中不存在 → missing
	documents.upsertByPath("D:/outside/库外书.pdf", "库外书"); // 绝对路径 → externalSkipped
	writeText(dataAdapter, "mindmaps/图M.md", "---\nmarinmind: mindmap\n---\n- x");
	dataAdapter.files.set("assets/img-1.png", new Uint8Array([1, 2]).buffer);
	writeText(dataAdapter, `${SNAPSHOT_DIR}/残留快照.md`, "旧"); // 快照目录不入包
	const vault = fakeVault(["books/a.pdf"]);
	vault.put("books/a.pdf", new Uint8Array([9, 9]));
	const backupAdapter = new MemoryAdapter();
	const plugin = {
		whenReady: () => Promise.resolve(),
		store,
		documents,
		dataLoc: { adapter: dataAdapter, rootDir: "MarinMind" },
		backupLoc: { adapter: backupAdapter, rootDir: "Backups" },
		app: { vault },
		manifest: { version: "1.0.0" },
	} as unknown as MarinMindPlugin;
	return { plugin, dataAdapter, backupAdapter, vault };
}

function sampleManifest(overrides: Partial<BackupManifest> = {}): BackupManifest {
	return {
		format: BACKUP_FORMAT,
		version: BACKUP_VERSION,
		storage: "markdown",
		appVersion: "1.0.0",
		exportedAt: "2026-09-17T00:00:00.000Z",
		documentCount: 2,
		cardCount: 5,
		assetCount: 1,
		...overrides,
	};
}

describe("exportBackup 导出编排", () => {
	it("数据根 md + 库内文档 + 附件 → 备份目录 zip；库外/失联/快照分流", async () => {
		const rig = await makeExportRig();
		await exportBackup(rig.plugin);

		const names = [...rig.backupAdapter.files.keys()];
		expect(names).toHaveLength(1);
		expect(names[0]).toMatch(/^marinmind-\d{8}-\d{6}\.marginpkg$/);

		const parsed = parseBackupZip(new Uint8Array(rig.backupAdapter.files.get(names[0])!));
		// 清单计数真实来自 store/documents（1 书存在 + 失联 + 库外 = 3 文档；2 卡；1 附件）
		expect(parsed.manifest.documentCount).toBe(3);
		expect(parsed.manifest.cardCount).toBe(2);
		expect(parsed.manifest.assetCount).toBe(1);
		// 文档只打包 vault 中存在的 books/a.pdf；失联/库外不入包
		expect(parsed.documents.map((d) => d.path)).toEqual(["books/a.pdf"]);
		expect([...parsed.documents[0].bytes]).toEqual([9, 9]);
		// 数据根 md：store 写的书 md + 手写脑图 md；快照目录豁免
		expect(parsed.notes.some((n) => n.path.startsWith("books/"))).toBe(true);
		expect(parsed.notes.map((n) => n.path)).toContain("mindmaps/图M.md");
		expect(parsed.notes.some((n) => n.path.startsWith(`${SNAPSHOT_DIR}/`))).toBe(false);
		// 附件相对 assets/ 存放
		expect(parsed.assets.map((a) => a.path)).toEqual(["img-1.png"]);
		// Notice 提示含落点与库外提示
		expect(
			notices.some((m) => m.includes("Backups") && m.includes("库外文档 1 个未打包")),
		).toBe(true);
	});

	it("store 未就绪：Notice 提示且不产出备份", async () => {
		const backupAdapter = new MemoryAdapter();
		const plugin = {
			whenReady: () => Promise.resolve(),
			store: undefined,
			backupLoc: { adapter: backupAdapter, rootDir: "Backups" },
		} as unknown as MarinMindPlugin;
		await exportBackup(plugin);
		expect(notices).toContain("MarinMind：数据层未就绪，无法导出");
		expect(backupAdapter.files.size).toBe(0);
	});
});

/** 导入侧 rig：独立数据根（旧书旧图 + 旧快照残留）+ store 桩（order 记录停写顺序） */
function makeImportRig(existingDocs: readonly string[]) {
	const dataAdapter = new MemoryAdapter();
	writeText(dataAdapter, "books/旧书.md", "旧");
	writeText(dataAdapter, "mindmaps/旧图.md", "旧");
	writeText(dataAdapter, `${SNAPSHOT_DIR}/更旧.md`, "更旧");
	const order: string[] = [];
	const storeStub = {
		flush: vi.fn(() => order.push("flush")),
		close: vi.fn(() => order.push("close")),
	};
	const vault = fakeVault(existingDocs);
	const plugin = {
		dataLoc: { adapter: dataAdapter, rootDir: "MarinMind" },
		backupLoc: { adapter: new MemoryAdapter(), rootDir: "Backups" },
		store: storeStub,
		app: {
			vault,
			commands: { executeCommandById: vi.fn() },
		},
		manifest: { version: "1.0.0" },
	} as unknown as MarinMindPlugin;
	return { plugin, dataAdapter, storeStub, vault, order };
}

function sampleZipBytes(): ArrayBuffer {
	const zipped = buildBackupZip(
		{
			notes: [
				{ path: "books/新A.md", bytes: strToU8("---\nmarinmind: book\n---\n新A") },
				{ path: "mindmaps/新M.md", bytes: strToU8("---\nmarinmind: mindmap\n---\n- 新") },
			],
			documents: [
				{ path: "books/exist.pdf", bytes: new Uint8Array([1]) },
				{ path: "books/add.pdf", bytes: new Uint8Array([2]) },
			],
			assets: [{ path: "pic.webp", bytes: new Uint8Array([3, 3]) }],
		},
		sampleManifest(),
	);
	return zipped.slice().buffer as ArrayBuffer;
}

describe("importBackupFromBytes 导入落地", () => {
	it("快照旧树 → 清空 → 写入新树 → 恢复文档（已存在跳过）→ 附件 → 重载", async () => {
		const rig = makeImportRig(["books/exist.pdf"]);
		importBackupFromBytes(rig.plugin, sampleZipBytes());
		// doImport 异步执行（ConfirmModal 替身 open 即触发）；轮询等重载命令
		await vi.waitFor(() => {
			expect(rig.plugin.app.commands.executeCommandById).toHaveBeenCalledWith("app:reload");
		});

		// 新树写入 + 旧树清空（根层不再有旧文件）
		expect(new TextDecoder().decode(rig.dataAdapter.files.get("books/新A.md")!)).toContain(
			"新A",
		);
		expect(rig.dataAdapter.files.has("mindmaps/新M.md")).toBe(true);
		expect(rig.dataAdapter.files.has("books/旧书.md")).toBe(false);
		expect(rig.dataAdapter.files.has("mindmaps/旧图.md")).toBe(false);
		// 旧树进快照（含更早快照清理：更旧.md 被删不再以任何形式存在）
		expect(rig.dataAdapter.files.has(`${SNAPSHOT_DIR}/books/旧书.md`)).toBe(true);
		expect(rig.dataAdapter.files.has(`${SNAPSHOT_DIR}/mindmaps/旧图.md`)).toBe(true);
		expect(rig.dataAdapter.files.has(`${SNAPSHOT_DIR}/更旧.md`)).toBe(false);
		// 文档恢复：已存在的 exist.pdf 跳过，add.pdf 经 vault.createBinary 落盘
		expect(rig.vault.created).toEqual(["books/add.pdf"]);
		expect(rig.vault.folders).toContain("books"); // 父目录补建
		// 附件进数据根 assets/
		expect(rig.dataAdapter.files.has("assets/pic.webp")).toBe(true);
		// 停写顺序：flush 先于 close（反序会让旧内存覆盖新导入）；store 引用清空
		expect(rig.order).toEqual(["flush", "close"]);
		expect(rig.plugin.store).toBeUndefined();
	});

	it("损坏字节：parse 拒绝并 Notice，不进确认弹窗", () => {
		const rig = makeImportRig([]);
		const before = ConfirmModal.instances.length;
		importBackupFromBytes(rig.plugin, new Uint8Array([1, 2, 3]).slice().buffer as ArrayBuffer);
		expect(notices.some((m) => m.includes("导入失败"))).toBe(true);
		expect(ConfirmModal.instances.length).toBe(before);
	});
});
