import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MarinMindStore } from "../../src/store/marinmind-store";
import { CardRepository } from "../../src/db/repositories/card-repo";
import { DocumentRepository } from "../../src/db/repositories/document-repo";
import { MindmapRepository } from "../../src/db/repositories/mindmap-repo";
import { LinkRepository } from "../../src/db/repositories/link-repo";
import { ReviewRepository } from "../../src/db/repositories/review-repo";
import { CardEventBus } from "../../src/events/card-bus";
import { recordReview } from "../../src/store/review-log";
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
		cards.create({
			documentId: doc.id,
			page: 1,
			rects: [],
			excerptType: "text",
			excerptText: "x",
		});

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
		const a = cards.create({
			documentId: doc.id,
			page: 1,
			rects: [],
			excerptType: "text",
			excerptText: "A",
		});
		const b = cards.create({
			documentId: doc.id,
			page: 2,
			rects: [],
			excerptType: "text",
			excerptText: "B",
		});
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

	it("durationSec 三态（84-B 语音时长）：创建落值 / undefined 不动 / null 清空", () => {
		const created = cards.create({
			documentId: null,
			page: null,
			rects: [],
			excerptType: "audio",
			excerptRef: "assets/a.webm",
			durationSec: 42,
		});
		expect(created.durationSec).toBe(42);
		const untouched = cards.update(created.id, { note: "批注" });
		expect(untouched?.durationSec).toBe(42); // 未指定不动
		const cleared = cards.update(created.id, { durationSec: null });
		expect(cleared?.durationSec).toBeUndefined(); // 显式清空（Card 层无 null——缺省即未知）
		// 创建缺省：非 audio / 未传时长 → undefined（未知）
		const plain = cards.create({
			documentId: null,
			page: null,
			rects: [],
			excerptType: "text",
		});
		expect(plain.durationSec).toBeUndefined();
	});

	it("rects 整体替换（84-D photo 展示框）：传数组替换 / 空数组清空 / undefined 不动", () => {
		const card = cards.create({
			documentId: null,
			page: 3,
			rects: [],
			excerptType: "photo",
			excerptRef: "assets/p.jpg",
		});
		const frame = [{ x: 0.3, y: 0.4, w: 0.2, h: 0.1 }];
		cards.update(card.id, { note: "批注" });
		expect(cards.get(card.id)!.rects).toEqual([]); // 未指定不动
		cards.update(card.id, { rects: frame }); // 定位：整体替换为单一展示框
		expect(cards.get(card.id)!.rects).toEqual(frame);
		cards.update(card.id, { rects: [] }); // 取消定位：清空回徽标锚定
		expect(cards.get(card.id)!.rects).toEqual([]);
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

	it("deck 三态（卡组）：undefined 不动 / 值更新 / null 移出；创建缺省与传值", () => {
		const plain = cards.create({
			documentId: null,
			page: null,
			rects: [],
			excerptType: "text",
			excerptText: "未分组",
		});
		expect(plain.deck).toBeNull(); // 创建缺省
		cards.update(plain.id, { note: "x" });
		expect(cards.get(plain.id)!.deck).toBeNull(); // 未指定不动
		cards.update(plain.id, { deck: "考研单词" });
		expect(cards.get(plain.id)!.deck).toBe("考研单词");
		cards.update(plain.id, { deck: null });
		expect(cards.get(plain.id)!.deck).toBeNull(); // null 显式移出卡组

		// 创建时直接传值
		const decked = cards.create({
			documentId: null,
			page: null,
			rects: [],
			excerptType: "text",
			excerptText: "组内卡",
			deck: "雅思口语",
		});
		expect(decked.deck).toBe("雅思口语");
	});

	it("lineStyle 三态（77 线型）：undefined 不动 / 值更新 / null 改回下划线；创建缺省与传值", () => {
		const plain = cards.create({
			documentId: null,
			page: null,
			rects: [],
			excerptType: "text",
			excerptText: "默认",
		});
		expect(plain.lineStyle).toBeNull(); // 创建缺省 = 下划线
		cards.update(plain.id, { note: "x" });
		expect(cards.get(plain.id)!.lineStyle).toBeNull(); // 未指定不动
		cards.update(plain.id, { lineStyle: "squiggle" });
		expect(cards.get(plain.id)!.lineStyle).toBe("squiggle");
		cards.update(plain.id, { lineStyle: null });
		expect(cards.get(plain.id)!.lineStyle).toBeNull(); // null 显式改回下划线（高亮菜单改回下划线路径）

		// 创建时直接传值
		const wavy = cards.create({
			documentId: null,
			page: null,
			rects: [],
			excerptType: "text",
			excerptText: "波浪",
			lineStyle: "strikethrough",
		});
		expect(wavy.lineStyle).toBe("strikethrough");
	});

	it("listByDocument 按页码排序，recent 按更新时间倒序", async () => {
		const doc = documents.upsertByPath("books/rl.pdf", "RL");
		const p3 = cards.create({
			documentId: doc.id,
			page: 3,
			rects: [],
			excerptType: "text",
			excerptText: "p3",
		});
		// p1 不引用句柄——建卡本身即副作用（listByDocument 需要页 1 的卡）
		cards.create({
			documentId: doc.id,
			page: 1,
			rects: [],
			excerptType: "text",
			excerptText: "p1",
		});
		const orphan = cards.create({
			documentId: null,
			page: null,
			rects: [],
			excerptType: "text",
			excerptText: "手工",
		});

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
		const c1 = cards.create({
			documentId: doc.id,
			page: 1,
			rects: [],
			excerptType: "text",
			excerptText: "1",
		});
		// c2 不引用句柄——凑满三卡（listAll 长度断言）
		cards.create({
			documentId: doc.id,
			page: 2,
			rects: [],
			excerptType: "area",
			excerptText: "2",
		});
		const orphan = cards.create({
			documentId: null,
			page: null,
			rects: [],
			excerptType: "blank",
			excerptText: "手工",
		});

		await new Promise((r) => setTimeout(r, 2));
		cards.update(c1.id, { note: "改动" }); // c1 成为最近更新

		const all = cards.listAll();
		expect(all).toHaveLength(3);
		expect(all.map((c) => c.id)).toContain(orphan.id);
		expect(all[0].id).toBe(c1.id); // 更新过的排最前；同刻创建按 id 稳定序
	});

	it("书名分组卡（81）不纳入卡片系统：listAll/listByDocument/count/recent 一律排除，get 仍可取", () => {
		const doc = documents.upsertByPath("books/a.pdf", "书A");
		const excerpt = cards.create({
			documentId: doc.id,
			page: 1,
			rects: [],
			excerptType: "text",
			excerptText: "摘录",
		});
		const group = cards.create({
			documentId: doc.id,
			page: null,
			rects: [],
			excerptType: "text",
			excerptText: "《书A》",
			group: true,
		});
		expect(group.group).toBe(true); // 创建即标记
		const manual = cards.create({
			documentId: null,
			page: null,
			rects: [],
			excerptType: "text",
			excerptText: "手工",
		});
		expect(manual.group).toBe(false); // 普通卡显式 false

		// 四个卡片视角查询全部排除组卡
		expect(cards.listAll().map((c) => c.id)).toEqual(
			expect.arrayContaining([excerpt.id, manual.id]),
		);
		expect(cards.listAll().map((c) => c.id)).not.toContain(group.id);
		expect(cards.listByDocument(doc.id).map((c) => c.id)).toEqual([excerpt.id]);
		expect(cards.recent(10).map((c) => c.id)).not.toContain(group.id);
		expect(cards.count()).toBe(2); // 全库：摘录 + 手工（组卡不计）
		expect(cards.count(doc.id)).toBe(1); // 单书同口径

		// 脑图节点渲染走 get：组卡本体仍可取
		expect(cards.get(group.id)?.excerptText).toBe("《书A》");
	});
});

