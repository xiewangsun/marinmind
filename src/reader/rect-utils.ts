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
