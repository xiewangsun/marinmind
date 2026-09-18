import { describe, expect, it } from "vitest";
import {
	activeDeckPath,
	allKnownDecks,
	buildCategoryTree,
	buildDeckTree,
	cardPreview,
	cardPreviewBlocks,
	cardRowSummary,
	distinctColors,
	distinctDecks,
	distinctTags,
	filterCards,
	filterCardsByQuery,
	filterDocsByCategory,
	filterDocsByQuery,
	formatRelativeTime,
	injectCategoryPath,
	inPathSubtree,
	normalizeCategory,
	pageCount,
	paginate,
	UNSET_COLOR,
	UNSET_DECK,
} from "../../src/home/home-data";
import type { BookDocument, Card } from "../../src/types";

function doc(partial: Partial<BookDocument> = {}): BookDocument {
	return {
		id: partial.id ?? `d${Math.random().toString(36).slice(2, 8)}`,
		filePath: "阅读/书籍A.pdf",
		title: "书籍A",
		category: null,
		collectMapId: null,
		autoFlashcard: false,
		createdAt: 1700000000000,
		updatedAt: 1700000000000,
		...partial,
	};
}

function card(partial: Partial<Card> = {}): Card {
	return {
		id: partial.id ?? `c${Math.random().toString(36).slice(2, 8)}`,
		documentId: null,
		page: null,
		rects: [],
		excerptType: "text",
		polygon: null,
		excerptText: "文本",
		excerptRef: null,
		note: null,
		color: null,
		title: null,
		deck: null,
		occlusions: [],
		tags: [],
		createdAt: 1700000000000,
		updatedAt: 1700000000000,
		...partial,
	};
}

describe("buildCategoryTree（㊲ 多层分类树）", () => {
	it("空库：全零无分类", () => {
		expect(buildCategoryTree([])).toEqual({ all: 0, uncategorized: 0, roots: [] });
	});

	it("多层分组：count 只算直接归入，total 含子孙；children 拼音序", () => {
		const tree = buildCategoryTree([
			doc({ category: "学习/英语" }),
			doc({ category: "学习/英语" }),
			doc({ category: "学习" }),
			doc({ category: "工作" }),
			doc({ category: null }),
			doc({ category: "  " }), // 空白视同未分类
		]);
		expect(tree.all).toBe(6);
		expect(tree.uncategorized).toBe(2);
		// localeCompare zh 拼音序：工作(g) < 学习(x)
		expect(tree.roots.map((n) => n.fullName)).toEqual(["工作", "学习"]);
		const work = tree.roots[0];
		expect(work.count).toBe(1);
		expect(work.total).toBe(1);
		const study = tree.roots[1];
		expect(study.count).toBe(1); // 只算直接归入「学习」
		expect(study.total).toBe(3); // 含 学习/英语 ×2
		expect(study.children.map((n) => n.fullName)).toEqual(["学习/英语"]);
		expect(study.children[0].count).toBe(2);
		expect(study.children[0].total).toBe(2);
	});

	it("段级归一分组：空白变体与规范路径归并到同一节点", () => {
		const tree = buildCategoryTree([
			doc({ category: "学习/英语" }),
			doc({ category: "学习 /  英语" }), // 手编产生的变体
			doc({ category: "学习" }),
		]);
		const study = tree.roots[0];
		expect(study.total).toBe(3);
		expect(study.children).toHaveLength(1);
		expect(study.children[0].count).toBe(2);
	});

	it("三层嵌套：中间层无直接文档也有节点", () => {
		const tree = buildCategoryTree([doc({ category: "a/b/c" })]);
		expect(tree.roots[0].name).toBe("a");
		expect(tree.roots[0].children[0].name).toBe("b");
		expect(tree.roots[0].children[0].children[0].fullName).toBe("a/b/c");
		expect(tree.roots[0].total).toBe(1);
	});
});