describe("链接仓储", () => {
	it("双向链接：两方向均可查到邻居；重复、反向重复与自链被拒绝", () => {
		const a = cards.create({
			documentId: null,
			page: null,
			rects: [],
			excerptType: "text",
			excerptText: "A",
		});
		const b = cards.create({
			documentId: null,
			page: null,
			rects: [],
			excerptType: "text",
			excerptText: "B",
		});

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
		const a = cards.create({
			documentId: null,
			page: null,
			rects: [],
			excerptType: "text",
			excerptText: "A",
		});
		const b = cards.create({
			documentId: null,
			page: null,
			rects: [],
			excerptType: "text",
			excerptText: "B",
		});
		links.link(a.id, b.id);

		cards.delete(a.id);
		expect(links.neighbors(b.id)).toEqual([]);
	});
});

describe("复习仓储", () => {
	it("enable 后进入待复习队列，review 按 SM-2 推进下次到期", () => {
		const card = cards.create({
			documentId: null,
			page: null,
			rects: [],
			excerptType: "text",
			excerptText: "Q",
		});

		expect(reviews.review(card.id, "good")).toBeUndefined(); // 未启用闪卡不能复习

		reviews.enable(card.id);
		expect(reviews.dueCount(Date.now())).toBe(1);

		const state = reviews.review(card.id, "good", Date.now());
		expect(state?.repetitions).toBe(1);
		expect(reviews.dueCount(Date.now())).toBe(0); // 明天才到期
		expect(reviews.dueCount(Date.now() + 86_400_000 + 1_000)).toBe(1);
	});

	it("due 返回到期卡片本体（按到期先后排序），disable 移出队列", () => {
		const a = cards.create({
			documentId: null,
			page: null,
			rects: [],
			excerptType: "text",
			excerptText: "A",
		});
		const b = cards.create({
			documentId: null,
			page: null,
			rects: [],
			excerptType: "text",
			excerptText: "B",
		});
		reviews.enable(a.id, 1000);
		reviews.enable(b.id, 2000);

		expect(reviews.due(3000).map((c) => c.id)).toEqual([a.id, b.id]);

		reviews.disable(a.id);
		expect(reviews.due(3000).map((c) => c.id)).toEqual([b.id]);
	});

	it("due 按书过滤（㊷）：只返回指定文档的到期卡；limit 在过滤之后生效；缺省不过滤", () => {
		const docA = documents.upsertByPath("books/a.pdf", "书A");
		const docB = documents.upsertByPath("books/b.pdf", "书B");
		const a1 = cards.create({
			documentId: docA.id,
			page: 1,
			rects: [],
			excerptType: "text",
			excerptText: "a1",
		});
		const a2 = cards.create({
			documentId: docA.id,
			page: 2,
			rects: [],
			excerptType: "text",
			excerptText: "a2",
		});
		const b1 = cards.create({
			documentId: docB.id,
			page: 1,
			rects: [],
			excerptType: "text",
			excerptText: "b1",
		});
		const orphan = cards.create({
			documentId: null,
			page: null,
			rects: [],
			excerptType: "text",
			excerptText: "手工",
		});
		// 到期顺序：a1(1000) < b1(2000) < a2(3000) < orphan(4000)
		reviews.enable(a1.id, 1000);
		reviews.enable(b1.id, 2000);
		reviews.enable(a2.id, 3000);
		reviews.enable(orphan.id, 4000);

		// 指定书：跨文档混合到期中只留该书（先过滤后计数）
		expect(reviews.due(5000, undefined, docA.id).map((c) => c.id)).toEqual([a1.id, a2.id]);
		expect(reviews.due(5000, undefined, docB.id).map((c) => c.id)).toEqual([b1.id]);
		// 68 语义更新：limit 只封顶复习段——全新卡场景（phase 均 new）不截断，
		// A 书两张新卡全出（旧行为截到 a1；新卡独立计量见下方混排 describe）
		expect(reviews.due(5000, 1, docA.id).map((c) => c.id)).toEqual([a1.id, a2.id]);
		// 缺省 = 全部书籍（含孤儿卡）——既有语义零回归
		expect(reviews.due(5000).map((c) => c.id)).toEqual([a1.id, b1.id, a2.id, orphan.id]);
	});

	it("due 按卡组过滤：只返回该组到期卡；limit 在过滤之后生效；与书过滤取交集；缺省不过滤", () => {
		const docA = documents.upsertByPath("books/a.pdf", "书A");
		const docB = documents.upsertByPath("books/b.pdf", "书B");
		// 到期顺序：g1(1000) < g2(2000) < 无组(3000) < g3(4000)
		const g1 = cards.create({
			documentId: docA.id,
			page: 1,
			rects: [],
			excerptType: "text",
			excerptText: "g1",
			deck: "考研单词",
		});
		const g2 = cards.create({
			documentId: docB.id,
			page: 1,
			rects: [],
			excerptType: "text",
			excerptText: "g2",
			deck: "考研单词",
		});
		const none = cards.create({
			documentId: docA.id,
			page: 2,
			rects: [],
			excerptType: "text",
			excerptText: "无组",
		});
		const g3 = cards.create({
			documentId: null,
			page: null,
			rects: [],
			excerptType: "text",
			excerptText: "g3",
			deck: "雅思口语",
		});
		reviews.enable(g1.id, 1000);
		reviews.enable(g2.id, 2000);
		reviews.enable(none.id, 3000);
		reviews.enable(g3.id, 4000);

		// 指定卡组：跨组到期中只留该组（无组卡被排除）
		expect(reviews.due(5000, undefined, undefined, "考研单词").map((c) => c.id)).toEqual([
			g1.id,
			g2.id,
		]);
		// 68 语义更新：limit 只封顶复习段——全新卡场景不截断，组内两张全出
		expect(reviews.due(5000, 1, undefined, "考研单词").map((c) => c.id)).toEqual([
			g1.id,
			g2.id,
		]);
		// 与书过滤取交集
		expect(reviews.due(5000, undefined, docA.id, "考研单词").map((c) => c.id)).toEqual([g1.id]);
		// 缺省 = 全部卡片（含无组卡）——既有语义零回归
		expect(reviews.due(5000).map((c) => c.id)).toEqual([g1.id, g2.id, none.id, g3.id]);
	});

	it("due 按卡组子树过滤（73 路径化）：父路径含子路径卡；空白变体归一命中；归一失败不命中", () => {
		// 到期顺序：s1(1000) < s2(2000) < s3(3000) < other(4000) < none(5000)
		const mk = (text: string, deck: string | null) =>
			cards.create({
				documentId: null,
				page: null,
				rects: [],
				excerptType: "text",
				excerptText: text,
				deck,
			});
		const s1 = mk("s1", "学习");
		const s2 = mk("s2", "学习/英语");
		const s3 = mk("s3", "学习 /  英语"); // 存量空白变体
		const other = mk("o", "工作");
		const none = mk("无组", null);
		reviews.enable(s1.id, 1000);
		reviews.enable(s2.id, 2000);
		reviews.enable(s3.id, 3000);
		reviews.enable(other.id, 4000);
		reviews.enable(none.id, 5000);

		// 父路径「学习」含子树（学习/英语 + 空白变体归一命中）；无组与异组排除
		expect(reviews.due(9000, undefined, undefined, "学习").map((c) => c.id)).toEqual([
			s1.id,
			s2.id,
			s3.id,
		]);
		// 深路径只含子树（变体同样命中）；前缀近似「学」不命中（斜杠边界）
		expect(reviews.due(9000, undefined, undefined, "学习/英语").map((c) => c.id)).toEqual([
			s2.id,
			s3.id,
		]);
		expect(reviews.due(9000, undefined, undefined, "学")).toEqual([]);
		// 归一失败的 deck 参数（超长）不命中任何卡（宁拒不赌，不静默放行）
		expect(reviews.due(9000, undefined, undefined, "长".repeat(121))).toEqual([]);
		// 扁平名行为逐字节不变（存量兼容：无 / 时子树 ≡ 精确）
		expect(reviews.due(9000, undefined, undefined, "工作").map((c) => c.id)).toEqual([
			other.id,
		]);
	});

	it("enable 覆盖到期时间（幂等重设），disable 后再 enable 恢复队列", () => {
		const a = cards.create({
			documentId: null,
			page: null,
			rects: [],
			excerptType: "text",
			excerptText: "A",
		});
		reviews.enable(a.id, 1000);
		reviews.enable(a.id, 5000); // 重新启用改期
		expect(reviews.due(4999)).toEqual([]);
		expect(reviews.due(5000).map((c) => c.id)).toEqual([a.id]);

		expect(reviews.disable(a.id)).toBe(true);
		expect(reviews.disable("不存在")).toBe(false);
	});

	it("restoreReview（67 撤销）：直写评分前快照（时间倒流不走 SM-2），状态逐值复原", () => {
		const card = cards.create({
			documentId: null,
			page: null,
			rects: [],
			excerptType: "text",
			excerptText: "Q",
		});
		reviews.enable(card.id, 1000);
		const before = reviews.get(card.id)!;
		const ts = new Date(2026, 8, 1, 10, 0).getTime();
		const next = reviews.review(card.id, "good", ts)!;
		expect(next.repetitions).toBe(before.repetitions + 1);
		expect(reviews.get(card.id)).toEqual(next);

		reviews.restoreReview(before, ts, "good");
		expect(reviews.get(card.id)).toEqual(before); // 快照原样写回
	});

	it("restoreReview 日志镜像回退（67）：评分记 newCards、撤销递减归零删日键", async () => {
		const adapter = new MemoryAdapter();
		const s1 = await MarinMindStore.open(adapter);
		const c1 = new CardRepository(s1);
		const r1 = new ReviewRepository(s1);
		const card = c1.create({
			documentId: null,
			page: null,
			rects: [],
			excerptType: "text",
			excerptText: "Q",
		});
		r1.enable(card.id, 1000);
		const before = r1.get(card.id)!;
		const ts = new Date(2026, 8, 1, 10, 0).getTime();
		r1.review(card.id, "good", ts); // 首考 = 新卡
		expect(s1.getReviewLog()["2026-09-01"]).toEqual({ reviews: 1, newCards: 1, again: 0 });

		r1.restoreReview(before, ts, "good"); // 撤销：newCards 递减归零 → 删日键
		expect(s1.getReviewLog()).toEqual({});
		s1.close();
	});
});

