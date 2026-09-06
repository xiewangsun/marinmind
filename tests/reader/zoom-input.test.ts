import { describe, expect, it } from "vitest";
import { parseZoomInput } from "../../src/reader/zoom-input";

/** 缩放比例输入解析（104-A）：格式归一 + 非法输入判 null（钳制在 setZoom 不在此） */
describe("parseZoomInput", () => {
	it("纯数字按百分比折算", () => {
		expect(parseZoomInput("150")).toBe(1.5);
		expect(parseZoomInput("100")).toBe(1);
		expect(parseZoomInput("20")).toBe(0.2);
		expect(parseZoomInput("62.5")).toBeCloseTo(0.625, 10);
	});

	it("尾缀半角/全角百分号均可", () => {
		expect(parseZoomInput("150%")).toBe(1.5);
		expect(parseZoomInput("62.5％")).toBeCloseTo(0.625, 10);
		// 连续多个百分号也容错（误按）
		expect(parseZoomInput("150%%")).toBe(1.5);
	});

	it("前后空白自动 trim", () => {
		expect(parseZoomInput("  150 ")).toBe(1.5);
		expect(parseZoomInput("\t150%\n")).toBe(1.5);
	});

	it("非法输入返回 null", () => {
		expect(parseZoomInput("")).toBeNull();
		expect(parseZoomInput("   ")).toBeNull();
		expect(parseZoomInput("%")).toBeNull();
		expect(parseZoomInput("abc")).toBeNull();
		expect(parseZoomInput("1.5x")).toBeNull();
		expect(parseZoomInput("-")).toBeNull();
		expect(parseZoomInput("15%0")).toBeNull();
	});
});
