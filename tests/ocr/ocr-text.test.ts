import { describe, expect, it } from "vitest";
import {
	joinRectTexts,
	normalizeOcrText,
	ocrFailNotice,
	ocrLinesFromBlocks,
	ocrStartNotice,
	pickOcrPsm,
} from "../../src/ocr/ocr-text";

describe("OCR 文本清洗 normalizeOcrText", () => {
	it("全角空格归一为半角并折叠行内连续空白", () => {
		expect(normalizeOcrText("机器　学习  算法\t\t导论")).toBe("机器 学习 算法 导论");
	});

	it("CRLF / CR 归一为 \\n", () => {
		expect(normalizeOcrText("第一行\r\n第二行\r第三行")).toBe("第一行\n第二行\n第三行");
	});

	it("每行 trim 并去掉空行（保留换行结构）", () => {
		expect(normalizeOcrText("  标题  \n\n\n  正文 \n \n")).toBe("标题\n正文");
	});

	it("null 安全由调用方保证：纯空白输入产出空串", () => {
		expect(normalizeOcrText("   \n　 \n")).toBe("");
	});
});

describe("OCR 多矩形拼接 joinRectTexts", () => {
	it("按顺序 \\n 连接，空段（含 null/undefined）丢弃", () => {
		expect(joinRectTexts(["标题", null, "", "正文一段", undefined, "正文二段"])).toBe(
			"标题\n正文一段\n正文二段",
		);
	});

	it("每段先经 normalize（全角空格/空白行清理后再拼接）", () => {
		expect(joinRectTexts(["  强化  学习 ", "　", "第二章　 简介"])).toBe(
			"强化 学习\n第二章 简介",
		);
	});

	it("全部为空产出空串（调用方以此判定未识别出）", () => {
		expect(joinRectTexts(["", null, "  \n　"])).toBe("");
	});
});

describe("PSM 启发式 pickOcrPsm（83）", () => {
	// 常用画布基准：2200px 宽离屏渲染（A4 纵向约 2200×3100）
	const W = 2200;
	const H = 3100;

	it("近整页大区域（归一化面积 ≥ 0.5）交给全自动版面分析（PSM 3）", () => {
		expect(pickOcrPsm({ x: 0, y: 0, w: 1, h: 0.6 }, W, H)).toBe("3");
		expect(pickOcrPsm({ x: 0.1, y: 0.1, w: 0.8, h: 0.8 }, W, H)).toBe("3");
	});

	it("扁长条（像素宽高比 ≥ 6）按单行识别（PSM 7）", () => {
		// 600px 宽 × 80px 高 = 7.5 倍
		expect(pickOcrPsm({ x: 0, y: 0, w: 600 / W, h: 80 / H }, W, H)).toBe("7");
	});

	it("小方块（像素宽高均 < 100）按单词识别（PSM 8）", () => {
		expect(pickOcrPsm({ x: 0, y: 0, w: 60 / W, h: 50 / H }, W, H)).toBe("8");
	});

	it("普通段落块走单一文本块（PSM 6）", () => {
		// 400×300px 的块：面积占比小、不扁、不小
		expect(pickOcrPsm({ x: 0, y: 0, w: 400 / W, h: 300 / H }, W, H)).toBe("6");
	});

	it("宽高比边界（5.9 归段落块、6.1 归单行）与画布尺寸异常回保守单块", () => {
		expect(pickOcrPsm({ x: 0, y: 0, w: 590 / W, h: 100 / H }, W, H)).toBe("6");
		expect(pickOcrPsm({ x: 0, y: 0, w: 610 / W, h: 100 / H }, W, H)).toBe("7");
		expect(pickOcrPsm({ x: 0, y: 0, w: 0.3, h: 0.2 }, 0, H)).toBe("6");
		expect(pickOcrPsm({ x: 0, y: 0, w: 0.3, h: 0.2 }, Number.NaN, H)).toBe("6");
	});
});

