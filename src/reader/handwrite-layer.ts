import type { DocRect } from "../types";
import {
	renderStrokesToPNG,
	strokesBBox,
	type HandwriteStroke,
	type StrokePoint,
} from "./handwrite-geometry";
import type { PageView } from "./page-view";

/** 手写层需要的宿主信息 */
export interface HandwriteCallbacks {
	/** 当前阅读缩放（容器 CSS 尺寸 ÷ PDF 基准尺寸；导出 PNG 的分辨率换算用） */
	getScale(): number;
}

/** 视觉线宽（CSS 像素）——归一化换算基准 */
const INK_WIDTH_PX = 2.5;

/**
 * 单页手写层：与 ExcerptLayer 同构（每页一个，铺满页面的透明画布）。
 *
 * - 模式关闭时 pointer-events:none 完全穿透；开启时 auto + touch-action:none
 * - 笔迹立即按归一化坐标存储：canvas 尺寸变化（缩放/重排）后按模型全量重绘
 *   （width/height 赋值会清空画布，绝不能假设内容保持）
 * - commit 由外部在恰当时机调用（退出模式/切文档/关视图）：
 *   同步快照并清空模型（destroy 之后再完成的异步渲染不受影响）
 */
export class HandwriteLayer {
	private readonly root: HTMLElement;
	private readonly canvas: HTMLCanvasElement;
	private readonly ctx: CanvasRenderingContext2D | null;
	private readonly ro: ResizeObserver | null;
	private strokes: HandwriteStroke[] = [];
	private current: HandwriteStroke | null = null;
	private activePointerId: number | null = null;
	private mode = false;
	private destroyed = false;

	constructor(
		private readonly pageView: PageView,
		private readonly cb: HandwriteCallbacks,
	) {
		this.root = document.createElement("div");
		this.root.classList.add("marinmind-handwrite-layer");
		this.canvas = document.createElement("canvas");
		this.canvas.classList.add("marinmind-handwrite-canvas");
		this.root.appendChild(this.canvas);
		this.pageView.el.appendChild(this.root); // DOM 序在 overlay 之后，自然置顶

		this.ctx = this.canvas.getContext("2d");
		if (this.ctx) {
			this.ctx.strokeStyle = "#d7373f";
			this.ctx.lineCap = "round";
			this.ctx.lineJoin = "round";
		}

		this.root.addEventListener("pointerdown", this.onPointerDown);
		this.root.addEventListener("pointermove", this.onPointerMove);
		this.root.addEventListener("pointerup", this.onPointerUp);
		this.root.addEventListener("pointercancel", this.onPointerCancel);

		// 尺寸变化（缩放/窗口 resize）→ 重设画布并按归一化模型全量重绘
		this.ro =
			typeof ResizeObserver !== "undefined"
				? new ResizeObserver(() => this.resizeCanvas())
				: null;
		this.ro?.observe(this.pageView.el);
		this.resizeCanvas();
	}

	/** 是否有未提交笔迹 */
	hasInk(): boolean {
		return this.strokes.length > 0;
	}

	/** 模式开关：切换指针事件与触控行为（样式类驱动） */
	setHandwriteMode(on: boolean): void {
		this.mode = on;
		this.root.classList.toggle("marinmind-handwrite-on", on);
	}

	/** 提交结果：归一化包围盒 + PNG 字节（由 reader-view 落库建卡） */
	async commit(): Promise<{ bbox: DocRect; png: ArrayBuffer } | null> {
		if (this.destroyed || this.strokes.length === 0) {
			return null;
		}
		// 同步快照并立即清空模型：之后的异步渲染/destroy 不影响本次提交数据
		const strokes = this.strokes;
		this.strokes = [];
		this.current = null;

		const dispW = this.pageView.displayWidth || 1;
		const dispH = this.pageView.displayHeight || 1;
		// 归一化 padding / 线宽：CSS 像素 → 相对页面显示尺寸的比例（与 dpr 无关）
		const padX = INK_WIDTH_PX / 2 / dispW;
		const padY = INK_WIDTH_PX / 2 / dispH;
		const lineWidthNorm = INK_WIDTH_PX / dispW;
		const bbox = strokesBBox(strokes, padX, padY);
		if (!bbox) {
			return null;
		}
		this.redraw(); // 清空画布
		// 页基准尺寸 = 容器 CSS 尺寸 ÷ 缩放（同步可算，不依赖仍存活的 PDF 实例）
		const scale = this.cb.getScale() || 1;
		const base = { width: dispW / scale, height: dispH / scale };
		const png = await renderStrokesToPNG(strokes, bbox, base, lineWidthNorm);
		return png ? { bbox, png } : null;
	}

	destroy(): void {
		this.destroyed = true;
		this.ro?.disconnect();
		this.root.remove();
	}

	// ---------- 内部实现 ----------

