import { ItemView, Menu, Notice } from "obsidian";
import type { ViewStateResult, WorkspaceLeaf } from "obsidian";
import type MarinMindPlugin from "../main";
import type { Card, MindmapNodeWithCard } from "../types";
import { TextPromptModal } from "../reader/note-edit-modal";
import { CardPickerModal } from "./card-picker-modal";
import { ConfirmModal } from "./confirm-modal";
import {
	buildChildrenMap,
	dropPlacement,
	edgePath,
	fitViewportTransform,
	isDescendantOrSelf,
	layoutTree,
	MAX_SCALE,
	MIN_SCALE,
	NODE_HEIGHT_EST,
	NODE_WIDTH,
	suggestRootPosition,
	visibleNodes,
} from "./mindmap-graph";
import { MindmapPickerModal } from "./mindmap-picker-modal";

/** 思维导图视图的 viewType */
export const MINDMAP_VIEW_TYPE = "marinmind-mindmap";

/** 活跃脑图视图注册表（onOpen 加入 / onClose 移除），供阅读器拖拽入图定位目标 */
const activeViews = new Set<MarinMindMindmapView>();

/**
 * 更新全部活跃脑图的落点提示（悬停的 viewport/节点上高亮类）。
 * 返回指针悬停的视图（无则 null）——阅读器拖卡的 pointermove/pointerup 调用。
 */
export function updateMindmapDropHint(
	x: number,
	y: number,
): MarinMindMindmapView | null {
	let hovered: MarinMindMindmapView | null = null;
	for (const view of activeViews) {
		if (view.updateDropHint(x, y)) {
			hovered = view;
		}
	}
	return hovered;
}

/** 清除全部活跃脑图的落点提示（拖拽结束/取消时调用） */
export function clearMindmapDropHints(): void {
	for (const view of activeViews) {
		view.clearDropHint();
	}
}

/** Ctrl+滚轮缩放的指数步进系数 */
const ZOOM_SENSITIVITY = 0.0015;
/** 拖拽判定阈值：位移超过该值才算拖动（否则视为点击/右键取消） */
const DRAG_THRESHOLD = 4;

/** 拖拽状态机：节点拖动 / 画布平移，单 pointerdown 入口分流 */
type DragState =
	| {
			kind: "node";
			nodeId: string;
			el: HTMLElement;
			/** 按下时的客户端坐标（阈值判定用） */
			startClient: { x: number; y: number };
			/** 节点原始世界坐标（右键取消时还原） */
			startPos: { x: number; y: number };
			/** 抓取点在节点内的世界偏移（拖动跟随用） */
			grabOffset: { x: number; y: number };
			moved: boolean;
	  }
	| {
			kind: "pan";
			startClient: { x: number; y: number };
			/** 按下时的平移量（差值跟随） */
			startT: { x: number; y: number };
	  };

/**
 * MarinMind 思维导图视图：卡片即节点，拖拽组树，跳回原文。
 *
 * 结构：viewport（事件宿主）→ world（单一 transform）→ svg 连线 + 节点 div。
 * 节点 left/top 与 SVG path 均为未缩放世界坐标，天然对齐；
 * 拖动过程只改 DOM 与内存快照，pointerup 才写库。
 */
export class MarinMindMindmapView extends ItemView {
	private readonly plugin: MarinMindPlugin;

	private viewportEl: HTMLElement | null = null;
	private worldEl: HTMLElement | null = null;
	private edgesSvg: SVGSVGElement | null = null;
	private emptyEl: HTMLElement | null = null;
	private titleSpan: HTMLElement | null = null;
	private countSpan: HTMLElement | null = null;

	/** setState 暂存的待打开图（onOpen 消费；骨架已就绪时立即应用） */
	private pendingMapId: string | null = null;
	private mapId: string | null = null;
	/** 节点内存快照（打开/刷新时全量拉取，写库后同步更新） */
	private nodes: MindmapNodeWithCard[] = [];
	private readonly nodeEls = new Map<string, HTMLElement>();

	/** 世界变换：world.style.transform = translate(tx,ty) scale(s) */
	/** 世界变换（纯内存不持久）：平移 + 缩放 */
	private tx = 0;
	private ty = 0;
	private scale = 1;
	private drag: DragState | null = null;
	/** cardBus 退订器（onClose 统一退订防泄漏） */
	private cardBusOffs: Array<() => void> = [];

