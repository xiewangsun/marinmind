import type { DocRect } from "../types";
import {
	eraseHitStrokeIndices,
	InkHistory,
	pressureWidthPx,
	renderStrokesToImage,
	strokesBBox,
	type HandwriteStroke,
	type StrokePoint,
} from "./handwrite-geometry";
import type { PageView } from "./page-view";

/** 视觉线宽（CSS 像素）——归一化换算基准 / 压感系数围绕它缩放 */
const INK_WIDTH_PX = 2.5;
/** 橡皮擦命中半径（CSS 像素，84-A）：整笔删除语义下的取笔阈值 */
const ERASE_RADIUS_PX = 12;

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
	/** bind 后的指针处理器引用（注册/解绑同源，101 修） */
	private readonly handlers: {
		pointerdown: (evt: PointerEvent) => void;
		pointermove: (evt: PointerEvent) => void;
		pointerup: (evt: PointerEvent) => void;
		pointercancel: (evt: PointerEvent) => void;
	};
	private readonly canvas: HTMLCanvasElement;
	private readonly ctx: CanvasRenderingContext2D | null;
	private readonly ro: ResizeObserver | null;
	private strokes: HandwriteStroke[] = [];
	private current: HandwriteStroke | null = null;
	private activePointerId: number | null = null;
	private mode = false;
	private destroyed = false;
	/** 橡皮擦工具态（84-A）：开启时 pointer 事件走命中删除而非落笔 */
	private eraser = false;
	/** 未提交笔迹的撤销栈（84-A）：commit 后整体作废 */
	private readonly history = new InkHistory();
	/** 落笔/擦除/清空回调（84-A）：reader 据此记录最近操作页（Ctrl+Z 目标层） */
	onInk?: () => void;

	constructor(private readonly pageView: PageView) {
		this.root = document.createElement("div");
		this.root.classList.add("marinmind-handwrite-layer");
		this.canvas = document.createElement("canvas");
		this.canvas.classList.add("marinmind-handwrite-canvas");
		this.root.appendChild(this.canvas);
		this.pageView.el.appendChild(this.root); // DOM 序在 overlay 之后，自然置顶

		// willReadFrequently 强制 CPU 后端：与 pdf-document 同因——GPU 加速 canvas 在部分
		// 环境位图不上屏，笔迹会画了也看不见（attrs 仅首次 getContext 生效，须在此传入）
		this.ctx = this.canvas.getContext("2d", { willReadFrequently: true });
		if (this.ctx) {
			this.ctx.strokeStyle = "#d7373f";
			this.ctx.lineCap = "round";
			this.ctx.lineJoin = "round";
		}

		// 101 修：处理器显式 bind（镜像 ExcerptLayer.handlers 模式）——原型方法
		// 直接注册时事件回调里的 this 是 DOM 元素而非层实例，this.mode 恒
		// undefined，onPointerDown 首行守卫直接早退——画布从未收到过任何一笔
		this.handlers = {
			pointerdown: this.onPointerDown.bind(this),
			pointermove: this.onPointerMove.bind(this),
			pointerup: this.onPointerUp.bind(this),
			pointercancel: this.onPointerCancel.bind(this),
		};
		this.root.addEventListener("pointerdown", this.handlers.pointerdown);
		this.root.addEventListener("pointermove", this.handlers.pointermove);
		this.root.addEventListener("pointerup", this.handlers.pointerup);
		this.root.addEventListener("pointercancel", this.handlers.pointercancel);

		// 尺寸变化（缩放/窗口 resize）→ 重设画布并按归一化模型全量重绘
		this.ro =
			typeof ResizeObserver !== "undefined"
				? new ResizeObserver(() => this.resizeCanvas())
				: null;
		this.ro?.observe(this.pageView.el);
		// 有 RO 时不在构造器同步 resize：observe 后首帧批量派发回调，只触发一次布局；
		// 构造器里同步读 clientWidth 会让打开文档的骨架循环每页强制重排（O(N²)）。
		// 无 RO 环境（理论不存在）才同步兜底，保证手写模式开启前画布有尺寸。
		if (!this.ro) {
			this.resizeCanvas();
		}
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

	/** 橡皮擦开关（84-A）：仅手写模式开时生效（样式类驱动光标变化） */
	setEraser(on: boolean): void {
		this.eraser = on;
		this.root.classList.toggle("marinmind-handwrite-eraser", on);
	}

	/** 是否有可撤销操作（84-A：撤销按钮态 / 快捷键目标层选择用） */
	canUndo(): boolean {
		return this.history.canUndo();
	}

	/**
	 * 撤销最近一次手写操作（84-A）：落笔=移除该笔 / 擦除=按原下标插回 / 清空=整体还原。
	 * 空栈返回 false（调用方无需反馈）。
	 */
	undo(): boolean {
		const action = this.history.pop();
		if (!action) {
			return false;
		}
		if (action.kind === "draw") {
			const idx = this.strokes.indexOf(action.stroke);
			if (idx >= 0) {
				this.strokes.splice(idx, 1);
			}
		} else if (action.kind === "erase") {
			// index 可能因后续增删越界，钳到当前长度内
			this.strokes.splice(Math.min(action.index, this.strokes.length), 0, action.stroke);
		} else {
			this.strokes = action.strokes;
		}
		this.current = null; // 撤销时正在画的笔不应残留（正常流程 pointerup 已清）
		this.redraw();
		return true;
	}

	/** 清空全部未提交笔迹（84-A：进撤销栈，可撤销恢复） */
	clearInk(): void {
		if (this.strokes.length === 0) {
			return;
		}
		this.history.push({ kind: "clear", strokes: this.strokes });
		this.strokes = [];
		this.current = null;
		this.redraw();
		this.onInk?.();
	}

	/** 提交结果：归一化包围盒 + 图片字节与实际格式（由 reader-view 落库建卡） */
	async commit(): Promise<{ bbox: DocRect; bytes: ArrayBuffer; ext: "png" | "webp" } | null> {
		if (this.destroyed || this.strokes.length === 0) {
			return null;
		}
		// 同步快照并立即清空模型：之后的异步渲染/destroy 不影响本次提交数据
		const strokes = this.strokes;
		this.strokes = [];
		this.current = null;
		this.history.clear(); // 已落卡的笔迹不可撤销（84-A）

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
		// 页基准尺寸直取本页 baseSize（㊳ 混合页尺寸：exact 优先，归一化坐标天然
		// 无关缩放——此前用"容器 ÷ 全局 scale"在混合尺寸文档上本就有偏差）
		const image = await renderStrokesToImage(
			strokes,
			bbox,
			this.pageView.baseSize,
			lineWidthNorm,
		);
		return image ? { bbox, bytes: image.bytes, ext: image.ext } : null;
	}

	destroy(): void {
		this.destroyed = true;
		this.ro?.disconnect();
		// 101 修：bind 后持有同引用可显式解绑（此前未 bind 既错又无法解绑）
		this.root.removeEventListener("pointerdown", this.handlers.pointerdown);
		this.root.removeEventListener("pointermove", this.handlers.pointermove);
		this.root.removeEventListener("pointerup", this.handlers.pointerup);
		this.root.removeEventListener("pointercancel", this.handlers.pointercancel);
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
		for (const stroke of this.strokes) {
			this.strokePath(ctx, stroke, w, h, dpr);
		}
		if (this.current && this.current !== this.strokes[this.strokes.length - 1]) {
			this.strokePath(ctx, this.current, w, h, dpr);
		}
	}

	/** 画一笔（84-A 逐段变宽：lineWidth = 两端平均压感系数 × 基准；单点画圆点） */
	private strokePath(
		ctx: CanvasRenderingContext2D,
		stroke: HandwriteStroke,
		w: number,
		h: number,
		dpr: number,
	): void {
		const pts = stroke.points;
		if (pts.length === 0) {
			return;
		}
		const base = INK_WIDTH_PX * dpr;
		if (pts.length === 1) {
			this.dot(ctx, pts[0], w, h, pressureWidthPx(pts[0].pressure, base) / 2);
			return;
		}
		for (let i = 0; i + 1 < pts.length; i++) {
			const a = pts[i];
			const b = pts[i + 1];
			ctx.lineWidth = pressureWidthPx(((a.pressure ?? 0.5) + (b.pressure ?? 0.5)) / 2, base);
			ctx.beginPath();
			ctx.moveTo(a.x * w, a.y * h);
			ctx.lineTo(b.x * w, b.y * h);
			ctx.stroke();
		}
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

	/** 事件坐标 → 归一化（0-1，相对页面容器）；附带原始压感（84-A） */
	private toNorm(evt: PointerEvent): StrokePoint {
		const box = this.root.getBoundingClientRect();
		return {
			x: (evt.clientX - box.left) / Math.max(1, box.width),
			y: (evt.clientY - box.top) / Math.max(1, box.height),
			// 鼠标恒 0.5、个别浏览器报 0——非法值在 pressureWidthPx 内统一兜底
			pressure: evt.pressure,
		};
	}

	private onPointerDown(evt: PointerEvent): void {
		if (!this.mode || evt.button !== 0 || this.activePointerId !== null) {
			return;
		}
		evt.preventDefault();
		this.activePointerId = evt.pointerId;
		this.root.setPointerCapture(evt.pointerId);
		if (this.eraser) {
			this.eraseAt(this.toNorm(evt));
			return;
		}
		this.current = { points: [this.toNorm(evt)] };
		// 单点即时画出圆点（视觉反馈；半径随压感 84-A）
		const ctx = this.ctx;
		if (ctx) {
			const dpr = Math.min(2, window.devicePixelRatio || 1);
			const p = this.current.points[0];
			this.dot(
				ctx,
				p,
				this.canvas.width,
				this.canvas.height,
				pressureWidthPx(p.pressure, INK_WIDTH_PX * dpr) / 2,
			);
		}
	}

	private onPointerMove(evt: PointerEvent): void {
		if (evt.pointerId !== this.activePointerId) {
			return;
		}
		if (this.eraser) {
			if (!this.mode) {
				return;
			}
			evt.preventDefault();
			this.eraseAt(this.toNorm(evt)); // 拖擦：连续命中连续删除
			return;
		}
		if (!this.current) {
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
		// 增量画最后一段（比全量重绘省；缩放时会全量重绘兜底）；宽度随该段压感（84-A）
		const ctx = this.ctx;
		if (ctx && last) {
			const w = this.canvas.width;
			const h = this.canvas.height;
			const dpr = Math.min(2, window.devicePixelRatio || 1);
			ctx.lineWidth = pressureWidthPx(
				((last.pressure ?? 0.5) + (p.pressure ?? 0.5)) / 2,
				INK_WIDTH_PX * dpr,
			);
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
		if (this.eraser) {
			return; // 橡皮擦：无未完成笔迹
		}
		if (this.current && this.current.points.length > 0) {
			this.strokes.push(this.current);
			this.history.push({ kind: "draw", stroke: this.current }); // 84-A 撤销栈
			this.onInk?.();
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

	/** 橡皮擦一次命中（84-A）：整笔删除 + 进撤销栈（move 连续调用 = 拖擦） */
	private eraseAt(point: StrokePoint): void {
		const hits = eraseHitStrokeIndices(
			this.strokes,
			point,
			ERASE_RADIUS_PX,
			this.pageView.displayWidth || 1,
			this.pageView.displayHeight || 1,
		);
		if (hits.length === 0) {
			return;
		}
		// 从大到小 splice 保证未处理下标稳定
		for (let i = hits.length - 1; i >= 0; i--) {
			const index = hits[i];
			const [stroke] = this.strokes.splice(index, 1);
			this.history.push({ kind: "erase", index, stroke });
		}
		this.redraw();
		this.onInk?.();
	}
}