describe("filterDocsByCategory（㊲ 子树匹配）", () => {
	const docs = [
		doc({ id: "a", category: "学习", updatedAt: 3 }),
		doc({ id: "b", category: "学习/英语", updatedAt: 2 }),
		doc({ id: "c", category: "工作", updatedAt: 1 }),
		doc({ id: "d", category: null, updatedAt: 0 }),
	];

	it("三态选择：all 全部 / null 未分类 / 具体分类路径", () => {
		expect(filterDocsByCategory(docs, "all").map((d) => d.id)).toEqual(["a", "b", "c", "d"]);
		expect(filterDocsByCategory(docs, null).map((d) => d.id)).toEqual(["d"]);
		expect(filterDocsByCategory(docs, "工作").map((d) => d.id)).toEqual(["c"]);
		expect(filterDocsByCategory(docs, "不存在的分类")).toEqual([]);
	});

	it("路径选中含子树：选「学习」也含「学习/英语」", () => {
		expect(filterDocsByCategory(docs, "学习").map((d) => d.id)).toEqual(["a", "b"]);
	});

	it("前缀不误伤：选「学」不匹配「学习」（斜杠边界）", () => {
		expect(filterDocsByCategory(docs, "学")).toEqual([]);
	});
});

describe("normalizeCategory（㊲ 路径归一）", () => {
	it("段内去首尾 + 折叠连续空白", () => {
		expect(normalizeCategory("  学习   笔记 ")).toBe("学习 笔记");
	});

	it("空与纯空白 → null（未分类）", () => {
		expect(normalizeCategory("")).toBeNull();
		expect(normalizeCategory("   ")).toBeNull();
		expect(normalizeCategory(" / / ")).toBeNull(); // 全空段
	});

	it("多层路径：空段丢弃、段内空白折叠", () => {
		expect(normalizeCategory("a//b")).toBe("a/b");
		expect(normalizeCategory(" / 学习 / 英语/ ")).toBe("学习/英语");
		expect(normalizeCategory("学习 /  英语")).toBe("学习/英语");
	});

	it("超 120 → null 拒绝（不截断）；120 以内通过", () => {
		expect(normalizeCategory("长".repeat(121))).toBeNull();
		expect(normalizeCategory("长".repeat(120))).toBe("长".repeat(120));
	});
});

describe("injectCategoryPath（㊲ 空分类注入）", () => {
	const tree = buildCategoryTree([doc({ category: "学习/英语" }), doc({ category: "工作" })]);

	it("不存在的路径注入空节点链（可选中/可作拖放目标）", () => {
		const roots = injectCategoryPath(tree.roots, "学习/数学");
		const study = roots.find((n) => n.fullName === "学习")!;
		expect(study.children.map((n) => n.fullName)).toEqual(["学习/数学", "学习/英语"]);
		const math = study.children[0];
		expect(math.count).toBe(0);
		expect(math.total).toBe(0);
	});

	it("注入节点参与拼音序排序", () => {
		const roots = injectCategoryPath(structuredClone(tree.roots), "安全");
		expect(roots.map((n) => n.fullName)).toEqual(["安全", "工作", "学习"]);
	});

	it("已存在的路径 no-op；null/all 原样返回", () => {
		const before = JSON.stringify(tree.roots);
		expect(injectCategoryPath(tree.roots, "工作")).toBe(tree.roots);
		expect(injectCategoryPath(tree.roots, null)).toBe(tree.roots);
		expect(JSON.stringify(tree.roots)).toBe(before);
	});

	it("多层不存在路径补齐中间层", () => {
		const roots = injectCategoryPath(tree.roots, "新根/子层/孙层");
		const root = roots.find((n) => n.fullName === "新根")!;
		expect(root.children[0].fullName).toBe("新根/子层");
		expect(root.children[0].children[0].fullName).toBe("新根/子层/孙层");
	});
});

describe("buildDeckTree（73 卡组路径树，与分类树同一核心）", () => {
	it("空库：全零无卡组", () => {
		expect(buildDeckTree([])).toEqual({ all: 0, uncategorized: 0, roots: [] });
	});

	it("多层分组：count 只算直接归入，total 含子孙；children 拼音序", () => {
		const tree = buildDeckTree([
			card({ deck: "学习/英语" }),
			card({ deck: "学习/英语" }),
			card({ deck: "学习" }),
			card({ deck: "工作" }),
			card({ deck: null }),
		]);
		expect(tree.all).toBe(5);
		expect(tree.uncategorized).toBe(1);
		// localeCompare zh 拼音序：工作(g) < 学习(x)
		expect(tree.roots.map((n) => n.fullName)).toEqual(["工作", "学习"]);
		const study = tree.roots[1];
		expect(study.count).toBe(1);
		expect(study.total).toBe(3); // 含 学习/英语 ×2
		expect(study.children[0].count).toBe(2);
	});

	it("段级归一防分裂：空白变体归并同节点；超长归一失败落未分组桶", () => {
		const tree = buildDeckTree([
			card({ deck: "学习/英语" }),
			card({ deck: "学习 /  英语" }), // 存量变体
			card({ deck: "长".repeat(121) }), // 归一失败 → 未分组
		]);
		expect(tree.uncategorized).toBe(1);
		const study = tree.roots[0];
		expect(study.children).toHaveLength(1);
		expect(study.children[0].count).toBe(2);
	});

	it("三层嵌套：中间层无直接卡片也有节点", () => {
		const tree = buildDeckTree([card({ deck: "a/b/c" })]);
		expect(tree.roots[0].name).toBe("a");
		expect(tree.roots[0].children[0].children[0].fullName).toBe("a/b/c");
	});
});

