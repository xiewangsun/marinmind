// @vitest-environment jsdom
/**
 * 选区几何纯函数测试（139-D）：jsdom 不做布局（Range 测量恒零），测试以
 * 「假布局引擎」patch Range.prototype 的 getBoundingClientRect/getClientRects——
 * 按文档序给每个字符分配确定性盒子（换行符零尺寸、空格有尺寸，贴近真实 DOM），
 * 使行聚类/空白收缩/首尾修剪语义可在无渲染环境验证。
 */
import { afterEach, describe, expect, it } from "vitest";
import {
	attributeBoxesToPages,
	collectSelectionLines,
	MAX_MEASURE_CHARS,
	trimRangeToBounds,
} from "../../src/reader/selection-geometry";
import type { ViewportRect } from "../../src/reader/rect-utils";

/** 假布局参数：每行 10 字符、字宽 6、行高 12（行号 = top / LINE_H 反推） */
const CHAR_W = 6;
const LINE_H = 12;
const CHARS_PER_LINE = 10;

/** 文档序全量字符盒：每个文本节点内逐字符的盒子（\n 记零尺寸并折到下一行首） */
const charBoxes = new Map<Text, ViewportRect[]>();

/** 计算自动布局并 patch Range 测量（须在 DOM 就绪后调用）；custom 允许按节点覆写盒子 */
function installFakeLayout(custom?: Map<Text, ViewportRect[]>): void {
	let globalIndex = 0;
	const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
	for (let n = walker.nextNode(); n; n = walker.nextNode()) {
		const t = n as Text;
		if (custom?.has(t)) {
			charBoxes.set(t, custom.get(t)!);
			globalIndex += t.data.length;
			continue;
		}
		const boxes: ViewportRect[] = [];
		for (const ch of t.data) {
			if (ch === "\n") {
				boxes.push({ left: 0, top: 0, width: 0, height: 0 });
				// 换行折到下一行首（与真实文本断行一致）
				globalIndex = (Math.floor(globalIndex / CHARS_PER_LINE) + 1) * CHARS_PER_LINE;
				continue;
			}
			const line = Math.floor(globalIndex / CHARS_PER_LINE);
			const col = globalIndex % CHARS_PER_LINE;
			boxes.push({ left: col * CHAR_W, top: line * LINE_H, width: CHAR_W, height: LINE_H });
			globalIndex++;
		}
		charBoxes.set(t, boxes);
	}
}

/** Range 覆盖的字符盒（文档序遍历全量文本节点，按 intersectsNode + 首尾偏移截取） */
function coveredBoxes(range: Range): ViewportRect[] {
	const out: ViewportRect[] = [];
	const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
	for (let n = walker.nextNode(); n; n = walker.nextNode()) {
		const t = n as Text;
		if (!range.intersectsNode(t)) {
			continue;
		}
		const s = t === range.startContainer ? range.startOffset : 0;
		const e = t === range.endContainer ? range.endOffset : t.length;
		const boxes = charBoxes.get(t);
		if (!boxes) {
			continue;
		}
		for (let i = s; i < e; i++) {
			out.push(boxes[i]);
		}
	}
	return out;
}

function unionOf(boxes: readonly ViewportRect[]): ViewportRect {
	let l = Infinity;
	let t = Infinity;
	let r = -Infinity;
	let b = -Infinity;
	for (const box of boxes) {
		l = Math.min(l, box.left);
		t = Math.min(t, box.top);
		r = Math.max(r, box.left + box.width);
		b = Math.max(b, box.top + box.height);
	}
	return { left: l, top: t, width: r - l, height: b - t };
}

const origGetBCR = Range.prototype.getBoundingClientRect;
const origGetCR = Range.prototype.getClientRects;

