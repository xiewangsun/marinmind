import { describe, expect, it } from "vitest";
import {
	clampNormRect,
	excerptCropRect,
	isTinyNormRect,
	jumpAnchorY,
	normRectToPercent,
	occlusionBounds,
	occlusionPercent,
	planSelectionToolbarPosition,
	pointsToNormRect,
	rectsRelativeToPage,
	snapshotImgSize,
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

	it("选区行矩形（视口坐标）→ 相对页面的归一化矩形", () => {
		const page = { left: 100, top: 200, width: 400, height: 800 };
		const rects = [
			{ left: 120, top: 300, width: 200, height: 20 },
			{ left: 100, top: 330, width: 360, height: 20 },
		];
		const [a, b] = rectsRelativeToPage(rects, page);
		expect(a).toEqual({ x: 0.05, y: 0.125, w: 0.5, h: 0.025 });
		expect(b).toEqual({ x: 0, y: 0.1625, w: 0.9, h: 0.025 });
	});

	it("越出页面边界的选区矩形被钳制", () => {
		const page = { left: 0, top: 0, width: 100, height: 100 };
		const [r] = rectsRelativeToPage([{ left: -10, top: -5, width: 130, height: 10 }], page);
		expect(r).toEqual({ x: 0, y: 0, w: 1, h: 0.1 });
	});
});

describe("跳转定位锚点 jumpAnchorY", () => {
	it("空矩形列表返回 null（photo/audio 卡降级只滚到页）", () => {
		expect(jumpAnchorY([])).toBeNull();
	});

	it("单矩形取其 y", () => {
		expect(jumpAnchorY([{ x: 0.1, y: 0.4, w: 0.3, h: 0.1 }])).toBe(0.4);
	});

	it("多矩形取最上沿（min y）——文字摘录多行场景", () => {
		expect(
			jumpAnchorY([
				{ x: 0.1, y: 0.6, w: 0.5, h: 0.05 },
				{ x: 0.1, y: 0.2, w: 0.5, h: 0.05 },
				{ x: 0.1, y: 0.4, w: 0.5, h: 0.05 },
			]),
		).toBe(0.2);
	});
});

describe("摘录预览裁剪窗口 excerptCropRect（㊶）", () => {
	it("多矩形并集包围盒 + 余量（文字摘录多行场景）", () => {
		const r = excerptCropRect([
			{ x: 0.1, y: 0.2, w: 0.5, h: 0.03 },
			{ x: 0.1, y: 0.3, w: 0.4, h: 0.03 },
		]);
		// 并集 (0.1, 0.2)-(0.6, 0.33)；mx = 0.5*0.08 = 0.04，my = 0.13*0.4 = 0.052
		expect(r.x).toBeCloseTo(0.06, 10);
		expect(r.y).toBeCloseTo(0.148, 10);
		expect(r.w).toBeCloseTo(0.58, 10);
		expect(r.h).toBeCloseTo(0.234, 10);
	});

	it("极小摘录（留白 6×6 锚点）扩到最小窗口且围绕中心", () => {
		const r = excerptCropRect([{ x: 0.5, y: 0.5, w: 0.006, h: 0.006 }]);
		// 余量触底 0.008/0.012 后仍小于最小窗口 → 围绕中心扩到 0.22×0.08
		expect(r.x).toBeCloseTo(0.503 - 0.11, 10);
		expect(r.y).toBeCloseTo(0.503 - 0.04, 10);
		expect(r.w).toBeCloseTo(0.22, 10);
		expect(r.h).toBeCloseTo(0.08, 10);
	});

	it("近页边摘录中心扩展越界被钳制（右缘贴齐）", () => {
		const r = excerptCropRect([{ x: 0.95, y: 0.1, w: 0.04, h: 0.03 }]);
		// 中心扩展后 x = 0.86，w 0.22 越出右缘 → 钳到 x + w = 1
		expect(r.x).toBeCloseTo(0.86, 10);
		expect(r.w).toBeCloseTo(0.14, 10);
	});

	it("空矩形列表返回整页（防御路径，调用方不应到达）", () => {
		expect(excerptCropRect([])).toEqual({ x: 0, y: 0, w: 1, h: 1 });
	});
});