describe("filterCards deck 三态 + activeDeckPath（73 路径化）", () => {
	const deckCards = [
		card({ id: "p1", deck: "学习" }),
		card({ id: "p2", deck: "学习/英语" }),
		card({ id: "p3", deck: "工作" }),
		card({ id: "p4", deck: null }),
		card({ id: "p5", deck: "学习 /  数学" }), // 空白变体
	];
	const all = {
		documentId: null,
		excerptType: null,
		deck: null,
		tag: null,
		color: null,
		flashcard: null,
	};

	it("路径选中含子树；前缀不误伤（斜杠边界）；归一变体同命中", () => {
		expect(filterCards(deckCards, { ...all, deck: "学习" }).map((c) => c.id)).toEqual([
			"p1",
			"p2",
			"p5",
		]);
		expect(filterCards(deckCards, { ...all, deck: "学习/英语" }).map((c) => c.id)).toEqual([
			"p2",
		]);
		expect(filterCards(deckCards, { ...all, deck: "学" })).toEqual([]); // 「学」≠「学习」
		expect(filterCards(deckCards, { ...all, deck: "学习/数学" }).map((c) => c.id)).toEqual([
			"p5",
		]);
	});

	it("UNSET_DECK 哨兵筛未分组；null 不限；归一失败的筛选值不命中任何卡", () => {
		expect(filterCards(deckCards, { ...all, deck: UNSET_DECK }).map((c) => c.id)).toEqual([
			"p4",
		]);
		expect(filterCards(deckCards, all)).toHaveLength(5);
		expect(filterCards(deckCards, { ...all, deck: "长".repeat(121) })).toEqual([]);
	});

	it("activeDeckPath：null/哨兵 → null，路径原样（复习本组与树注入的守卫单源）", () => {
		expect(activeDeckPath(null)).toBeNull();
		expect(activeDeckPath(UNSET_DECK)).toBeNull();
		expect(activeDeckPath("学习/英语")).toBe("学习/英语");
	});

	it("inPathSubtree：斜杠边界——前缀近似名不误伤", () => {
		expect(inPathSubtree("学习", "学习")).toBe(true);
		expect(inPathSubtree("学习/英语", "学习")).toBe(true);
		expect(inPathSubtree("学习后", "学习")).toBe(false);
		expect(inPathSubtree("学习", "学习/英语")).toBe(false);
	});
});

describe("filterDocsByQuery（㊲ 文档搜索）", () => {
	const docs = [
		doc({ id: "a", title: "强化学习导论", filePath: "books/rl.pdf" }),
		doc({ id: "b", title: "图论", filePath: "阅读/Graph.pdf" }),
	];

	it("空 query 原样返回（拷贝）", () => {
		const out = filterDocsByQuery(docs, "  ");
		expect(out.map((d) => d.id)).toEqual(["a", "b"]);
		expect(out).not.toBe(docs);
	});

	it("标题与路径命中，大小写不敏感，保序", () => {
		expect(filterDocsByQuery(docs, "学习").map((d) => d.id)).toEqual(["a"]);
		expect(filterDocsByQuery(docs, "graph").map((d) => d.id)).toEqual(["b"]);
		expect(filterDocsByQuery(docs, "pdf").map((d) => d.id)).toEqual(["a", "b"]); // 路径均命中
	});

	it("无命中 → 空数组", () => {
		expect(filterDocsByQuery(docs, "不存在")).toEqual([]);
	});
});