	constructor(leaf: WorkspaceLeaf, plugin: MarinMindPlugin) {
		super(leaf);
		this.plugin = plugin;

		// 工具栏：添加已有卡片 / 新建文字卡片 / 自动布局 / 手动刷新（跨视图改卡后同步）
		this.addAction("list-plus", "添加卡片", () => this.openCardPicker());
		this.addAction("plus", "新建文字卡片", () => this.createTextCard());
		this.addAction("layout-template", "自动布局", () => this.autoLayout());
		this.addAction("rotate-cw", "刷新", () => this.refresh());
	}

	getViewType(): string {
		return MINDMAP_VIEW_TYPE;
	}

	getDisplayText(): string {
		return "MarinMind 思维导图";
	}

	getIcon(): string {
		return "git-fork";
	}

	async onOpen(): Promise<void> {
		activeViews.add(this); // 注册先于任何 await（拖放目标解析用）
		this.subscribeCardBus();
		await this.plugin.whenReady();
		if (!this.plugin.db) {
			this.contentEl.empty();
			this.contentEl.classList.add("marinmind-mindmap");
			const tip = document.createElement("p");
			tip.textContent = "MarinMind 数据库未就绪，无法加载思维导图。";
			tip.className = "marinmind-reader-tip";
			this.contentEl.appendChild(tip);
			return;
		}
		this.buildSkeleton();
		const pending = this.pendingMapId;
		this.pendingMapId = null;
		if (pending) {
			this.loadMap(pending);
		} else {
			this.showPicker();
		}
	}

	/**
	 * 图 id 经 setViewState state 传入（重启恢复标签页 / openMindmap 复用切换）。
	 * setState 先于 onOpen 执行：骨架未建时只暂存，由 onOpen 消费；
	 * 骨架已建（视图已打开）时立即切换图。
	 */
	async setState(
		state: { mapId?: string } & Record<string, unknown>,
		result: ViewStateResult,
	): Promise<void> {
		this.pendingMapId = typeof state.mapId === "string" ? state.mapId : null;
		await super.setState(state, result);
		if (this.viewportEl && this.pendingMapId) {
			const id = this.pendingMapId;
			this.pendingMapId = null;
			this.loadMap(id);
		}
	}

	getState(): Record<string, unknown> {
		return this.mapId ? { mapId: this.mapId } : {};
	}

	protected async onClose(): Promise<void> {
		for (const off of this.cardBusOffs) {
			off();
		}
		this.cardBusOffs = [];
		activeViews.delete(this);
		this.clearDropHint();
		this.drag = null;
		this.nodeEls.clear();
	}

	// ---------- 卡片变更事件（跨视图同步，⑨-B） ----------

	/** 订阅卡片变更/删除（回调只做内存与 DOM 更新，禁止写库——契约见 card-bus.ts） */
	private subscribeCardBus(): void {
		this.cardBusOffs.push(
			this.plugin.cardBus.onCardChanged((card) => this.applyCardUpdate(card)),
			this.plugin.cardBus.onCardRemoved((cardId) => this.applyCardRemoval(cardId)),
		);
	}

	/** 卡片被改（批注/OCR 文本/转闪卡等）：图内命中节点就地更新文本，不动布局 */
	private applyCardUpdate(card: Card): void {
		const local = this.nodes.find((n) => n.cardId === card.id);
		if (!local) {
			return; // 不在当前图：与本视图无关
		}
		local.card = card;
		const text = this.nodeEls.get(local.id)?.querySelector<HTMLElement>(".marinmind-mm-node-text");
		if (text) {
			text.textContent = this.nodeText(card);
		}
	}

	/** 卡片被删：DB 级联已删节点行（SET NULL 上浮语义一致），本地同步移除节点 */
	private applyCardRemoval(cardId: string): void {
		const local = this.nodes.find((n) => n.cardId === cardId);
		if (local) {
			this.removeNodeLocal(local.id);
		}
	}

	// ---------- 数据加载 ----------

	/** 打开指定图（图已被删则回选图器） */
	public loadMap(mapId: string): void {
		const map = this.plugin.mindmaps.get(mapId);
		if (!map) {
			new Notice("该思维导图已不存在");
			this.clearMap();
			this.showPicker();
			return;
		}
		this.mapId = mapId;
		this.nodes = this.plugin.mindmaps.listNodes(mapId);
		this.rebuildWorld();
		this.updateHeader();
	}

	/** 手动刷新：重新拉取当前图（跨视图改卡/删卡后的兜底同步） */
	private refresh(): void {
		if (this.mapId) {
			this.loadMap(this.mapId);
		} else {
			this.showPicker();
		}
	}

	private clearMap(): void {
		this.mapId = null;
		this.nodes = [];
		this.rebuildWorld();
		this.updateHeader();
	}

