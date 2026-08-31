import type { Card, DocRect, NormPoint } from "../types";
import {
	clearMindmapDropHints,
	updateMindmapDropHint,
} from "../mindmap/mindmap-view";
import type { MarinMindMindmapView } from "../mindmap/mindmap-view";
import type { PageView } from "./page-view";
import { isTinyNormRect, normRectToPercent, pointsToNormRect } from "./rect-utils";
import { highlightFallbackColor } from "./highlight-colors";
import { LassoTracker } from "./lasso-tracker";

/** 通用闪烁反馈：加 marinmind-flash 类 1.5s 后移除（跳转定位视觉锚点） */
export function flashEl(el: HTMLElement): void {
	el.classList.remove("marinmind-flash");
	void el.offsetWidth; // 强制 reflow：连续两次定位同一目标时重启动画
	el.classList.add("marinmind-flash");
	window.setTimeout(() => el.classList.remove("marinmind-flash"), 1500);
}

/**
 * 摘录工具四选一（MarginNote 式）：
 * - text：文字摘录（默认）——overlay 穿透，承载原生文字划选
 * - area / lasso / blank：捕获型工具——overlay 整层接管指针
 */
export type ExcerptTool = "text" | "area" | "lasso" | "blank";

/**
 * 阅读工具行单选状态（㉖ 起含 select）：
 * - hand = 手型只读平移（平移逻辑在 reader-view，此处只负责拦截）
 * - select = 纯文本选择（㉖，对标 Acrobat「文本选择工具」）——overlay 穿透同
 *   text，划选文字仅供复制（Ctrl+C），**不生成卡片**；与 text 的行为差异只在
 *   reader-view 的划选建卡守卫（activeTool === "text"），本层零特殊分支
 */
export type ReaderTool = "select" | "hand" | ExcerptTool;

export interface ExcerptLayerCallbacks {
	/** 拖拽完成且尺寸有效，请求创建 area 卡片 */
	onCreateAreaCard(pageNumber: number, rect: DocRect): void;
	/** 套索完成，请求创建 lasso 卡片（polygon = 原始轮廓，bbox = 包围盒入 rects 供定位） */
	onCreateLassoCard(pageNumber: number, polygon: NormPoint[], bbox: DocRect): void;
	/** 留白点击暂存坐标，reader-view 在此弹出输入框 */
	onBlankPending?(point: { page: number; localX: number; localY: number }): void;
	/** 留白确认后创建 blank 卡片（带最小锚点矩形，供精确定位） */
	onCreateBlankCard(pageNumber: number, anchor: DocRect, note: string): void;
	/** 点击已有高亮（查看/管理卡片） */
	onHighlightClick(card: Card, evt: MouseEvent): void;
	/** 遮挡编辑：拖框完成，请求给目标卡追加一个遮挡矩形（㊷） */
	onOcclusionDraw?(pageNumber: number, rect: DocRect): void;
	/** 点击已有遮挡块（删除该块 / 清除全部 / 预览开关菜单，㊷） */
	onOcclusionClick?(card: Card, index: number, evt: MouseEvent): void;
	/** 读取媒体附件（手写 PNG 回显为 <img>） */
	readAttachment(ref: string): Promise<ArrayBuffer>;
}

/** 拖卡判定阈值：位移超过该值才升级为拖拽入图（否则视为点击弹菜单） */
const CARD_DRAG_THRESHOLD = 5;
/** ghost 文本截断长度 */
const GHOST_TEXT_LIMIT = 60;
/** 最小套索路径像素长度（避免抖动产生无效套索） */
const MIN_LASSO_PATH_LENGTH = 12;

/** 无文字可显示时的形态占位（与脑图节点文案一致） */
function shapeFallbackText(type: string | undefined): string {
	switch (type) {
		case "photo":
			return "（照片摘录）";
		case "handwriting":
			return "（手写摘录）";
		case "audio":
			return "（语音摘录）";
		case "lasso":
			return "（套索摘录）";
		case "blank":
			return "（留白摘录）";
		default:
			return "（区域摘录）";
	}
}

