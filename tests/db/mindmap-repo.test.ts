import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MarinMindDatabase } from "../../src/db/database";
import { CardRepository } from "../../src/db/repositories/card-repo";
import { DocumentRepository } from "../../src/db/repositories/document-repo";
import { MindmapRepository } from "../../src/db/repositories/mindmap-repo";

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
});
