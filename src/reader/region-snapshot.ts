import type { Card, DocRect, NormPoint } from "../types";
import { highlightFallbackColor, highlightLineColor, highlightLineStyle } from "./highlight-colors";
import { encodeCanvasWebpFirst } from "../imaging/canvas-encode";

/**
 * 区域/套索摘录的内容快照（⑳）：从已渲染的页面 canvas 裁剪摘录区域为图片，
 * 存附件（excerptRef）——脑图节点与复习界面据此显示"选择的区域内容"而非占位文字，
 * 与手写/照片同模式（一卡一附件）；摘录区域本身在页面上仍是矢量高亮（缩放不失真）。
 * 编码（㉛）优先 WebP：体积约为 PNG 的 1/3~1/5 且支持 alpha（套索多边形外透明，
 * JPEG 用不了）；能力探测与回退逻辑单源于 src/imaging/canvas-encode.ts——
 * 扩展名跟随实际格式写入 excerptRef。
 */

/** 快照编码结果：bytes 为图片字节，ext 为实际格式（决定附件扩展名） */
export interface SnapshotImage {
	bytes: ArrayBuffer;
	ext: "webp" | "png";
}

/** canvas → 快照字节（能力探测与编码单源：src/imaging/canvas-encode.ts，2026-09 收敛） */
async function encodeCanvas(canvas: HTMLCanvasElement): Promise<SnapshotImage> {
	const enc = await encodeCanvasWebpFirst(canvas);
	if (!enc) {
		throw new Error("画布导出图片失败");
	}
	return { bytes: await enc.blob.arrayBuffer(), ext: enc.ext };
}

/** 画布像素矩形（源画布上的裁剪窗口） */
export interface PixelRect {
	sx: number;
	sy: number;
	sw: number;
	sh: number;
}

/**
 * 归一化矩形 → 画布像素矩形（clamp 进画布、四舍五入；宽高至少 1px 防空裁剪）。
 * canvas 内部像素含 dpr，与归一化坐标天然同基准（都是"相对整页"的比例）。
 */
export function pixelRect(rect: DocRect, canvasW: number, canvasH: number): PixelRect {
	const x1 = Math.max(0, Math.min(canvasW, rect.x * canvasW));
	const y1 = Math.max(0, Math.min(canvasH, rect.y * canvasH));
	const x2 = Math.max(0, Math.min(canvasW, (rect.x + rect.w) * canvasW));
	const y2 = Math.max(0, Math.min(canvasH, (rect.y + rect.h) * canvasH));
	return {
		sx: Math.round(x1),
		sy: Math.round(y1),
		sw: Math.max(1, Math.round(x2 - x1)),
		sh: Math.max(1, Math.round(y2 - y1)),
	};
}

/** 归一化多边形顶点 → 画布像素顶点（套索轮廓按用户原始形状等比映射） */
export function pixelPoints(
	polygon: NormPoint[],
	canvasW: number,
	canvasH: number,
): Array<{ x: number; y: number }> {
	return polygon.map((p) => ({
		x: p.x * canvasW,
		y: p.y * canvasH,
	}));
}

/**
 * 从源画布裁剪摘录区域：
 * - area：直接按包围盒裁剪；
 * - lasso（polygon 非空）：先按原始轮廓 clip 再裁包围盒——多边形外的部分透明，
 *   脑图/复习中保持"套住什么显示什么"的形状语义。
 * 返回实际编码格式（WebP 优先，探测失败 PNG），扩展名由调用方写入附件路径。
 */
export async function cropRegionSnapshot(
	source: HTMLCanvasElement,
	rect: DocRect,
	polygon: NormPoint[] | null,
): Promise<SnapshotImage> {
	const win = pixelRect(rect, source.width, source.height);
	const out = document.createElement("canvas");
	out.width = win.sw;
	out.height = win.sh;
	const ctx = out.getContext("2d");
	if (!ctx) {
		throw new Error("无法获取裁剪 canvas 2d 上下文");
	}
	if (polygon && polygon.length >= 3) {
		ctx.save();
		ctx.beginPath();
		const pts = pixelPoints(polygon, source.width, source.height);
		ctx.moveTo(pts[0].x - win.sx, pts[0].y - win.sy);
		for (let i = 1; i < pts.length; i++) {
			ctx.lineTo(pts[i].x - win.sx, pts[i].y - win.sy);
		}
		ctx.closePath();
		ctx.clip();
	}
	ctx.drawImage(source, win.sx, win.sy, win.sw, win.sh, 0, 0, win.sw, win.sh);
	if (polygon && polygon.length >= 3) {
		ctx.restore();
	}
	return encodeCanvas(out);
}

