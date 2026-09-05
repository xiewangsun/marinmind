import { describe, expect, it } from "vitest";
import { mergeTextOcclusions, snapOcclusionToLines } from "../../src/reader/occlusion-snap";
import type { DocRect } from "../../src/types";

/** 行矩形助手：高 0.02 的整行 */
function line(y: number, partial: Partial<DocRect> = {}): DocRect {
	return { x: 0.1, y, w: 0.8, h: 0.02, ...partial };
}

/** 逐字段断言（h 是两浮点相减有尾差，不用 toEqual 整体比） */
function expectRect(out: DocRect, want: { x: number; y: number; w: number; h: number }) {
	expect(out.x).toBeCloseTo(want.x, 10);
	expect(out.y).toBeCloseTo(want.y, 10);
	expect(out.w).toBeCloseTo(want.w, 10);
	expect(out.h).toBeCloseTo(want.h, 10);
}

describe("snapOcclusionToLines（71 遮挡行吸附）", () => {
	it("命中单行：垂直吸附为整行上下边，水平保持用户拖框", () => {
		const occ: DocRect = { x: 0.3, y: 0.201, w: 0.2, h: 0.018 };
		expectRect(snapOcclusionToLines(occ, [line(0.2)]), { x: 0.3, y: 0.2, w: 0.2, h: 0.02 });
	});

	it("命中多行：取并集上下边（跨行遮严）；行间空白一并吞入", () => {
		const occ: DocRect = { x: 0.3, y: 0.2, w: 0.2, h: 0.1 };
		expectRect(snapOcclusionToLines(occ, [line(0.2), line(0.24), line(0.28)]), {
			x: 0.3,
			y: 0.2,
			w: 0.2,
			h: 0.1, // (0.28+0.02) - 0.2
		});
	});

	it("阈值边缘：重叠恰 = 0.5×行高命中（≥ 语义），不足不命中（宁拒不赌）", () => {
		// 行 y=0.2 h=0.02，阈值 0.5 → 需重叠 ≥ 0.01
		const miss: DocRect = { x: 0.3, y: 0.218, w: 0.2, h: 0.005 }; // 重叠 0.002 < 0.01
		expect(snapOcclusionToLines(miss, [line(0.2)])).toEqual(miss);
		const edge: DocRect = { x: 0.3, y: 0.208, w: 0.2, h: 0.011 }; // 重叠 0.011 ≥ 0.01
		expectRect(snapOcclusionToLines(edge, [line(0.2)]), { x: 0.3, y: 0.2, w: 0.2, h: 0.02 });
	});

	it("无命中行：原样返回（不猜最近行）", () => {
		const occ: DocRect = { x: 0.3, y: 0.5, w: 0.2, h: 0.03 };
		expect(snapOcclusionToLines(occ, [line(0.2)])).toEqual(occ);
	});

	it("lines 为空原样返回；overlapThreshold 可调", () => {
		const occ: DocRect = { x: 0.3, y: 0.2, w: 0.2, h: 0.005 };
		expect(snapOcclusionToLines(occ, [])).toEqual(occ);
		// 自定义阈值 0.9：重叠 0.005 < 0.9×0.02=0.018 不命中
		expect(snapOcclusionToLines(occ, [line(0.2)], { overlapThreshold: 0.9 })).toEqual(occ);
		// 自定义阈值 0.1：命中
		expectRect(snapOcclusionToLines(occ, [line(0.2)], { overlapThreshold: 0.1 }), {
			x: 0.3,
			y: 0.2,
			w: 0.2,
			h: 0.02,
		});
	});

	it("返回新对象：不改入参（调用方 rect 直接入库安全）", () => {
		const occ: DocRect = { x: 0.3, y: 0.5, w: 0.2, h: 0.03 };
		const out = snapOcclusionToLines(occ, [line(0.2)]);
		expect(out).not.toBe(occ);
		expect(out).toEqual(occ);
	});
});

describe("mergeTextOcclusions（74 文字遮罩去重合并）", () => {
	it("容差内全等跳过：重复划选同段文字（亚像素测量抖动）不叠块", () => {
		const existing = [line(0.2)];
		// 四字段差均 ≤ 1e-3（x/w/y 各抖 5e-4）——同一行重划的典型测量误差
		const added = [line(0.2005, { x: 0.1005, w: 0.8005 })];
		expect(mergeTextOcclusions(existing, added)).toEqual([existing[0]]);
	});

	it("超容差视为不同块追加：既有在前、新增在后保持顺序", () => {
		const existing = [line(0.2)];
		const added = [line(0.24)]; // y 差 0.04 ≫ 1e-3
		const merged = mergeTextOcclusions(existing, added);
		expect(merged).toEqual([line(0.2), line(0.24)]);
		expect(merged[0]).toBe(existing[0]); // 既有块保持原引用（镜像 onOcclusionDraw 拼接语义）
	});

	it("added 内部重复也去重：同批两行完全一致只加一个", () => {
		const merged = mergeTextOcclusions([], [line(0.2), line(0.2)]);
		expect(merged).toEqual([line(0.2)]);
	});

	it("added 逐块比对既有全量：中间夹不同块时同段仍被识别为重复", () => {
		const existing = [line(0.2), line(0.24)];
		const added = [line(0.24)];
		expect(mergeTextOcclusions(existing, added)).toEqual([line(0.2), line(0.24)]);
	});

	it("追加块为浅克隆非同引用（入库后单删遮挡块不动划选产物）", () => {
		const added = [line(0.2)];
		const merged = mergeTextOcclusions([], added);
		expect(merged[0]).not.toBe(added[0]);
		expect(merged[0]).toEqual(added[0]);
	});

	it("空数组边界：existing 空透传追加；added 空返回等长既有", () => {
		expect(mergeTextOcclusions([], [line(0.2)])).toEqual([line(0.2)]);
		const existing = [line(0.2)];
		expect(mergeTextOcclusions(existing, [])).toEqual(existing);
	});
});
