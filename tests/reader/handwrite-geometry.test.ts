import { describe, expect, it } from "vitest";
import {
	InkHistory,
	INK_HISTORY_LIMIT,
	eraseHitStrokeIndices,
	exportPixelSize,
	pressureWidthPx,
	strokesBBox,
} from "../../src/reader/handwrite-geometry";

describe("手写几何 strokesBBox", () => {
	it("取全部笔迹点的 min/max 并外加 padding", () => {
		const bbox = strokesBBox(
			[
				{
					points: [
						{ x: 0.2, y: 0.3 },
						{ x: 0.4, y: 0.3 },
					],
				},
				{
					points: [
						{ x: 0.3, y: 0.2 },
						{ x: 0.3, y: 0.5 },
					],
				},
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
		const bbox = strokesBBox(
			[
				{
					points: [
						{ x: 0, y: 0 },
						{ x: 1, y: 1 },
					],
				},
			],
			0.05,
			0.05,
		);
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

describe("手写导出 exportPixelSize", () => {
	it("bbox × 页基准尺寸 × 2 倍率", () => {
		const size = exportPixelSize({ x: 0, y: 0, w: 0.5, h: 0.25 }, { width: 600, height: 800 });
		expect(size).toEqual({ width: 600, height: 400 });
	});

	it("总像素超过 4M 时按面积比例钳制（宽高同缩）", () => {
		// 0.9 × 0.9 × 3000 × 2000 × 4 = 19.44M 像素，超限约 4.86 倍
		const size = exportPixelSize({ x: 0, y: 0, w: 0.9, h: 0.9 }, { width: 3000, height: 2000 });
		expect(size.width * size.height).toBeLessThanOrEqual(4 * 1024 * 1024 + 2); // 取整余量
		expect(size.width).toBeGreaterThan(1000);
		expect(size.height).toBeGreaterThan(700);
	});

	it("极小 bbox 至少 1×1 像素", () => {
		const size = exportPixelSize(
			{ x: 0.5, y: 0.5, w: 0.0001, h: 0.0001 },
			{ width: 600, height: 800 },
		);
		expect(size.width).toBeGreaterThanOrEqual(1);
		expect(size.height).toBeGreaterThanOrEqual(1);
	});
});

describe("84-A 压感线宽 pressureWidthPx", () => {
	it("鼠标 pressure=0.5 恰等于基准线宽（无笔设备观感零退化）", () => {
		expect(pressureWidthPx(0.5, 4)).toBe(4);
	});

	it("压感趋 0+ → 0.5×（极细）；压感 1 → 1.5×（极粗）", () => {
		expect(pressureWidthPx(0.001, 4)).toBeCloseTo(2.004, 3);
		expect(pressureWidthPx(1, 4)).toBe(6);
	});

	it("超界压感钳制到 [0.5, 1.5] 系数区间", () => {
		expect(pressureWidthPx(2, 4)).toBe(6); // > 1 钳到 1.5
		expect(pressureWidthPx(-0.4, 4)).toBe(4); // 负数 = 无数据哨兵 → 0.5 压感 → 基准宽
	});

	it("非法值（NaN / undefined）按 0.5 处理", () => {
		expect(pressureWidthPx(Number.NaN, 4)).toBe(4);
		expect(pressureWidthPx(undefined, 4)).toBe(4);
	});
});

describe("84-A 橡皮擦命中 eraseHitStrokeIndices", () => {
	// 页面 800×600：x 每归一化单位 800px，y 每单位 600px（异向比例）
	const pageW = 800;
	const pageH = 600;
	const strokes = [
		{
			points: [
				{ x: 0.1, y: 0.5 },
				{ x: 0.3, y: 0.5 },
			],
		}, // 水平笔画（像素 y=300）
		{
			points: [
				{ x: 0.5, y: 0.2 },
				{ x: 0.5, y: 0.8 },
			],
		}, // 垂直笔画（像素 x=400）
	];

	it("点在线段上命中（距离 0 ≤ 半径）", () => {
		expect(eraseHitStrokeIndices(strokes, { x: 0.2, y: 0.5 }, 12, pageW, pageH)).toEqual([0]);
		expect(eraseHitStrokeIndices(strokes, { x: 0.5, y: 0.5 }, 12, pageW, pageH)).toEqual([1]);
	});

	it("点在延长线外按最近端点距离判定", () => {
		// x=0.35 在第一笔 (0.1..0.3) 延长线上：最近点为端点 0.3×800=240px（差 40px > 半径 12，不命中）
		expect(eraseHitStrokeIndices(strokes, { x: 0.35, y: 0.5 }, 12, pageW, pageH)).toEqual([]);
		// x=0.3125 → 250px，距端点 10px ≤ 12 命中
		expect(eraseHitStrokeIndices(strokes, { x: 0.3125, y: 0.5 }, 12, pageW, pageH)).toEqual([
			0,
		]);
	});

	it("半径边界：距离恰等于 radiusPx 命中", () => {
		// 垂直笔画 x=400（0.5×800），点 x=412 → 距离 12
		expect(eraseHitStrokeIndices(strokes, { x: 412 / 800, y: 0.5 }, 12, pageW, pageH)).toEqual([
			1,
		]);
		expect(eraseHitStrokeIndices(strokes, { x: 413 / 800, y: 0.5 }, 12, pageW, pageH)).toEqual(
			[],
		);
	});

	it("多笔画只删命中笔（互不牵连）", () => {
		const both = eraseHitStrokeIndices(
			[
				...strokes,
				{
					points: [
						{ x: 0.1, y: 0.5 },
						{ x: 0.3, y: 0.5 },
					],
				},
			],
			{ x: 0.2, y: 0.5 },
			12,
			pageW,
			pageH,
		);
		expect(both).toEqual([0, 2]); // 第一、三笔同为该水平线；第二笔垂直不相交
	});

	it("pageW≠pageH 时归一化坐标按各向像素换算（异向比例正确）", () => {
		// 点 (0.5, 0.55) 与水平笔画线 y=0.5 的像素距离 = 0.05×600 = 30px > 12 不命中；
		// 若错误地用 pageW 换算则 = 40px（同样不命中）——构造反向用例：x 偏移 0.02
		// 用 pageW 是 16px 命中、用 pageH 是 12px 恰命中，两者区分
		expect(eraseHitStrokeIndices(strokes, { x: 0.52, y: 0.2 }, 16, pageW, pageH)).toEqual([1]); // 0.02×800=16
		expect(eraseHitStrokeIndices(strokes, { x: 0.52, y: 0.2 }, 15, pageW, pageH)).toEqual([]);
	});

	it("空笔画不参与命中；单点笔画按点距离判定", () => {
		expect(
			eraseHitStrokeIndices([{ points: [] }], { x: 0.5, y: 0.5 }, 12, pageW, pageH),
		).toEqual([]);
		expect(
			eraseHitStrokeIndices(
				[{ points: [{ x: 0.5, y: 0.5 }] }],
				{ x: 0.5, y: 0.5 },
				12,
				pageW,
				pageH,
			),
		).toEqual([0]);
	});
});

describe("84-A 手写撤销栈 InkHistory", () => {
	it("LIFO：draw → erase → clear 依次 pop 逆序返回", () => {
		const history = new InkHistory();
		const stroke = { points: [{ x: 0.5, y: 0.5 }] };
		history.push({ kind: "draw", stroke });
		history.push({ kind: "erase", index: 0, stroke });
		history.push({ kind: "clear", strokes: [stroke] });
		expect(history.pop()?.kind).toBe("clear");
		expect(history.pop()?.kind).toBe("erase");
		expect(history.pop()?.kind).toBe("draw");
		expect(history.pop()).toBeNull();
		expect(history.canUndo()).toBe(false);
	});

	it("深度上限：超出 INK_HISTORY_LIMIT 丢最旧", () => {
		const history = new InkHistory();
		const stroke = { points: [{ x: 0, y: 0 }] };
		for (let i = 0; i < INK_HISTORY_LIMIT + 5; i++) {
			history.push({ kind: "draw", stroke });
		}
		let count = 0;
		while (history.pop()) {
			count++;
		}
		expect(count).toBe(INK_HISTORY_LIMIT);
	});

	it("clear 整体作废（提交落卡后调用）", () => {
		const history = new InkHistory();
		history.push({ kind: "draw", stroke: { points: [{ x: 0, y: 0 }] } });
		history.clear();
		expect(history.pop()).toBeNull();
		expect(history.canUndo()).toBe(false);
	});
});
