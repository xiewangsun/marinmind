import { afterEach, beforeEach, describe, expect, it } from "vitest";
import initSqlJs from "sql.js";
import { MarinMindDatabase, type StorageAdapter } from "../../src/db/database";
import { CardRepository } from "../../src/db/repositories/card-repo";
import { DocumentRepository } from "../../src/db/repositories/document-repo";
import { MindmapRepository } from "../../src/db/repositories/mindmap-repo";
import { MIGRATIONS, SCHEMA_VERSION } from "../../src/db/schema";

let db: MarinMindDatabase;
let documents: DocumentRepository;
let cards: CardRepository;
let mindmaps: MindmapRepository;

/** 每个用例使用独立的纯内存数据库 */
beforeEach(async () => {
	db = await MarinMindDatabase.open();
	documents = new DocumentRepository(db);
	cards = new CardRepository(db);
	mindmaps = new MindmapRepository(db);
});
afterEach(() => db.close());

function makeCard(text: string, documentId: string | null = null) {
	return cards.create({
		documentId,
		page: 1,
		rects: [],
		excerptType: "text",
		excerptText: text,
	});
}

/** 内存版 StorageAdapter（升级/持久化用例；与 persistence.test.ts 同构，不跨文件导出） */
class MemoryAdapter implements StorageAdapter {
	files = new Map<string, ArrayBuffer>();
	exists(path: string): Promise<boolean> {
		return Promise.resolve(this.files.has(path));
	}
	mkdir(): Promise<void> {
		return Promise.resolve();
	}
	readBinary(path: string): Promise<ArrayBuffer> {
		const data = this.files.get(path);
		if (!data) {
			return Promise.reject(new Error(`文件不存在: ${path}`));
		}
		return Promise.resolve(data);
	}
	writeBinary(path: string, data: ArrayBuffer): Promise<void> {
		this.files.set(path, data);
		return Promise.resolve();
	}
}

const DB_PATH = ".marinmind/marinmind.db";

