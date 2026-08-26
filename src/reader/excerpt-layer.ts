import type { Card, DocRect } from "../types";
import {
	clearMindmapDropHints,
	updateMindmapDropHint,
} from "../mindmap/mindmap-view";
import type { MarinMindMindmapView } from "../mindmap/mindmap-view";
import type { PageView } from "./page-view";
import { isTinyNormRect, normRectToPercent, pointsToNormRect } from "./rect-utils";

/** 通用闪烁反馈：加 marinmind-flash 类 1.5s 后移除（跳转定位视觉锚点） */
export function flashEl(el: HTMLElement): void {
	el.classList.remove("marinmind-flash");
	void el.offsetWidth; // 强制 reflow：连续两次定位同一目标时重启动画
	el.classList.add("marinmind-flash");
	window.setTimeout(() => el.classList.remove("marinmind-flash"), 1500);
}

export interface ExcerptLayerCallbacks {
	/** 当前是否处于区域摘录模式（拖拽框选） */
	isExcerptMode(): boolean;
	/** 拖拽完成且尺寸有效，请求创建 area 卡片 */
	onCreateAreaCard(pageNumber: number, rect: DocRect): void;
	/** 点击已有高亮（查看/管理卡片） */
	onHighlightClick(card: Card, evt: MouseEvent): void;
	/** 读取媒体附件（手写 PNG 回显为 <img>） */
	readAttachment(ref: string): Promise<ArrayBuffer>;
}

/** 拖卡判定阈值：位移超过该值才升级为拖拽入图（否则视为点击弹菜单） */
const CARD_DRAG_THRESHOLD = 5;
/** ghost 文本截断长度 */
const GHOST_TEXT_LIMIT = 60;

/** 无文字可显示时的形态占位（与脑图节点文案一致） */
function shapeFallbackText(type: string | undefined): string {
	switch (type) {
		case "photo":
			return "（照片摘录）";
		case "handwriting":
			return "（手写摘录）";
		case "audio":
			return "（语音摘录）";
		default:
			return "（区域摘录）";
	}
}

/** 拖卡（高亮 → 脑图画布）状态 */
interface CardDragState {
	pointerId: number;
	cardId: string;
	startClient: { x: number; y: number };
	/** 按下的高亮元素（capture 宿主；中途被删则取消拖拽） */
	el: HTMLElement;
	moved: boolean;
}

/**
 * 单页摘录层：已有卡片的高亮回显 + 摘录模式下的拖拽框选 + 拖卡入脑图。
 *
 * 事件模型：
 * - overlay 平时 pointer-events:none（完全穿透，滚轮/点击照常落到页面）
 * - 高亮块单独 pointer-events:auto，可点击（即便不在摘录模式）
 * - 摘录模式开启时 overlay 整层 pointer-events:auto + touch-action:none
 *   （touch-action 是触摸端阻止滚动的唯一可靠手段），并以 setPointerCapture
 *   锁定拖拽；右键取消进行中的拖拽
 *
 * 拖卡入图（非摘录模式）：按住高亮移动超阈值 → ghost 跟随指针（挂 body，
 * pointer-events:none），elementFromPoint 命中脑图画布给落点提示，
 * 松手落卡。pointer capture 下 click 仍会派发到高亮自身，须捕获阶段吞噬。
 */
export class ExcerptLayer {
	/** cardId → 该卡片在高亮层的 DOM 节点（多矩形摘录时为多个） */
	private readonly highlightEls = new Map<string, HTMLElement[]>();
	/** cardId → 卡片对象（点击高亮时回查） */
	private readonly cardsById = new Map<string, Card>();
	/** excerptRef → blob URL（手写 <img> 回显；同 ref 复用，删除/销毁时 revoke） */
	private readonly mediaUrls = new Map<string, string>();
	private dragStart: { x: number; y: number } | null = null;
	private dragPreview: HTMLElement | null = null;
	private excerptMode = false;

	private cardDrag: CardDragState | null = null;
	private ghost: HTMLElement | null = null;
	/** 拖拽刚结束，吞噬紧随的 click（防止松手在高亮上误弹菜单） */
	private suppressClick = false;

	// 绑定宿主引用，便于 destroy 解绑
	private readonly handlers = {
		pointerdown: this.onPointerDown.bind(this),
		pointermove: this.onPointerMove.bind(this),
		pointerup: this.onPointerUp.bind(this),
		pointercancel: this.onPointerCancel.bind(this),
		contextmenu: this.onContextMenu.bind(this),
		clickCapture: this.onClickCapture.bind(this),
	};

