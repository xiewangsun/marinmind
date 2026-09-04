import type { DocRect } from "../types";
import type { PageSize } from "./page-view";

/**
 * 笔迹点：归一化页面坐标（0-1，x 相对页宽、y 相对页高），与显示尺寸/缩放无关。
 * pressure 为 PointerEvent 原始压感（0-1，鼠标按住恒 0.5）；可选——旧数据/测试夹具
 * 缺省时按 0.5 处理（pressureWidthPx 内兜底）。
 */
export interface StrokePoint {
	x: number;
	y: number;
	pressure?: number;
}

/** 一条笔迹（pointerdown → pointerup 之间的采样点序列） */
export interface HandwriteStroke {
	points: StrokePoint[];
}

/** 手写导出 PNG 的上限倍率与总像素钳制（4M 像素约 16MB RGBA） */
const PNG_SCALE = 2;
const MAX_PNG_PIXELS = 4 * 1024 * 1024;
/** 笔迹颜色：红色批注笔（覆盖在 PDF 上醒目；与 tesseract 无关，仅视觉） */
const INK_COLOR = "#d7373f";

/**
 * 压感 → 线宽系数（84-A 笔锋）：basePx × clamp(0.5 + p, 0.5, 1.5)。
 * 鼠标 pressure=0.5 恰等于基准线宽（无笔设备观感与旧版恒宽一致）；
 * 笔轻压最细 0.5×、重压最粗 1.5×。非法值（NaN/≤0——部分浏览器鼠标报 0）按 0.5 兜底。
 */
export function pressureWidthPx(pressure: number | undefined, basePx: number): number {
	const p =
		typeof pressure === "number" && Number.isFinite(pressure) && pressure > 0 ? pressure : 0.5;
	const k = Math.min(1.5, Math.max(0.5, 0.5 + p));
	return basePx * k;
}

