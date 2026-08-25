import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MarinMindDatabase } from "../../src/db/database";
import { CardRepository } from "../../src/db/repositories/card-repo";
import { DocumentRepository } from "../../src/db/repositories/document-repo";
import { LinkRepository } from "../../src/db/repositories/link-repo";
import { ReviewRepository } from "../../src/db/repositories/review-repo";

let db: MarinMindDatabase;
let documents: DocumentRepository;
let cards: CardRepository;
let links: LinkRepository;
let reviews: ReviewRepository;

/** 每个用例使用独立的纯内存数据库 */
beforeEach(async () => {
	db = await MarinMindDatabase.open();
	documents = new DocumentRepository(db);
	cards = new CardRepository(db);
	links = new LinkRepository(db);
	reviews = new ReviewRepository(db);
});
afterEach(() => db.close());

describe("文档仓储", () => {
	it("按路径 upsert：重复调用复用记录并更新标题", () => {
		const a = documents.upsertByPath("books/rl.pdf", "强化学习");
		const b = documents.upsertByPath("books/rl.pdf", "强化学习（第2版）");
		expect(b.id).toBe(a.id);
		expect(b.title).toBe("强化学习（第2版）");
		expect(documents.count()).toBe(1);
		expect(documents.getByPath("books/rl.pdf")?.id).toBe(a.id);
	});

	it("renamePath 同步路径，卡片归属不变", () => {
		const doc = documents.upsertByPath("books/a.pdf", "A");
		cards.create({ documentId: doc.id, page: 1, rects: [], excerptType: "text", excerptText: "x" });

		documents.renamePath("books/a.pdf", "books/改名后.pdf");

		expect(documents.getByPath("books/a.pdf")).toBeUndefined();
		const moved = documents.getByPath("books/改名后.pdf");
		expect(moved?.id).toBe(doc.id);
		expect(cards.listByDocument(doc.id)).toHaveLength(1);
	});

	it("删除文档级联删除其卡片、链接与复习状态", () => {
		const doc = documents.upsertByPath("books/rl.pdf", "RL");
		const a = cards.create({ documentId: doc.id, page: 1, rects: [], excerptType: "text", excerptText: "A" });
		const b = cards.create({ documentId: doc.id, page: 2, rects: [], excerptType: "text", excerptText: "B" });
		links.link(a.id, b.id);
		reviews.enable(a.id);

		expect(documents.delete(doc.id)).toBe(true);
		expect(cards.get(a.id)).toBeUndefined();
		expect(cards.get(b.id)).toBeUndefined();
		expect(links.neighbors(a.id)).toEqual([]);
		expect(reviews.get(a.id)).toBeUndefined();
	});
});

describe("卡片仓储", () => {
	it("创建卡片：矩形与标签以 JSON 往返，并生成默认复习状态", () => {
		const doc = documents.upsertByPath("books/rl.pdf", "RL");
		const card = cards.create({
			documentId: doc.id,
			page: 12,
			rects: [{ x: 0.1, y: 0.2, w: 0.3, h: 0.05 }],
			excerptType: "text",
			excerptText: "策略梯度",
			tags: ["数学", "RL"],
		});
		const loaded = cards.get(card.id);
		expect(loaded?.excerptText).toBe("策略梯度");
		expect(loaded?.rects).toEqual([{ x: 0.1, y: 0.2, w: 0.3, h: 0.05 }]);
		expect(loaded?.tags).toEqual(["数学", "RL"]);

		const state = reviews.get(card.id);
		expect(state?.phase).toBe("new");
		expect(state?.isFlashcard).toBe(false);
	});

	it("更新卡片只改动给定字段", () => {
		const card = cards.create({
			documentId: null,
			page: null,
			rects: [],
			excerptType: "text",
			excerptText: "原文",
		});
		const updated = cards.update(card.id, { note: "重点", tags: ["必考"] });
		expect(updated?.note).toBe("重点");
		expect(updated?.tags).toEqual(["必考"]);
		expect(updated?.excerptText).toBe("原文"); // 未指定的字段保持不变
		expect(updated?.updatedAt).toBeGreaterThanOrEqual(card.updatedAt);
	});

	it("listByDocument 按页码排序，recent 按更新时间倒序", () => {
		const doc = documents.upsertByPath("books/rl.pdf", "RL");
		const p3 = cards.create({ documentId: doc.id, page: 3, rects: [], excerptType: "text", excerptText: "p3" });
		cards.create({ documentId: doc.id, page: 1, rects: [], excerptType: "text", excerptText: "p1" });

		expect(cards.listByDocument(doc.id).map((c) => c.page)).toEqual([1, 3]);

		cards.update(p3.id, { note: "x" }); // p3 成为最近更新
		expect(cards.recent(2)[0].id).toBe(p3.id);
		expect(cards.count(doc.id)).toBe(2);
	});
});

describe("链接仓储", () => {
	it("双向链接：两方向均可查到邻居；重复、反向重复与自链被拒绝", () => {
		const a = cards.create({ documentId: null, page: null, rects: [], excerptType: "text", excerptText: "A" });
		const b = cards.create({ documentId: null, page: null, rects: [], excerptType: "text", excerptText: "B" });

		expect(links.link(a.id, b.id)).toBeDefined();
		expect(links.neighbors(a.id)).toEqual([b.id]);
		expect(links.neighbors(b.id)).toEqual([a.id]);
		expect(links.link(a.id, b.id)).toBeUndefined(); // 重复
		expect(links.link(b.id, a.id)).toBeUndefined(); // 反向视为同一条
		expect(links.link(a.id, a.id)).toBeUndefined(); // 自链

		expect(links.unlink(a.id, b.id)).toBe(true);
		expect(links.neighbors(a.id)).toEqual([]);
		expect(links.unlink(a.id, b.id)).toBe(false);
	});
});

describe("复习仓储", () => {
	it("enable 后进入待复习队列，review 按 SM-2 推进下次到期", () => {
		const card = cards.create({ documentId: null, page: null, rects: [], excerptType: "text", excerptText: "Q" });

		expect(reviews.review(card.id, "good")).toBeUndefined(); // 未启用闪卡不能复习

		reviews.enable(card.id);
		expect(reviews.dueCount(Date.now())).toBe(1);

		const state = reviews.review(card.id, "good", Date.now());
		expect(state?.repetitions).toBe(1);
		expect(reviews.dueCount(Date.now())).toBe(0); // 明天才到期
		expect(reviews.dueCount(Date.now() + 86_400_000 + 1_000)).toBe(1);
	});

	it("due 返回到期卡片本体（按到期先后排序），disable 移出队列", () => {
		const a = cards.create({ documentId: null, page: null, rects: [], excerptType: "text", excerptText: "A" });
		const b = cards.create({ documentId: null, page: null, rects: [], excerptType: "text", excerptText: "B" });
		reviews.enable(a.id, 1000);
		reviews.enable(b.id, 2000);

		expect(reviews.due(3000).map((c) => c.id)).toEqual([a.id, b.id]);

		reviews.disable(a.id);
		expect(reviews.due(3000).map((c) => c.id)).toEqual([b.id]);
	});
});
