import type { DocRect } from "../types";
import type { PageSize } from "./page-view";

/** 笔迹点：归一化页面坐标（0-1，x 相对页宽、y 相对页高），与显示尺寸/缩放无关 */
export interface StrokePoint {
	x: number;
	y: number;
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
 * lineWidth 为归一化线宽（相对页宽的比例），输出画布内按比例放大。
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
	ctx.lineWidth = Math.max(1, lineWidthNorm * outW);
	ctx.lineCap = "round";
	ctx.lineJoin = "round";
	// 笔迹点：归一化 → bbox 内相对坐标 → 输出画布像素
	for (const stroke of strokes) {
		if (stroke.points.length === 0) {
			continue;
		}
		ctx.beginPath();
		stroke.points.forEach((p, i) => {
			const px = ((p.x - bbox.x) / bbox.w) * outW;
			const py = ((p.y - bbox.y) / bbox.h) * outH;
			if (i === 0) {
				ctx.moveTo(px, py);
			} else {
				ctx.lineTo(px, py);
			}
		});
		ctx.stroke();
	}
	// 单点笔迹（点一下）：画一个圆点
	for (const stroke of strokes) {
		if (stroke.points.length === 1) {
			const p = stroke.points[0];
			ctx.beginPath();
			ctx.arc(((p.x - bbox.x) / bbox.w) * outW, ((p.y - bbox.y) / bbox.h) * outH, ctx.lineWidth / 2, 0, Math.PI * 2);
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
