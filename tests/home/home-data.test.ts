import { describe, expect, it } from "vitest";
import {
	buildCategoryTree,
	cardPreview,
	filterCards,
	filterDocsByCategory,
	filterDocsByQuery,
	formatRelativeTime,
	injectCategoryPath,
	normalizeCategory,
	pageCount,
	paginate,
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
	const tree = buildCategoryTree([
		doc({ category: "学习/英语" }),
		doc({ category: "工作" }),
	]);

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

describe("filterCards + paginate（㊲ 卡片筛选分页）", () => {
	const cards = [
		card({ id: "t1", documentId: "d1", excerptType: "text" }),
		card({ id: "a1", documentId: "d1", excerptType: "area" }),
		card({ id: "t2", documentId: null, excerptType: "text" }),
	];

	it("null 不限全量；按文档/形态单独与组合筛选", () => {
		expect(filterCards(cards, { documentId: null, excerptType: null })).toHaveLength(3);
		expect(filterCards(cards, { documentId: "d1", excerptType: null }).map((c) => c.id)).toEqual(["t1", "a1"]);
		expect(filterCards(cards, { documentId: null, excerptType: "text" }).map((c) => c.id)).toEqual(["t1", "t2"]);
		expect(filterCards(cards, { documentId: "d1", excerptType: "text" }).map((c) => c.id)).toEqual(["t1"]);
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
		expect(cardPreview(card({ title: "  标题 ", note: "问题", excerptText: "原文" }))).toBe("标题");
		expect(cardPreview(card({ title: "   ", note: "问题", excerptText: "原文" }))).toBe("问题");
	});
});