describe("整页行级解析 ocrLinesFromBlocks（83）", () => {
	/** 两块各两行的最小合法 blocks 结构 */
	const blocks = [
		{
			paragraphs: [
				{
					lines: [
						{ text: "第一章　导论", bbox: { x0: 100, y0: 200, x1: 800, y1: 240 } },
						{ text: "这是正文的第一行", bbox: { x0: 100, y0: 300, x1: 1800, y1: 340 } },
					],
				},
			],
		},
		{
			paragraphs: [
				{
					lines: [
						{ text: "  第二章  方法 ", bbox: { x0: 100, y0: 500, x1: 900, y1: 540 } },
						{ text: "   ", bbox: { x0: 0, y0: 600, x1: 100, y1: 640 } },
					],
				},
			],
		},
	];

	it("正常结构：逐行归一化矩形 + 文本清洗，空行丢弃，阅读序保持", () => {
		const lines = ocrLinesFromBlocks(blocks, 2200, 3100);
		expect(lines.map((l) => l.text)).toEqual(["第一章 导论", "这是正文的第一行", "第二章 方法"]);
		// 归一化矩形逐字段近似比较（浮点除法/减法顺序不保证逐位一致）
		expect(lines[0].rect.x).toBeCloseTo(100 / 2200);
		expect(lines[0].rect.y).toBeCloseTo(200 / 3100);
		expect(lines[0].rect.w).toBeCloseTo(700 / 2200);
		expect(lines[0].rect.h).toBeCloseTo(40 / 3100);
	});

	it("bbox 越界 / 负值 clamp 到 [0,1] 且退化矩形（宽高 ≤ 0）丢弃", () => {
		const clamped = ocrLinesFromBlocks(
			[
				{
					paragraphs: [
						{
							lines: [
								{ text: "越界行", bbox: { x0: -50, y0: -10, x1: 3000, y1: 4000 } },
								{ text: "退化行", bbox: { x0: 500, y0: 500, x1: 400, y1: 540 } },
							],
						},
					],
				},
			],
			2200,
			3100,
		);
		expect(clamped).toHaveLength(1);
		expect(clamped[0].rect).toEqual({ x: 0, y: 0, w: 1, h: 1 });
	});

	it("结构异常（非数组 / 缺 paragraphs / bbox 非数值）宁拒不赌返回 [] 或跳过", () => {
		expect(ocrLinesFromBlocks(null, 2200, 3100)).toEqual([]);
		expect(ocrLinesFromBlocks([], 2200, 3100)).toEqual([]);
		expect(ocrLinesFromBlocks([{}], 2200, 3100)).toEqual([]);
		expect(ocrLinesFromBlocks([{ paragraphs: [{}] }], 2200, 3100)).toEqual([]);
		const badBbox = ocrLinesFromBlocks(
			[{ paragraphs: [{ lines: [{ text: "坏框", bbox: { x0: "a", y0: 0, x1: 1, y1: 1 } }] }] }],
			2200,
			3100,
		);
		expect(badBbox).toEqual([]);
		// 画布尺寸非正：整体返回 []
		expect(ocrLinesFromBlocks(blocks, 0, 3100)).toEqual([]);
	});

	it("行文本含换行时折叠为空格（保证一行 = 一段文本 = 一个矩形）", () => {
		const folded = ocrLinesFromBlocks(
			[{ paragraphs: [{ lines: [{ text: "上半\n下半", bbox: { x0: 0, y0: 0, x1: 100, y1: 40 } }] }] }],
			2200,
			3100,
		);
		expect(folded).toHaveLength(1);
		expect(folded[0].text).toBe("上半 下半");
	});
});

// ---------- 85-C 提示文案（ocrStartNotice / ocrFailNotice） ----------

describe("ocrStartNotice（85-C 就绪态分流）", () => {
	it("未就绪附首次下载说明（region/page 两形态）", () => {
		expect(ocrStartNotice("region", false)).toBe(
			"正在识别文字…（首次使用需联网下载引擎与语言包，约 10-20MB）",
		);
		expect(ocrStartNotice("page", false)).toBe(
			"正在识别整页文字…（首次使用需联网下载引擎与语言包，约 10-20MB）",
		);
	});

	it("已就绪不再附下载说明（同会话二次调用秒加载）", () => {
		expect(ocrStartNotice("region", true)).toBe("正在识别文字…");
		expect(ocrStartNotice("page", true)).toBe("正在识别整页文字…");
	});
});

describe("ocrFailNotice（85-C 失败提示分流）", () => {
	it("未就绪失败提示检查网络（下载可能未完成）", () => {
		expect(ocrFailNotice(false)).toBe(
			"文字识别失败：引擎与语言包可能尚未下载完成，请检查网络后重试",
		);
	});

	it("已就绪失败给通用提示", () => {
		expect(ocrFailNotice(true)).toBe("文字识别失败，请稍后重试");
	});
});