	/** 弹出选图器（命令入口 / 空态 / 删除图后） */
	private showPicker(): void {
		new MindmapPickerModal(this.app, this.plugin, (map) => this.loadMap(map.id)).open();
	}

	// ---------- 自动布局（⑨-C） ----------

	/**
	 * 一键自动布局：树形层级整列（layoutTree 纯函数）→ applyLayout 单事务写回 →
	 * 全量重拉 → 视口适配。覆盖全部节点手动位置（含折叠隐藏的子树），先确认再执行。
	 */
	private autoLayout(): void {
		if (!this.mapId) {
			new Notice("请先打开或创建一张脑图");
			return;
		}
		if (this.nodes.length === 0) {
			new Notice("画布为空，无需布局");
			return;
		}
		new ConfirmModal(
			this.app,
			"自动布局",
			"将按树形层级重新排列全部节点（含折叠隐藏的子树），覆盖当前手动位置。继续吗？",
			() => {
				if (!this.mapId) {
					return;
				}
				this.plugin.mindmaps.applyLayout(this.mapId, layoutTree(this.nodes));
				this.loadMap(this.mapId);
				this.fitToContent();
			},
		).open();
	}

	/** 视口适配：可见节点包围盒缩放并居中（折叠隐藏的子树不参与适配） */
	private fitToContent(): void {
		const vp = this.viewportEl;
		if (!vp) {
			return;
		}
		const visible = visibleNodes(this.nodes);
		let minX = Infinity;
		let minY = Infinity;
		let maxX = -Infinity;
		let maxY = -Infinity;
		for (const n of this.nodes) {
			if (!visible.has(n.id)) {
				continue;
			}
			const h = this.nodeEls.get(n.id)?.offsetHeight ?? NODE_HEIGHT_EST;
			minX = Math.min(minX, n.x);
			minY = Math.min(minY, n.y);
			maxX = Math.max(maxX, n.x + NODE_WIDTH);
			maxY = Math.max(maxY, n.y + h);
		}
		if (minX === Infinity) {
			return; // 无可见节点
		}
		const rect = vp.getBoundingClientRect();
		const t = fitViewportTransform(
			{ minX, minY, maxX, maxY },
			{ width: rect.width, height: rect.height },
			40,
		);
		this.tx = t.tx;
		this.ty = t.ty;
		this.scale = t.scale;
		this.applyTransform();
	}

	// ---------- 渲染 ----------

	/** 一次性搭好 header + viewport + world + svg + 提示条骨架（onOpen 调用） */
	private buildSkeleton(): void {
		this.contentEl.empty();
		this.contentEl.classList.add("marinmind-mindmap");

		// header：图名 + 节点数 + 重命名 / 删除
		const header = this.contentEl.createDiv({ cls: "marinmind-mm-header" });
		this.titleSpan = header.createSpan({ cls: "marinmind-mm-title" });
		this.titleSpan.textContent = "未打开脑图";
		this.countSpan = header.createSpan({ cls: "marinmind-mm-count" });
		header.createEl("button", {
			cls: "marinmind-mm-header-btn clickable-icon",
			attr: { "aria-label": "重命名" },
			text: "✏️",
		}).addEventListener("click", () => this.renameMap());
		header.createEl("button", {
			cls: "marinmind-mm-header-btn clickable-icon",
			attr: { "aria-label": "删除脑图" },
			text: "🗑️",
		}).addEventListener("click", () => this.deleteMap());

		// 画布：事件宿主是 viewport（world 是 0×0 的 transform 容器，收不到事件）
		this.viewportEl = this.contentEl.createDiv({ cls: "marinmind-mm-viewport" });
		this.worldEl = this.viewportEl.createDiv({ cls: "marinmind-mm-world" });
		this.edgesSvg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
		this.edgesSvg.setAttribute("class", "marinmind-mm-edges");
		this.worldEl.appendChild(this.edgesSvg);

		// 空态提示（无节点时显示，不挡指针）
		this.emptyEl = this.viewportEl.createDiv({ cls: "marinmind-mm-empty" });
		this.emptyEl.textContent = "画布空白：双击新建文字卡片，或用右上角工具栏添加卡片";

		const hint = this.contentEl.createDiv({ cls: "marinmind-mm-hint" });
		hint.textContent = "拖节点到另一节点=连线（挂为子节点）· 拖空白=平移 · Ctrl+滚轮=缩放 · 双击空白=新建卡片 · 节点右缘 ▾=折叠/展开子树 · 右键节点=更多操作";

		this.registerCanvasEvents();
		this.applyTransform();
	}

