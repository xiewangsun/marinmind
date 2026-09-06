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
export function isTinyNormRect(rect: DocRect, pageW: number, pageH: number, minPx = 6): boolean {
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
 * opts.context（110 area/lasso 参照文字摘录显示范围）：余量下限抬到页比例
 * （水平每侧 ≥10% 页宽、垂直每侧 ≥5% 页高），最小窗口抬到文字摘录量级
 * （≥55% 页宽 × ≥18% 页高）——小区域不再紧贴包围盒裁成一小块 zoom 图，
 * 与 text 卡同等带上下文的窗口形态（用户反馈 area/lasso 显示范围远小于
 * 文字摘录：text 矩形天然整行/整段宽，同一比例公式得到的窗口就大）。
 */
export function excerptCropRect(rects: DocRect[], opts?: { context?: boolean }): DocRect {
	if (rects.length === 0) {
		return { x: 0, y: 0, w: 1, h: 1 };
	}
	const x1 = Math.min(...rects.map((r) => r.x));
	const y1 = Math.min(...rects.map((r) => r.y));
	const x2 = Math.max(...rects.map((r) => r.x + r.w));
	const y2 = Math.max(...rects.map((r) => r.y + r.h));
	// 余量：水平 = 包围盒宽 8%，垂直 = 包围盒高 40%（多带上下文行），各设页比例
	// 下限；context 档（110）下限抬高到页比例，大区域仍由比例公式主导
	const mx = Math.max((x2 - x1) * 0.08, opts?.context ? 0.1 : 0.008);
	const my = Math.max((y2 - y1) * 0.4, opts?.context ? 0.05 : 0.012);
	let cx = x1 - mx;
	let cy = y1 - my;
	let cw = x2 - x1 + mx * 2;
	let ch = y2 - y1 + my * 2;
	// 最小窗口（页比例）：围绕包围盒中心扩到可辨尺寸；context 档抬到文字量级
	const MIN_W = opts?.context ? 0.55 : 0.22;
	const MIN_H = opts?.context ? 0.18 : 0.08;
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
 * 84-D photo：遮挡是图内 0-1 坐标（预览弹窗编辑），展示图即整图——
 * rects 展示框不得参与（否则复习遮挡错位），恒返回整图。
 */
export function occlusionBounds(card: {
	rects: DocRect[];
	excerptRef: string | null;
	excerptType?: string;
}): DocRect {
	if (card.excerptType === "photo") {
		return { x: 0, y: 0, w: 1, h: 1 };
	}
	if (card.excerptRef && card.rects.length > 0) {
		return {
			x: Math.min(...card.rects.map((r) => r.x)),
			y: Math.min(...card.rects.map((r) => r.y)),
			w:
				Math.max(...card.rects.map((r) => r.x + r.w)) -
				Math.min(...card.rects.map((r) => r.x)),
			h:
				Math.max(...card.rects.map((r) => r.y + r.h)) -
				Math.min(...card.rects.map((r) => r.y)),
		};
	}
	return excerptCropRect(card.rects);
}

/**
 * R3（W-02）：快照/照片 img 的预留宽高属性——加载前按包围盒比例占位防 CLS。
 * 属性值只取比例（等比缩放到 400 基宽），实际尺寸由 CSS max-* 约束重算。
 * area/lasso/handwriting 快照图按 rects 并集包围盒取比；photo 的 rects 是
 * 页上展示框非图像几何（图像恒整图，见 occlusionBounds），无锚可取回退 4:3。
 */
export function snapshotImgSize(card: { rects: DocRect[]; excerptType?: string }): {
	width: number;
	height: number;
} {
	if (card.excerptType !== "photo" && card.rects.length > 0) {
		const w =
			Math.max(...card.rects.map((r) => r.x + r.w)) - Math.min(...card.rects.map((r) => r.x));
		const h =
			Math.max(...card.rects.map((r) => r.y + r.h)) - Math.min(...card.rects.map((r) => r.y));
		if (w > 0 && h > 0) {
			return { width: 400, height: Math.max(1, Math.round((400 * h) / w)) };
		}
	}
	return { width: 400, height: 300 };
}

/** 划选工具栏定位输入（75）：全部视口坐标（getBoundingClientRect 产物） */
export interface ToolbarPlanInput {
	/** 选区锚：range.getClientRects() 非零矩形的并集包围盒 */
	anchor: { left: number; top: number; right: number; bottom: number };
	/** 定位容器：宿主元素（contentEl）的 gBCR */
	container: { left: number; top: number; width: number; height: number };
	/** 工具栏实测尺寸（宿主内 absolute，visibility 隐藏不影响 offsetWidth） */
	toolbarWidth: number;
	toolbarHeight: number;
	/** 工具栏与选区的间距（默认 8px） */
	margin?: number;
}

/**
 * 划选工具栏定位规划（75，纯函数）：选区上方优先、上缘不足回退下方，
 * 水平以选区中心对齐、两侧钳制在容器内，纵向整体钳入容器。
 * 输入视口坐标，输出已减容器原点的**本地坐标**（供 absolute left/top 直接使用）。
 */
export function planSelectionToolbarPosition(input: ToolbarPlanInput): {
	left: number;
	top: number;
} {
	const margin = input.margin ?? 8;
	const c = input.container;
	// 水平：选区中心 − 工具栏半宽，钳制在容器内（4px 内边距）
	const centerX = (input.anchor.left + input.anchor.right) / 2;
	const minLeft = c.left + 4;
	const maxLeft = c.left + c.width - input.toolbarWidth - 4;
	// 容器比工具栏还窄（极端窗格）：钳制次序反转时取 minLeft 保左对齐不溢出右缘
	const left = Math.min(
		Math.max(centerX - input.toolbarWidth / 2, minLeft),
		Math.max(minLeft, maxLeft),
	);
	// 垂直：上方优先（选区顶 − 工具栏高 − 间距），容器顶放不下回退选区下方
	const aboveTop = input.anchor.top - input.toolbarHeight - margin;
	const belowTop = input.anchor.bottom + margin;
	const top = aboveTop >= c.top + 4 ? aboveTop : belowTop;
	// 纵向整体钳入容器（选区贴近容器底时下方方案可能溢出）
	const maxTop = c.top + c.height - input.toolbarHeight - 4;
	const clampedTop = Math.min(Math.max(top, c.top + 4), Math.max(c.top + 4, maxTop));
	return { left: left - c.left, top: clampedTop - c.top };
}
