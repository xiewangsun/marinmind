import { describe, expect, it } from "vitest";
import { pngPixelSize, strokesBBox } from "../../src/reader/handwrite-geometry";

describe("手写几何 strokesBBox", () => {
	it("取全部笔迹点的 min/max 并外加 padding", () => {
		const bbox = strokesBBox(
			[
				{ points: [{ x: 0.2, y: 0.3 }, { x: 0.4, y: 0.3 }] },
				{ points: [{ x: 0.3, y: 0.2 }, { x: 0.3, y: 0.5 }] },
			],
			0.01,
			0.02,
		);
		expect(bbox).not.toBeNull();
		expect(bbox!.x).toBeCloseTo(0.19);
		expect(bbox!.y).toBeCloseTo(0.18);
		expect(bbox!.w).toBeCloseTo(0.22);
		expect(bbox!.h).toBeCloseTo(0.34);
	});

	it("结果 clamp 到 [0,1]：贴边笔迹不越界", () => {
		const bbox = strokesBBox([{ points: [{ x: 0, y: 0 }, { x: 1, y: 1 }] }], 0.05, 0.05);
		expect(bbox).toEqual({ x: 0, y: 0, w: 1, h: 1 });
	});

	it("空笔迹 / 空点序列返回 null", () => {
		expect(strokesBBox([], 0.01, 0.01)).toBeNull();
		expect(strokesBBox([{ points: [] }], 0.01, 0.01)).toBeNull();
	});

	it("单点笔迹也产生有效包围盒（点画不丢）", () => {
		const bbox = strokesBBox([{ points: [{ x: 0.5, y: 0.5 }] }], 0.01, 0.01);
		expect(bbox).not.toBeNull();
		expect(bbox!.x).toBeCloseTo(0.49);
		expect(bbox!.y).toBeCloseTo(0.49);
		expect(bbox!.w).toBeCloseTo(0.02);
		expect(bbox!.h).toBeCloseTo(0.02);
	});
});

describe("手写导出 pngPixelSize", () => {
	it("bbox × 页基准尺寸 × 2 倍率", () => {
		const size = pngPixelSize({ x: 0, y: 0, w: 0.5, h: 0.25 }, { width: 600, height: 800 });
		expect(size).toEqual({ width: 600, height: 400 });
	});

	it("总像素超过 4M 时按面积比例钳制（宽高同缩）", () => {
		// 0.9 × 0.9 × 3000 × 2000 × 4 = 19.44M 像素，超限约 4.86 倍
		const size = pngPixelSize({ x: 0, y: 0, w: 0.9, h: 0.9 }, { width: 3000, height: 2000 });
		expect(size.width * size.height).toBeLessThanOrEqual(4 * 1024 * 1024 + 2); // 取整余量
		expect(size.width).toBeGreaterThan(1000);
		expect(size.height).toBeGreaterThan(700);
	});

	it("极小 bbox 至少 1×1 像素", () => {
		const size = pngPixelSize({ x: 0.5, y: 0.5, w: 0.0001, h: 0.0001 }, { width: 600, height: 800 });
		expect(size.width).toBeGreaterThanOrEqual(1);
		expect(size.height).toBeGreaterThanOrEqual(1);
	});
});