	/** 全量重建 world 内的节点与连线（loadMap / 刷新；折叠隐藏的节点不建 DOM） */
	private rebuildWorld(): void {
		if (!this.worldEl) {
			return;
		}
		this.nodeEls.clear();
		this.edgesSvg?.replaceChildren();
		for (const child of Array.from(this.worldEl.children)) {
			if (child !== this.edgesSvg) {
				child.remove();
			}
		}
		const visible = visibleNodes(this.nodes);
		for (const node of this.nodes) {
			if (!visible.has(node.id)) {
				continue;
			}
			this.createNodeEl(node);
		}
		this.drawEdges();
	}

	private createNodeEl(node: MindmapNodeWithCard): void {
		const world = this.worldEl;
		if (!world) {
			return;
		}
		const el = document.createElement("div");
		el.className = "marinmind-mm-node";
		el.dataset.nodeId = node.id;
		el.style.left = `${node.x}px`;
		el.style.top = `${node.y}px`;

		const color = document.createElement("div");
		color.className = "marinmind-mm-node-color";
		color.dataset.color = node.card.color ?? "";
		el.appendChild(color);

		const text = document.createElement("div");
		text.className = "marinmind-mm-node-text";
		text.textContent = this.nodeText(node.card);
		el.appendChild(text);

		const meta = document.createElement("div");
		meta.className = "marinmind-mm-node-meta";
		meta.textContent = node.card.documentId
			? node.card.page != null
				? `第 ${node.card.page} 页`
				: "文档卡片"
			: "手工";
		el.appendChild(meta);

		// 折叠开关（仅有子节点的节点显示）：chevron + 折叠时的后代计数。
		// pointerdown/click 双 stopPropagation：不触发节点拖拽与画布平移/双击。
		if (this.nodes.some((n) => n.parentId === node.id)) {
			const toggle = document.createElement("button");
			toggle.className = "marinmind-mm-toggle";
			toggle.dataset.collapsed = node.collapsed ? "1" : "0";
			toggle.setAttribute(
				"aria-label",
				node.collapsed ? "展开子树" : "折叠子树",
			);
			toggle.textContent = node.collapsed
				? `▸ ${this.descendantCount(node.id)}`
				: "▾";
			toggle.addEventListener("pointerdown", (evt) => evt.stopPropagation());
			toggle.addEventListener("click", (evt) => {
				evt.stopPropagation();
				this.toggleCollapsed(node.id);
			});
			el.appendChild(toggle);
		}

		world.appendChild(el);
		this.nodeEls.set(node.id, el);
	}

	/** 全部后代数（折叠徽标计数用，含折叠隐藏的后代） */
	private descendantCount(nodeId: string): number {
		const childrenMap = buildChildrenMap(this.nodes);
		const visited = new Set<string>([nodeId]);
		let count = 0;
		const stack = [...(childrenMap.get(nodeId) ?? [])];
		while (stack.length > 0) {
			const cur = stack.pop()!;
			if (visited.has(cur.id)) {
				continue; // 脏数据成环防御
			}
			visited.add(cur.id);
			count += 1;
			stack.push(...(childrenMap.get(cur.id) ?? []));
		}
		return count;
	}

	/**
	 * 切换子树折叠态：写库持久化（schema v3）后全量重拉重建。
	 * loadMap 不触碰 tx/ty/scale——平移缩放视图保持不变。
	 */
	private toggleCollapsed(nodeId: string): void {
		if (!this.mapId) {
			return;
		}
		const node = this.nodes.find((n) => n.id === nodeId);
		if (!node) {
			return;
		}
		this.plugin.mindmaps.setCollapsed(nodeId, !node.collapsed);
		this.loadMap(this.mapId);
	}

	/** 节点显示文本：批注 > 摘录文字 > 形态占位 */
	private nodeText(card: Card): string {
		if (card.note) {
			return card.note;
		}
		if (card.excerptText) {
			return card.excerptText;
		}
		return card.excerptType === "area" ? "（区域摘录）" : `（${card.excerptType} 摘录）`;
	}

	/** 全量重画连线（父右缘中点 → 子左缘中点的三次贝塞尔）；任一端被折叠隐藏的边跳过 */
	private drawEdges(): void {
		const svg = this.edgesSvg;
		if (!svg) {
			return;
		}
		svg.replaceChildren();
		const byId = new Map(this.nodes.map((n) => [n.id, n]));
		const visible = visibleNodes(this.nodes);
		for (const n of this.nodes) {
			if (!n.parentId || !visible.has(n.id)) {
				continue;
			}
			const parent = byId.get(n.parentId);
			if (!parent || !visible.has(parent.id)) {
				continue;
			}
			const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
			path.setAttribute("class", "marinmind-mm-edge");
			path.setAttribute(
				"d",
				edgePath(
					{ x: parent.x, y: parent.y, h: this.nodeEls.get(parent.id)?.offsetHeight },
					{ x: n.x, y: n.y, h: this.nodeEls.get(n.id)?.offsetHeight },
				),
			);
			svg.appendChild(path);
		}
	}

