import { describe, expect, it } from "vitest";
import type { Card } from "../../src/types";
import {
	HIGHLIGHT_COLORS,
	highlightFallbackColor,
	highlightLineColor,
	highlightLineStyle,
	isHighlightColor,
	LINE_STYLE_ICONS,
} from "../../src/reader/highlight-colors";
import { isLineStyle, LINE_STYLES, LINE_STYLE_LABELS, type LineStyle } from "../../src/types";

/** 测试用最小卡片（highlightFallbackColor/highlightLineStyle 只读 color/lineStyle/excerptType） */
function cardOf(
	excerptType: Card["excerptType"],
	color: string | null,
	lineStyle: LineStyle | null = null,
): Card {
	return {
		id: "c1",
		documentId: "d1",
		page: 1,
		rects: [],
		polygon: null,
		excerptType,
		excerptText: null,
		excerptRef: null,
		note: null,
		color,
		lineStyle,
		title: null,
		deck: null,
		occlusions: [],
		tags: [],
		createdAt: 0,
		updatedAt: 0,
	} as Card;
}

describe("高亮颜色体系（㊹ MN3 四色化）", () => {
	it("四色且 value 唯一（顺序即色板与工具按钮循环序）", () => {
		expect(HIGHLIGHT_COLORS).toHaveLength(4);
		const values = HIGHLIGHT_COLORS.map((c) => c.value);
		expect(new Set(values).size).toBe(4);
		expect(values).toEqual(["yellow", "green", "blue", "red"]);
	});

	it("label/swatch/line 非空（色板弹窗与 canvas 描边可用性）", () => {
		for (const def of HIGHLIGHT_COLORS) {
			expect(def.label.length).toBeGreaterThan(0);
			expect(def.swatch.startsWith("#")).toBe(true);
			expect(def.line.startsWith("#")).toBe(true);
		}
	});

	it("isHighlightColor：四色为真，旧色相与未知值为假（新建卡只落四色）", () => {
		expect(isHighlightColor("yellow")).toBe(true);
		expect(isHighlightColor("green")).toBe(true);
		expect(isHighlightColor("blue")).toBe(true);
		expect(isHighlightColor("red")).toBe(true);
		expect(isHighlightColor("teal")).toBe(false);
		expect(isHighlightColor("purple")).toBe(false);
		expect(isHighlightColor("magenta")).toBe(false);
		expect(isHighlightColor("")).toBe(false);
	});

	it("highlightFallbackColor：card.color 优先直返", () => {
		expect(highlightFallbackColor(cardOf("text", "blue"))).toBe("blue");
		expect(highlightFallbackColor(cardOf("area", "teal"))).toBe("teal");
	});

	it("highlightFallbackColor：无色按形态回退（手写绿/照片语音红/其余黄）", () => {
		expect(highlightFallbackColor(cardOf("handwriting", null))).toBe("green");
		expect(highlightFallbackColor(cardOf("photo", null))).toBe("red");
		expect(highlightFallbackColor(cardOf("audio", null))).toBe("red");
		expect(highlightFallbackColor(cardOf("text", null))).toBe("yellow");
		expect(highlightFallbackColor(cardOf("area", null))).toBe("yellow");
		expect(highlightFallbackColor(cardOf("lasso", null))).toBe("yellow");
		expect(highlightFallbackColor(cardOf("blank", null))).toBe("yellow");
	});

	it("highlightLineColor：四色取 line 字段，存量旧色相保持原色相，未知回黄", () => {
		expect(highlightLineColor("yellow")).toBe("#d9a916");
		expect(highlightLineColor("blue")).toBe("#4a90d9");
		expect(highlightLineColor("teal")).toBe("#14b8a6");
		expect(highlightLineColor("pink")).toBe("#d96a9c");
		expect(highlightLineColor("unknown")).toBe("#d9a916");
	});
});

describe("文字摘录线型（77 下划线/波浪线/删除线）", () => {
	it("LINE_STYLES 三值且顺序固定（下划线在前=默认值位）", () => {
		expect(LINE_STYLES).toEqual(["underline", "squiggle", "strikethrough"]);
	});

	it("isLineStyle：三值为真，未知/空/非字符串为假（解析层守卫）", () => {
		expect(isLineStyle("underline")).toBe(true);
		expect(isLineStyle("squiggle")).toBe(true);
		expect(isLineStyle("strikethrough")).toBe(true);
		expect(isLineStyle("wavy")).toBe(false);
		expect(isLineStyle("")).toBe(false);
		expect(isLineStyle(123)).toBe(false);
		expect(isLineStyle(null)).toBe(false);
	});

	it("highlightLineStyle：squiggle/strikethrough 直返，null 回退下划线", () => {
		expect(highlightLineStyle(cardOf("text", null, "squiggle"))).toBe("squiggle");
		expect(highlightLineStyle(cardOf("text", null, "strikethrough"))).toBe("strikethrough");
		expect(highlightLineStyle(cardOf("text", null))).toBe("underline");
	});

	it("LINE_STYLE_LABELS 三键非空（菜单/Notice 文案可用性）", () => {
		for (const style of LINE_STYLES) {
			expect(LINE_STYLE_LABELS[style].length).toBeGreaterThan(0);
		}
	});

	it("LINE_STYLE_ICONS 三键非空（工具栏钮与菜单条目共用，均经 asar 验证）", () => {
		expect(LINE_STYLE_ICONS.underline).toBe("underline");
		expect(LINE_STYLE_ICONS.squiggle).toBe("waves");
		expect(LINE_STYLE_ICONS.strikethrough).toBe("strikethrough");
	});
});