describe("脑图仓储", () => {
	it("create/get/rename/list：list 按最近使用在前", () => {
		const a = mindmaps.create("图一");
		const b = mindmaps.create("图二");
		expect(mindmaps.get(a.id)?.name).toBe("图一");
		expect(mindmaps.list().map((m) => m.id)).toEqual([b.id, a.id]);

		mindmaps.rename(a.id, "改名");
		expect(mindmaps.get(a.id)?.name).toBe("改名");
		expect(mindmaps.rename("不存在", "x")).toBeUndefined();
	});

	it("addNode + listNodes：节点字段与卡片本体往返完整", () => {
		const doc = documents.upsertByPath("books/a.pdf", "书A");
		const card = makeCard("要点", doc.id);
		const map = mindmaps.create("图");

		const added = mindmaps.addNode(map.id, card.id, null, 10, 20);
		expect(added?.parentId).toBeNull();
		expect(added?.card.excerptText).toBe("要点");
		expect(added?.card.tags).toEqual([]);

		const nodes = mindmaps.listNodes(map.id);
		expect(nodes).toHaveLength(1);
		expect(nodes[0].id).toBe(added?.id);
		expect(nodes[0].card.id).toBe(card.id);
	});

	it("同图重复加卡返回 undefined；不同图可加同一卡", () => {
		const card = makeCard("同一张卡");
		const mapA = mindmaps.create("A");
		const mapB = mindmaps.create("B");

		expect(mindmaps.addNode(mapA.id, card.id, null, 0, 0)).toBeDefined();
		expect(mindmaps.addNode(mapA.id, card.id, null, 5, 5)).toBeUndefined();
		expect(mindmaps.hasCard(mapA.id, card.id)).toBe(true);
		// 不同图互不影响
		expect(mindmaps.addNode(mapB.id, card.id, null, 0, 0)).toBeDefined();
		expect(mindmaps.countNodes(mapB.id)).toBe(1);
	});

	it("moveNode 更新坐标（小数取整）", () => {
		const card = makeCard("卡");
		const map = mindmaps.create("图");
		const node = mindmaps.addNode(map.id, card.id, null, 0, 0)!;

		mindmaps.moveNode(node.id, 10.6, -3.2);
		const moved = mindmaps.getNode(node.id)!;
		expect(moved.x).toBe(11);
		expect(moved.y).toBe(-3);
	});

	it("setParent：同图成功；跨图/自身返回 undefined", () => {
		const c1 = makeCard("1");
		const c2 = makeCard("2");
		const mapA = mindmaps.create("A");
		const mapB = mindmaps.create("B");
		const n1 = mindmaps.addNode(mapA.id, c1.id, null, 0, 0)!;
		const n2 = mindmaps.addNode(mapA.id, c2.id, null, 0, 0)!;
		const nOther = mindmaps.addNode(mapB.id, makeCard("3").id, null, 0, 0)!;

		expect(mindmaps.setParent(n2.id, n1.id)?.parentId).toBe(n1.id);
		expect(mindmaps.setParent(n1.id, n1.id)).toBeUndefined(); // 自身
		expect(mindmaps.setParent(n1.id, nOther.id)).toBeUndefined(); // 跨图
		// 置空 = 变回根
		expect(mindmaps.setParent(n2.id, null)?.parentId).toBeNull();
	});

	it("removeNode 后子节点上浮为根（SET NULL）", () => {
		const c1 = makeCard("1");
		const c2 = makeCard("2");
		const map = mindmaps.create("图");
		const n1 = mindmaps.addNode(map.id, c1.id, null, 0, 0)!;
		const n2 = mindmaps.addNode(map.id, c2.id, n1.id, 100, 0)!;

		expect(mindmaps.removeNode(n1.id)).toBe(true);
		expect(mindmaps.getNode(n1.id)).toBeUndefined();
		expect(mindmaps.getNode(n2.id)?.parentId).toBeNull();
	});

	it("级联：删图→节点消失；删卡→节点消失；删文档→卡与节点消失", () => {
		const doc = documents.upsertByPath("books/a.pdf", "书");
		const c1 = makeCard("1", doc.id);
		const c2 = makeCard("2", doc.id);
		const map = mindmaps.create("图");
		const n1 = mindmaps.addNode(map.id, c1.id, null, 0, 0)!;
		mindmaps.addNode(map.id, c2.id, n1.id, 100, 0);

		// 删卡：其节点级联消失
		cards.delete(c2.id);
		expect(mindmaps.countNodes(map.id)).toBe(1);

		// 删文档：卡片连同节点两跳级联消失
		documents.delete(doc.id);
		expect(mindmaps.countNodes(map.id)).toBe(0);

		// 再补一个节点验证删图级联
		const c3 = makeCard("3");
		mindmaps.addNode(map.id, c3.id, null, 0, 0);
		expect(mindmaps.countNodes(map.id)).toBe(1);
		mindmaps.delete(map.id);
		expect(mindmaps.countNodes()).toBe(0);
	});

	it("addNode 前移图的 updated_at（list 最近使用排序变化）", async () => {
		const a = mindmaps.create("A");
		await new Promise((r) => setTimeout(r, 5)); // 保证时间戳不同
		const b = mindmaps.create("B");
		expect(mindmaps.list().map((m) => m.id)).toEqual([b.id, a.id]);

		const card = makeCard("卡");
		mindmaps.addNode(a.id, card.id, null, 0, 0);
		expect(mindmaps.list().map((m) => m.id)).toEqual([a.id, b.id]);
	});

	// ---------- ⑨-C 折叠态 / 自动布局 ----------

	it("setCollapsed + applyLayout：写回取整，重开后折叠态与坐标保留", async () => {
		const adapter = new MemoryAdapter();
		const db1 = await MarinMindDatabase.open({ adapter, path: DB_PATH });
		const cards1 = new CardRepository(db1);
		const maps1 = new MindmapRepository(db1);
		const map = maps1.create("图");
		const c1 = cards1.create({
			documentId: null,
			page: null,
			rects: [],
			excerptType: "text",
			excerptText: "1",
		});
		const c2 = cards1.create({
			documentId: null,
			page: null,
			rects: [],
			excerptType: "text",
			excerptText: "2",
		});
		const n1 = maps1.addNode(map.id, c1.id, null, 0, 0)!;
		const n2 = maps1.addNode(map.id, c2.id, n1.id, 0, 0)!;

		maps1.setCollapsed(n1.id, true);
		maps1.applyLayout(
			map.id,
			new Map([
				[n1.id, { x: 10.4, y: 20.6 }],
				[n2.id, { x: 300.9, y: -5.2 }],
			]),
		);
		// 悬空 id 静默跳过（map_id 守卫），不影响其余写入
		maps1.applyLayout(map.id, new Map([["ghost", { x: 1, y: 1 }]]));
		await db1.flush();
		db1.close();

		const db2 = await MarinMindDatabase.open({ adapter, path: DB_PATH });
		const maps2 = new MindmapRepository(db2);
		const r1 = maps2.getNode(n1.id)!;
		expect(r1.collapsed).toBe(true);
		expect(r1.x).toBe(10); // 坐标取整入库
		expect(maps2.getNode(n2.id)?.y).toBe(-5);
		// listNodes 的 JOIN 行同样带出折叠态
		const listed = maps2.listNodes(map.id);
		expect(listed.find((n) => n.id === n2.id)?.collapsed).toBe(false);
		db2.close();
	});

	it("v2 老库升级：自动补 v2→v3，user_version=3 且既有节点 collapsed=false", async () => {
		// 手工构造 v2 库（只应用前两条迁移）——模拟 0.1.x 老用户的真实数据
		const SQL = await initSqlJs();
		const old = new SQL.Database();
		old.exec(MIGRATIONS[0]); // v0 → v1
		old.exec(MIGRATIONS[1]); // v1 → v2
		old.exec("PRAGMA user_version = 2"); // 标记版本，否则 open 时会重复跑 v0→v1
		old.run(
			"INSERT INTO cards (id, document_id, page, rects, excerpt_type, created_at, updated_at) VALUES ('c1', NULL, 1, '[]', 'text', 1, 1)",
		);
		old.run(
			"INSERT INTO mindmaps (id, name, created_at, updated_at) VALUES ('m1', '旧图', 1, 1)",
		);
		old.run(
			"INSERT INTO mindmap_nodes (id, map_id, card_id, parent_id, x, y, created_at) VALUES ('n1', 'm1', 'c1', NULL, 5, 6, 1)",
		);
		const data = old.export();
		old.close();

		const adapter = new MemoryAdapter();
		adapter.files.set(
			DB_PATH,
			data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) as ArrayBuffer,
		);
		const db2 = await MarinMindDatabase.open({ adapter, path: DB_PATH });
		expect(db2.version).toBe(SCHEMA_VERSION); // = 3
		const nodes = new MindmapRepository(db2).listNodes("m1");
		expect(nodes).toHaveLength(1);
		expect(nodes[0].collapsed).toBe(false); // ALTER DEFAULT 0
		expect(nodes[0].x).toBe(5); // 既有数据原样保留
		db2.close();
	});
});
