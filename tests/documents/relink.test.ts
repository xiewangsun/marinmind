import { describe, expect, it } from "vitest";
import { MarinMindStore } from "../../src/store/marinmind-store";
import { DocumentRepository } from "../../src/db/repositories/document-repo";
import { CardRepository } from "../../src/db/repositories/card-repo";
import { MindmapRepository } from "../../src/db/repositories/mindmap-repo";
import { applyRelink, planRelink } from "../../src/documents/relink";
import { MemoryAdapter } from "../helpers/memory-adapter";

interface Rig {
	store: MarinMindStore;
	documents: DocumentRepository;
	cards: CardRepository;
}

/** 每个用例独立的内存适配器 + 存储（㉚ md 存储版） */
async function makeRig(): Promise<Rig> {
	const store = await MarinMindStore.open(new MemoryAdapter());
	return { store, documents: new DocumentRepository(store), cards: new CardRepository(store) };
}

function makeCard(rig: Rig, documentId: string) {
	return rig.cards.create({
		documentId,
		page: 1,
		rects: [],
		excerptType: "text",
		excerptText: "内容",
	});
}

describe("planRelink 决策", () => {
	it("目标无主 → apply", () => {
		const plan = planRelink({ id: "s", cardCount: 3 }, null);
		expect(plan.action).toBe("apply");
	});

	it("目标有卡片 → reject（文案含两侧卡片数）", () => {
		const plan = planRelink({ id: "s", cardCount: 2 }, { id: "t", cardCount: 5 });
		expect(plan.action).toBe("reject");
		expect(plan.message).toContain("5");
		expect(plan.message).toContain("2");
	});

	it("目标零卡片 → takeover-empty-target", () => {
		const plan = planRelink({ id: "s", cardCount: 1 }, { id: "t", cardCount: 0 });
		expect(plan.action).toBe("takeover-empty-target");
	});
});

describe("applyRelink 落库", () => {
	it("无冲突：源行改道，行 id 与卡片归属不变（零迁移零孤儿）", async () => {
		const rig = await makeRig();
		const doc = rig.documents.upsertByPath("old/a.pdf", "A");
		const card = makeCard(rig, doc.id);

		applyRelink(rig.documents, rig.cards, doc, "new/a.pdf");

		const moved = rig.documents.getByPath("new/a.pdf");
		expect(moved?.id).toBe(doc.id);
		expect(rig.cards.get(card.id)?.documentId).toBe(doc.id);
		expect(rig.documents.getByPath("old/a.pdf")).toBeUndefined();
		rig.store.close();
	});

	it("改道到库外绝对路径（㉞）：路径形态无差异，卡片原地跟随", async () => {
		const rig = await makeRig();
		const doc = rig.documents.upsertByPath("books/a.pdf", "A");
		const card = makeCard(rig, doc.id);
		const abs = "D:\\Books 库外\\a.pdf";

		applyRelink(rig.documents, rig.cards, doc, abs);

		const moved = rig.documents.getByPath(abs);
		expect(moved?.id).toBe(doc.id);
		expect(rig.cards.get(card.id)?.documentId).toBe(doc.id);
		expect(rig.documents.getByPath("books/a.pdf")).toBeUndefined();
		rig.store.close();
	});

	it("空目标接管：先删空行再改道（内存同步操作天然原子）", async () => {
		const rig = await makeRig();
		const source = rig.documents.upsertByPath("old/b.pdf", "B");
		makeCard(rig, source.id);
		const empty = rig.documents.upsertByPath("taken/b.pdf", "占位空行"); // 打开即 upsert 产生的空记录

		applyRelink(rig.documents, rig.cards, source, "taken/b.pdf");

		expect(rig.documents.get(empty.id)).toBeUndefined(); // 空行已删
		const moved = rig.documents.getByPath("taken/b.pdf");
		expect(moved?.id).toBe(source.id); // 源行接管
		expect(rig.cards.count(source.id)).toBe(1);
		rig.store.close();
	});

	it("有卡片目标 → 防御性抛错（此前裸 renamePath 会撞 UNIQUE 约束）", async () => {
		const rig = await makeRig();
		const source = rig.documents.upsertByPath("old/c.pdf", "C");
		makeCard(rig, source.id);
		const target = rig.documents.upsertByPath("taken/c.pdf", "T");
		makeCard(rig, target.id);

		// 实现前提锁定：不经删行直接改道必然撞应用层占用检查（对齐旧库 file_path UNIQUE）
		expect(() => rig.documents.renamePath("old/c.pdf", "taken/c.pdf")).toThrow();
		// applyRelink 的防御分支
		expect(() => applyRelink(rig.documents, rig.cards, source, "taken/c.pdf")).toThrow("占用");
		// 抛错在改动前：源行未被改道
		expect(rig.documents.getByPath("old/c.pdf")?.id).toBe(source.id);
		rig.store.close();
	});

	it("删除文档行级联清理卡片、脑图节点引用", async () => {
		const rig = await makeRig();
		const doc = rig.documents.upsertByPath("books/d.pdf", "D");
		const card = makeCard(rig, doc.id);
		const mindmaps = new MindmapRepository(rig.store);
		const map = mindmaps.create("测试图");
		mindmaps.addNode(map.id, card.id, null, 0, 0);

		rig.documents.delete(doc.id);

		expect(rig.cards.get(card.id)).toBeUndefined();
		expect(mindmaps.listNodes(map.id)).toHaveLength(0);
		rig.store.close();
	});
});
