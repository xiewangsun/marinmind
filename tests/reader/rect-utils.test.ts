import { describe, expect, it } from "vitest";
import {
	clampNormRect,
	isTinyNormRect,
	normRectToPercent,
	pointsToNormRect,
} from "../../src/reader/rect-utils";

describe("rect-utils 坐标换算", () => {
	it("正向拖拽：像素坐标 → 归一化矩形", () => {
		const r = pointsToNormRect(10, 20, 90, 60, 100, 100);
		expect(r).toEqual({ x: 0.1, y: 0.2, w: 0.8, h: 0.4 });
	});

	it("反向拖拽（从右下往左上）自动归一", () => {
		const r = pointsToNormRect(90, 60, 10, 20, 100, 100);
		expect(r).toEqual({ x: 0.1, y: 0.2, w: 0.8, h: 0.4 });
	});

	it("拖出页面边界的坐标钳制到 [0,1]", () => {
		const r = pointsToNormRect(-20, -10, 150, 120, 100, 100);
		expect(r).toEqual({ x: 0, y: 0, w: 1, h: 1 });
	});

	it("clampNormRect 保证矩形不越出页面", () => {
		const r = clampNormRect({ x: 0.8, y: 0.9, w: 0.5, h: 0.5 });
		expect(r.x).toBe(0.8);
		expect(r.y).toBe(0.9);
		expect(r.w).toBeCloseTo(0.2, 10); // 1 - 0.8 存在浮点误差，按精度断言
		expect(r.h).toBeCloseTo(0.1, 10);
	});

	it("归一化矩形 → 百分比定位", () => {
		expect(normRectToPercent({ x: 0.25, y: 0.5, w: 0.1, h: 0.2 })).toEqual({
			left: "25%",
			top: "50%",
			width: "10%",
			height: "20%",
		});
	});

	it("小于阈值的拖拽视为误触", () => {
		expect(isTinyNormRect({ x: 0, y: 0, w: 0.03, h: 0.03 }, 100, 100)).toBe(true);
		expect(isTinyNormRect({ x: 0, y: 0, w: 0.1, h: 0.1 }, 100, 100)).toBe(false);
		// 高阈值下 10px 也算误触（按显示像素判定，与缩放无关）
		expect(isTinyNormRect({ x: 0, y: 0, w: 0.1, h: 0.1 }, 100, 100, 20)).toBe(true);
	});
});