describe("filterCardsByQuery（139-F 卡片全文搜索）", () => {
	const cards = [
		card({ id: "t1", excerptText: "强化学习是机器学习分支", note: null, tags: [] }),
		card({ id: "n1", excerptText: null, note: "梯度下降笔记", tags: [] }),
		card({ id: "g1", excerptText: null, note: null, tags: ["英语", "GRE"] }),
		card({ id: "m1", excerptText: null, note: null, tags: [] }), // 纯媒体卡无文字
	];

	it("空 query 原样返回（拷贝）", () => {
		const out = filterCardsByQuery(cards, "  ");
		expect(out.map((c) => c.id)).toEqual(["t1", "n1", "g1", "m1"]);
		expect(out).not.toBe(cards);
	});

	it("正文/批注/标签三字段命中，大小写不敏感，保序", () => {
		expect(filterCardsByQuery(cards, "机器学习").map((c) => c.id)).toEqual(["t1"]); // 正文
		expect(filterCardsByQuery(cards, "笔记").map((c) => c.id)).toEqual(["n1"]); // 批注
		expect(filterCardsByQuery(cards, "gre").map((c) => c.id)).toEqual(["g1"]); // 标签小写
		expect(filterCardsByQuery(cards, "学习").map((c) => c.id)).toEqual(["t1"]); // 非子串误配
	});

	it("无文字字段（纯媒体卡）与无命中 → 不出现", () => {
		expect(filterCardsByQuery(cards, "英语").map((c) => c.id)).toEqual(["g1"]); // m1 无文字不命中
		expect(filterCardsByQuery(cards, "不存在")).toEqual([]);
	});
});