	private updateHeader(): void {
		const map = this.mapId ? this.plugin.mindmaps.get(this.mapId) : undefined;
		if (this.titleSpan) {
			this.titleSpan.textContent = map?.name ?? "未打开脑图";
		}
		if (this.countSpan) {
			this.countSpan.textContent = this.nodes.length ? `${this.nodes.length} 个节点` : "";
		}
		if (this.emptyEl) {
			this.emptyEl.style.display = this.nodes.length ? "none" : "";
		}
	}

	// ---------- 拖拽入图（阅读器高亮拖卡落点） ----------

	/**
	 * 落点提示：viewport 含指针 → 画布轮廓高亮；指针下是本视图节点 → 节点高亮。
	 * 返回是否悬停在本视图（供模块级 updateMindmapDropHint 汇总）。
	 */
	public updateDropHint(x: number, y: number): boolean {
		this.clearDropHint();
		const vp = this.viewportEl;
		if (!vp) {
			return false;
		}
		const rect = vp.getBoundingClientRect();
		const inside =
			x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom;
		if (!inside) {
			return false;
		}
		vp.classList.add("marinmind-mm-droptarget");
		const hitId = this.hitNodeAt(x, y);
		if (hitId) {
			this.nodeEls.get(hitId)?.classList.add("marinmind-mm-node-droptarget");
		}
		return true;
	}

	/** 清除本视图的落点提示类 */
	public clearDropHint(): void {
		this.viewportEl?.classList.remove("marinmind-mm-droptarget");
		for (const el of this.nodeEls.values()) {
			el.classList.remove("marinmind-mm-node-droptarget");
		}
	}

	/** 拖卡落点：命中节点=挂其子（标准子落位），空白=根（指针世界坐标） */
	public dropCard(card: Card, x: number, y: number): void {
		this.clearDropHint();
		if (!this.mapId) {
			new Notice("请先打开或创建一张脑图");
			return;
		}
		const hitId = this.hitNodeAt(x, y);
		const { parentId, x: wx, y: wy } = dropPlacement(this.nodes, hitId, this.toWorld(x, y));
		const added = this.plugin.mindmaps.addNode(
			this.mapId,
			card.id,
			parentId,
			Math.round(wx),
			Math.round(wy),
		);
		if (!added) {
			new Notice("该卡片已在此图中");
			return;
		}
		this.nodes.push(added);
		this.createNodeEl(added);
		this.drawEdges();
		this.updateHeader();
		new Notice(hitId ? "已挂为子节点" : "已添加为根节点");
	}

	/**
	 * 指针下的本视图节点 id（无则 null）。
	 * 归属验证 nodeEls.get(id) === el：多脑图同屏时 elementFromPoint 可能命中他图节点。
	 */
	private hitNodeAt(x: number, y: number): string | null {
		const hit = document
			.elementFromPoint(x, y)
			?.closest<HTMLElement>(".marinmind-mm-node");
		const id = hit?.dataset.nodeId;
		if (!id || this.nodeEls.get(id) !== hit) {
			return null;
		}
		return id;
	}

	// ---------- 坐标与变换 ----------

	private applyTransform(): void {
		if (this.worldEl) {
			this.worldEl.style.transform = `translate(${this.tx}px, ${this.ty}px) scale(${this.scale})`;
		}
	}

	/** 客户端坐标 → 世界坐标（唯一换算点） */
	private toWorld(clientX: number, clientY: number): { x: number; y: number } {
		const rect = this.viewportEl!.getBoundingClientRect();
		return {
			x: (clientX - rect.left - this.tx) / this.scale,
			y: (clientY - rect.top - this.ty) / this.scale,
		};
	}

	// ---------- 画布事件 ----------

	private registerCanvasEvents(): void {
		const vp = this.viewportEl;
		if (!vp) {
			return;
		}

		this.registerDomEvent(vp, "pointerdown", (evt) => this.onPointerDown(evt));

		this.registerDomEvent(vp, "pointermove", (evt) => this.onPointerMove(evt));

		this.registerDomEvent(vp, "pointerup", (evt) => this.onPointerUp(evt));
		// pointer 被 系统/浏览器 打断（如触摸滚动手势接管）：节点拖动还原，平移直接结束
		this.registerDomEvent(vp, "pointercancel", () => this.cancelDrag());

		this.registerDomEvent(vp, "contextmenu", (evt) => this.onContextMenu(evt));

		this.registerDomEvent(vp, "dblclick", (evt) => this.onDblClick(evt));

		// passive:false 才能阻断默认缩放/滚动（registerDomEvent 已核实支持第三参）
		this.registerDomEvent(vp, "wheel", (evt) => this.onWheel(evt), { passive: false });
	}

