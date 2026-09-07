import { describe, expect, it } from "vitest";
import { MarinMindDatabase } from "../../src/db/database";
import { MarinMindStore } from "../../src/store/marinmind-store";
import { convertLegacyDb, legacyDbBytesToNotes, openLegacyDb } from "../../src/store/legacy-import";
import { CardRepository } from "../../src/db/repositories/card-repo";
import { DocumentRepository } from "../../src/db/repositories/document-repo";
import { LinkRepository } from "../../src/db/repositories/link-repo";
import { MindmapRepository } from "../../src/db/repositories/mindmap-repo";
import { ReviewRepository } from "../../src/db/repositories/review-repo";
import { BookmarkRepository } from "../../src/db/repositories/bookmark-repo";
import { MemoryAdapter, textOf } from "../helpers/memory-adapter";

/**
 * 旧库 → md 迁移链路（㉚；接替被移除的 SQL 老库升级类测试）：
 * 直插 SQL 行构造 schema v8 旧库（与旧版插件落盘形态一致）→ openLegacyDb 读取 →
 * 转换 → importLegacy 灌入 → flush 落盘 → 重开走 md 解析断言全字段往返。
 */

/** 构造一个有数据的旧 SQL 库，落盘后返回其适配器 */
async function makeLegacyAdapter(): Promise<MemoryAdapter> {
	const adapter = new MemoryAdapter();
	const db = await MarinMindDatabase.open({ adapter, path: "marinmind.db" });
	seedLegacyRows(db);
	await db.flush();
	db.close();
	return adapter;
}

/** 直插 SQL 行构造旧库数据（字段与旧版插件生产形态一致） */
function seedLegacyRows(db: MarinMindDatabase): void {
	db.run(
		`INSERT INTO documents (id, title, file_path, created_at, updated_at) VALUES
		('doc1', '强化学习', 'books/rl.pdf', 1700000000000, 1700000000001),
		('doc2', '图论', 'books/graph.pdf', 1700000000002, 1700000000003)`,
	);
	db.run(
		`INSERT INTO cards (id, document_id, page, rects, excerpt_type, excerpt_text,
			excerpt_ref, note, color, tags, polygon, created_at, updated_at) VALUES
		('c1', 'doc1', 5, '[{"x":0.1,"y":0.2,"w":0.5,"h":0.05}]', 'text', '贝尔曼方程', NULL, '重点', 'yellow',
			'["数学","RL"]', NULL, 1700000000100, 1700000000100),
		('c2', 'doc1', 7, '[{"x":0,"y":0,"w":0.4,"h":0.3}]', 'lasso', NULL, '.marinmind/assets/abc.png', NULL, 'orange',
			'[]', '[{"x":0.05,"y":0.05},{"x":0.4,"y":0.1},{"x":0.35,"y":0.3}]', 1700000000200, 1700000000200),
		('c3', 'doc2', 1, '[]', 'blank', '留白内容', NULL, NULL, NULL, '[]', NULL, 1700000000300, 1700000000300)`,
	);
	db.run(
		`INSERT INTO review_states (card_id, is_flashcard, phase, ease, interval_days,
			repetitions, due_at, last_reviewed_at, lapses) VALUES
		('c1', 1, 'review', 2.6, 6, 2, 1700100000000, 1700000005000, 0),
		('c2', 0, 'new', 2.5, 0, 0, 1700000000200, NULL, 0)`,
	);
	db.run(
		`INSERT INTO card_links (id, source_id, target_id, created_at) VALUES
		('l1', 'c1', 'c3', 1700000000400)`,
	);
	db.run(
		`INSERT INTO mindmaps (id, name, default_branch_style, document_id, fixed_root_node_id,
			created_at, updated_at) VALUES
		('m1', '学习图', 'bidir', 'doc1', NULL, 1700000000500, 1700000000500)`,
	);
	db.run(
		`INSERT INTO mindmap_nodes (id, map_id, card_id, parent_id, x, y, collapsed, branch_style, created_at) VALUES
		('n1', 'm1', 'c1', NULL, 10, 20, 1, 'frame', 1700000000600),
		('n2', 'm1', 'c2', 'n1', 300, 40, 0, NULL, 1700000000700)`,
	);
	db.run(
		`INSERT INTO document_bookmarks (id, document_id, page, label, created_at) VALUES
		('bm1', 'doc1', 12, '第三章', 1700000000800)`,
	);
}