describe("filterCards + paginate（㊲ 卡片筛选分页；卡组批扩四维）", () => {
	const cards = [
		card({ id: "t1", documentId: "d1", excerptType: "text" }),
		card({ id: "a1", documentId: "d1", excerptType: "area" }),
		card({ id: "t2", documentId: null, excerptType: "text" }),
	];
	const all = {
		documentId: null,
		excerptType: null,
		deck: null,
		tag: null,
		color: null,
		flashcard: null,
	};

	it("null 不限全量；按书籍/形态单独与组合筛选", () => {
		expect(filterCards(cards, all)).toHaveLength(3);
		expect(filterCards(cards, { ...all, documentId: "d1" }).map((c) => c.id)).toEqual([
			"t1",
			"a1",
		]);
		expect(filterCards(cards, { ...all, excerptType: "text" }).map((c) => c.id)).toEqual([
			"t1",
			"t2",
		]);
		expect(
			filterCards(cards, { ...all, documentId: "d1", excerptType: "text" }).map((c) => c.id),
		).toEqual(["t1"]);
	});

	it("卡组批：按 deck 精确筛选（null 不限；未分组卡用空串筛不到）", () => {
		const deckCards = [
			card({ id: "x1", deck: "考研单词" }),
			card({ id: "x2", deck: "考研单词" }),
			card({ id: "x3", deck: "面试题" }),
			card({ id: "x4", deck: null }),
		];
		expect(filterCards(deckCards, all)).toHaveLength(4);
		expect(filterCards(deckCards, { ...all, deck: "考研单词" }).map((c) => c.id)).toEqual([
			"x1",
			"x2",
		]);
		expect(filterCards(deckCards, { ...all, deck: "面试题" }).map((c) => c.id)).toEqual(["x3"]);
	});

	it("卡组批：按 tag 含即命中（多标签卡）", () => {
		const tagCards = [
			card({ id: "y1", tags: ["英语", "词汇"] }),
			card({ id: "y2", tags: ["英语"] }),
			card({ id: "y3", tags: [] }),
		];
		expect(filterCards(tagCards, { ...all, tag: "英语" }).map((c) => c.id)).toEqual([
			"y1",
			"y2",
		]);
		expect(filterCards(tagCards, { ...all, tag: "词汇" }).map((c) => c.id)).toEqual(["y1"]);
	});

	it("70：按颜色精确筛选 + UNSET_COLOR 哨兵筛未设色；distinctColors 派生（含旧色相与哨兵殿后）", () => {
		const colorCards = [
			card({ id: "c1", color: "yellow" }),
			card({ id: "c2", color: "teal" }), // 旧色相存量卡可筛
			card({ id: "c3", color: null }),
		];
		expect(filterCards(colorCards, { ...all, color: "yellow" }).map((c) => c.id)).toEqual([
			"c1",
		]);
		expect(filterCards(colorCards, { ...all, color: UNSET_COLOR }).map((c) => c.id)).toEqual([
			"c3",
		]);
		expect(distinctColors(colorCards)).toEqual(["teal", "yellow", UNSET_COLOR]);
		// 无未设色卡时不出现哨兵选项；空输入空数组
		expect(distinctColors([card({ color: "red" })])).toEqual(["red"]);
		expect(distinctColors([])).toEqual([]);
	});

	it("卡组批：四维 AND 组合（书×形态×卡组×标签交集）", () => {
		const mix = [
			card({ id: "z1", documentId: "d1", excerptType: "text", deck: "G", tags: ["a"] }),
			card({ id: "z2", documentId: "d1", excerptType: "text", deck: "G", tags: ["b"] }),
			card({ id: "z3", documentId: "d1", excerptType: "text", deck: "H", tags: ["a"] }),
			card({ id: "z4", documentId: "d2", excerptType: "text", deck: "G", tags: ["a"] }),
		];
		expect(
			filterCards(mix, {
				documentId: "d1",
				excerptType: "text",
				deck: "G",
				tag: "a",
				color: null,
				flashcard: null,
			}).map((c) => c.id),
		).toEqual(["z1"]);
	});

	it("130：闪卡维——null 不限 / true 只含集合内 / 漏传集合显式空 / 与其他维度 AND", () => {
		const cards = [
			card({ id: "f1", documentId: "d1", excerptType: "text" }),
			card({ id: "f2", documentId: "d1", excerptType: "area" }),
			card({ id: "f3", documentId: null, excerptType: "text" }),
		];
		const flash = new Set(["f1", "f3"]);
		// null 不限：不传集合也不影响
		expect(filterCards(cards, all).map((c) => c.id)).toEqual(["f1", "f2", "f3"]);
		// true 只看集合内
		expect(filterCards(cards, { ...all, flashcard: true }, flash).map((c) => c.id)).toEqual([
			"f1",
			"f3",
		]);
		// true 但调用方漏传集合：显式失败返回空（不误放行）
		expect(filterCards(cards, { ...all, flashcard: true })).toEqual([]);
		// 空集 + true = 空
		expect(filterCards(cards, { ...all, flashcard: true }, new Set())).toEqual([]);
		// 与书籍维度 AND 组合
		expect(
			filterCards(cards, { ...all, documentId: "d1", flashcard: true }, flash).map(
				(c) => c.id,
			),
		).toEqual(["f1"]);
	});

	it("卡组批：distinctDecks / distinctTags 去重 + 拼音序，空输入空数组", () => {
		const pool = [
			card({ deck: "面试题", tags: ["英语", "词汇"] }),
			card({ deck: "考研单词", tags: ["英语"] }),
			card({ deck: "考研单词", tags: [] }),
			card({ deck: null, tags: ["zzz"] }),
		];
		expect(distinctDecks(pool)).toEqual(["考研单词", "面试题"]);
		// zh 拼音序：词汇(cíhuì) < 英语(yīngyǔ) < zzz
		expect(distinctTags(pool)).toEqual(["词汇", "英语", "zzz"]);
		expect(distinctDecks([])).toEqual([]);
		expect(distinctTags([])).toEqual([]);
	});

	it("73：distinctDecks 归一去重——空白变体合并单条，超长归一失败不列出", () => {
		const pool = [
			card({ deck: "学习 /  英语" }),
			card({ deck: "学习/英语" }),
			card({ deck: "长".repeat(121) }),
		];
		expect(distinctDecks(pool)).toEqual(["学习/英语"]);
	});

	it("paginate：切片、页码从 1 起、越界钳到最后一页", () => {
		const items = [1, 2, 3, 4, 5];
		expect(paginate(items, 1, 2)).toEqual([1, 2]);
		expect(paginate(items, 3, 2)).toEqual([5]);
		expect(paginate(items, 99, 2)).toEqual([5]); // 越界钳制
		expect(paginate(items, 0, 2)).toEqual([1, 2]); // 低于 1 钳到第 1 页
		expect(paginate(items, 1, 10)).toEqual([1, 2, 3, 4, 5]); // 单页全量
		expect(paginate([], 1, 10)).toEqual([]);
	});

	it("pageCount：空集也至少 1 页", () => {
		expect(pageCount(0, 50)).toBe(1);
		expect(pageCount(50, 50)).toBe(1);
		expect(pageCount(51, 50)).toBe(2);
	});
});

