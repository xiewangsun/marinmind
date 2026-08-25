import type { Card, DocRect } from "../types";
import type { PageView } from "./page-view";
import { isTinyNormRect, normRectToPercent, pointsToNormRect } from "./rect-utils";

export interface ExcerptLayerCallbacks {
	/** 当前是否处于区域摘录模式（拖拽框选） */
	isExcerptMode(): boolean;
	/** 拖拽完成且尺寸有效，请求创建 area 卡片 */
	onCreateAreaCard(pageNumber: number, rect: DocRect): void;
	/** 点击已有高亮（查看/管理卡片） */
	onHighlightClick(card: Card, evt: MouseEvent): void;
}

/**
 * 单页摘录层：已有卡片的高亮回显 + 摘录模式下的拖拽框选。
 *
 * 事件模型：
 * - overlay 平时 pointer-events:none（完全穿透，滚轮/点击照常落到页面）
 * - 高亮块单独 pointer-events:auto，可点击（即便不在摘录模式）
 * - 摘录模式开启时 overlay 整层 pointer-events:auto + touch-action:none
 *   （touch-action 是触摸端阻止滚动的唯一可靠手段），并以 setPointerCapture
 *   锁定拖拽；右键取消进行中的拖拽
 */
export class ExcerptLayer {
	/** cardId → 该卡片在高亮层的 DOM 节点（多矩形摘录时为多个） */
	private readonly highlightEls = new Map<string, HTMLElement[]>();
	/** cardId → 卡片对象（点击高亮时回查） */
	private readonly cardsById = new Map<string, Card>();
	private dragStart: { x: number; y: number } | null = null;
	private dragPreview: HTMLElement | null = null;
	private excerptMode = false;

	// 绑定宿主引用，便于 destroy 解绑
	private readonly handlers = {
		pointerdown: this.onPointerDown.bind(this),
		pointermove: this.onPointerMove.bind(this),
		pointerup: this.onPointerUp.bind(this),
		contextmenu: this.onContextMenu.bind(this),
	};

	constructor(
		private readonly pageView: PageView,
		private readonly cb: ExcerptLayerCallbacks,
	) {
		const overlay = this.pageView.overlayEl;
		overlay.addEventListener("pointerdown", this.handlers.pointerdown);
		overlay.addEventListener("pointermove", this.handlers.pointermove);
		overlay.addEventListener("pointerup", this.handlers.pointerup);
		overlay.addEventListener("contextmenu", this.handlers.contextmenu);
	}

	/** 打开文档时批量回显该页已有卡片（先清空旧高亮） */
	setCards(cards: Card[]): void {
		this.clearHighlights();
		for (const card of cards) {
			this.addHighlight(card);
		}
	}

	/** 新建摘录后即时回显（或重新加载单张卡片） */
	addHighlight(card: Card): void {
		this.cardsById.set(card.id, card);
		const els: HTMLElement[] = [];
		for (const rect of card.rects) {
			const el = document.createElement("div");
			el.classList.add("marinmind-excerpt-highlight");
			el.dataset.cardId = card.id;
			// 颜色变体挂 data-color（区域=yellow，文字=blue），样式表按值上色
			el.dataset.color = card.color ?? "yellow";
			const pos = normRectToPercent(rect);
			el.style.left = pos.left;
			el.style.top = pos.top;
			el.style.width = pos.width;
			el.style.height = pos.height;
			el.addEventListener("click", (evt) => this.cb.onHighlightClick(card, evt));
			this.pageView.overlayEl.appendChild(el);
			els.push(el);
		}
		this.highlightEls.set(card.id, els);
	}

	/** 删除卡片后即时移除高亮 */
	removeHighlight(cardId: string): void {
		for (const el of this.highlightEls.get(cardId) ?? []) {
			el.remove();
		}
		this.highlightEls.delete(cardId);
		this.cardsById.delete(cardId);
	}

	/** 摘录模式开关（切换 overlay 的事件捕获行为，样式类驱动） */
	setExcerptMode(on: boolean): void {
		this.excerptMode = on;
		this.cancelDrag();
		this.pageView.overlayEl.classList.toggle("marinmind-excerpt-on", on);
	}

	destroy(): void {
		this.cancelDrag();
		const overlay = this.pageView.overlayEl;
		overlay.removeEventListener("pointerdown", this.handlers.pointerdown);
		overlay.removeEventListener("pointermove", this.handlers.pointermove);
		overlay.removeEventListener("pointerup", this.handlers.pointerup);
		overlay.removeEventListener("contextmenu", this.handlers.contextmenu);
		this.clearHighlights();
	}

	private clearHighlights(): void {
		for (const els of this.highlightEls.values()) {
			for (const el of els) {
				el.remove();
			}
		}
		this.highlightEls.clear();
		this.cardsById.clear();
	}

	/** 事件坐标 → 相对 overlay 的本地像素坐标 */
	private toLocal(evt: PointerEvent): { x: number; y: number } {
		const box = this.pageView.overlayEl.getBoundingClientRect();
		return { x: evt.clientX - box.left, y: evt.clientY - box.top };
	}

	private onPointerDown(evt: PointerEvent): void {
		if (!this.excerptMode || evt.button !== 0) {
			return;
		}
		// 点在高亮块上不启动拖框（高亮自身可点击查看）
		if (evt.target !== this.pageView.overlayEl) {
			return;
		}
		evt.preventDefault();
		this.pageView.overlayEl.setPointerCapture(evt.pointerId);
		this.dragStart = this.toLocal(evt);

		this.dragPreview = document.createElement("div");
		this.dragPreview.classList.add("marinmind-drag-rect");
		this.pageView.overlayEl.appendChild(this.dragPreview);
		this.updatePreview(this.dragStart);
	}

	private onPointerMove(evt: PointerEvent): void {
		if (!this.dragStart || !this.dragPreview) {
			return;
		}
		this.updatePreview(this.toLocal(evt));
	}

	private onPointerUp(evt: PointerEvent): void {
		if (!this.dragStart) {
			return;
		}
		const end = this.toLocal(evt);
		const start = this.dragStart;
		this.cancelDrag();

		const pageW = this.pageView.displayWidth;
		const pageH = this.pageView.displayHeight;
		const rect = pointsToNormRect(start.x, start.y, end.x, end.y, pageW, pageH);
		// 过小视为误触（单击/抖动），不生成卡片
		if (isTinyNormRect(rect, pageW, pageH)) {
			return;
		}
		this.cb.onCreateAreaCard(this.pageView.pageNumber, rect);
	}

	/** 右键取消进行中的拖拽（不弹浏览器菜单） */
	private onContextMenu(evt: MouseEvent): void {
		if (this.dragStart) {
			evt.preventDefault();
			this.cancelDrag();
		}
	}

	private updatePreview(p: { x: number; y: number }): void {
		if (!this.dragStart || !this.dragPreview) {
			return;
		}
		const x = Math.min(this.dragStart.x, p.x);
		const y = Math.min(this.dragStart.y, p.y);
		this.dragPreview.style.left = `${x}px`;
		this.dragPreview.style.top = `${y}px`;
		this.dragPreview.style.width = `${Math.abs(p.x - this.dragStart.x)}px`;
		this.dragPreview.style.height = `${Math.abs(p.y - this.dragStart.y)}px`;
	}

	private cancelDrag(): void {
		this.dragPreview?.remove();
		this.dragPreview = null;
		this.dragStart = null;
	}
}