describe("旧库迁移（legacy-import，㉚）", () => {
	it("构造 → 转换 → 灌入 → 落盘 → 重开：全字段往返完整", async () => {
		const legacyAdapter = await makeLegacyAdapter();
		expect(legacyAdapter.files.has("marinmind.db")).toBe(true); // findLegacyDb 检测依据

		const legacy = await openLegacyDb(legacyAdapter);
		const converted = convertLegacyDb(legacy);
		legacy.close();
		expect(converted.warnings).toEqual([]);
		expect(converted.documents).toHaveLength(2);
		expect(converted.cards).toHaveLength(3);

		const target = new MemoryAdapter();
		const store = await MarinMindStore.open(target);
		const result = store.importLegacy(converted);
		expect(result.warnings).toEqual([]);
		await store.flush();
		store.close();

		// md 文件按书名落盘（123 布局 v2：books/ 与 mindmaps/），旧库文件未被改动
		expect(target.files.has("books/强化学习.md")).toBe(true);
		expect(target.files.has("mindmaps/学习图.md")).toBe(true);
		expect(legacyAdapter.files.has("marinmind.db")).toBe(true);

		// 重开（走 md 解析）后经仓储断言
		const store2 = await MarinMindStore.open(target);
		const documents = new DocumentRepository(store2);
		const cards = new CardRepository(store2);
		const links = new LinkRepository(store2);
		const reviews = new ReviewRepository(store2);
		const mindmaps = new MindmapRepository(store2);
		const bookmarks = new BookmarkRepository(store2);

		expect(documents.count()).toBe(2);
		expect(documents.getByPath("books/rl.pdf")?.id).toBe("doc1");

		const c1 = cards.get("c1")!;
		expect(c1.excerptText).toBe("贝尔曼方程");
		expect(c1.note).toBe("重点");
		expect(c1.color).toBe("yellow");
		expect(c1.tags).toEqual(["数学", "RL"]);
		expect(c1.rects).toEqual([{ x: 0.1, y: 0.2, w: 0.5, h: 0.05 }]);
		expect(reviews.get("c1")).toMatchObject({
			isFlashcard: true,
			phase: "review",
			ease: 2.6,
			intervalDays: 6,
			repetitions: 2,
		});

		const c2 = cards.get("c2")!;
		expect(c2.excerptRef).toBe("assets/abc.png"); // 旧前缀 .marinmind/ 已剥离
		expect(c2.polygon).toEqual([
			{ x: 0.05, y: 0.05 },
			{ x: 0.4, y: 0.1 },
			{ x: 0.35, y: 0.3 },
		]);

		expect(links.neighbors("c1")).toEqual(["c3"]);

		const nodes = mindmaps.listNodes("m1");
		expect(nodes).toHaveLength(2);
		const n1 = nodes.find((n) => n.id === "n1")!;
		expect(n1.collapsed).toBe(true);
		expect(n1.branchStyle).toBe("frame");
		expect(nodes.find((n) => n.id === "n2")?.parentId).toBe("n1");
		expect(mindmaps.get("m1")?.defaultBranchStyle).toBe("bidir");
		expect(mindmaps.get("m1")?.documentId).toBe("doc1");

		const bms = bookmarks.listByDocument("doc1");
		expect(bms).toHaveLength(1);
		expect(bms[0]).toMatchObject({ page: 12, label: "第三章" });
		store2.close();
	});

	it("重复灌入幂等：二次 importLegacy 不产生重复数据", async () => {
		const legacyAdapter = await makeLegacyAdapter();
		const legacy = await openLegacyDb(legacyAdapter);
		const converted = convertLegacyDb(legacy);
		legacy.close();

		const store = await MarinMindStore.open(new MemoryAdapter());
		store.importLegacy(converted);
		const again = store.importLegacy(converted); // 迁移失败重试场景
		expect(again.warnings).toEqual([]);
		const stats = store.stats();
		expect(stats.documents).toBe(2);
		expect(stats.cards).toBe(3);
		expect(stats.mindmaps).toBe(1);
		store.close();
	});

	it("file_path 冲突：现有库同路径文档跳过（对齐 UNIQUE），其卡片兜底孤儿并告警", async () => {
		const legacyAdapter = await makeLegacyAdapter();
		const legacy = await openLegacyDb(legacyAdapter);
		const converted = convertLegacyDb(legacy);
		legacy.close();

		const target = new MemoryAdapter();
		const store = await MarinMindStore.open(target);
		const documents = new DocumentRepository(store);
		const cards = new CardRepository(store);
		// 现有库已有一本占住 books/rl.pdf 的文档
		const occupied = documents.upsertByPath("books/rl.pdf", "新书的同名路径");

		const result = store.importLegacy(converted);
		expect(result.warnings.some((w) => w.includes("强化学习"))).toBe(true);
		expect(documents.getByPath("books/rl.pdf")?.id).toBe(occupied.id); // 现有文档不被覆盖
		// doc1 被跳过，其卡片（c1/c2）兜底进 books/未归类卡片.md
		expect(cards.get("c1")?.documentId).toBeNull();
		expect(cards.get("c2")?.documentId).toBeNull();
		// doc2 正常导入
		expect(cards.get("c3")?.documentId).toBe("doc2");
		expect(result.warnings.some((w) => w.includes("未归类"))).toBe(true);
		await store.flush();
		expect(textOf(target, "books/未归类卡片.md")).toContain("贝尔曼方程");
		store.close();
	});

	it("转换容错：损坏的 JSON 列降级空值并记 warning，不拖垮整卡", async () => {
		const adapter = new MemoryAdapter();
		const db = await MarinMindDatabase.open({ adapter, path: "marinmind.db" });
		db.run(
			`INSERT INTO documents (id, title, file_path, created_at, updated_at) VALUES
			('d1', '坏数据书', 'books/bad.pdf', 1, 1)`,
		);
		db.run(
			`INSERT INTO cards (id, document_id, page, rects, excerpt_type, excerpt_text,
				excerpt_ref, note, color, tags, polygon, created_at, updated_at) VALUES
			('c9', 'd1', 1, '不是JSON', 'text', '内容', NULL, NULL, NULL, '也是坏的', NULL, 2, 2)`,
		);
		await db.flush();
		db.close();

		const legacy = await openLegacyDb(adapter);
		const converted = convertLegacyDb(legacy);
		legacy.close();
		expect(converted.warnings.length).toBeGreaterThanOrEqual(2); // rects + tags 各一条
		expect(converted.cards[0].rects).toEqual([]);
		expect(converted.cards[0].tags).toEqual([]);
	});

	it("legacyDbBytesToNotes（v1 备份包兼容导入）：库字节 → md 文件集，可被 store 重开认领", async () => {
		const legacyAdapter = await makeLegacyAdapter();
		const dbBytes = new Uint8Array(legacyAdapter.files.get("marinmind.db")!);

		const { notes, warnings } = await legacyDbBytesToNotes(dbBytes);
		expect(warnings).toEqual([]);
		const paths = notes.map((n) => n.path).sort();
		expect(paths).toContain("books/强化学习.md");
		expect(paths).toContain("books/图论.md");
		expect(paths).toContain("mindmaps/学习图.md");

		// md 文件集写入目标根后能被 store 正常认领（备份导入链路的后半段）
		const target = new MemoryAdapter();
		for (const note of notes) {
			writeTextBytes(target, note.path, note.bytes);
		}
		const store2 = await MarinMindStore.open(target);
		expect(store2.stats()).toMatchObject({ documents: 2, cards: 3, mindmaps: 1, nodes: 2 });
		store2.close();
	});
});

/** 以字节形态写入适配器（legacyDbBytesToNotes 的产物落地） */
function writeTextBytes(adapter: MemoryAdapter, path: string, bytes: Uint8Array): void {
	adapter.files.set(path, bytes.slice().buffer as ArrayBuffer);
}