describe("formatRelativeTime（㉟ 相对时间）", () => {
	const NOW = new Date(2026, 7, 28, 12, 0, 0).getTime(); // 2026-08-28 12:00

	it("一分钟内 → 刚刚；分钟/小时档", () => {
		expect(formatRelativeTime(NOW - 30_000, NOW)).toBe("刚刚");
		expect(formatRelativeTime(NOW - 5 * 60_000, NOW)).toBe("5 分钟前");
		expect(formatRelativeTime(NOW - 3 * 3_600_000, NOW)).toBe("3 小时前");
	});

	it("昨天（跨日历日而非 48h）；今年内 → M月D日", () => {
		expect(formatRelativeTime(new Date(2026, 7, 27, 23, 0).getTime(), NOW)).toBe("昨天");
		expect(formatRelativeTime(new Date(2026, 2, 5).getTime(), NOW)).toBe("3月5日");
	});

	it("往年 → YYYY年M月D日", () => {
		expect(formatRelativeTime(new Date(2024, 11, 31).getTime(), NOW)).toBe("2024年12月31日");
	});
});

describe("cardPreview 卡片预览文本（㶈 与主页列表/预览弹窗共用）", () => {
	it("批注 > 摘录文字 > 形态占位（与脑图节点标题同序）", () => {
		expect(cardPreview(card({ note: "问题", excerptText: "原文" }))).toBe("问题");
		expect(cardPreview(card({ excerptText: "  原文  " }))).toBe("原文"); // trim
		expect(cardPreview(card({ excerptText: null, excerptType: "audio" }))).toBe("语音摘录");
	});

	it("空白批注让位于摘录文字", () => {
		expect(cardPreview(card({ note: "   ", excerptText: "原文" }))).toBe("原文");
	});

	it("㊺ 标题最高优先（trim）；空白标题让位于批注", () => {
		expect(cardPreview(card({ title: "  标题 ", note: "问题", excerptText: "原文" }))).toBe(
			"标题",
		);
		expect(cardPreview(card({ title: "   ", note: "问题", excerptText: "原文" }))).toBe("问题");
	});
});

describe("cardPreviewBlocks 正文块拆分（85-D 批注/摘录独立展示位）", () => {
	it("title+note+excerpt 三全：批注块与摘录块均另列（互不吸收）", () => {
		expect(cardPreviewBlocks(card({ title: "T", note: "N", excerptText: "E" }))).toEqual({
			note: "N",
			excerpt: "E",
		});
	});

	it("只有 OCR 文字（无标题无批注）：不另列（cardPreview 已用它当标题）", () => {
		expect(cardPreviewBlocks(card({ excerptText: "E" }))).toEqual({
			note: null,
			excerpt: null,
		});
	});

	it("只有批注：批注不另列（已当标题），摘录无", () => {
		expect(cardPreviewBlocks(card({ note: "N", excerptText: null }))).toEqual({
			note: null,
			excerpt: null,
		});
	});

	it("标题+摘录（OCR 卡常见）：摘录另列、无批注块", () => {
		expect(cardPreviewBlocks(card({ title: "T", excerptText: "E" }))).toEqual({
			note: null,
			excerpt: "E",
		});
	});

	it("批注+摘录（无标题）：批注已被 cardPreview 当标题吸收，摘录另列", () => {
		expect(cardPreviewBlocks(card({ note: "N", excerptText: "E" }))).toEqual({
			note: null,
			excerpt: "E",
		});
	});

	it("标题+批注（无摘录）：批注另列、无摘录块", () => {
		expect(cardPreviewBlocks(card({ title: "T", note: "N", excerptText: null }))).toEqual({
			note: "N",
			excerpt: null,
		});
	});

	it("全空（纯媒体卡）：两块皆无", () => {
		expect(cardPreviewBlocks(card({ excerptText: null }))).toEqual({
			note: null,
			excerpt: null,
		});
	});

	it("空白字段按空处理（trim 边界：不计入块也不吸收标题序）", () => {
		// note 全空白 + excerpt 有值 + 无标题 → cardPreview 用 excerpt 当标题 → 不另列
		expect(cardPreviewBlocks(card({ note: "   ", excerptText: "E" }))).toEqual({
			note: null,
			excerpt: null,
		});
		// title 正常 + note/excerpt 全空白 → 均不另列
		expect(cardPreviewBlocks(card({ title: "T", note: " ", excerptText: " " }))).toEqual({
			note: null,
			excerpt: null,
		});
	});
});