describe("复习仓储 due 分批与新卡混排（68）", () => {
	/** 造一张"复习态"到期卡：enable 后立即评分（首考出 new），1 天后到期再现 */
	function makeReviewDueCard(text: string, reviewTs: number): string {
		const card = cards.create({
			documentId: null,
			page: null,
			rects: [],
			excerptType: "text",
			excerptText: text,
		});
		reviews.enable(card.id, 1000);
		reviews.review(card.id, "good", reviewTs); // phase→review，dueAt = reviewTs + 1 天
		return card.id;
	}

	it("全新卡场景回归钉住：dueAt 升序 + cardId 次键（旧位置式调用排序逐字节等价）", () => {
		const a = cards.create({
			documentId: null,
			page: null,
			rects: [],
			excerptType: "text",
			excerptText: "A",
		});
		const b = cards.create({
			documentId: null,
			page: null,
			rects: [],
			excerptType: "text",
			excerptText: "B",
		});
		reviews.enable(a.id, 2000);
		reviews.enable(b.id, 1000);
		expect(reviews.due(5000).map((c) => c.id)).toEqual([b.id, a.id]);
	});

	it("复习卡优先新卡殿后：即使新卡 dueAt 更早（Anki 语义——先清欠账再引新）", () => {
		const r = makeReviewDueCard("R", 1500); // 复习态，dueAt = 1500 + 1 天
		const n = cards.create({
			documentId: null,
			page: null,
			rects: [],
			excerptType: "text",
			excerptText: "N",
		});
		reviews.enable(n.id, 500); // 新卡 dueAt 500 ≪ r
		expect(reviews.due(1500 + 86_400_000).map((c) => c.id)).toEqual([r, n.id]);
	});

	it("limit 只封顶复习段：3 复习 + 1 新 limit=2 → 前 2 复习 + 新卡照常", () => {
		const r1 = makeReviewDueCard("r1", 1000);
		const r2 = makeReviewDueCard("r2", 1001);
		const n = cards.create({
			documentId: null,
			page: null,
			rects: [],
			excerptType: "text",
			excerptText: "N",
		});
		reviews.enable(n.id, 500);
		expect(reviews.due(1002 + 86_400_000, 2).map((c) => c.id)).toEqual([r1, r2, n.id]);
	});

	it("无复习卡时新卡独立成批：limit 不封顶新段", () => {
		const a = cards.create({
			documentId: null,
			page: null,
			rects: [],
			excerptType: "text",
			excerptText: "A",
		});
		const b = cards.create({
			documentId: null,
			page: null,
			rects: [],
			excerptType: "text",
			excerptText: "B",
		});
		reviews.enable(a.id, 1000);
		reviews.enable(b.id, 2000);
		expect(reviews.due(5000, 1).map((c) => c.id)).toEqual([a.id, b.id]);
	});

	it("newPerDay 截断：3 新卡上限 2 → 只出 2 张", () => {
		const ids = ["a", "b", "c"].map(
			(t) =>
				cards.create({
					documentId: null,
					page: null,
					rects: [],
					excerptType: "text",
					excerptText: t,
				}).id,
		);
		ids.forEach((id, i) => reviews.enable(id, 1000 + i));
		expect(reviews.due(5000, 20, undefined, undefined, 2).map((c) => c.id)).toEqual([
			ids[0],
			ids[1],
		]);
	});

	it("newPerDay=0 = 不限：新卡全量", () => {
		const ids = ["a", "b", "c"].map(
			(t) =>
				cards.create({
					documentId: null,
					page: null,
					rects: [],
					excerptType: "text",
					excerptText: t,
				}).id,
		);
		ids.forEach((id, i) => reviews.enable(id, 1000 + i));
		expect(reviews.due(5000, 20, undefined, undefined, 0).map((c) => c.id)).toEqual(ids);
	});

	it("当日已考新卡计入配额：日志预置 newCards=1，上限 2 → 只补 1 张", () => {
		const ts = new Date(2026, 8, 2, 10, 0).getTime();
		const ids = ["a", "b", "c"].map(
			(t) =>
				cards.create({
					documentId: null,
					page: null,
					rects: [],
					excerptType: "text",
					excerptText: t,
				}).id,
		);
		ids.forEach((id, i) => reviews.enable(id, 1000 + i));
		store.mutateReviewLog((log) => recordReview(log, ts, true, "good"));
		expect(reviews.due(ts, 20, undefined, undefined, 2).map((c) => c.id)).toEqual([ids[0]]);
	});

	it("配额耗尽：当日已考 ≥ 上限 → 新卡 0 张，复习段照常", () => {
		const ts = new Date(2026, 8, 2, 10, 0).getTime();
		const r = makeReviewDueCard("R", 0); // 复习态 dueAt = 86400000 < ts
		const n = cards.create({
			documentId: null,
			page: null,
			rects: [],
			excerptType: "text",
			excerptText: "N",
		});
		reviews.enable(n.id, 500);
		store.mutateReviewLog((log) => {
			recordReview(log, ts, true, "good");
			recordReview(log, ts, true, "good");
		});
		expect(reviews.due(ts, 20, undefined, undefined, 2).map((c) => c.id)).toEqual([r]);
	});

	it("书过滤在混排下仍取交集：复习段与新段各自过滤", () => {
		const docA = documents.upsertByPath("books/a.pdf", "书A");
		const r = makeReviewDueCard("R", 0);
		const n1 = cards.create({
			documentId: docA.id,
			page: 1,
			rects: [],
			excerptType: "text",
			excerptText: "n1",
		});
		const n2 = cards.create({
			documentId: null,
			page: null,
			rects: [],
			excerptType: "text",
			excerptText: "n2",
		});
		reviews.enable(n1.id, 2000);
		reviews.enable(n2.id, 3000);
		expect(reviews.due(86_400_000 + 1, 20, docA.id).map((c) => c.id)).toEqual([n1.id]);
		expect(r).toBeTruthy();
	});
});