function patchRangeMeasure(): void {
	Range.prototype.getBoundingClientRect = function (this: Range) {
		const boxes = coveredBoxes(this).filter((b) => b.width > 0 && b.height > 0);
		if (boxes.length === 0) {
			return { left: 0, top: 0, width: 0, height: 0 } as DOMRect;
		}
		const u = unionOf(boxes);
		return { ...u, right: u.left + u.width, bottom: u.top + u.height } as DOMRect;
	};
	Range.prototype.getClientRects = function (this: Range) {
		// 按行分组：同行连续字符并成一个矩形（贴近真实 DOM 的逐行 rects）
		const boxes = coveredBoxes(this).filter((b) => b.width > 0 && b.height > 0);
		const rects: DOMRect[] = [];
		let cur: ViewportRect[] = [];
		let curLine = -1;
		for (const box of boxes) {
			const line = Math.round(box.top / LINE_H);
			if (cur.length > 0 && line !== curLine) {
				const u = unionOf(cur);
				rects.push({ ...u, right: u.left + u.width, bottom: u.top + u.height } as DOMRect);
				cur = [];
			}
			cur.push(box);
			curLine = line;
		}
		if (cur.length > 0) {
			const u = unionOf(cur);
			rects.push({ ...u, right: u.left + u.width, bottom: u.top + u.height } as DOMRect);
		}
		return rects as unknown as DOMRectList;
	};
}

function restoreRangeMeasure(): void {
	Range.prototype.getBoundingClientRect = origGetBCR;
	Range.prototype.getClientRects = origGetCR;
	charBoxes.clear();
}

/** 建 DOM + 装假布局，返回全选 Range（宿主内首文本节点首到末文本节点尾） */
function setupSelection(html: string, select?: { from: number; to: number }): Range {
	document.body.innerHTML = html;
	installFakeLayout();
	patchRangeMeasure();
	const texts: Text[] = [];
	const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
	for (let n = walker.nextNode(); n; n = walker.nextNode()) {
		texts.push(n as Text);
	}
	const first = texts[0];
	const last = texts[texts.length - 1];
	const range = document.createRange();
	if (select) {
		range.setStart(first, select.from);
		range.setEnd(last, select.to);
	} else {
		range.setStart(first, 0);
		range.setEnd(last, last.length);
	}
	return range;
}

afterEach(restoreRangeMeasure);

