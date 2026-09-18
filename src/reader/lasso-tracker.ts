/**
 * 套索摘录工具（lasso）：用户自由绘制闭合路径圈选页面区域，松手后生成 lasso 类型卡片。
 *
 * 交互契约：
 * - 只在 overlay 上响应 pointerdown/move/up；指针离开 overlay 不立即取消（拖出再拖回仍续画）。
 * - 右键取消当前套索（不生成卡片）。
 * - 最小路径点数：2（单点/极小抖动丢弃，与 area 的 isTinyNormRect 等价）。
 * - 路径闭合逻辑：松手时用 closePath 连回起点；视觉用虚线回连线。
 * - 生成卡片时保存**原始轮廓**：路径抽稀后按 0-1 归一为多边形顶点（Card.polygon），
 *   渲染用 clip-path 裁形保持原状；rects 只存单个包围盒（跳转锚点 + 无多边形旧卡兜底）。
 */

import type { DocRect, NormPoint } from "../types";
import { clampNormRect } from "../reader/rect-utils";
import type { PageView } from "./page-view";

/** 套索路径点（overlay 本地像素坐标） */
interface LassoPoint {
	x: number;
	y: number;
}

/** 拖拽预览的路径 SVG（挂在 overlay 之上） */
interface LassoPreview {
	svg: SVGElement;
	pathEl: SVGPathElement;
	closeLine: SVGLineElement;
}

/**
 * 套索追踪器：在单页 overlay 上监听指针，采集自由绘制路径。
 *
 * 状态机：
 * - Idle → Drawing（pointerdown）→ Commit/Cancel（pointerup/contextmenu/cancel）→ 回到 Idle
 * - commit/cancel 后立即可再次起笔（工具保持激活可连续套索；此前有 committed
 *   一次性标志，右键取消或极小抖动一次后整套索工具永久失灵的根因，已移除）
 */
export class LassoTracker {
	private pageView: PageView;
	private points: LassoPoint[] = [];
	private preview: LassoPreview | null = null;
	private pointerId: number | null = null;

	constructor(pageView: PageView) {
		this.pageView = pageView;
		this.bindEvents();
	}

	/** 最小套索路径像素长度（避免抖动产生无效套索） */
	private static readonly MIN_PATH_LENGTH = 12;

	private bindEvents(): void {
		const overlay = this.pageView.overlayEl;
		this.ondown = this.onPointerDown.bind(this);
		this.onmove = this.onPointerMove.bind(this);
		this.onup = this.onPointerUp.bind(this);
		this.οncancel = this.onPointerCancel.bind(this);
		this.onctx = this.onContextMenu.bind(this);
		overlay.addEventListener("pointerdown", this.ondown);
		overlay.addEventListener("pointermove", this.onmove);
		overlay.addEventListener("pointerup", this.onup);
		overlay.addEventListener("pointercancel", this.οncancel);
		overlay.addEventListener("contextmenu", this.onctx);
	}

	ondown: ((e: PointerEvent) => void) | null = null;
	onmove: ((e: PointerEvent) => void) | null = null;
	onup: ((e: PointerEvent) => void) | null = null;
	οncancel: ((e: PointerEvent) => void) | null = null;
	onctx: ((e: MouseEvent) => void) | null = null;

	destroy(): void {
		if (this.ondown == null) {
			return; // 已销毁
		}
		const overlay = this.pageView.overlayEl;
		if (this.ondown) overlay.removeEventListener("pointerdown", this.ondown);
		if (this.onmove) overlay.removeEventListener("pointermove", this.onmove);
		if (this.onup) overlay.removeEventListener("pointerup", this.onup);
		if (this.οncancel) overlay.removeEventListener("pointercancel", this.οncancel);
		if (this.onctx) overlay.removeEventListener("contextmenu", this.onctx);
		this.ondown = null;
		this.onmove = null;
		this.onup = null;
		this.οncancel = null;
		this.onctx = null;
		this.cancel();
	}

	private toLocal(evt: PointerEvent): LassoPoint {
		const box = this.pageView.overlayEl.getBoundingClientRect();
		return { x: evt.clientX - box.left, y: evt.clientY - box.top };
	}

	private onPointerDown(evt: PointerEvent): void {
		if (evt.button !== 0) {
			return;
		}
		evt.preventDefault();
		this.pointerId = evt.pointerId;
		this.pageView.overlayEl.setPointerCapture(this.pointerId);
		this.points = [this.toLocal(evt)];
		this.buildPreview();
	}

	private onPointerMove(evt: PointerEvent): void {
		if (this.pointerId == null || evt.pointerId !== this.pointerId) {
			return;
		}
		evt.preventDefault();
		this.points.push(this.toLocal(evt));
		this.updatePreview();
	}

	private onPointerUp(evt: PointerEvent): void {
		if (this.pointerId == null || evt.pointerId !== this.pointerId) {
			return;
		}
		this.pointerId = null;
		this.commit();
	}

	private onPointerCancel(): void {
		this.pointerId = null;
		this.cancel();
	}

	private onContextMenu(evt: MouseEvent): void {
		evt.preventDefault();
		this.cancel();
	}