	constructor(
		private readonly pageView: PageView,
		private readonly cb: ExcerptLayerCallbacks,
	) {
		const overlay = this.pageView.overlayEl;
		overlay.addEventListener("pointerdown", this.handlers.pointerdown);
		overlay.addEventListener("pointermove", this.handlers.pointermove);
		overlay.addEventListener("pointerup", this.handlers.pointerup);
		overlay.addEventListener("pointercancel", this.handlers.pointercancel);
		overlay.addEventListener("contextmenu", this.handlers.contextmenu);
		// 捕获阶段先于高亮自身的 click 监听执行，才能可靠吞噬
		overlay.addEventListener("click", this.handlers.clickCapture, true);
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
		// 手写摘录有精确 bbox，用 PNG 图片铺满高亮框回显（点击/拖卡复用高亮机制）
		if (card.excerptType === "handwriting" && card.excerptRef && card.rects.length > 0) {
			this.addHandwritingHighlight(card);
			return;
		}
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
			el.addEventListener("click", (evt) =>
				// 从缓存回查最新快照（编辑批注后闭包里的旧对象会过期）
				this.cb.onHighlightClick(this.cardsById.get(card.id) ?? card, evt),
			);
			this.pageView.overlayEl.appendChild(el);
			els.push(el);
		}
		this.highlightEls.set(card.id, els);
	}

	/** 手写摘录回显：透明高亮框内嵌 <img>（PNG 按 bbox 裁剪，铺满即等比） */
	private addHandwritingHighlight(card: Card): void {
		const el = document.createElement("div");
		el.classList.add("marinmind-excerpt-highlight", "marinmind-excerpt-highlight-img");
		el.dataset.cardId = card.id;
		el.dataset.color = card.color ?? "green";
		const pos = normRectToPercent(card.rects[0]);
		el.style.left = pos.left;
		el.style.top = pos.top;
		el.style.width = pos.width;
		el.style.height = pos.height;
		el.addEventListener("click", (evt) =>
			this.cb.onHighlightClick(this.cardsById.get(card.id) ?? card, evt),
		);
		const img = el.createEl("img", { cls: "marinmind-excerpt-img" });
		img.alt = "手写摘录";
		const ref = card.excerptRef!;
		void this.loadMediaUrl(ref).then((url) => {
			if (el.isConnected) {
				img.src = url;
			}
		});
		this.pageView.overlayEl.appendChild(el);
		this.highlightEls.set(card.id, [el]);
	}

	/** 附件 → blob URL（同 ref 复用；destroy/removeHighlight 时统一 revoke） */
	private loadMediaUrl(ref: string): Promise<string> {
		const cached = this.mediaUrls.get(ref);
		if (cached) {
			return Promise.resolve(cached);
		}
		return this.cb.readAttachment(ref).then((bytes) => {
			const url = URL.createObjectURL(new Blob([bytes]));
			this.mediaUrls.set(ref, url);
			return url;
		});
	}

	/** 外部更新卡片（如编辑批注）后同步缓存（高亮位置不变，无需重摆 DOM） */
	updateCardSnapshot(card: Card): void {
		this.cardsById.set(card.id, card);
	}

	/**
	 * 卡片变更统一入口（cardBus 事件驱动，⑨-B）：
	 * 已登记的高亮只更新缓存；未登记（如另一标签页新建的摘录）则回显新增。
	 */
	syncCard(card: Card): void {
		if (this.cardsById.has(card.id)) {
			this.updateCardSnapshot(card);
		} else {
			this.addHighlight(card);
		}
	}

	/** 闪烁该卡的全部高亮块（跳转原文定位反馈）；命中任意块返回 true */
	flashHighlights(cardId: string): boolean {
		const els = this.highlightEls.get(cardId);
		if (!els || els.length === 0) {
			return false;
		}
		for (const el of els) {
			flashEl(el);
		}
		return true;
	}

	/** 删除卡片后即时移除高亮 */
	removeHighlight(cardId: string): void {
		const card = this.cardsById.get(cardId);
		for (const el of this.highlightEls.get(cardId) ?? []) {
			el.remove();
		}
		this.highlightEls.delete(cardId);
		this.cardsById.delete(cardId);
		// 附件随卡片删除：uid 唯一命名 ⇒ 一卡一附件，可安全 revoke 该 ref 的 URL
		if (card?.excerptRef) {
			const url = this.mediaUrls.get(card.excerptRef);
			if (url) {
				URL.revokeObjectURL(url);
				this.mediaUrls.delete(card.excerptRef);
			}
		}
	}

	/** 摘录模式开关（切换 overlay 的事件捕获行为，样式类驱动） */
	setExcerptMode(on: boolean): void {
		this.excerptMode = on;
		this.cancelDrag();
		this.cancelCardDrag();
		this.pageView.overlayEl.classList.toggle("marinmind-excerpt-on", on);
	}

	destroy(): void {
		this.cancelDrag();
		this.cancelCardDrag();
		const overlay = this.pageView.overlayEl;
		overlay.removeEventListener("pointerdown", this.handlers.pointerdown);
		overlay.removeEventListener("pointermove", this.handlers.pointermove);
		overlay.removeEventListener("pointerup", this.handlers.pointerup);
		overlay.removeEventListener("pointercancel", this.handlers.pointercancel);
		overlay.removeEventListener("contextmenu", this.handlers.contextmenu);
		overlay.removeEventListener("click", this.handlers.clickCapture, true);
		this.clearHighlights();
		for (const url of this.mediaUrls.values()) {
			URL.revokeObjectURL(url);
		}
		this.mediaUrls.clear();
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
		if (evt.button !== 0) {
			return;
		}
		this.suppressClick = false; // 清上一次拖拽残留
		if (this.excerptMode) {
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
			return;
		}
		// 非摘录模式：按住高亮预备拖卡入脑图。
		// 不 preventDefault：一旦抑制，部分浏览器会连带抑制后续 click，普通点击弹菜单会失效
		const hl = (evt.target as HTMLElement).closest<HTMLElement>(
			".marinmind-excerpt-highlight",
		);
		if (hl?.dataset.cardId) {
			hl.setPointerCapture(evt.pointerId);
			this.cardDrag = {
				pointerId: evt.pointerId,
				cardId: hl.dataset.cardId,
				startClient: { x: evt.clientX, y: evt.clientY },
				el: hl,
				moved: false,
			};
		}
	}

	private onPointerMove(evt: PointerEvent): void {
		if (this.dragStart) {
			if (this.dragPreview) {
				this.updatePreview(this.toLocal(evt));
			}
			return;
		}
		const d = this.cardDrag;
		if (!d) {
			return;
		}
		// 高亮中途被删（切页/清场/删卡）：capture 已静默失效，立即取消防 ghost 泄漏
		if (!d.el.isConnected) {
			this.cancelCardDrag();
			return;
		}
		if (!d.moved) {
			const dx = evt.clientX - d.startClient.x;
			const dy = evt.clientY - d.startClient.y;
			if (dx * dx + dy * dy < CARD_DRAG_THRESHOLD * CARD_DRAG_THRESHOLD) {
				return;
			}
			d.moved = true;
			this.beginGhost(d);
		}
		this.moveGhost(evt.clientX, evt.clientY);
		const view = updateMindmapDropHint(evt.clientX, evt.clientY);
		this.ghost?.classList.toggle("is-over-mm", !!view);
	}

	private onPointerUp(evt: PointerEvent): void {
		if (this.dragStart) {
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
			return;
		}
		const d = this.cardDrag;
		if (!d) {
			return;
		}
		// 先取最新悬停视图，再清 ghost（ghost 移除后 dropCard 的 elementFromPoint 才准确）
		const view: MarinMindMindmapView | null = updateMindmapDropHint(
			evt.clientX,
			evt.clientY,
		);
		const moved = d.moved;
		const cardId = d.cardId;
		this.cancelCardDrag();
		if (!moved) {
			return; // 未升级为拖拽：放行后续 click 弹菜单
		}
		this.suppressClick = true;
		if (view) {
			const card = this.cardsById.get(cardId);
			if (card) {
				view.dropCard(card, evt.clientX, evt.clientY);
			}
		}
	}

	/** 系统手势/触摸滚动打断指针：拖框与拖卡都直接取消 */
	private onPointerCancel(): void {
		this.cancelDrag();
		this.cancelCardDrag();
	}

	/** 右键取消进行中的拖拽（不弹浏览器菜单） */
	private onContextMenu(evt: MouseEvent): void {
		if (this.dragStart) {
			evt.preventDefault();
			this.cancelDrag();
			return;
		}
		if (this.cardDrag?.moved) {
			evt.preventDefault();
			this.cancelCardDrag();
		}
	}

	/** 捕获阶段吞噬拖拽后紧随的 click（capture 会把 click 派发到高亮自身） */
	private onClickCapture(evt: MouseEvent): void {
		if (this.suppressClick) {
			this.suppressClick = false;
			evt.stopPropagation();
			evt.preventDefault();
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

	// ---------- 拖卡入图 ----------

	/** 升级为拖卡：创建跟随指针的 ghost（挂 body，跨出 leaf 仍可见） */
	private beginGhost(d: CardDragState): void {
		const card = this.cardsById.get(d.cardId);
		const ghost = document.createElement("div");
		ghost.className = "marinmind-drag-ghost";
		const color = document.createElement("div");
		color.className = "marinmind-mm-node-color";
		color.dataset.color = card?.color ?? "";
		ghost.appendChild(color);
		const text = document.createElement("div");
		text.className = "marinmind-drag-ghost-text";
		const raw =
			card?.note ?? card?.excerptText ?? shapeFallbackText(card?.excerptType);
		text.textContent = raw.length > GHOST_TEXT_LIMIT
			? `${raw.slice(0, GHOST_TEXT_LIMIT)}…`
			: raw;
		ghost.appendChild(text);
		document.body.appendChild(ghost);
		this.ghost = ghost;
		document.body.classList.add("marinmind-card-dragging");
		// 兜底：capture 静默丢失（元素被删 / 指针离开窗口）时清 ghost
		d.el.addEventListener("lostpointercapture", () => this.cancelCardDrag(), {
			once: true,
		});
	}

	private moveGhost(x: number, y: number): void {
		if (this.ghost) {
			this.ghost.style.left = `${x + 12}px`;
			this.ghost.style.top = `${y + 12}px`;
		}
	}

	/** 结束/取消拖卡：清 ghost、body 状态类、全部脑图落点提示（幂等） */
	private cancelCardDrag(): void {
		this.cardDrag = null;
		this.ghost?.remove();
		this.ghost = null;
		document.body.classList.remove("marinmind-card-dragging");
		clearMindmapDropHints();
	}
}