	private onPointerDown(evt: PointerEvent): void {
		if (evt.button !== 0 || this.drag) {
			return;
		}
		const nodeEl = (evt.target as HTMLElement).closest<HTMLElement>(".marinmind-mm-node");
		if (nodeEl?.dataset.nodeId) {
			// 节点拖动预备：未超阈值前不移动 DOM
			const node = this.nodes.find((n) => n.id === nodeEl.dataset.nodeId);
			if (!node) {
				return;
			}
			const w = this.toWorld(evt.clientX, evt.clientY);
			this.drag = {
				kind: "node",
				nodeId: node.id,
				el: nodeEl,
				startClient: { x: evt.clientX, y: evt.clientY },
				startPos: { x: node.x, y: node.y },
				grabOffset: { x: node.x - w.x, y: node.y - w.y },
				moved: false,
			};
			// 指针捕获到目标元素：后续事件仍以其为 target 并冒泡到 viewport 监听
			(evt.target as HTMLElement).setPointerCapture?.(evt.pointerId);
		} else if (!this.emptyEl?.contains(evt.target as Node)) {
			this.drag = {
				kind: "pan",
				startClient: { x: evt.clientX, y: evt.clientY },
				startT: { x: this.tx, y: this.ty },
			};
			(this.viewportEl!).setPointerCapture?.(evt.pointerId);
		}
	}

	private onPointerMove(evt: PointerEvent): void {
		const drag = this.drag;
		if (!drag) {
			return;
		}
		if (drag.kind === "pan") {
			this.tx = drag.startT.x + (evt.clientX - drag.startClient.x);
			this.ty = drag.startT.y + (evt.clientY - drag.startClient.y);
			this.applyTransform();
			return;
		}
		// 阈值判定：超过才升级为拖动
		if (!drag.moved) {
			const dx = evt.clientX - drag.startClient.x;
			const dy = evt.clientY - drag.startClient.y;
			if (dx * dx + dy * dy < DRAG_THRESHOLD * DRAG_THRESHOLD) {
				return;
			}
			drag.moved = true;
			// 给 elementFromPoint 让路：命中检测需要穿透被拖节点自身
			drag.el.style.pointerEvents = "none";
			drag.el.classList.add("marinmind-mm-dragging");
		}
		const w = this.toWorld(evt.clientX, evt.clientY);
		const node = this.nodes.find((n) => n.id === drag.nodeId);
		if (!node) {
			return;
		}
		node.x = w.x - drag.grabOffset.x;
		node.y = w.y - drag.grabOffset.y;
		drag.el.style.left = `${node.x}px`;
		drag.el.style.top = `${node.y}px`;
		this.drawEdges();
	}

	private onPointerUp(evt: PointerEvent): void {
		const drag = this.drag;
		if (!drag) {
			return;
		}
		this.drag = null;
		if (drag.kind === "pan" || !drag.moved) {
			return; // 平移结束 / 未升级的点击：无写库
		}
		drag.el.style.pointerEvents = "";
		drag.el.classList.remove("marinmind-mm-dragging");

		const node = this.nodes.find((n) => n.id === drag.nodeId);
		if (!node) {
			return;
		}
		// 命中检测：松手点下的最深节点（被拖节点已 pointerEvents:none 穿透）
		const hit = document
			.elementFromPoint(evt.clientX, evt.clientY)
			?.closest<HTMLElement>(".marinmind-mm-node");
		const hitId = hit?.dataset.nodeId;
		const x = Math.round(node.x);
		const y = Math.round(node.y);

		if (hitId && hitId !== node.id) {
			if (isDescendantOrSelf(this.nodes, node.id, hitId)) {
				new Notice("不能移动到自己的子节点上");
				// 坐标仍落库（与 MarginNote 一致：拒绝的是父子关系，不是位置）
				this.plugin.mindmaps.moveNode(node.id, x, y);
				this.drawEdges();
				return;
			}
			const updated = this.plugin.mindmaps.setParent(node.id, hitId);
			if (updated) {
				node.parentId = updated.parentId;
			}
		}
		this.plugin.mindmaps.moveNode(node.id, x, y);
		node.x = x;
		node.y = y;
		drag.el.style.left = `${x}px`;
		drag.el.style.top = `${y}px`;
		this.drawEdges();
	}