	/** 重设画布像素尺寸（清空内容），随后按模型全量重绘 */
	private resizeCanvas(): void {
		const w = this.pageView.el.clientWidth;
		const h = this.pageView.el.clientHeight;
		if (w === 0 || h === 0) {
			return;
		}
		const dpr = Math.min(2, window.devicePixelRatio || 1);
		// 设备像素渲染保证清晰；CSS 尺寸由层样式 100% 铺满容器
		this.canvas.width = Math.round(w * dpr);
		this.canvas.height = Math.round(h * dpr);
		this.redraw();
	}

	/** 按归一化模型全量重绘（也用于提交后清屏——模型空则画布空） */
	private redraw(): void {
		const ctx = this.ctx;
		if (!ctx) {
			return;
		}
		const w = this.canvas.width;
		const h = this.canvas.height;
		ctx.clearRect(0, 0, w, h);
		const dpr = Math.min(2, window.devicePixelRatio || 1);
		ctx.lineWidth = INK_WIDTH_PX * dpr;
		for (const stroke of this.strokes) {
			this.strokePath(ctx, stroke, w, h);
			if (stroke.points.length === 1) {
				this.dot(ctx, stroke.points[0], w, h, ctx.lineWidth / 2);
			}
		}
		if (this.current && this.current !== this.strokes[this.strokes.length - 1]) {
			this.strokePath(ctx, this.current, w, h);
		}
	}

	private strokePath(
		ctx: CanvasRenderingContext2D,
		stroke: HandwriteStroke,
		w: number,
		h: number,
	): void {
		if (stroke.points.length === 0) {
			return;
		}
		ctx.beginPath();
		stroke.points.forEach((p, i) => {
			if (i === 0) {
				ctx.moveTo(p.x * w, p.y * h);
			} else {
				ctx.lineTo(p.x * w, p.y * h);
			}
		});
		if (stroke.points.length === 1) {
			// 单点：lineTo 自身画不出线，dot 已在 redraw 中处理
			ctx.lineTo(stroke.points[0].x * w + 0.01, stroke.points[0].y * h);
		}
		ctx.stroke();
	}

	private dot(
		ctx: CanvasRenderingContext2D,
		p: { x: number; y: number },
		w: number,
		h: number,
		r: number,
	): void {
		ctx.beginPath();
		ctx.arc(p.x * w, p.y * h, r, 0, Math.PI * 2);
		ctx.fillStyle = "#d7373f";
		ctx.fill();
	}

	/** 事件坐标 → 归一化（0-1，相对页面容器） */
	private toNorm(evt: PointerEvent): StrokePoint {
		const box = this.root.getBoundingClientRect();
		return {
			x: (evt.clientX - box.left) / Math.max(1, box.width),
			y: (evt.clientY - box.top) / Math.max(1, box.height),
		};
	}

	private onPointerDown(evt: PointerEvent): void {
		if (!this.mode || evt.button !== 0 || this.activePointerId !== null) {
			return;
		}
		evt.preventDefault();
		this.activePointerId = evt.pointerId;
		this.root.setPointerCapture(evt.pointerId);
		this.current = { points: [this.toNorm(evt)] };
		// 单点即时画出圆点（视觉反馈）
		const ctx = this.ctx;
		if (ctx) {
			const dpr = Math.min(2, window.devicePixelRatio || 1);
			this.dot(ctx, this.current.points[0], this.canvas.width, this.canvas.height, (INK_WIDTH_PX * dpr) / 2);
		}
	}

	private onPointerMove(evt: PointerEvent): void {
		if (!this.current || evt.pointerId !== this.activePointerId) {
			return;
		}
		evt.preventDefault();
		const p = this.toNorm(evt);
		const pts = this.current.points;
		const last = pts[pts.length - 1];
		// 过密的采样点直接跳过（画布上不可分辨）
		if (last && Math.abs(p.x - last.x) < 0.001 && Math.abs(p.y - last.y) < 0.001) {
			return;
		}
		pts.push(p);
		// 增量画最后一段（比全量重绘省；缩放时会全量重绘兜底）
		const ctx = this.ctx;
		if (ctx && last) {
			const w = this.canvas.width;
			const h = this.canvas.height;
			ctx.beginPath();
			ctx.moveTo(last.x * w, last.y * h);
			ctx.lineTo(p.x * w, p.y * h);
			ctx.stroke();
		}
	}

	private onPointerUp(evt: PointerEvent): void {
		if (evt.pointerId !== this.activePointerId) {
			return;
		}
		this.activePointerId = null;
		if (this.current && this.current.points.length > 0) {
			this.strokes.push(this.current);
		}
		this.current = null;
	}

	private onPointerCancel(evt: PointerEvent): void {
		if (evt.pointerId !== this.activePointerId) {
			return;
		}
		this.activePointerId = null;
		this.current = null; // 系统手势打断：丢弃未完成的笔迹
	}
}
