import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MarinMindStore } from "../../src/store/marinmind-store";
import { CardRepository } from "../../src/db/repositories/card-repo";
import { DocumentRepository } from "../../src/db/repositories/document-repo";
import { MindmapRepository } from "../../src/db/repositories/mindmap-repo";
import { LinkRepository } from "../../src/db/repositories/link-repo";
import { ReviewRepository } from "../../src/db/repositories/review-repo";
import { CardEventBus } from "../../src/events/card-bus";
import type { Card } from "../../src/types";
import { MemoryAdapter } from "../helpers/memory-adapter";

let store: MarinMindStore;
let documents: DocumentRepository;
let cards: CardRepository;
let links: LinkRepository;
let reviews: ReviewRepository;

/** 每个用例使用独立的内存适配器 + 存储（㉚ md 存储版） */
beforeEach(async () => {
	store = await MarinMindStore.open(new MemoryAdapter());
	documents = new DocumentRepository(store);
	cards = new CardRepository(store);
	links = new LinkRepository(store);
	reviews = new ReviewRepository(store);
});
afterEach(() => store.close());

describe("文档仓储", () => {
	it("按路径 upsert：重复调用复用记录并更新标题", () => {
		const a = documents.upsertByPath("books/rl.pdf", "强化学习");
		const b = documents.upsertByPath("books/rl.pdf", "强化学习（第2版）");
		expect(b.id).toBe(a.id);
		expect(b.title).toBe("强化学习（第2版）");
		expect(documents.count()).toBe(1);
		expect(documents.getByPath("books/rl.pdf")?.id).toBe(a.id);
	});

	it("分类字段（㉟）：update 归入/清空/不传不动，flush 落盘重开恢复", async () => {
		const adapter = new MemoryAdapter();
		const s1 = await MarinMindStore.open(adapter);
		const docs1 = new DocumentRepository(s1);
		const d = docs1.upsertByPath("books/rl.pdf", "RL");
		expect(d.category).toBeNull(); // 新建默认未分类
		docs1.update(d.id, { category: "学习" });
		expect(docs1.get(d.id)!.category).toBe("学习");
		await s1.flush();
		s1.close();

		const s2 = await MarinMindStore.open(adapter);
		const docs2 = new DocumentRepository(s2);
		expect(docs2.get(d.id)!.category).toBe("学习"); // 落盘恢复
		docs2.update(d.id, {}); // 不传 category：不动
		expect(docs2.get(d.id)!.category).toBe("学习");
		docs2.update(d.id, { category: null }); // 显式清空 → 未分类
		expect(docs2.get(d.id)!.category).toBeNull();
		await s2.flush();
		s2.close();

		const s3 = await MarinMindStore.open(adapter);
		expect(new DocumentRepository(s3).get(d.id)!.category).toBeNull();
		s3.close();
	});

	it("摘录目标覆盖 collectMapId（㊴）：update 三态语义 + flush 落盘重开恢复", async () => {
		const adapter = new MemoryAdapter();
		const s1 = await MarinMindStore.open(adapter);
		const docs1 = new DocumentRepository(s1);
		const mindmaps1 = new MindmapRepository(s1);
		const d = docs1.upsertByPath("books/rl.pdf", "RL");
		expect(d.collectMapId).toBeNull(); // 新建默认同名图路径
		const topic = mindmaps1.create("主题图");

		docs1.update(d.id, { collectMapId: topic.id });
		expect(docs1.get(d.id)!.collectMapId).toBe(topic.id);
		await s1.flush();
		s1.close();

		const s2 = await MarinMindStore.open(adapter);
		const docs2 = new DocumentRepository(s2);
		expect(docs2.get(d.id)!.collectMapId).toBe(topic.id); // frontmatter 落盘恢复
		docs2.update(d.id, {}); // 不传：不动
		expect(docs2.get(d.id)!.collectMapId).toBe(topic.id);
		docs2.update(d.id, { collectMapId: null }); // 显式清空 → 回默认
		expect(docs2.get(d.id)!.collectMapId).toBeNull();
		await s2.flush();
		s2.close();

		// 零写入契约：清空后的书文件不含该行（存量库字节不变）
		const raw = new TextDecoder().decode(adapter.files.get("RL.md")!);
		expect(raw).not.toContain("collect_map_id");
	});

	it("按书自动转闪卡开关 autoFlashcard（㊷）：update 布尔语义 + flush 落盘重开恢复 + 零写入契约", async () => {
		const adapter = new MemoryAdapter();
		const s1 = await MarinMindStore.open(adapter);
		const docs1 = new DocumentRepository(s1);
		const d = docs1.upsertByPath("books/rl.pdf", "RL");
		expect(d.autoFlashcard).toBe(false); // 新建默认关闭

		docs1.update(d.id, { autoFlashcard: true });
		expect(docs1.get(d.id)!.autoFlashcard).toBe(true);
		await s1.flush();
		s1.close();

		const s2 = await MarinMindStore.open(adapter);
		const docs2 = new DocumentRepository(s2);
		expect(docs2.get(d.id)!.autoFlashcard).toBe(true); // frontmatter 落盘恢复
		docs2.update(d.id, {}); // 不传：不动
		expect(docs2.get(d.id)!.autoFlashcard).toBe(true);
		docs2.update(d.id, { autoFlashcard: false }); // 显式关闭
		expect(docs2.get(d.id)!.autoFlashcard).toBe(false);
		await s2.flush();
		s2.close();

		// 零写入契约：关闭（false）的书文件不含该行（存量库字节不变）
		const raw = new TextDecoder().decode(adapter.files.get("RL.md")!);
		expect(raw).not.toContain("auto_flashcard");
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

	it("renamePath 目标被其他文档占用时抛错（对齐旧库 UNIQUE 约束）", () => {
		documents.upsertByPath("books/a.pdf", "A");
		documents.upsertByPath("books/b.pdf", "B");
		expect(() => documents.renamePath("books/a.pdf", "books/b.pdf")).toThrow();
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
	it("创建卡片：矩形与标签往返，并生成默认复习状态", () => {
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

	it("创建卡片时 documentId 指向不存在的文档抛错（对齐旧库外键）", () => {
		expect(() =>
			cards.create({ documentId: "不存在", page: 1, rects: [], excerptType: "text" }),
		).toThrow();
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

	it("title 三态（㊺）：undefined 不动 / 值更新 / null 清空；创建缺省为 null", () => {
		const card = cards.create({
			documentId: null,
			page: null,
			rects: [],
			excerptType: "text",
			excerptText: "原文",
		});
		expect(card.title).toBeNull(); // 创建缺省
		cards.update(card.id, { note: "x" });
		expect(cards.get(card.id)!.title).toBeNull(); // 未指定不动
		cards.update(card.id, { title: "我的标题" });
		expect(cards.get(card.id)!.title).toBe("我的标题");
		cards.update(card.id, { title: null });
		expect(cards.get(card.id)!.title).toBeNull(); // null 显式清空
	});

	it("listByDocument 按页码排序，recent 按更新时间倒序", async () => {
		const doc = documents.upsertByPath("books/rl.pdf", "RL");
		const p3 = cards.create({ documentId: doc.id, page: 3, rects: [], excerptType: "text", excerptText: "p3" });
		const p1 = cards.create({ documentId: doc.id, page: 1, rects: [], excerptType: "text", excerptText: "p1" });
		const orphan = cards.create({ documentId: null, page: null, rects: [], excerptType: "text", excerptText: "手工" });

		expect(cards.listByDocument(doc.id).map((c) => c.page)).toEqual([1, 3]);

		await new Promise((r) => setTimeout(r, 2)); // 保证 updated_at 严格大于创建时刻（毫秒粒度）
		cards.update(p3.id, { note: "x" }); // p3 成为最近更新
		expect(cards.recent(3)[0].id).toBe(p3.id);
		expect(cards.recent(3).map((c) => c.id)).toContain(orphan.id); // 全库含未归类卡片
		expect(cards.count(doc.id)).toBe(2);
		expect(cards.count()).toBe(3);
	});

	it("listAll 全库含孤儿卡，按更新时间降序（㊲ 主页卡片页数据源）", async () => {
		const doc = documents.upsertByPath("books/a.pdf", "书A");
		const c1 = cards.create({ documentId: doc.id, page: 1, rects: [], excerptType: "text", excerptText: "1" });
		const c2 = cards.create({ documentId: doc.id, page: 2, rects: [], excerptType: "area", excerptText: "2" });
		const orphan = cards.create({ documentId: null, page: null, rects: [], excerptType: "blank", excerptText: "手工" });

		await new Promise((r) => setTimeout(r, 2));
		cards.update(c1.id, { note: "改动" }); // c1 成为最近更新

		const all = cards.listAll();
		expect(all).toHaveLength(3);
		expect(all.map((c) => c.id)).toContain(orphan.id);
		expect(all[0].id).toBe(c1.id); // 更新过的排最前；同刻创建按 id 稳定序
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

	it("删卡级联删除其链接（双侧）", () => {
		const a = cards.create({ documentId: null, page: null, rects: [], excerptType: "text", excerptText: "A" });
		const b = cards.create({ documentId: null, page: null, rects: [], excerptType: "text", excerptText: "B" });
		links.link(a.id, b.id);

		cards.delete(a.id);
		expect(links.neighbors(b.id)).toEqual([]);
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

	it("due 按书过滤（㊷）：只返回指定文档的到期卡；limit 在过滤之后生效；缺省不过滤", () => {
		const docA = documents.upsertByPath("books/a.pdf", "书A");
		const docB = documents.upsertByPath("books/b.pdf", "书B");
		const a1 = cards.create({ documentId: docA.id, page: 1, rects: [], excerptType: "text", excerptText: "a1" });
		const a2 = cards.create({ documentId: docA.id, page: 2, rects: [], excerptType: "text", excerptText: "a2" });
		const b1 = cards.create({ documentId: docB.id, page: 1, rects: [], excerptType: "text", excerptText: "b1" });
		const orphan = cards.create({ documentId: null, page: null, rects: [], excerptType: "text", excerptText: "手工" });
		// 到期顺序：a1(1000) < b1(2000) < a2(3000) < orphan(4000)
		reviews.enable(a1.id, 1000);
		reviews.enable(b1.id, 2000);
		reviews.enable(a2.id, 3000);
		reviews.enable(orphan.id, 4000);

		// 指定书：跨文档混合到期中只留该书（先过滤后计数）
		expect(reviews.due(5000, undefined, docA.id).map((c) => c.id)).toEqual([a1.id, a2.id]);
		expect(reviews.due(5000, undefined, docB.id).map((c) => c.id)).toEqual([b1.id]);
		// limit 在过滤之后生效：A 书第 1 张到期即止（b1 不占名额）
		expect(reviews.due(5000, 1, docA.id).map((c) => c.id)).toEqual([a1.id]);
		// 缺省 = 全部书籍（含孤儿卡）——既有语义零回归
		expect(reviews.due(5000).map((c) => c.id)).toEqual([a1.id, b1.id, a2.id, orphan.id]);
	});

	it("enable 覆盖到期时间（幂等重设），disable 后再 enable 恢复队列", () => {
		const a = cards.create({ documentId: null, page: null, rects: [], excerptType: "text", excerptText: "A" });
		reviews.enable(a.id, 1000);
		reviews.enable(a.id, 5000); // 重新启用改期
		expect(reviews.due(4999)).toEqual([]);
		expect(reviews.due(5000).map((c) => c.id)).toEqual([a.id]);

		expect(reviews.disable(a.id)).toBe(true);
		expect(reviews.disable("不存在")).toBe(false);
	});
});

describe("卡片仓储 × CardEventBus（⑨-B 事件同步）", () => {
	it("create/update 成功触发 changed，delete 命中触发 removed", () => {
		const bus = new CardEventBus();
		const wired = new CardRepository(store, bus);
		const changed: string[] = [];
		const created: string[] = [];
		let removed: { id: string; last: Card } | null = null;
		bus.onCardChanged((c) => changed.push(c.id));
		bus.onCardCreated((c) => created.push(c.id));
		bus.onCardRemoved((id, last) => (removed = { id, last }));

		const card = wired.create({
			documentId: null,
			page: 1,
			rects: [],
			excerptType: "area",
		});
		expect(changed).toEqual([card.id]);
		// create 双发 created + changed（⑲ 自动收录只认 created）
		expect(created).toEqual([card.id]);
		const updated = wired.update(card.id, { note: "批注" });
		expect(changed).toEqual([card.id, card.id]);
		expect(changed[1]).toBe(updated!.id);
		expect(created).toEqual([card.id]); // update 只发 changed 不发 created

		expect(wired.delete(card.id)).toBe(true);
		expect(removed!.id).toBe(card.id);
		// last 是删除前快照：删除后已查不到，但事件里仍可读 note
		expect(removed!.last.note).toBe("批注");
	});

	it("update 未命中 / delete 未命中不触发事件", () => {
		const bus = new CardEventBus();
		const wired = new CardRepository(store, bus);
		let n = 0;
		bus.onCardChanged(() => ++n);
		bus.onCardRemoved(() => ++n);

		expect(wired.update("不存在", { note: "x" })).toBeUndefined();
		expect(wired.delete("不存在")).toBe(false);
		expect(n).toBe(0);
	});

	it("未注入 bus 的仓储行为不变（兼容旧用法）", () => {
		expect(() =>
			cards.create({ documentId: null, page: 1, rects: [], excerptType: "area" }),
		).not.toThrow();
	});
});
