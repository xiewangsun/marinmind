import { describe, expect, it } from "vitest";
import {
	detectBlocks,
	isDuplicateBlock,
	type AutoBlock,
	type LayoutItem,
} from "../../src/reader/auto-excerpt";

/** 快捷构造文本项（页 600×800，body 字号 10pt） */
function item(str: string, x: number, yTop: number, w: number, h = 10): LayoutItem {
	return { str, x, yTop, w, h };
}

describe("auto-excerpt.detectBlocks（AI 一键摘录版面块检测，㉓）", () => {
	it("同 y 带的 CJK 相邻项聚为一行且直连不加空格", () => {
		const blocks = detectBlocks(
			[item("知识", 100, 100, 44), item("卡片", 144, 100, 44)],
			600,
			800,
		);
		expect(blocks).toHaveLength(1);
		expect(blocks[0].text).toBe("知识卡片");
		expect(blocks[0].kind).toBe("body");
	});

	it("latin 词距补空格（间距 > 0.25×字号）", () => {
		const blocks = detectBlocks(
			[item("Hello", 100, 100, 30), item("world", 140, 100, 28)],
			600,
			800,
		);
		expect(blocks[0].text).toBe("Hello world");
	});

	it("y 微抖（±0.6×字号内）同属一行", () => {
		const blocks = detectBlocks(
			[item("基线", 100, 100, 44), item("微抖", 144, 101, 44)],
			600,
			800,
		);
		expect(blocks).toHaveLength(1);
		expect(blocks[0].text).toBe("基线微抖");
	});

	it("双栏同一水平线拆为两行两块（栏间距 > 20pt，水平无重叠）", () => {
		const left = [
			item("左栏第一", 60, 100, 88),
			item("左栏第二", 60, 112, 88),
		];
		const right = [
			item("右栏第一", 320, 100, 88),
			item("右栏第二", 320, 112, 88),
		];
		const blocks = detectBlocks([...left, ...right], 600, 800);
		expect(blocks).toHaveLength(2);
		expect(blocks[0].text).toContain("左栏");
		expect(blocks[1].text).toContain("右栏");
	});

	it("段内行距合块、段间距分块（gap > 0.75×行高）", () => {
		const lines = [
			item("第一段行一", 100, 100, 110),
			item("第一段行二", 100, 112, 110), // gap = 2 ≤ 7.5 同段
			item("第二段行一", 100, 130, 110), // gap = 130-122 = 8 > 7.5 新段
		];
		const blocks = detectBlocks(lines, 600, 800);
		expect(blocks).toHaveLength(2);
		expect(blocks[0].text).toBe("第一段行一\n第一段行二");
		expect(blocks[1].text).toBe("第二段行一");
	});

	it("大字号行识别为标题（≥ 1.18×正文中位字号）并独立成块", () => {
		const lines = [
			item("第二章 知识卡片", 100, 100, 120, 14), // 标题
			item("正文内容较长一些", 100, 122, 110, 10),
			item("正文继续下一行", 100, 134, 100, 10),
			item("再一行正文", 100, 146, 80, 10),
		];
		const blocks = detectBlocks(lines, 600, 800);
		expect(blocks).toHaveLength(2);
		expect(blocks[0].kind).toBe("heading");
		expect(blocks[0].text).toBe("第二章 知识卡片");
		expect(blocks[1].kind).toBe("body");
		// 行文本按 \n 拼接
		expect(blocks[1].text.split("\n")).toHaveLength(3);
	});

	it("页眉/页脚（上下 4.5% 带内）整行过滤", () => {
		const lines = [
			item("书眉标题", 100, 20, 100), // center 25 < 36 → 页眉
			item("正文行", 100, 100, 66),
			item("第 12 页", 280, 770, 44), // center 775 > 764 → 页脚
		];
		const blocks = detectBlocks(lines, 600, 800);
		expect(blocks).toHaveLength(1);
		expect(blocks[0].text).toBe("正文行");
	});

	it("矩形按页尺寸归一（逐行一条）", () => {
		const blocks = detectBlocks([item("文本", 120, 160, 88, 10)], 600, 800);
		expect(blocks[0].rects).toEqual([
			{ x: 120 / 600, y: 160 / 800, w: 88 / 600, h: 10 / 800 },
		]);
	});

	it("空输入 / 全空白项返回空数组", () => {
		expect(detectBlocks([], 600, 800)).toEqual([]);
		expect(
			detectBlocks([item("  ", 100, 100, 20), item("", 200, 100, 10)], 600, 800),
		).toEqual([]);
	});

	it("非法页尺寸返回空数组（防御）", () => {
		expect(detectBlocks([item("文本", 100, 100, 44)], 0, 800)).toEqual([]);
	});
});