describe("复习仓储 dueByIds（70 cards 范围）", () => {
	/** 造一张"复习态"到期卡（与 68 describe 同式）：enable 后立即评分，1 天后到期 */
	function makeReviewDueCard(text: string, reviewTs: number): string {
		const card = cards.create({
			documentId: null,
			page: null,
			rects: [],
			excerptType: "text",
			excerptText: text,
		});
		reviews.enable(card.id, 1000);
		reviews.review(card.id, "good", reviewTs);
		return card.id;
	}

	it("id 集合过滤 + 忽略未启用/未到期/不存在的 id；同混排语义（复习卡在前新卡殿后）", () => {
		const r = makeReviewDueCard("R", 1500); // 复习态 dueAt = 1500 + 1 天
		const n1 = cards.create({
			documentId: null,
			page: null,
			rects: [],
			excerptType: "text",
			excerptText: "N1",
		});
		const n2 = cards.create({
			documentId: null,
			page: null,
			rects: [],
			excerptType: "text",
			excerptText: "N2",
		});
		const off = cards.create({
			documentId: null,
			page: null,
			rects: [],
			excerptType: "text",
			excerptText: "off",
		});
		reviews.enable(n1.id, 500);
		reviews.enable(n2.id, 600);
		// off 不启用闪卡；future 启用但未到期；ghost 不存在
		const future = cards.create({
			documentId: null,
			page: null,
			rects: [],
			excerptType: "text",
			excerptText: "future",
		});
		reviews.enable(future.id, Number.MAX_SAFE_INTEGER);
		const out = reviews.dueByIds([r, n1.id, n2.id, off.id, future.id, "ghost"], {
			nowMs: 1500 + 86_400_000,
		});
		expect(out.map((c) => c.id)).toEqual([r, n1.id, n2.id]);
	});

	it("无 limit：集合内到期卡全量返回（cards 范围由调用方框定，20 截断反而漏卡）", () => {
		const ids = Array.from(
			{ length: 25 },
			(_, i) =>
				cards.create({
					documentId: null,
					page: null,
					rects: [],
					excerptType: "text",
					excerptText: `t${i}`,
				}).id,
		);
		ids.forEach((id, i) => reviews.enable(id, 1000 + i));
		expect(reviews.dueByIds(ids, { nowMs: 5000 })).toHaveLength(25);
	});

	it("newPerDay 配额同源：上限 2 → 新卡只出 2 张", () => {
		const ids = ["a", "b", "c"].map(
			(t) =>
				cards.create({
					documentId: null,
					page: null,
					rects: [],
					excerptType: "text",
					excerptText: t,
				}).id,
		);
		ids.forEach((id, i) => reviews.enable(id, 1000 + i));
		expect(reviews.dueByIds(ids, { nowMs: 5000, newPerDay: 2 }).map((c) => c.id)).toEqual([
			ids[0],
			ids[1],
		]);
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
