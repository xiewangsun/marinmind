import type { DocRect } from "../types";

/**
 * 阅读器坐标换算纯函数（无 DOM 依赖，vitest 可测）：
 * 归一化矩形（0-1，入库格式）↔ 页面显示像素 ↔ 高亮 % 定位。
 */

/**
 * 拖拽两点（相对页面的显示像素）→ 归一化矩形。
 * 反向拖拽（从右下往左上）自动归一；坐标钳制到 [0,1]。
 */
export function pointsToNormRect(
	x0: number,
	y0: number,
	x1: number,
	y1: number,
	pageW: number,
	pageH: number,
): DocRect {
	// 除数兜底：布局未就绪（宽高为 0）时避免除零产生 Infinity
	const w = Math.max(1, pageW);
	const h = Math.max(1, pageH);
	return clampNormRect({
		x: Math.min(x0, x1) / w,
		y: Math.min(y0, y1) / h,
		w: Math.abs(x1 - x0) / w,
		h: Math.abs(y1 - y0) / h,
	});
}

/** 钳制归一化矩形：各字段限制在 [0,1] 且不越出页面 */
export function clampNormRect(rect: DocRect): DocRect {
	const x = Math.min(Math.max(rect.x, 0), 1);
	const y = Math.min(Math.max(rect.y, 0), 1);
	return {
		x,
		y,
		w: Math.min(Math.max(rect.w, 0), 1 - x),
		h: Math.min(Math.max(rect.h, 0), 1 - y),
	};
}

/** 归一化矩形 → CSS 百分比定位（高亮随缩放自动跟随，免重排） */
export function normRectToPercent(rect: DocRect): {
	left: string;
	top: string;
	width: string;
	height: string;
} {
	return {
		left: `${rect.x * 100}%`,
		top: `${rect.y * 100}%`,
		width: `${rect.w * 100}%`,
		height: `${rect.h * 100}%`,
	};
}

/** 拖拽结果是否过小（按显示像素阈值判定误触，丢弃不生成卡片） */
export function isTinyNormRect(
	rect: DocRect,
	pageW: number,
	pageH: number,
	minPx = 6,
): boolean {
	return rect.w * pageW < minPx || rect.h * pageH < minPx;
}

/** 视口坐标矩形（如 getClientRects 的结果）与页面包围盒的形状 */
export interface ViewportRect {
	left: number;
	top: number;
	width: number;
	height: number;
}

/**
 * 选区行矩形（相对视口）→ 归一化矩形列表。
 * 多行选区得到多个矩形，正好对应 Card.rects 的多区域模型。
 */
export function rectsRelativeToPage(rects: ViewportRect[], pageBox: ViewportRect): DocRect[] {
	const w = Math.max(1, pageBox.width);
	const h = Math.max(1, pageBox.height);
	return rects.map((r) =>
		clampNormRect({
			x: (r.left - pageBox.left) / w,
			y: (r.top - pageBox.top) / h,
			w: r.width / w,
			h: r.height / h,
		}),
	);
}

/**
 * 跳转定位锚点：多矩形卡片取最上沿（min y），供精确定位滚动计算。
 * 空矩形列表（photo/audio 卡）返回 null——调用方降级为只滚到页。
 */
export function jumpAnchorY(rects: DocRect[]): number | null {
	if (rects.length === 0) {
		return null;
	}
	return Math.min(...rects.map((r) => r.y));
}

/**
 * 摘录预览裁剪窗口（㊶ 卡片预览弹窗）：矩形并集包围盒外扩少量余量
 * （上下多带一两行上下文便于辨认位置），并保证最小窗口尺寸（留白 6×6
 * 锚点等极小摘录不至于裁出一条缝），整体钳制在页内。
 * 空矩形列表返回整页（调用方不应到达——无 rects 的卡不走页裁剪路径）。
 */
export function excerptCropRect(rects: DocRect[]): DocRect {
	if (rects.length === 0) {
		return { x: 0, y: 0, w: 1, h: 1 };
	}
	const x1 = Math.min(...rects.map((r) => r.x));
	const y1 = Math.min(...rects.map((r) => r.y));
	const x2 = Math.max(...rects.map((r) => r.x + r.w));
	const y2 = Math.max(...rects.map((r) => r.y + r.h));
	// 余量：水平 = 包围盒宽 8%，垂直 = 包围盒高 40%（多带上下文行），各设页比例下限
	const mx = Math.max((x2 - x1) * 0.08, 0.008);
	const my = Math.max((y2 - y1) * 0.4, 0.012);
	let cx = x1 - mx;
	let cy = y1 - my;
	let cw = x2 - x1 + mx * 2;
	let ch = y2 - y1 + my * 2;
	// 最小窗口（页比例）：围绕包围盒中心扩到可辨尺寸
	const MIN_W = 0.22;
	const MIN_H = 0.08;
	if (cw < MIN_W) {
		cx = (x1 + x2) / 2 - MIN_W / 2;
		cw = MIN_W;
	}
	if (ch < MIN_H) {
		cy = (y1 + y2) / 2 - MIN_H / 2;
		ch = MIN_H;
	}
	return clampNormRect({ x: cx, y: cy, w: cw, h: ch });
}

/**
 * 遮挡区域 → 视觉窗口内的 CSS 百分比定位（㊷ 复习正面遮挡）：
 * occ 与 bounds 均为页归一化坐标，bounds 为当前展示视觉（内容快照图 /
 * 页裁剪窗口）对应的页归一化窗口；遮挡跨出窗口的部分按窗口边缘钳制，
 * 完全在窗口外的遮挡退化为零尺寸（调用方 CSS 上不可见）。
 */
export function occlusionPercent(
	occ: DocRect,
	bounds: DocRect,
): { left: string; top: string; width: string; height: string } {
	const x1 = Math.max(occ.x, bounds.x);
	const x2 = Math.min(occ.x + occ.w, bounds.x + bounds.w);
	const y1 = Math.max(occ.y, bounds.y);
	const y2 = Math.min(occ.y + occ.h, bounds.y + bounds.h);
	return {
		left: `${((x1 - bounds.x) / bounds.w) * 100}%`,
		top: `${((y1 - bounds.y) / bounds.h) * 100}%`,
		width: `${Math.max(0, (x2 - x1) / bounds.w) * 100}%`,
		height: `${Math.max(0, (y2 - y1) / bounds.h) * 100}%`,
	};
}

/**
 * 遮挡视觉窗口（㊷）：复习正面出图对应的页归一化范围——
 * 有内容快照的卡（area/lasso/handwriting）取 rects 并集包围盒（快照图边界），
 * 其余（text/blank，走页裁剪路径）取摘录预览裁剪窗口。
 */
export function occlusionBounds(card: {
	rects: DocRect[];
	excerptRef: string | null;
}): DocRect {
	if (card.excerptRef && card.rects.length > 0) {
		return {
			x: Math.min(...card.rects.map((r) => r.x)),
			y: Math.min(...card.rects.map((r) => r.y)),
			w: Math.max(...card.rects.map((r) => r.x + r.w)) - Math.min(...card.rects.map((r) => r.x)),
			h: Math.max(...card.rects.map((r) => r.y + r.h)) - Math.min(...card.rects.map((r) => r.y)),
		};
	}
	return excerptCropRect(card.rects);
}