describe("buildCategoryTree/buildDeckTree 显式清单 union（76 空分组持久化）", () => {
	it("空分类只长节点不计 count：徽标 0、all/uncategorized 不受影响", () => {
		const tree = buildCategoryTree(
			[doc({ category: "学习" }), doc({ category: null })],
			["工作", "学习/英语"], // 「工作」全空 + 「学习/英语」空子分类
		);
		expect(tree.all).toBe(2);
		expect(tree.uncategorized).toBe(1);
		const work = tree.roots.find((n) => n.fullName === "工作")!;
		expect(work.count).toBe(0);
		expect(work.total).toBe(0);
		const study = tree.roots.find((n) => n.fullName === "学习")!;
		expect(study.count).toBe(1);
		expect(study.total).toBe(1); // 空子分类不虚增 total
		expect(study.children.map((n) => n.fullName)).toEqual(["学习/英语"]);
	});

	it("多层清单路径长出父链（无文档的中间层也在树上）", () => {
		const tree = buildCategoryTree([], ["a/b/c"]);
		expect(tree.all).toBe(0);
		expect(tree.roots.map((n) => n.fullName)).toEqual(["a"]);
		expect(tree.roots[0].children[0].children[0].fullName).toBe("a/b/c");
	});

	it("清单与派生路径重复：ensure 幂等不虚增计数", () => {
		const tree = buildCategoryTree([doc({ category: "学习" })], ["学习"]);
		const study = tree.roots.find((n) => n.fullName === "学习")!;
		expect(study.count).toBe(1);
		expect(tree.roots).toHaveLength(1);
	});

	it("buildDeckTree 第二参同构", () => {
		const tree = buildDeckTree([card({ deck: "英语" })], ["空组"]);
		expect(tree.all).toBe(1);
		const names = tree.roots.map((n) => n.fullName);
		expect(names).toContain("空组");
		expect(names).toContain("英语");
	});
});

describe("allKnownDecks（76 设卡组选择器 items 源）", () => {
	it("卡片实际卡组 ∪ 显式清单去重，拼音序", () => {
		const decks = allKnownDecks(
			[card({ deck: "学习" }), card({ deck: " 学习 " }), card({ deck: null })],
			["工作", "学习"], // 「学习」与派生重复 → 去重
		);
		expect(decks).toEqual(["工作", "学习"]); // 归一去重后拼音序
	});

	it("无清单：与 distinctDecks 等价", () => {
		const cards = [card({ deck: "a" }), card({ deck: "b" })];
		expect(allKnownDecks(cards)).toEqual(distinctDecks(cards));
	});

	it("仅清单（全空卡组）也返回", () => {
		expect(allKnownDecks([], ["空组"])).toEqual(["空组"]);
	});
});

describe("cardRowSummary（卡片行摘要第二行，91 批）", () => {
	it("title+note+excerpt：摘要取批注（与 cardPreview 优先链同序）", () => {
		expect(
			cardRowSummary(card({ title: "T", note: "批注内容", excerptText: "摘录原文" })),
		).toBe("批注内容");
	});

	it("title+excerpt（OCR 卡）：摘要取摘录文字", () => {
		expect(cardRowSummary(card({ title: "T", note: null, excerptText: "摘录原文" }))).toBe(
			"摘录原文",
		);
	});

	it("无 title 有 note+excerpt：note 被标题吸收，摘要取摘录", () => {
		expect(cardRowSummary(card({ title: null, note: "当标题", excerptText: "摘录原文" }))).toBe(
			"摘录原文",
		);
	});

	it("仅 title：全被吸收返回 null（不空占位）", () => {
		expect(cardRowSummary(card({ title: "T", note: null, excerptText: null }))).toBeNull();
	});

	it("全空媒体卡（无文字字段）：返回 null", () => {
		expect(
			cardRowSummary(
				card({ excerptType: "photo", excerptText: null, note: null, title: null }),
			),
		).toBeNull();
	});
});