describe("110 area/lasso 参照文字摘录裁剪范围（context 档）", () => {
	it("小区域：页比例余量 + 文字量级最小窗口（不再紧贴包围盒裁成小 zoom 图）", () => {
		const r = excerptCropRect([{ x: 0.3, y: 0.4, w: 0.2, h: 0.12 }], { context: true });
		// mx=max(0.016,0.1)=0.1 → cw=0.4<0.55 → 围绕中心 0.4 扩到 0.55；
		// my=max(0.048,0.05)=0.05 → ch=0.22≥0.18 不再扩
		expect(r.x).toBeCloseTo(0.125, 10);
		expect(r.y).toBeCloseTo(0.35, 10);
		expect(r.w).toBeCloseTo(0.55, 10);
		expect(r.h).toBeCloseTo(0.22, 10);
	});

	it("极小摘录（留白级锚点）同款下限：中心扩到 0.55×0.18", () => {
		const r = excerptCropRect([{ x: 0.5, y: 0.5, w: 0.006, h: 0.006 }], { context: true });
		// 余量触 0.1/0.05 底 → cw=0.206<0.55、ch=0.106<0.18 → 双向中心扩展
		expect(r.x).toBeCloseTo(0.503 - 0.275, 10);
		expect(r.y).toBeCloseTo(0.503 - 0.09, 10);
		expect(r.w).toBeCloseTo(0.55, 10);
		expect(r.h).toBeCloseTo(0.18, 10);
	});

	it("大区域：比例余量主导（40% 垂直规则），context 档不缩小既有窗口", () => {
		const r = excerptCropRect([{ x: 0.15, y: 0.1, w: 0.6, h: 0.5 }], { context: true });
		// mx=max(0.048,0.1)=0.1 → cw=0.8；my=max(0.2,0.05)=0.2 → ch=0.9（越顶钳 0）
		expect(r.x).toBeCloseTo(0.05, 10);
		expect(r.y).toBeCloseTo(0, 10);
		expect(r.w).toBeCloseTo(0.8, 10);
		expect(r.h).toBeCloseTo(0.9, 10);
	});

	it("不传 context（text/blank 主路径）窗口量纲与现状一致——110 零回归", () => {
		const r = excerptCropRect([{ x: 0.3, y: 0.4, w: 0.2, h: 0.12 }]);
		// mx=max(0.016,0.008)=0.016、my=max(0.048,0.012)=0.048 → 0.232×0.216
		expect(r.w).toBeCloseTo(0.232, 10);
		expect(r.h).toBeCloseTo(0.216, 10);
	});
});