	/** 右键：拖动中=取消还原；节点=操作菜单；空白=放行 Obsidian 默认菜单 */
	private onContextMenu(evt: MouseEvent): void {
		const drag = this.drag;
		if (drag?.kind === "node" && drag.moved) {
			evt.preventDefault();
			this.cancelDrag();
			return;
		}
		const nodeEl = (evt.target as HTMLElement).closest<HTMLElement>(".marinmind-mm-node");
		const node = nodeEl?.dataset.nodeId
			? this.nodes.find((n) => n.id === nodeEl.dataset.nodeId)
			: undefined;
		if (node) {
			evt.preventDefault();
			this.showNodeMenu(node, evt);
		}
	}

	/** 还原节点拖动到按下前位置 */
	private cancelDrag(): void {
		const drag = this.drag;
		this.drag = null;
		if (!drag || drag.kind !== "node") {
			return;
		}
		drag.el.style.pointerEvents = "";
		drag.el.classList.remove("marinmind-mm-dragging");
		if (drag.moved) {
			const node = this.nodes.find((n) => n.id === drag.nodeId);
			if (node) {
				node.x = drag.startPos.x;
				node.y = drag.startPos.y;
				drag.el.style.left = `${node.x}px`;
				drag.el.style.top = `${node.y}px`;
				this.drawEdges();
			}
		}
	}

	/** 双击空白：就地新建文字卡片（手工卡，无文档归属） */
	private onDblClick(evt: MouseEvent): void {
		if ((evt.target as HTMLElement).closest(".marinmind-mm-node") || !this.mapId) {
			return;
		}
		const pos = this.toWorld(evt.clientX, evt.clientY);
		new TextPromptModal(
			this.app,
			{ title: "新建文字卡片", placeholder: "输入卡片内容…" },
			(text) => {
				if (!text || !this.mapId) {
					return;
				}
				const card = this.plugin.cards.create({
					documentId: null,
					page: null,
					rects: [],
					excerptType: "text",
					excerptText: text,
				});
				const added = this.plugin.mindmaps.addNode(
					this.mapId,
					card.id,
					null,
					Math.round(pos.x),
					Math.round(pos.y),
				);
				if (added) {
					this.nodes.push(added);
					this.createNodeEl(added);
					this.drawEdges();
					this.updateHeader();
				}
			},
		).open();
	}

	/** 滚轮：Ctrl/Cmd=指针居中缩放；普通=平移 */
	private onWheel(evt: WheelEvent): void {
		evt.preventDefault();
		if (evt.ctrlKey || evt.metaKey) {
			const rect = this.viewportEl!.getBoundingClientRect();
			const px = evt.clientX - rect.left;
			const py = evt.clientY - rect.top;
			const k = Math.exp(-evt.deltaY * ZOOM_SENSITIVITY);
			const next = Math.min(MAX_SCALE, Math.max(MIN_SCALE, this.scale * k));
			if (next === this.scale) {
				return;
			}
			// 指针下的世界点保持不动
			const factor = next / this.scale;
			this.tx = px - (px - this.tx) * factor;
			this.ty = py - (py - this.ty) * factor;
			this.scale = next;
			this.applyTransform();
		} else {
			this.tx -= evt.deltaX;
			this.ty -= evt.deltaY;
			this.applyTransform();
		}
	}

	// ---------- 菜单与操作 ----------

	/** 节点右键菜单：跳原文 / 编辑批注 / 闪卡开关 / 移出脑图 / 删除卡片 */
	private showNodeMenu(node: MindmapNodeWithCard, evt: MouseEvent): void {
		const card = node.card;
		const info = card.note ?? card.excerptText ?? "区域摘录";
		const menu = new Menu();
		menu.addItem((item) =>
			item
				.setTitle(info.length > 30 ? `${info.slice(0, 30)}…` : info)
				.setIcon("sticky-note")
				.setDisabled(true),
		);
		menu.addSeparator();
		if (card.documentId && card.page != null) {
			menu.addItem((item) =>
				item
					.setTitle("跳转原文")
					.setIcon("book-open")
					.onClick(() => void this.plugin.openCardSource(card)),
			);
		}
		menu.addItem((item) =>
			item
				.setTitle("编辑批注")
				.setIcon("pencil")
				.onClick(() => this.editNote(node)),
		);
		// 闪卡开关：每次打开菜单即时查 DB（卡片可能在会话外被改变）
		const isFlashcard = this.plugin.reviews.get(card.id)?.isFlashcard ?? false;
		menu.addItem((item) =>
			item
				.setTitle(isFlashcard ? "取消闪卡" : "转为闪卡")
				.setIcon(isFlashcard ? "layers" : "graduation-cap")
				.onClick(() => {
					if (isFlashcard) {
						this.plugin.reviews.disable(card.id);
					} else {
						this.plugin.reviews.enable(card.id);
					}
				}),
		);
		menu.addItem((item) =>
			item
				.setTitle("移出脑图")
				.setIcon("unlink")
				.onClick(() => {
					this.plugin.mindmaps.removeNode(node.id);
					this.removeNodeLocal(node.id);
				}),
		);
		menu.addItem((item) =>
			item
				.setTitle("删除卡片")
				.setIcon("trash-2")
				.onClick(() => {
					// 节点移除由 cardBus 删除事件回环完成（DB 级联删行 + applyCardRemoval）
					this.plugin.cards.delete(card.id);
				}),
		);
		menu.showAtMouseEvent(evt);
	}

