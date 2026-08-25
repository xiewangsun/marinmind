import { describe, expect, it } from "vitest";
import { joinRectTexts, normalizeOcrText } from "../../src/ocr/ocr-text";

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