describe("遮挡摆位 occlusionPercent / occlusionBounds（㊷）", () => {
	// 视觉窗口：页 (0.1,0.2)-(0.5,0.4)（0.4×0.2）
	const bounds = { x: 0.1, y: 0.2, w: 0.4, h: 0.2 };
	// 百分比字符串含浮点尾差（0.2-0.1 等），按数值精度断言
	const pct = (v: string) => Number.parseFloat(v);

	it("窗口内的遮挡按窗口内相对位置换算百分比", () => {
		const r = occlusionPercent({ x: 0.2, y: 0.25, w: 0.1, h: 0.05 }, bounds);
		expect(pct(r.left)).toBeCloseTo(25, 6);
		expect(pct(r.top)).toBeCloseTo(25, 6);
		expect(pct(r.width)).toBeCloseTo(25, 6);
		expect(pct(r.height)).toBeCloseTo(25, 6);
	});

	it("跨出窗口的遮挡按窗口边缘钳制（页裁剪窗口小于遮挡的余量场景）", () => {
		// 遮挡 (0.05,0.18)-(0.35,0.35) 与窗口交集 = (0.1,0.2)-(0.35,0.35) → 0.25×0.15
		const r = occlusionPercent({ x: 0.05, y: 0.18, w: 0.3, h: 0.17 }, bounds);
		expect(pct(r.left)).toBeCloseTo(0, 6);
		expect(pct(r.top)).toBeCloseTo(0, 6);
		expect(pct(r.width)).toBeCloseTo(62.5, 6);
		expect(pct(r.height)).toBeCloseTo(75, 6);
	});

	it("完全在窗口外的遮挡退化为零尺寸（CSS 上不可见）", () => {
		const r = occlusionPercent({ x: 0.7, y: 0.7, w: 0.2, h: 0.2 }, bounds);
		expect(pct(r.width)).toBeCloseTo(0, 6);
		expect(pct(r.height)).toBeCloseTo(0, 6);
	});

	it("occlusionBounds：有 excerptRef 的卡取 rects 并集包围盒（快照图边界）", () => {
		const b = occlusionBounds({
			excerptRef: "assets/area1.png",
			rects: [
				{ x: 0.2, y: 0.3, w: 0.1, h: 0.05 },
				{ x: 0.25, y: 0.4, w: 0.2, h: 0.05 },
			],
		});
		// 并集 (0.2, 0.3)-(0.45, 0.45)
		expect(b.x).toBeCloseTo(0.2, 6);
		expect(b.y).toBeCloseTo(0.3, 6);
		expect(b.w).toBeCloseTo(0.25, 6);
		expect(b.h).toBeCloseTo(0.15, 6);
	});

	it("occlusionBounds：无 excerptRef（text/blank 走页裁剪）取 excerptCropRect 窗口", () => {
		const rects = [{ x: 0.5, y: 0.5, w: 0.006, h: 0.006 }];
		const b = occlusionBounds({ excerptRef: null, rects });
		expect(b.x).toBeCloseTo(excerptCropRect(rects).x, 10);
		expect(b.w).toBeCloseTo(excerptCropRect(rects).w, 10);
	});

	it("71 钉住：photo 卡（excerptRef + rects 空）bounds 恒整图 {0,0,1,1}——预览弹窗编辑的遮挡在复习端天然对位", () => {
		const b = occlusionBounds({ excerptRef: "assets/photo1.jpg", rects: [] });
		expect(b).toEqual({ x: 0, y: 0, w: 1, h: 1 });
		// 图内 0-1 遮挡直通百分比（photo 遮挡的渲染数学基础）
		const r = occlusionPercent({ x: 0.25, y: 0.25, w: 0.5, h: 0.5 }, b);
		expect(pct(r.left)).toBeCloseTo(25, 6);
		expect(pct(r.width)).toBeCloseTo(50, 6);
	});

	it("84-D 定位后的 photo 卡（rects=展示框非空）仍恒整图——展示框不参与遮挡摆位", () => {
		const b = occlusionBounds({
			excerptRef: "assets/photo2.jpg",
			rects: [{ x: 0.3, y: 0.4, w: 0.2, h: 0.1 }],
			excerptType: "photo",
		});
		expect(b).toEqual({ x: 0, y: 0, w: 1, h: 1 });
	});
});