describe("auto-excerpt ㉕ 增强（标题模式 / 段首缩进 / 断词 / 去重）", () => {
	it("编号章节模式（与正文同字号）独立成块并判为标题", () => {
		const lines = [
			item("1.2 知识卡片模型", 100, 100, 120),
			item("正文内容紧跟其后", 100, 112, 110),
			item("正文继续", 100, 124, 88),
		];
		const blocks = detectBlocks(lines, 600, 800);
		expect(blocks).toHaveLength(2);
		expect(blocks[0].kind).toBe("heading");
		expect(blocks[0].text).toBe("1.2 知识卡片模型");
		expect(blocks[1].kind).toBe("body");
		expect(blocks[1].text.split("\n")).toHaveLength(2);
	});

	it("编号正文行（句末标点收尾）不判标题，照常合块", () => {
		const lines = [
			item("1. 这是一个较长的编号正文行内容。", 100, 100, 200),
			item("2. 第二条编号正文行。", 100, 112, 150),
		];
		const blocks = detectBlocks(lines, 600, 800);
		expect(blocks).toHaveLength(1);
		expect(blocks[0].kind).toBe("body");
		expect(blocks[0].text).toContain("编号正文行内容");
	});

	it("全大写拉丁短行判标题", () => {
		const lines = [
			item("INTRODUCTION", 100, 100, 110),
			item("body text follows here", 100, 112, 130),
		];
		const blocks = detectBlocks(lines, 600, 800);
		expect(blocks).toHaveLength(2);
		expect(blocks[0].kind).toBe("heading");
		expect(blocks[0].text).toBe("INTRODUCTION");
	});

	it("居中短行判标题；图注（图 X-X 起头）不判", () => {
		const lines = [
			item("前言", 270, 200, 60), // center = 300 = 页宽中点
			item("图 3-1 系统架构", 250, 300, 100), // 居中但以"图"起头
			item("正文行内容", 100, 400, 110),
		];
		const blocks = detectBlocks(lines, 600, 800);
		expect(blocks).toHaveLength(3);
		expect(blocks[0].kind).toBe("heading");
		expect(blocks[1].kind).toBe("body");
	});

	it("段首缩进切分：缩进 ≥ 1.2×行高的行起新段（段尾短行后照样切分）", () => {
		const lines = [
			item("知识卡片第一段首行较长占满整行", 100, 100, 200),
			item("第一段第二行", 100, 112, 88), // 段尾短行（不顶右缘）
			item("第二段从两字符缩进处开始写起", 124, 124, 200), // 缩进 24pt > 12pt
			item("第二段第二行对齐缩进", 124, 136, 120),
		];
		const blocks = detectBlocks(lines, 600, 800);
		expect(blocks).toHaveLength(2);
		expect(blocks[0].text).toBe("知识卡片第一段首行较长占满整行\n第一段第二行");
		expect(blocks[1].text).toBe("第二段从两字符缩进处开始写起\n第二段第二行对齐缩进");
	});

	it("英文行尾断词合并（去掉连字符，不引入换行）", () => {
		const lines = [
			item("knowledge is pow-", 100, 100, 100),
			item("ered by cards", 100, 112, 80),
		];
		const blocks = detectBlocks(lines, 600, 800);
		expect(blocks).toHaveLength(1);
		expect(blocks[0].text).toBe("knowledge is powered by cards");
	});
});

describe("auto-excerpt.isDuplicateBlock（㉕ 重复执行去重）", () => {
	const block: AutoBlock = {
		kind: "body",
		text: "知识 卡片\n模型",
		rects: [{ x: 0.1, y: 0.1, w: 0.3, h: 0.05 }],
	};

	it("同页且空白折叠后文本一致 → 判重", () => {
		expect(
			isDuplicateBlock(block, 5, { page: 5, rects: [], excerptText: "知识卡片 模型" }),
		).toBe(true);
	});

	it("不同页 → 不判重（即使文本一致）", () => {
		expect(
			isDuplicateBlock(block, 6, { page: 5, rects: block.rects, excerptText: block.text }),
		).toBe(false);
	});

	it("同页文本不同但包围盒 IoU ≥ 0.55 → 判重", () => {
		expect(
			isDuplicateBlock(block, 5, {
				page: 5,
				rects: [{ x: 0.1, y: 0.1, w: 0.33, h: 0.05 }],
				excerptText: "完全不同的文字",
			}),
		).toBe(true);
	});

	it("同页文本不同且位置不重叠 → 不判重", () => {
		expect(
			isDuplicateBlock(block, 5, {
				page: 5,
				rects: [{ x: 0.6, y: 0.5, w: 0.2, h: 0.02 }],
				excerptText: "完全不同的文字",
			}),
		).toBe(false);
	});

	it("卡片无文本且无矩形（页码 null）→ 不判重", () => {
		expect(
			isDuplicateBlock(block, 5, { page: 5, rects: [], excerptText: null }),
		).toBe(false);
	});
});
