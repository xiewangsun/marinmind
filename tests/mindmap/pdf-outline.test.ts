import { describe, expect, it } from "vitest";
import { planOutlineChapters } from "../../src/mindmap/pdf-outline";
import type { OutlineEntry } from "../../src/reader/pdf-document";

/** 目录条目工厂（children 可省） */
function entry(title: string, page: number | null, children: OutlineEntry[] = []): OutlineEntry {
	return { title, page, children };
}

describe("planOutlineChapters 目录建卡计划（55）", () => {
	it("深度优先平铺：层级深度与 parentIndex 指向正确（父先子后，建卡按下标回挂）", () => {
		const tree = [
			entry("第一章", 1, [entry("1.1", 2), entry("1.2", 5)]),
			entry("第二章", 20),
		];
		expect(planOutlineChapters(tree)).toEqual([
			{ title: "第一章", page: 1, anchorY: null, depth: 0, parentIndex: null },
			{ title: "1.1", page: 2, anchorY: null, depth: 1, parentIndex: 0 },
			{ title: "1.2", page: 5, anchorY: null, depth: 1, parentIndex: 0 },
			{ title: "第二章", page: 20, anchorY: null, depth: 0, parentIndex: null },
		]);
	});

	it("损坏条目（page null）自身跳过，子级就近重挂最近有效祖先，深度随重挂归一", () => {
		const tree = [
			entry("第一章", 1, [
				// 损坏章自身跳过；其子级重挂最近有效祖先「第一章」（深度 1）。
				// 注意 1.1.2.1 的最近有效祖先也是第一章（1.1.1 是旁支兄弟不是
				// 祖先——就近重挂只上溯父链，不借道兄弟分支）
				entry("损坏章", null, [
					entry("1.1.1", 3),
					entry("损坏孙", null, [entry("1.1.2.1", 4)]),
				]),
			]),
		];
		expect(planOutlineChapters(tree)).toEqual([
			{ title: "第一章", page: 1, anchorY: null, depth: 0, parentIndex: null },
			{ title: "1.1.1", page: 3, anchorY: null, depth: 1, parentIndex: 0 },
			{ title: "1.1.2.1", page: 4, anchorY: null, depth: 1, parentIndex: 0 },
		]);
	});

	it("顶层损坏条目：子级上浮为顶层", () => {
		expect(planOutlineChapters([entry("坏", null, [entry("好章", 7)])])).toEqual([
			{ title: "好章", page: 7, anchorY: null, depth: 0, parentIndex: null },
		]);
	});

	it("空目录返回空数组", () => {
		expect(planOutlineChapters([])).toEqual([]);
	});

	it("anchorY 透传（62 md 框架）：携带者照抄；普通 OutlineEntry（pdf/epub）归一 null", () => {
		// md 量测产物：OutlineEntry + anchorY（MeasuredOutlineEntry 结构兼容入参）
		const mdTree = [
			{
				title: "第一章",
				page: 1,
				anchorY: 0.05,
				children: [{ title: "1.1", page: 1, anchorY: 0.12, children: [] as never[] }],
			},
		];
		expect(planOutlineChapters(mdTree)).toEqual([
			{ title: "第一章", page: 1, anchorY: 0.05, depth: 0, parentIndex: null },
			{ title: "1.1", page: 1, anchorY: 0.12, depth: 1, parentIndex: 0 },
		]);
		// pdf/epub 路径（无 anchorY 字段）：plan 项 anchorY 恒 null
		const pdfTree = [entry("第一章", 1, [entry("1.1", 2)])];
		expect(planOutlineChapters(pdfTree)).toEqual([
			{ title: "第一章", page: 1, anchorY: null, depth: 0, parentIndex: null },
			{ title: "1.1", page: 2, anchorY: null, depth: 1, parentIndex: 0 },
		]);
	});
});
