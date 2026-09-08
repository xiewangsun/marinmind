import { describe, expect, it } from "vitest";
import { MarinMindStore, ORPHAN_SCOPE } from "../../src/store/marinmind-store";
import { DocumentRepository } from "../../src/db/repositories/document-repo";
import { CardRepository } from "../../src/db/repositories/card-repo";
import { MemoryAdapter, textOf, dirtyScopeCount } from "../helpers/memory-adapter";

describe("卡片移动到其他文档（127 批量移动）", () => {
	it("换桶正确性：源删/目标增/documentId 更新 + 双 scope 标脏", async () => {
		const adapter = new MemoryAdapter();
		const store = await MarinMindStore.open(adapter);
		const docs = new DocumentRepository(store);
		const cards = new CardRepository(store);
		const a = docs.upsertByPath("a.pdf", "书A");
		const b = docs.upsertByPath("b.pdf", "书B");
		const card = cards.create({
			documentId: a.id,
			page: 3,
			rects: [{ x: 0.1, y: 0.2, w: 0.5, h: 0.05 }],
			excerptType: "text",
			excerptText: "摘录内容",
		});
		await store.flush();
		expect(dirtyScopeCount(store)).toBe(0);

		const moved = cards.move(card.id, b.id);
		expect(moved?.documentId).toBe(b.id);
		expect(cards.listByDocument(a.id).some((c) => c.id === card.id)).toBe(false);
		expect(cards.listByDocument(b.id).some((c) => c.id === card.id)).toBe(true);
		// 双 scope 标脏（旧书文件 + 新书文件）
		expect(dirtyScopeCount(store)).toBe(2);
		store.close();
	});

	it("清锚点收口：page/rects/polygon 清空，photo occlusions 保留、text 清空", async () => {
		const adapter = new MemoryAdapter();
		const store = await MarinMindStore.open(adapter);
		const docs = new DocumentRepository(store);
		const cards = new CardRepository(store);
		const a = docs.upsertByPath("a.pdf", "书A");
		const b = docs.upsertByPath("b.pdf", "书B");

		const text = cards.create({
			documentId: a.id,
			page: 3,
			rects: [{ x: 0.1, y: 0.2, w: 0.5, h: 0.05 }],
			excerptType: "text",
			excerptText: "文字",
			occlusions: [{ x: 0.1, y: 0.2, w: 0.3, h: 0.05 }],
		});
		const movedText = cards.move(text.id, b.id)!;
		expect(movedText.page).toBeNull();
		expect(movedText.rects).toEqual([]);
		expect(movedText.polygon).toBeNull();
		expect(movedText.occlusions).toEqual([]); // 页面坐标系遮挡随锚点清除

		const photo = cards.create({
			documentId: a.id,
			page: 1,
			rects: [],
			excerptType: "photo",
			excerptRef: "assets/p1.png",
			occlusions: [{ x: 0.2, y: 0.3, w: 0.4, h: 0.2 }],
		});
		const movedPhoto = cards.move(photo.id, b.id)!;
		expect(movedPhoto.occlusions).toEqual([{ x: 0.2, y: 0.3, w: 0.4, h: 0.2 }]); // 图内坐标保留
		// 内容/附件字段保留
		expect(movedPhoto.excerptRef).toBe("assets/p1.png");
		store.close();
	});

	it("复习态与内容随新文档文件落盘（flush 后旧文件不含、新文件含）", async () => {
		const adapter = new MemoryAdapter();
		const store1 = await MarinMindStore.open(adapter);
		const docs = new DocumentRepository(store1);
		const cards = new CardRepository(store1);
		const a = docs.upsertByPath("a.pdf", "书A");
		const b = docs.upsertByPath("b.pdf", "书B");
		const card = cards.create({
			documentId: a.id,
			page: 2,
			rects: [],
			excerptType: "text",
			excerptText: "跨书迁移的摘录",
		});
		await store1.flush();
		cards.move(card.id, b.id);
		await store1.flush();
		store1.close();

		expect(textOf(adapter, "books/书A.md")).not.toContain("跨书迁移的摘录");
		expect(textOf(adapter, "books/书B.md")).toContain("跨书迁移的摘录");

		// 重开恢复：卡在新书名下、复习态跟随
		const store2 = await MarinMindStore.open(adapter);
		const restored = new CardRepository(store2).get(card.id);
		expect(restored?.documentId).toBe(b.id);
		expect(restored?.page).toBeNull();
		expect(store2.reviews.has(card.id)).toBe(true);
		expect(store2.scopeOfCard(card.id)).toBe(b.id);
		store2.close();
	});

	it("链接归属跟随：持有方为被移卡时，链接随卡落新文件", async () => {
		const adapter = new MemoryAdapter();
		const store = await MarinMindStore.open(adapter);
		const docs = new DocumentRepository(store);
		const cards = new CardRepository(store);
		const a = docs.upsertByPath("a.pdf", "书A");
		const b = docs.upsertByPath("b.pdf", "书B");
		const c1 = cards.create({
			documentId: a.id,
			page: null,
			rects: [],
			excerptType: "text",
			excerptText: "持有方",
		});
		const c2 = cards.create({
			documentId: b.id,
			page: null,
			rects: [],
			excerptType: "text",
			excerptText: "对侧",
		});
		store.addLink(c1.id, c2.id, Date.now());
		await store.flush();
		// c1（持有方）移到书B：链接应从书A文件消失、出现在书B文件
		cards.move(c1.id, b.id);
		await store.flush();
		expect(textOf(adapter, "books/书A.md")).not.toContain(c2.id);
		expect(textOf(adapter, "books/书B.md")).toContain(c2.id);
		expect(store.links.size).toBe(1); // 链接本体不删，只换持有文件
		store.close();
	});

	it("移到未归类（orphan 桶）与移回文档对称", async () => {
		const adapter = new MemoryAdapter();
		const store = await MarinMindStore.open(adapter);
		const docs = new DocumentRepository(store);
		const cards = new CardRepository(store);
		const a = docs.upsertByPath("a.pdf", "书A");
		const card = cards.create({
			documentId: a.id,
			page: 1,
			rects: [],
			excerptType: "text",
			excerptText: "自由化",
		});
		cards.move(card.id, null);
		expect(store.scopeOfCard(card.id)).toBe(ORPHAN_SCOPE);
		expect(cards.listByDocument(a.id).length).toBe(0);
		const back = cards.move(card.id, a.id)!;
		expect(back.documentId).toBe(a.id);
		expect(cards.listByDocument(a.id).length).toBe(1);
		store.close();
	});

	it("目标文档不存在抛中文 Error；同文档 no-op 不改不脏", async () => {
		const adapter = new MemoryAdapter();
		const store = await MarinMindStore.open(adapter);
		const docs = new DocumentRepository(store);
		const cards = new CardRepository(store);
		const a = docs.upsertByPath("a.pdf", "书A");
		const card = cards.create({
			documentId: a.id,
			page: null,
			rects: [],
			excerptType: "text",
			excerptText: "锚",
		});
		await store.flush();
		expect(() => cards.move(card.id, "no-such-doc")).toThrow("目标文档不存在");
		const before = dirtyScopeCount(store);
		const same = cards.move(card.id, a.id);
		expect(same?.id).toBe(card.id);
		expect(same?.excerptText).toBe("锚");
		expect(dirtyScopeCount(store)).toBe(before); // no-op 零写入
		expect(() => cards.move("no-such-card", a.id)).not.toThrow(); // 无卡 undefined
		store.close();
	});
});