	/** 编辑批注：只写库，节点文本就地更新由 cardBus 事件回环完成（⑨-B） */
	private editNote(node: MindmapNodeWithCard): void {
		new TextPromptModal(
			this.app,
			{ title: "编辑批注", initialText: node.card.note ?? "" },
			(note) => {
				this.plugin.cards.update(node.card.id, { note });
			},
		).open();
	}

	/** 本地移除节点（库已删）：子上浮为根原位保留，仅重画连线 */
	private removeNodeLocal(nodeId: string): void {
		for (const n of this.nodes) {
			if (n.parentId === nodeId) {
				n.parentId = null;
			}
		}
		this.nodes = this.nodes.filter((n) => n.id !== nodeId);
		this.nodeEls.get(nodeId)?.remove();
		this.nodeEls.delete(nodeId);
		this.drawEdges();
		this.updateHeader();
	}

	/** 工具栏"添加卡片"：选择器挑最近卡片，根节点区顺延落位 */
	private openCardPicker(): void {
		if (!this.mapId) {
			new Notice("请先打开或创建一张脑图");
			return;
		}
		const mapId = this.mapId;
		new CardPickerModal(this.app, this.plugin, mapId, (card) => {
			const pos = suggestRootPosition(
				this.nodes.filter((n) => n.parentId === null).map((n) => ({ x: n.x, y: n.y })),
			);
			const added = this.plugin.mindmaps.addNode(mapId, card.id, null, pos.x, pos.y);
			if (!added) {
				new Notice("该卡片已在此图中");
				return;
			}
			this.nodes.push(added);
			this.createNodeEl(added);
			this.drawEdges();
			this.updateHeader();
		}).open();
	}

	/** 工具栏"新建文字卡片"：以画布可视中心落点 */
	private createTextCard(): void {
		if (!this.mapId || !this.viewportEl) {
			new Notice("请先打开或创建一张脑图");
			return;
		}
		const rect = this.viewportEl.getBoundingClientRect();
		const pos = this.toWorld(rect.left + rect.width / 2, rect.top + rect.height / 2);
		new TextPromptModal(
			this.app,
			{ title: "新建文字卡片", placeholder: "输入卡片内容…" },
			(text) => {
				if (!text || !this.mapId) {
					return;
				}
				const card = this.plugin.cards.create({
					documentId: null,
					page: null,
					rects: [],
					excerptType: "text",
					excerptText: text,
				});
				const added = this.plugin.mindmaps.addNode(
					this.mapId,
					card.id,
					null,
					Math.round(pos.x),
					Math.round(pos.y),
				);
				if (added) {
					this.nodes.push(added);
					this.createNodeEl(added);
					this.drawEdges();
					this.updateHeader();
				}
			},
		).open();
	}

	private renameMap(): void {
		if (!this.mapId) {
			return;
		}
		const map = this.plugin.mindmaps.get(this.mapId);
		if (!map) {
			return;
		}
		new TextPromptModal(
			this.app,
			{ title: "重命名脑图", initialText: map.name, multiline: false },
			(name) => {
				if (!name || !this.mapId) {
					return;
				}
				this.plugin.mindmaps.rename(this.mapId, name);
				this.updateHeader();
			},
		).open();
	}

	private deleteMap(): void {
		if (!this.mapId) {
			return;
		}
		const map = this.plugin.mindmaps.get(this.mapId);
		if (!map) {
			return;
		}
		new ConfirmModal(
			this.app,
			"删除脑图",
			`确定删除《${map.name}》吗？共 ${this.nodes.length} 个节点。卡片本身保留，仅移除脑图组织结构。`,
			() => {
				this.plugin.mindmaps.delete(this.mapId!);
				this.clearMap();
				this.showPicker();
			},
		).open();
	}
}
