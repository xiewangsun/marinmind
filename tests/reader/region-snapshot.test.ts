import { describe, expect, it } from "vitest";
import { pixelPoints, pixelRect } from "../../src/reader/region-snapshot";

describe("pixelRect 归一化矩形 → 画布像素矩形", () => {
	it("基础映射：按画布尺寸等比放大", () => {
		expect(pixelRect({ x: 0.1, y: 0.2, w: 0.5, h: 0.25 }, 1000, 2000)).toEqual({
			sx: 100,
			sy: 400,
			sw: 500,
			sh: 500,
		});
	});

	it("越界 clamp：负坐标与超边界收进画布", () => {
		expect(pixelRect({ x: -0.2, y: 0.5, w: 1.5, h: 0.1 }, 400, 800)).toEqual({
			sx: 0,
			sy: 400,
			sw: 400,
			sh: 80,
		});
	});

	it("零宽/零高矩形至少 1px（防空裁剪）", () => {
		const r = pixelRect({ x: 0.5, y: 0.5, w: 0, h: 0 }, 1000, 1000);
		expect(r.sw).toBe(1);
		expect(r.sh).toBe(1);
	});

	it("完全在画布外：退化到边缘 1px", () => {
		const r = pixelRect({ x: 1.5, y: -0.5, w: 0.2, h: 0.2 }, 1000, 1000);
		expect(r.sx).toBe(1000);
		expect(r.sw).toBe(1);
		expect(r.sy).toBe(0);
	});

	it("canvas 内部像素含 dpr：归一化坐标与显示缩放无关", () => {
		// 同一归一化矩形在 dpr=2 的画布（内部像素翻倍）上映射出的窗口覆盖同一内容
		const css = pixelRect({ x: 0.25, y: 0.25, w: 0.5, h: 0.5 }, 800, 600);
		const dpr = pixelRect({ x: 0.25, y: 0.25, w: 0.5, h: 0.5 }, 1600, 1200);
		expect(dpr.sx).toBe(css.sx * 2);
		expect(dpr.sw).toBe(css.sw * 2);
	});
});

describe("pixelPoints 归一化多边形 → 画布像素顶点", () => {
	it("逐顶点等比映射", () => {
		const pts = pixelPoints(
			[
				{ x: 0, y: 0 },
				{ x: 0.5, y: 0.25 },
				{ x: 1, y: 1 },
			],
			400,
			200,
		);
		expect(pts).toEqual([
			{ x: 0, y: 0 },
			{ x: 200, y: 50 },
			{ x: 400, y: 200 },
		]);
	});

	it("空多边形返回空数组", () => {
		expect(pixelPoints([], 100, 100)).toEqual([]);
	});
});