describe("collectSelectionLines 行聚类", () => {
	it("跨行选区按 y 拆行，行文本首尾空白收缩", () => {
		// 10 字/行：第 0 行 "hello worl"、第 1 行 "d foo bar"（硬换行由 \n 触发）
		const range = setupSelection("<div><span>hello world foo bar</span></div>");
		const lines = collectSelectionLines(range);
		expect(lines).not.toBeNull();
		expect(lines!.map((l) => l.text)).toEqual(["hello worl", "d foo bar"]);
		// 第 0 行 10 字符盒并集：宽 10×6、高 12
		expect(lines![0].box).toEqual({ left: 0, top: 0, width: 60, height: 12 });
		expect(lines![1].box.left).toBe(0);
		expect(lines![1].box.top).toBe(LINE_H);
	});

	it("行尾空白不入行盒（收缩到末个非空白字符）", () => {
		// "ab" + 3 空格 + \n + "cd"：第 0 行收缩为 "ab"，\n 零尺寸归属第 0 行被剪掉
		const range = setupSelection("<div><span>ab   \ncd</span></div>");
		const lines = collectSelectionLines(range);
		expect(lines!.map((l) => l.text)).toEqual(["ab", "cd"]);
		expect(lines![0].box.width).toBe(2 * CHAR_W); // 不含 3 个尾部空格
	});

	it("行内多空白折叠为单空格", () => {
		const range = setupSelection("<div><span>a  b</span></div>");
		const lines = collectSelectionLines(range);
		expect(lines!.map((l) => l.text)).toEqual(["a b"]);
	});

	it("选区落在单个文本节点内不丢（NodeIterator 含根语义）", () => {
		// commonAncestor 即 Text 自身——TreeWalker 实现会静默丢卡，回归钉住
		const range = setupSelection("<div><span>abc</span></div>");
		const span = document.body.querySelector("span")!.firstChild as Text;
		range.setStart(span, 0);
		range.setEnd(span, 3);
		const lines = collectSelectionLines(range);
		expect(lines!.map((l) => l.text)).toEqual(["abc"]);
	});

	it("跨 span 同一行选区合为一行（行盒跨节点并集）", () => {
		const range = setupSelection("<div><span>aaa</span><span>bbb</span></div>");
		const lines = collectSelectionLines(range);
		expect(lines!.map((l) => l.text)).toEqual(["aaabbb"]);
		expect(lines![0].box.width).toBe(6 * CHAR_W);
	});

	it("同 y 但 x 大幅回退判为换列另起一行", () => {
		// 自定义盒：a(0,0) b(100,0) 同行；c(50,0) 落后 b 右缘 56px > 20 → 新行
		document.body.innerHTML = "<div><span>abc</span></div>";
		const span = document.body.querySelector("span")!.firstChild as Text;
		const custom = new Map<Text, ViewportRect[]>([
			[
				span,
				[
					{ left: 0, top: 0, width: 6, height: 12 },
					{ left: 100, top: 0, width: 6, height: 12 },
					{ left: 50, top: 0, width: 6, height: 12 },
				],
			],
		]);
		installFakeLayout(custom);
		patchRangeMeasure();
		const range = document.createRange();
		range.setStart(span, 0);
		range.setEnd(span, 3);
		const lines = collectSelectionLines(range);
		expect(lines!.map((l) => l.text)).toEqual(["ab", "c"]);
	});

	it("超大规模选区返回 null（退回老路径信号）", () => {
		const big = "a".repeat(MAX_MEASURE_CHARS + 1);
		const range = setupSelection(`<div><span>${big}</span></div>`);
		expect(collectSelectionLines(range)).toBeNull();
	});

	it("空选区（无相交文本）返回 null", () => {
		document.body.innerHTML = "<div><span>abc</span></div>";
		installFakeLayout();
		patchRangeMeasure();
		const span = document.body.querySelector("span")!.firstChild as Text;
		const range = document.createRange();
		range.setStart(span, 1);
		range.setEnd(span, 1); // 折叠选区：无字符
		expect(collectSelectionLines(range)).toBeNull();
	});
});

describe("trimRangeToBounds 首尾空白修剪", () => {
	it("就地收缩到首末非空白字符（单 span）", () => {
		const range = setupSelection("<div><span>  ab  </span></div>");
		expect(trimRangeToBounds(range)).toBe(true);
		expect(range.toString()).toBe("ab");
	});

	it("跨 span 修剪（空白分布在两端节点）", () => {
		const range = setupSelection("<div><span>  ab</span><span>cd  </span></div>");
		expect(trimRangeToBounds(range)).toBe(true);
		expect(range.toString()).toBe("abcd");
	});

	it("全空白选区返回 false", () => {
		const range = setupSelection("<div><span>   </span></div>");
		expect(trimRangeToBounds(range)).toBe(false);
	});
});

describe("attributeBoxesToPages 归页单源", () => {
	it("盒按中心点归属页，零尺寸与无页盒跳过", () => {
		const boxes: ViewportRect[] = [
			{ left: 0, top: 0, width: 10, height: 10 }, // 中心 (5,5) → 页 1
			{ left: 100, top: 0, width: 10, height: 10 }, // 中心 (105,5) → 页 2
			{ left: 0, top: 0, width: 0, height: 10 }, // 零宽 → 跳过
			{ left: -50, top: -50, width: 4, height: 4 }, // 中心 (-48,-48) → 无页
		];
		const byPage = attributeBoxesToPages(boxes, (cx, cy) => {
			if (cx >= 0 && cy >= 0 && cx < 50) {
				return 1;
			}
			if (cx >= 50 && cy >= 0) {
				return 2;
			}
			return null; // 负坐标（中心点不落任何页）
		});
		expect(byPage.size).toBe(2);
		expect(byPage.get(1)).toEqual([boxes[0]]);
		expect(byPage.get(2)).toEqual([boxes[1]]);
	});
});
