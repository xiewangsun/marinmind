import { ItemView, Menu, Notice, TFile } from "obsidian";
import type { ViewStateResult, WorkspaceLeaf } from "obsidian";
import type MarinMindPlugin from "../main";
import type { Card, MindmapNodeWithCard } from "../types";
import { TextPromptModal } from "../reader/note-edit-modal";
import { CardPickerModal } from "./card-picker-modal";
import { ConfirmModal } from "./confirm-modal";
import {
	edgePath,
	isDescendantOrSelf,
	suggestRootPosition,
} from "./mindmap-graph";
import { MindmapPickerModal } from "./mindmap-picker-modal";

/** 思维导图视图的 viewType */
export const MINDMAP_VIEW_TYPE = "marinmind-mindmap";

/** 缩放边界 */
const MIN_SCALE = 0.25;
const MAX_SCALE = 2.5;
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
	private tx = 0;
	private ty = 0;
	private scale = 1;
	private drag: DragState | null = null;

	constructor(leaf: WorkspaceLeaf, plugin: MarinMindPlugin) {
		super(leaf);
		this.plugin = plugin;

		// 工具栏：添加已有卡片 / 新建文字卡片 / 手动刷新（跨视图改卡后同步）
		this.addAction("list-plus", "添加卡片", () => this.openCardPicker());
		this.addAction("plus", "新建文字卡片", () => this.createTextCard());
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
		this.drag = null;
		this.nodeEls.clear();
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
		hint.textContent = "拖节点到另一节点=连线（挂为子节点）· 拖空白=平移 · Ctrl+滚轮=缩放 · 双击空白=新建卡片 · 右键节点=更多操作";

		this.registerCanvasEvents();
		this.applyTransform();
	}

	/** 全量重建 world 内的节点与连线（loadMap / 刷新） */
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
		for (const node of this.nodes) {
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

		world.appendChild(el);
		this.nodeEls.set(node.id, el);
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

	/** 全量重画连线（父右缘中点 → 子左缘中点的三次贝塞尔） */
	private drawEdges(): void {
		const svg = this.edgesSvg;
		if (!svg) {
			return;
		}
		svg.replaceChildren();
		const byId = new Map(this.nodes.map((n) => [n.id, n]));
		for (const n of this.nodes) {
			if (!n.parentId) {
				continue;
			}
			const parent = byId.get(n.parentId);
			if (!parent) {
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
				item.setTitle("跳转原文").setIcon("book-open").onClick(() => void this.jumpToSource(card)),
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
					this.plugin.cards.delete(card.id);
					this.removeNodeLocal(node.id);
				}),
		);
		menu.showAtMouseEvent(evt);
	}

	/** 编辑批注后就地更新节点文本（不动布局尺寸重画连线） */
	private editNote(node: MindmapNodeWithCard): void {
		new TextPromptModal(
			this.app,
			{ title: "编辑批注", initialText: node.card.note ?? "" },
			(note) => {
				const updated = this.plugin.cards.update(node.card.id, { note });
				if (!updated) {
					return;
				}
				const local = this.nodes.find((n) => n.id === node.id);
				if (!local) {
					return;
				}
				local.card = updated;
				const el = this.nodeEls.get(node.id);
				const text = el?.querySelector<HTMLElement>(".marinmind-mm-node-text");
				if (text) {
					text.textContent = this.nodeText(updated);
				}
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

	/** 跳转原文：打开阅读器并滚动到卡片所在页（文档/文件缺失时 Notice 降级） */
	private async jumpToSource(card: Card): Promise<void> {
		const doc = card.documentId ? this.plugin.documents.get(card.documentId) : undefined;
		const file = doc ? this.app.vault.getAbstractFileByPath(doc.filePath) : null;
		if (!(file instanceof TFile)) {
			new Notice("原文文件不在当前库中，无法跳转");
			return;
		}
		await this.plugin.openInReader(file, card.page ?? undefined);
	}
}