	/** 提交：抽稀 + 归一化多边形 → 回调 onCommit */
	private commit(): void {
		if (this.points.length < 2) {
			this.cancel();
			return;
		}
		// 路径总长不够（极小抖动）也丢弃
		if (this.pathLength() < LassoTracker.MIN_PATH_LENGTH) {
			this.cancel();
			return;
		}
		const shape = pathToNormPolygon(
			this.points,
			this.pageView.displayWidth,
			this.pageView.displayHeight,
		);
		this.removePreview();
		if (!shape) {
			return;
		}
		this.cb?.(this.pageView.pageNumber, shape.polygon, shape.bbox);
	}

	private cancel(): void {
		this.pointerId = null;
		this.points = [];
		this.removePreview();
	}

	private pathLength(): number {
		let len = 0;
		for (let i = 1; i < this.points.length; i++) {
			const dx = this.points[i].x - this.points[i - 1].x;
			const dy = this.points[i].y - this.points[i - 1].y;
			len += Math.sqrt(dx * dx + dy * dy);
		}
		return len;
	}

	/** 外部回调：套索结束时创建卡片（由 ExcerptLayer 注入） */
	setCommitCallback(cb: (page: number, polygon: NormPoint[], bbox: DocRect) => void): void {
		this.cb = cb;
	}
	private cb: ((page: number, polygon: NormPoint[], bbox: DocRect) => void) | null = null;

	/** 预览线色跟随当前摘录色系（㊹ 按钮循环切色时由 ExcerptLayer 推送；建预览时生效） */
	setPreviewColor(color: string): void {
		this.previewColor = color;
		this.preview?.svg.setAttribute("data-color", color);
	}
	private previewColor = "yellow";

	// ---------- 预览 ----------

	private buildPreview(): void {
		const overlay = this.pageView.overlayEl;
		const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
		svg.classList.add("marinmind-lasso-preview");
		svg.setAttribute("data-color", this.previewColor);
		svg.setCssStyles({ position: "absolute" });
		svg.setCssStyles({ top: "0" });
		svg.setCssStyles({ left: "0" });
		svg.setCssStyles({ width: "100%" });
		svg.setCssStyles({ height: "100%" });
		svg.setCssStyles({ pointerEvents: "none" });
		const pathEl = document.createElementNS("http://www.w3.org/2000/svg", "path");
		pathEl.classList.add("marinmind-lasso-path");
		svg.appendChild(pathEl);
		const closeLine = document.createElementNS("http://www.w3.org/2000/svg", "line");
		closeLine.classList.add("marinmind-lasso-close");
		svg.appendChild(closeLine);
		overlay.appendChild(svg);
		this.preview = { svg, pathEl, closeLine };
		this.updatePreview();
	}

	private updatePreview(): void {
		if (!this.preview || this.points.length === 0) {
			return;
		}
		const { pathEl, closeLine } = this.preview;
		const pts = this.points.map((p) => `${p.x},${p.y}`).join(" ");
		pathEl.setAttribute("d", `M ${pts}`);
		// 虚线连回起点
		const first = this.points[0];
		const last = this.points[this.points.length - 1];
		closeLine.setAttribute("x1", String(first.x));
		closeLine.setAttribute("y1", String(first.y));
		closeLine.setAttribute("x2", String(last.x));
		closeLine.setAttribute("y2", String(last.y));
	}

	private removePreview(): void {
		this.preview?.svg.remove();
		this.preview = null;
	}
}

/**
 * 套索路径抽稀：只保留与上一个保留点距离 ≥ minDist 的点（首末点必留）。
 * pointermove 高频采样产生大量近邻点，直接入库存 JSON 过大且无益于轮廓精度。
 */
export function simplifyPath(points: LassoPoint[], minDist = 2): LassoPoint[] {
	if (points.length <= 2) {
		return points.slice();
	}
	const out: LassoPoint[] = [points[0]];
	for (let i = 1; i < points.length - 1; i++) {
		const last = out[out.length - 1];
		const dx = points[i].x - last.x;
		const dy = points[i].y - last.y;
		if (Math.sqrt(dx * dx + dy * dy) >= minDist) {
			out.push(points[i]);
		}
	}
	out.push(points[points.length - 1]);
	return out;
}

/**
 * 套索路径 → 归一化多边形 + 包围盒。
 * 多边形按 0-1 相对页面归一（与 rects 同一坐标系，凹凸形状顶点原样保留）；
 * bbox 作为 rects 入库（跳转锚点用）。返回 null = 点太少/包围盒过小（误触）。
 */
export function pathToNormPolygon(
	points: LassoPoint[],
	pageW: number,
	pageH: number,
): { polygon: NormPoint[]; bbox: DocRect } | null {
	const simplified = simplifyPath(points);
	if (simplified.length < 3) {
		return null;
	}
	let minX = Infinity,
		minY = Infinity,
		maxX = -Infinity,
		maxY = -Infinity;
	for (const p of simplified) {
		if (p.x < minX) minX = p.x;
		if (p.y < minY) minY = p.y;
		if (p.x > maxX) maxX = p.x;
		if (p.y > maxY) maxY = p.y;
	}
	const w = maxX - minX;
	const h = maxY - minY;
	if (w < 2 || h < 2) {
		return null; // 过小视为误触
	}
	const absW = Math.max(1, pageW);
	const absH = Math.max(1, pageH);
	return {
		polygon: simplified.map((p) => ({ x: p.x / absW, y: p.y / absH })),
		bbox: clampNormRect({ x: minX / absW, y: minY / absH, w: w / absW, h: h / absH }),
	};
}