describe("划选工具栏定位 planSelectionToolbarPosition（75）", () => {
	it("常规场景：选区上方优先 + 水平以选区中心对齐", () => {
		const pos = planSelectionToolbarPosition({
			anchor: { left: 300, top: 200, right: 500, bottom: 240 },
			container: { left: 0, top: 0, width: 800, height: 600 },
			toolbarWidth: 200,
			toolbarHeight: 40,
		});
		// 水平：中心 400 − 半宽 100 = 300；垂直：200 − 40 − 8 = 152
		expect(pos).toEqual({ left: 300, top: 152 });
	});

	it("输出为容器本地坐标（非零容器原点已减除）+ 左缘钳制", () => {
		const pos = planSelectionToolbarPosition({
			// 选区中心 125 距容器左缘（100）仅 25px，居中后越出左缘 → 钳到 left+4
			anchor: { left: 90, top: 200, right: 160, bottom: 240 },
			container: { left: 100, top: 50, width: 800, height: 600 },
			toolbarWidth: 200,
			toolbarHeight: 40,
		});
		expect(pos).toEqual({ left: 4, top: 102 }); // 152 − 50（垂直上方正常）
	});

	it("右缘钳制：选区靠容器右缘居中后不溢出", () => {
		const pos = planSelectionToolbarPosition({
			anchor: { left: 700, top: 100, right: 790, bottom: 140 },
			container: { left: 0, top: 0, width: 800, height: 600 },
			toolbarWidth: 200,
			toolbarHeight: 40,
		});
		// 中心 745 − 100 = 645 > 800 − 200 − 4 = 596 → 钳到 596
		expect(pos).toEqual({ left: 596, top: 52 });
	});

	it("上方空间不足（选区贴近容器顶）回退到选区下方", () => {
		const pos = planSelectionToolbarPosition({
			anchor: { left: 300, top: 20, right: 500, bottom: 60 },
			container: { left: 0, top: 0, width: 800, height: 600 },
			toolbarWidth: 200,
			toolbarHeight: 40,
		});
		// 20 − 48 = −28 < 4 → 回退 60 + 8 = 68
		expect(pos).toEqual({ left: 300, top: 68 });
	});

	it("下方方案溢出容器底时纵向整体钳入（贴底选区）", () => {
		const pos = planSelectionToolbarPosition({
			anchor: { left: 300, top: 20, right: 500, bottom: 280 },
			container: { left: 0, top: 0, width: 800, height: 300 },
			toolbarWidth: 200,
			toolbarHeight: 40,
		});
		// 上方不足 → 下方 288，maxTop = 300 − 40 − 4 = 256 → 钳入
		expect(pos).toEqual({ left: 300, top: 256 });
	});

	it("容器比工具栏还窄（极端窗格）：左对齐不溢出右缘", () => {
		const pos = planSelectionToolbarPosition({
			anchor: { left: 30, top: 200, right: 90, bottom: 240 },
			container: { left: 0, top: 0, width: 120, height: 600 },
			toolbarWidth: 200,
			toolbarHeight: 40,
		});
		expect(pos).toEqual({ left: 4, top: 152 });
	});
});

describe("snapshotImgSize 快照图预留尺寸（R3 W-02：按包围盒取比防 CLS）", () => {
	it("rects 并集包围盒比例：等比缩放到 400 基宽", () => {
		// 两块矩形并集：x 0.1-0.5（w 0.4）、y 0.2-0.6（h 0.4）→ 1:1
		const size = snapshotImgSize({
			rects: [
				{ x: 0.1, y: 0.2, w: 0.2, h: 0.2 },
				{ x: 0.3, y: 0.4, w: 0.2, h: 0.2 },
			],
			excerptType: "area",
		});
		expect(size).toEqual({ width: 400, height: 400 });
	});

	it("宽扁包围盒：高度按比例折算且至少 1px", () => {
		const size = snapshotImgSize({
			rects: [{ x: 0, y: 0.4, w: 1, h: 0.01 }],
			excerptType: "lasso",
		});
		expect(size.width).toBe(400);
		expect(size.height).toBeGreaterThanOrEqual(1);
	});

	it("photo 恒整图（rects 是页上展示框非图像几何）：回退 4:3", () => {
		const size = snapshotImgSize({
			rects: [{ x: 0, y: 0, w: 1, h: 0.5 }],
			excerptType: "photo",
		});
		expect(size).toEqual({ width: 400, height: 300 });
	});

	it("无 rects（徽标锚定/兜底）与退化包围盒（零宽/零高）：回退 4:3", () => {
		expect(snapshotImgSize({ rects: [] })).toEqual({ width: 400, height: 300 });
		expect(
			snapshotImgSize({
				rects: [{ x: 0.2, y: 0.2, w: 0, h: 0.5 }],
				excerptType: "handwriting",
			}),
		).toEqual({ width: 400, height: 300 });
	});
});