/** 高亮颜色回退（㊳ 起，㊹ 迁入 highlight-colors 纯模块）：card.color 为空时按
 *  摘录形态取默认色——各 add*Highlight 路径与 syncCard 补刷共用同一处定义 */

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
	/** cardId → 遮挡块 DOM（㊷；高亮之外的独立标记层，随卡增删重摆） */
	private readonly occlusionEls = new Map<string, HTMLElement[]>();
	/** 遮挡编辑目标（㊷）：非空时本页 overlay 接管指针画遮挡框（复用 area 拖框） */
	private occlusionTarget: Card | null = null;
	/** 遮挡预览（㊷）：true 时遮挡块显示为实心覆盖（模拟复习正面观感） */
	private occlusionPreview = false;
	/** excerptRef → blob URL（手写 <img> 回显；同 ref 复用，删除/销毁时 revoke） */
	private readonly mediaUrls = new Map<string, string>();
	private dragStart: { x: number; y: number } | null = null;
	private dragPreview: HTMLElement | null = null;
	private excerptMode = false;
	/** 当前阅读工具：text 之外的工具指针归摘录工具所有，高亮只响应点击不进拖卡状态机 */
	private tool: ReaderTool = "text";
	/** 当前摘录色系（㊹ MN3 式按钮循环切色）：拖框/套索预览跟随；reader 在切工具与切色时推送 */
	private toolColor = "yellow";
	/** 当前页的套索追踪器（按需创建/销毁，避免多页同时活跃） */
	private lasso: LassoTracker | null = null;
	/** 留白笔记点击坐标（overlay 本地像素，await TextPromptModal 后回查渲染为卡片） */
	private blankPending: { page: number; localX: number; localY: number } | null = null;

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
		this.syncOcclusionEls(card);
		// 手写摘录有精确 bbox，用 PNG 图片铺满高亮框回显（点击/拖卡复用高亮机制）
		if (card.excerptType === "handwriting" && card.excerptRef && card.rects.length > 0) {
			this.addHandwritingHighlight(card);
			return;
		}
		// 留白摘录渲染为可见的备注胶囊（6px 锚点矩形肉眼不可见，MN 式在页面上直接展示文字）
		if (card.excerptType === "blank" && card.rects.length > 0) {
			this.addBlankHighlight(card);
			return;
		}
		// 套索摘录有原始轮廓多边形：clip-path 裁形保持原状（点击命中也贴合形状）；
		// 存量三列矩形旧卡无 polygon，走下方通用 rects 路径
		if (card.excerptType === "lasso" && card.polygon && card.polygon.length >= 3) {
			this.addLassoHighlight(card);
			return;
		}
		const els: HTMLElement[] = [];
		for (const rect of card.rects) {
			const el = document.createElement("div");
			el.classList.add("marinmind-excerpt-highlight");
			// ㊹ 形态类：文字=下划线（逐行矩形天然逐行下划线），区域=边框
			// （含 polygon 缺失的存量套索旧卡；photo/audio 不走此路径）
			el.classList.add(card.excerptType === "text" ? "marinmind-hl-text" : "marinmind-hl-area");
			el.dataset.cardId = card.id;
			// 颜色变体挂 data-color：每色定义 --mm-hl-line/--mm-hl-tint 两变量供形态规则消费
			el.dataset.color = highlightFallbackColor(card);
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
		el.dataset.color = highlightFallbackColor(card);
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

	/** 留白摘录回显：锚点位置的备注胶囊（文字直接可见，点击弹菜单/可拖入脑图） */
	private addBlankHighlight(card: Card): void {
		const el = document.createElement("div");
		el.classList.add("marinmind-excerpt-highlight", "marinmind-blank-chip");
		el.dataset.cardId = card.id;
		el.dataset.color = highlightFallbackColor(card);
		const pos = normRectToPercent(card.rects[0]);
		el.style.left = pos.left;
		el.style.top = pos.top;
		// 锚点贴近右缘时向左展开，防胶囊溢出页面被 overflow:hidden 裁剪
		if (card.rects[0].x > 0.8) {
			el.style.transform = "translateX(-100%)";
		}
		const label = card.note ?? card.excerptText ?? "留白";
		el.setText(label.length > 40 ? `${label.slice(0, 40)}…` : label);
		el.title = label;
		el.addEventListener("click", (evt) =>
			this.cb.onHighlightClick(this.cardsById.get(card.id) ?? card, evt),
		);
		this.pageView.overlayEl.appendChild(el);
		this.highlightEls.set(card.id, [el]);
	}

	/** 套索摘录回显：包围盒 div + 内嵌 SVG 描边原始轮廓（㊹ MN3 式线稿——只描线不填充）。
	 *  弃 clip-path 裁形：clip 会连 border 一起裁（加不了边框），且命中区贴形过窄；
	 *  改 SVG 后命中区放宽为包围盒（视觉/交互影响可忽略），描边色随 data-color
	 *  的 --mm-hl-line 变量（syncCard 刷 data-color 即级联变色，零 JS 改 path） */
	private addLassoHighlight(card: Card): void {
		const polygon = card.polygon!;
		let minX = 1,
			minY = 1,
			maxX = 0,
			maxY = 0;
		for (const p of polygon) {
			if (p.x < minX) minX = p.x;
			if (p.y < minY) minY = p.y;
			if (p.x > maxX) maxX = p.x;
			if (p.y > maxY) maxY = p.y;
		}
		// 退化保护（polygon 顶点全重合时避免除零）
		const w = Math.max(maxX - minX, 0.0001);
		const h = Math.max(maxY - minY, 0.0001);
		const el = document.createElement("div");
		el.classList.add("marinmind-excerpt-highlight", "marinmind-excerpt-poly");
		el.dataset.cardId = card.id;
		el.dataset.color = highlightFallbackColor(card);
		el.style.left = `${(minX * 100).toFixed(3)}%`;
		el.style.top = `${(minY * 100).toFixed(3)}%`;
		el.style.width = `${(w * 100).toFixed(3)}%`;
		el.style.height = `${(h * 100).toFixed(3)}%`;
		// viewBox 0-100 + preserveAspectRatio:none：顶点用盒内百分比坐标，随盒自由拉伸
		// （漏设这两个属性时百分比坐标被当像素解析——轮廓压缩在盒左上角 100×100px，
		//   随盒尺寸/缩放档变化呈现“套索自动缩放”的错位观感，㊹-A 修复）
		const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
		svg.classList.add("marinmind-poly-svg");
		svg.setAttribute("viewBox", "0 0 100 100");
		svg.setAttribute("preserveAspectRatio", "none");
		const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
		const d =
			polygon
				.map(
					(p, i) =>
						`${i === 0 ? "M" : "L"} ${(((p.x - minX) / w) * 100).toFixed(2)} ${(((p.y - minY) / h) * 100).toFixed(2)}`,
				)
				.join(" ") + " Z";
		path.setAttribute("d", d);
		// 描边宽度不随元素缩放（高倍离屏/缩小窗格下轮廓线粗细恒定）
		path.setAttribute("vector-effect", "non-scaling-stroke");
		svg.appendChild(path);
		el.appendChild(svg);
		el.addEventListener("click", (evt) =>
			this.cb.onHighlightClick(this.cardsById.get(card.id) ?? card, evt),
		);
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
	 * ㊳ 颜色变更时补刷 data-color（高亮位置不变，无需重摆 DOM）。
	 * ㊷ 遮挡数量/几何可能随 update 变化：有遮挡或已渲染过遮挡就整组重摆（元素少，开销可忽略）。
	 */
	syncCard(card: Card): void {
		if (this.cardsById.has(card.id)) {
			this.updateCardSnapshot(card);
			const color = highlightFallbackColor(card);
			for (const el of this.highlightEls.get(card.id) ?? []) {
				el.dataset.color = color;
			}
			if (card.occlusions.length > 0 || this.occlusionEls.has(card.id)) {
				this.syncOcclusionEls(card);
			}
		} else {
			this.addHighlight(card);
		}
	}

	/**
	 * 重摆一张卡的遮挡块（㊷）：默认虚线标记不遮内容；is-preview 实心覆盖。
	 * 遮挡块可点击弹管理菜单；遮挡编辑模式中由 CSS 关闭其指针事件（不挡画框）。
	 */
	private syncOcclusionEls(card: Card): void {
		for (const el of this.occlusionEls.get(card.id) ?? []) {
			el.remove();
		}
		this.occlusionEls.delete(card.id);
		if (card.occlusions.length === 0) {
			return;
		}
		const els: HTMLElement[] = [];
		card.occlusions.forEach((occ, index) => {
			const el = document.createElement("div");
			el.classList.add("marinmind-occlusion");
			if (this.occlusionPreview) {
				el.classList.add("is-preview");
			}
			el.dataset.cardId = card.id;
			const pos = normRectToPercent(occ);
			el.style.left = pos.left;
			el.style.top = pos.top;
			el.style.width = pos.width;
			el.style.height = pos.height;
			// occlusions 每次变更整组重摆，闭包 index 与数组下标始终一致
			el.addEventListener("click", (evt) => {
				const latest = this.cardsById.get(card.id) ?? card;
				this.cb.onOcclusionClick?.(latest, index, evt);
			});
			this.pageView.overlayEl.appendChild(el);
			els.push(el);
		});
		this.occlusionEls.set(card.id, els);
	}

	/** 遮挡编辑模式开关（㊷）：只在目标卡所在页生效（页归一化矩形跨页无意义） */
	setOcclusionTarget(card: Card | null): void {
		this.occlusionTarget =
			card && card.page === this.pageView.pageNumber ? card : null;
		this.cancelDrag();
		this.applyOverlayCapture();
	}

	/** 遮挡预览开关（㊷）：切换全部遮挡块的实心/虚线观感 */
	setOcclusionPreview(on: boolean): void {
		this.occlusionPreview = on;
		for (const els of this.occlusionEls.values()) {
			for (const el of els) {
				el.classList.toggle("is-preview", on);
			}
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
		// 遮挡块随卡清理（㊷）
		for (const el of this.occlusionEls.get(cardId) ?? []) {
			el.remove();
		}
		this.occlusionEls.delete(cardId);
		// 附件随卡片删除：uid 唯一命名 ⇒ 一卡一附件，可安全 revoke 该 ref 的 URL
		if (card?.excerptRef) {
			const url = this.mediaUrls.get(card.excerptRef);
			if (url) {
				URL.revokeObjectURL(url);
				this.mediaUrls.delete(card.excerptRef);
			}
		}
	}

	/**
	 * 切换阅读工具（工具行单选；调用方保证语义单选）。
	 *
	 * 关键：非 text 工具都必须让 overlay 接管指针——此前套索/留白漏开捕获，
	 * overlay 保持穿透导致 pointer/click 事件永远收不到，工具"开了没反应"的根因。
	 * hand（手型）同样要捕获（拦截拖拽做平移、阻断文字选中），但用 grab 光标。
	 * 切换时清掉在途拖框/拖卡/套索路径与留白 pending。
	 */
	setTool(tool: ReaderTool): void {
		this.tool = tool;
		this.excerptMode = tool === "area";
		// 显式切换工具结束遮挡编辑（㊷；遮挡编辑是来自卡片菜单的瞬态模式）
		this.occlusionTarget = null;
		this.cancelDrag();
		this.cancelCardDrag();
		// 套索：按需创建/销毁（单页同时最多一个活跃套索）
		if (tool === "lasso") {
			if (!this.lasso) {
				this.lasso = new LassoTracker(this.pageView);
				this.lasso.setCommitCallback((page, polygon, bbox) =>
				this.cb.onCreateLassoCard(page, polygon, bbox),
			);
			}
		} else {
			this.lasso?.destroy();
			this.lasso = null;
		}
		// 留白：挂/摘 overlay 点击监听（同一引用，防泄漏）
		const overlay = this.pageView.overlayEl;
		if (tool === "blank") {
			if (!this.pendingBlankClick) {
				this.pendingBlankClick = this.onBlankClick.bind(this);
				overlay.addEventListener("click", this.pendingBlankClick);
			}
		} else {
			this.blankPending = null;
			if (this.pendingBlankClick) {
				overlay.removeEventListener("click", this.pendingBlankClick);
				this.pendingBlankClick = null;
			}
		}
		// 光标（crosshair）由 excerpt-on 样式类统一提供，无需内联设置；
		// 手型工具单独用 hand-on 类（grab 光标），摘录捕获用 excerpt-on（crosshair）
		this.applyOverlayCapture();
	}

	/**
	 * 推送当前摘录色系（㊹）：拖框与套索预览元素挂 data-color 着色。
	 * 与 setTool 分离——切色不改工具状态（循环切色发生在工具已激活时）。
	 */
	setToolColor(color: string): void {
		this.toolColor = color;
		this.lasso?.setPreviewColor(color);
	}

	/** overlay 捕获态统一计算（㊷ 抽出）：捕获型工具 或 遮挡编辑模式 都要接管指针 */
	private applyOverlayCapture(): void {
		const overlay = this.pageView.overlayEl;
		const capture =
			this.tool === "area" ||
			this.tool === "lasso" ||
			this.tool === "blank" ||
			this.occlusionTarget != null;
		overlay.classList.toggle("marinmind-excerpt-on", capture);
		overlay.classList.toggle("marinmind-hand-on", this.tool === "hand");
		// 遮挡编辑模式单独挂类（㊿-C）：CSS 关掉高亮块指针事件——遮挡框起点落在
		// 摘录内部也能正常拖画（此前命中高亮元素被 onPointerDown 早退，只能从
		// 摘录外起笔）。area 工具不受影响（高亮保持可点击）
		overlay.classList.toggle("marinmind-occlusion-on", this.occlusionTarget != null);
	}
	/** 留白点击监听器（挂/摘时用同一引用，防泄漏） */
	private pendingBlankClick: ((evt: MouseEvent) => void) | null = null;

	/** 留白点击处理：暂存坐标后回调 onBlankPending（由 reader-view 负责弹 TextPromptModal 收集文字） */
	private onBlankClick(evt: MouseEvent): void {
		// 防止点中高亮块误触发
		const hl = (evt.target as HTMLElement).closest<HTMLElement>(".marinmind-excerpt-highlight");
		if (hl) {
			return;
		}
		const box = this.pageView.overlayEl.getBoundingClientRect();
		this.blankPending = {
			page: this.pageView.pageNumber,
			localX: evt.clientX - box.left,
			localY: evt.clientY - box.top,
		};
		this.cb.onBlankPending?.(this.blankPending);
	}

	destroy(): void {
		this.cancelDrag();
		this.cancelCardDrag();
		// 摘录工具的监听与在途状态一并清理（切文档/关视图不残留）
		this.lasso?.destroy();
		this.lasso = null;
		if (this.pendingBlankClick) {
			this.pageView.overlayEl.removeEventListener("click", this.pendingBlankClick);
			this.pendingBlankClick = null;
		}
		this.blankPending = null;
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
		// 遮挡块随高亮一并清理（㊷）
		for (const els of this.occlusionEls.values()) {
			for (const el of els) {
				el.remove();
			}
		}
		this.occlusionEls.clear();
		this.occlusionTarget = null;
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
		if (this.excerptMode || this.occlusionTarget) {
			// 点在高亮块上不启动拖框（高亮自身可点击查看）；遮挡编辑模式下
			// 高亮与遮挡块都被 CSS 关闭指针事件，不会命中（遮挡块 ㊷；高亮 ㊿-C——
			// 遮挡框起点要能落在摘录内部）
			if (evt.target !== this.pageView.overlayEl) {
				return;
			}
			evt.preventDefault();
			this.pageView.overlayEl.setPointerCapture(evt.pointerId);
			this.dragStart = this.toLocal(evt);

			this.dragPreview = document.createElement("div");
			this.dragPreview.classList.add("marinmind-drag-rect");
			this.dragPreview.dataset.color = this.toolColor;
			this.pageView.overlayEl.appendChild(this.dragPreview);
			this.updatePreview(this.dragStart);
			return;
		}
		// 拖卡入图仅在 text 工具（overlay 穿透的阅读态）启用：捕获型工具接管指针期间
		// 起笔在高亮上会与 setPointerCapture 抢路由（lasso 起笔在高亮上应画套索而非拖卡）
		if (this.tool !== "text") {
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
			// 遮挡编辑模式（㊷）：拖框结果追加给目标卡而非建新卡
			if (this.occlusionTarget) {
				this.cb.onOcclusionDraw?.(this.pageView.pageNumber, rect);
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
		// ㊺ 节点色条已随三栏化删除，ghost 改用独立竖条类（观感不变）
		color.className = "marinmind-drag-ghost-color";
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