/**
 * 在渲染完成的页面画布上叠加卡片摘录区域（归一化坐标 → 画布内部像素，
 * 天然 dpr 无关）。㊹ MN3 式线稿：**只描线不填充**——套索 polygon 描原始轮廓、
 * 文字卡每行矩形底部画粗线（下划线）、其余形态描矩形边框；线色读 card.color
 * （highlightLineColor：四色 + 存量旧色相同源）。复习溯源缩略图（context-preview）
 * 与主页卡片预览弹窗共用，保证两处与阅读器观感一致。线宽随画布宽度等比
 * 放大——高倍离屏渲染后经 CSS 缩小展示时描边仍可见。
 */
export function paintCardHighlights(canvas: HTMLCanvasElement, card: Card): void {
	const ctx = canvas.getContext("2d");
	if (!ctx) {
		return;
	}
	const w = canvas.width;
	const h = canvas.height;
	const line = highlightLineColor(highlightFallbackColor(card));
	// 套索轮廓：只描原始形状（与阅读器 SVG 描边回显一致）
	if (card.polygon && card.polygon.length >= 3) {
		ctx.beginPath();
		const pts = pixelPoints(card.polygon, w, h);
		pts.forEach((p, i) => (i === 0 ? ctx.moveTo(p.x, p.y) : ctx.lineTo(p.x, p.y)));
		ctx.closePath();
		ctx.strokeStyle = line;
		ctx.lineWidth = Math.max(2, w / 300);
		ctx.stroke();
		return;
	}
	// 文字卡：按线型画行底/行中记号（77 三态——与阅读器 CSS 形态同观感）
	if (card.excerptType === "text") {
		const style = highlightLineStyle(card);
		for (const r of card.rects) {
			const x = r.x * w;
			const y = r.y * h;
			const rw = r.w * w;
			const rh = r.h * h;
			const lw = Math.max(2.5, rh * 0.06, w / 500);
			if (style === "strikethrough") {
				// 删除线：行中线粗条（与 CSS ::before top:50% 同位）
				ctx.fillStyle = line;
				ctx.fillRect(x, y + (rh - lw) / 2, rw, lw);
				continue;
			}
			if (style === "squiggle") {
				// 波浪线：行底正弦串（quadraticCurveTo 交替上下控制点；周期/振幅
				// 与 lw 同源等比——高倍离屏渲染后经 CSS 缩小仍同观感）
				const period = lw * 3.2; // 波浪周期 ≈ 线宽 3.2 倍（CSS 8px tile/2.5px 同比）
				const amp = lw * 0.8; // 控制点偏移（曲线峰值约 amp/2）
				const yb = y + rh - lw; // 基线略高于行底（与下划线条同位）
				ctx.strokeStyle = line;
				ctx.lineWidth = Math.max(1.5, lw * 0.6); // 波形笔画细于下划线粗条
				ctx.lineCap = "round";
				ctx.beginPath();
				let cx = x;
				let up = true;
				ctx.moveTo(cx, yb);
				while (cx < x + rw) {
					const next = Math.min(cx + period / 2, x + rw);
					ctx.quadraticCurveTo((cx + next) / 2, yb + (up ? -2 * amp : 2 * amp), next, yb);
					cx = next;
					up = !up;
				}
				ctx.stroke();
				continue;
			}
			ctx.fillStyle = line;
			ctx.fillRect(x, y + rh - lw, rw, lw);
		}
		return;
	}
	// 其余形态（区域/手写/留白）：只描矩形边框
	for (const r of card.rects) {
		const x = r.x * w;
		const y = r.y * h;
		const rw = r.w * w;
		const rh = r.h * h;
		ctx.strokeStyle = line;
		ctx.lineWidth = Math.max(1.5, w / 400);
		ctx.strokeRect(x, y, rw, rh);
	}
}
