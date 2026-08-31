import { describe, expect, it } from "vitest";
import type { Card } from "../../src/types";
import {
	HIGHLIGHT_COLORS,
	highlightFallbackColor,
	highlightLineColor,
	isHighlightColor,
} from "../../src/reader/highlight-colors";

/** 测试用最小卡片（highlightFallbackColor 只读 color/excerptType） */
function cardOf(excerptType: Card["excerptType"], color: string | null): Card {
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
		title: null,
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