/** 点到线段距离（像素空间；退化零长段按点到点距离处理） */
function pointSegDist(
	px: number,
	py: number,
	ax: number,
	ay: number,
	bx: number,
	by: number,
): number {
	const dx = bx - ax;
	const dy = by - ay;
	const lenSq = dx * dx + dy * dy;
	if (lenSq === 0) {
		return Math.hypot(px - ax, py - ay);
	}
	let t = ((px - ax) * dx + (py - ay) * dy) / lenSq;
	t = Math.min(1, Math.max(0, t));
	return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

/**
 * 橡皮擦命中检测（84-A）：归一化坐标 × 页面显示宽高换入像素空间后，点到笔画任意
 * 线段的距离 ≤ radiusPx 即判中，返回命中笔画下标（升序；调用方整笔删除）。
 * pageW/pageH 必须分别换算——归一化坐标在 x/y 方向的像素比例不同。空点笔画不参与。
 */
export function eraseHitStrokeIndices(
	strokes: HandwriteStroke[],
	point: { x: number; y: number },
	radiusPx: number,
	pageW: number,
	pageH: number,
): number[] {
	const w = Math.max(1, pageW);
	const h = Math.max(1, pageH);
	const px = point.x * w;
	const py = point.y * h;
	const hits: number[] = [];
	strokes.forEach((stroke, index) => {
		const pts = stroke.points;
		if (pts.length === 0) {
			return;
		}
		let hit = false;
		for (let i = 0; i + 1 < pts.length && !hit; i++) {
			const a = pts[i];
			const b = pts[i + 1];
			hit = pointSegDist(px, py, a.x * w, a.y * h, b.x * w, b.y * h) <= radiusPx;
		}
		if (!hit && pts.length === 1) {
			// 单点笔画：与点本身比距离
			const a = pts[0];
			hit = Math.hypot(px - a.x * w, py - a.y * h) <= radiusPx;
		}
		if (hit) {
			hits.push(index);
		}
	});
	return hits;
}

/** 手写撤销条目（84-A）：draw=落一笔 / erase=擦除第 index 笔 / clear=清空（存原快照可还原） */
export type InkAction =
	| { kind: "draw"; stroke: HandwriteStroke }
	| { kind: "erase"; index: number; stroke: HandwriteStroke }
	| { kind: "clear"; strokes: HandwriteStroke[] };

/** 撤销栈深度上限（超出丢最旧；镜像脑图 UNDO_STACK_LIMIT。只 undo 不 redo——挂账仅要求撤销） */
export const INK_HISTORY_LIMIT = 50;

/**
 * 未提交笔迹的撤销栈（84-A）：LIFO pop 即逆操作（draw=移除该笔 / erase=按 index 插回 /
 * clear=整体还原）。commit 落卡后由调用方 clear 整体作废。
 */
export class InkHistory {
	private entries: InkAction[] = [];

	push(action: InkAction): void {
		this.entries.push(action);
		if (this.entries.length > INK_HISTORY_LIMIT) {
			this.entries.shift();
		}
	}

	pop(): InkAction | null {
		return this.entries.pop() ?? null;
	}

	canUndo(): boolean {
		return this.entries.length > 0;
	}

	clear(): void {
		this.entries = [];
	}
}

/**
 * 计算全部笔迹的包围盒（归一化矩形），外加 padding（也是归一化单位——
 * 调用方按「线宽像素 / 页面显示像素」换算传入，保证线宽视觉一致）。
 * 无任何点返回 null。结果 clamp 到 [0,1]。
 */
export function strokesBBox(
	strokes: HandwriteStroke[],
	padX: number,
	padY: number,
): DocRect | null {
	let minX = Infinity;
	let minY = Infinity;
	let maxX = -Infinity;
	let maxY = -Infinity;
	for (const stroke of strokes) {
		for (const p of stroke.points) {
			minX = Math.min(minX, p.x);
			minY = Math.min(minY, p.y);
			maxX = Math.max(maxX, p.x);
			maxY = Math.max(maxY, p.y);
		}
	}
	if (minX === Infinity) {
		return null;
	}
	const clamp01 = (v: number) => Math.min(1, Math.max(0, v));
	return {
		x: clamp01(minX - padX),
		y: clamp01(minY - padY),
		w: clamp01(maxX + padX) - clamp01(minX - padX),
		h: clamp01(maxY + padY) - clamp01(minY - padY),
	};
}

/** PNG 画布像素尺寸（纯计算便于测试）：bbox × 页基准尺寸 × 2，总像素钳制到 4M */
export function pngPixelSize(bbox: DocRect, pageBase: PageSize): { width: number; height: number } {
	let width = Math.max(1, Math.round(bbox.w * pageBase.width * PNG_SCALE));
	let height = Math.max(1, Math.round(bbox.h * pageBase.height * PNG_SCALE));
	const pixels = width * height;
	if (pixels > MAX_PNG_PIXELS) {
		const k = Math.sqrt(MAX_PNG_PIXELS / pixels);
		width = Math.max(1, Math.round(width * k));
		height = Math.max(1, Math.round(height * k));
	}
	return { width, height };
}

/**
 * 把笔迹渲染为裁剪到 bbox 的 PNG（透明底）。
 * lineWidth 为归一化线宽（相对页宽的比例），输出画布内按比例放大；
 * 逐段按压感调整线宽（84-A 笔锋——鼠标恒 0.5 时与旧版恒宽视觉一致）。
 * 无 canvas 环境 / 编码失败返回 null（调用方放弃本次提交）。
 */
export async function renderStrokesToPNG(
	strokes: HandwriteStroke[],
	bbox: DocRect,
	pageBase: PageSize,
	lineWidthNorm: number,
): Promise<ArrayBuffer | null> {
	if (typeof document === "undefined") {
		return null;
	}
	const { width: outW, height: outH } = pngPixelSize(bbox, pageBase);
	const canvas = document.createElement("canvas");
	canvas.width = outW;
	canvas.height = outH;
	const ctx = canvas.getContext("2d");
	if (!ctx) {
		return null;
	}
	ctx.strokeStyle = INK_COLOR;
	ctx.lineCap = "round";
	ctx.lineJoin = "round";
	// 基准线宽（输出画布像素）：压感系数围绕它缩放
	const baseWidth = Math.max(1, lineWidthNorm * outW);
	// 笔迹点：归一化 → bbox 内相对坐标 → 输出画布像素；逐段独立成段（变宽），round cap 重叠掩盖台阶
	for (const stroke of strokes) {
		const pts = stroke.points;
		for (let i = 0; i + 1 < pts.length; i++) {
			const a = pts[i];
			const b = pts[i + 1];
			ctx.lineWidth = pressureWidthPx(((a.pressure ?? 0.5) + (b.pressure ?? 0.5)) / 2, baseWidth);
			ctx.beginPath();
			ctx.moveTo(((a.x - bbox.x) / bbox.w) * outW, ((a.y - bbox.y) / bbox.h) * outH);
			ctx.lineTo(((b.x - bbox.x) / bbox.w) * outW, ((b.y - bbox.y) / bbox.h) * outH);
			ctx.stroke();
		}
	}
	// 单点笔迹（点一下）：画一个圆点（半径随压感）
	for (const stroke of strokes) {
		if (stroke.points.length === 1) {
			const p = stroke.points[0];
			ctx.beginPath();
			ctx.arc(
				((p.x - bbox.x) / bbox.w) * outW,
				((p.y - bbox.y) / bbox.h) * outH,
				pressureWidthPx(p.pressure, baseWidth) / 2,
				0,
				Math.PI * 2,
			);
			ctx.fillStyle = INK_COLOR;
			ctx.fill();
		}
	}
	return await new Promise<ArrayBuffer | null>((resolve) => {
		canvas.toBlob((blob) => {
			if (!blob) {
				resolve(null);
				return;
			}
			void blob.arrayBuffer().then(resolve, () => resolve(null));
		}, "image/png");
	});
}
