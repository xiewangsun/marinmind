import { ItemView, Menu, Notice, setIcon } from "obsidian";
import type { ViewStateResult, WorkspaceLeaf } from "obsidian";
import type MarinMindPlugin from "../main";
import type { BranchStyle, Card, MindmapNodeWithCard } from "../types";
import { BRANCH_STYLES, BRANCH_STYLE_LABELS, isBranchStyle } from "../types";
import { READER_VIEW_TYPE } from "../reader/reader-view";
import { TextPromptModal } from "../reader/note-edit-modal";
import { CardPickerModal } from "./card-picker-modal";
import { ConfirmModal } from "./confirm-modal";
import { createViewModeBar } from "../ui/view-mode-bar";
import { pageWordOf } from "../storage/paths";
import {
	buildChildrenMap,
	dropPlacement,
	dropZoneFor,
	edgePath,
	effectiveBranchStyle,
	fitViewportTransform,
	frameRectFor,
	FRAME_PADDING,
	type GraphNode,
	insertOrder,
	isDescendantOrSelf,
	layoutSubtree,
	layoutTree,
	MAX_SCALE,
	MIN_SCALE,
	NODE_HEIGHT_EST,
	NODE_WIDTH,
	restackRoots,
	ROOT_GAP_Y,
	suggestRootPosition,
	subtreeIds,
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

/**
 * 联动定位（文档→脑图，⑰）：在全部活跃脑图中定位该卡——
 * 命中即停（平移 + 闪烁）；不在任何打开的图中返回 false。
 */
export function locateCardInActiveMindmaps(cardId: string): boolean {
	for (const view of activeViews) {
		if (view.locateCard(cardId)) {
			return true;
		}
	}
	return false;
}

/**
 * 刷新正在展示某图的活跃视图（㉗）：自动入图/固定根变更等插件级写图后，
 * 由 main.ts 调用同步画布——loadMap 重拉不动 tx/ty/scale，平移缩放保持。
 */
export function refreshActiveMindmaps(mapId: string): void {
	for (const view of activeViews) {
		view.refreshIfShowing(mapId);
	}
}

/** Ctrl+滚轮缩放的指数步进系数 */
const ZOOM_SENSITIVITY = 0.0015;
/** 拖拽判定阈值：位移超过该值才算拖动（否则视为点击/右键取消） */
const DRAG_THRESHOLD = 4;
/** ㉜ 指针距视口边缘小于此值时触发自动平移（拖到画布外时仍能继续拖） */
const EDGE_SCROLL_PX = 36;
/** ㉜ 插入线宽度（px，世界坐标系） */
const INSERT_LINE_W = 3;
/** ㉜ 自动平移每事件的最大位移（px） */
const EDGE_SCROLL_SPEED = 18;
/** ㊺ 节点编辑器面板宽（px）——与 CSS .marinmind-mm-editor 的 width 保持同步 */
const NODE_EDITOR_W = 264;
/** ㊺ 编辑器面板与节点的垂直间隙（px） */
const NODE_EDITOR_GAP = 8;

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
			/** ㉜ 当前落点目标：命中节点 id 或 null（空白）；null 时按自由定位 */
			dropTargetId: string | null;
			/** ㉜ 落点分区：before / inside / after（空白 = null） */
			dropZone: "before" | "inside" | "after" | null;
			/** ㉜ 落点分区轴（树形下=纵向堆叠，tree-down 的行=横向）；提示横/竖插入线 */
			dropAxis: "v" | "h";
			/** ㉜ 子树快照是否已收集（升格时一次性，含折叠隐藏后代） */
			subtreeCollected: boolean;
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
	/** 图级默认分支样式选择器（header 内，⑱） */
	private styleSelect: HTMLSelectElement | null = null;
	/** 「添加到脑图」总开关按钮（header 内，㉗）：全局持久化 settings.autoAddToMindmap */
	private autoAddBtn: HTMLElement | null = null;
	/** 「固定根」状态按钮（header 内，㉗）：显示当前固定态；点击取消固定 */
	private fixedRootBtn: HTMLElement | null = null;
	/** 当前全局固定根节点 id（loadMap 重拉刷新；null=未设定） */
	private fixedRootId: string | null = null;

	/** setState 暂存的待打开图（onOpen 消费；骨架已就绪时立即应用） */
	private pendingMapId: string | null = null;
	private mapId: string | null = null;
	/** 图级默认分支样式（loadMap 时随图快照更新，⑱） */
	private mapDefault: BranchStyle = "tree";
	/** 节点内存快照（打开/刷新时全量拉取，写库后同步更新） */
	private nodes: MindmapNodeWithCard[] = [];
	private readonly nodeEls = new Map<string, HTMLElement>();

	/** 世界变换：world.style.transform = translate(tx,ty) scale(s) */
	/** 世界变换（纯内存不持久）：平移 + 缩放 */
	private tx = 0;
	private ty = 0;
	private scale = 1;
	private drag: DragState | null = null;
	/** ㉜ 插入线元素（拖节点到同级前后时，在 worldEl 内绝对定位的横/竖线） */
	private insertLineEl: HTMLElement | null = null;
	/** ㉜ 被拖子树 DOM 快照：nodeId → {el, startLeft, startTop, worldX, worldY}（含折叠隐藏后代） */
	private subtreeSnapshot: Map<string, { el: HTMLElement; startLeft: number; startTop: number; worldX: number; worldY: number }> | null = null;
	/** cardBus 退订器（onClose 统一退订防泄漏） */
	private cardBusOffs: Array<() => void> = [];
	/** 视图模式切换条退订器（onClose 退订防泄漏） */
	private viewModeOff: (() => void) | null = null;
	/** 媒体图片 blob URL 缓存（excerptRef → url；同 ref 复用，onClose/删卡时 revoke，⑳） */
	private readonly mediaUrls = new Map<string, string>();
	/** ㊺ 节点编辑器（浮动面板，null=未开）：挂 viewportEl 不受 world 缩放影响；
	 * ㊺-A 打开途径 = 右键菜单「编辑标题/批注」（单击节点已回归直接跳原文） */
	private nodeEditor: {
		nodeId: string;
		el: HTMLElement;
		title: HTMLInputElement;
		note: HTMLTextAreaElement;
	} | null = null;

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
		if (!this.plugin.store) {
			this.contentEl.empty();
			this.contentEl.classList.add("marinmind-mindmap");
			const tip = document.createElement("p");
			tip.textContent = "MarinMind 数据层未就绪，无法加载思维导图。";
			tip.className = "marinmind-reader-tip";
			this.contentEl.appendChild(tip);
			return;
		}
		this.buildSkeleton();
		const pending = this.pendingMapId;
		this.pendingMapId = null;
		if (pending) {
			this.loadMap(pending);
		} else if (!this.mapId) {
			// ㊿-A 空态不自动弹选图器：Obsidian 对 setViewState 新建的视图是
			// onOpen 先于 setState 执行——联动/研究模式程序化带 mapId 分裂标签时，
			// 此刻 mapId 尚未送达，自动弹窗会抢在加载前弹出（用户所见"同名图
			// 加载了但选图器也弹了"的真根因）。改为画布内提示 +「选择脑图」按钮
			// （见 syncEmptyHint）；setState 送达后 loadMap 自然替换空态。
			// !this.mapId 守卫防 onOpen 期间 setState 已抢先加载的交错时序。
			this.updateHeader();
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
		// 联动互关（㊿）：先捕获本图 id，关闭后交给 plugin 匹配绑定到本图的阅读标签
		const linkedMapId = this.mapId;
		this.closeNodeEditor(false); // ㊺ 面板挂 viewportEl，显式清防残留
		for (const off of this.cardBusOffs) {
			off();
		}
		this.cardBusOffs = [];
		this.viewModeOff?.();
		this.viewModeOff = null;
		activeViews.delete(this);
		this.clearDropHint();
		this.drag = null;
		this.nodeEls.clear();
		// 媒体 blob URL 全量回收（视图销毁后不再有消费者）
		for (const url of this.mediaUrls.values()) {
			URL.revokeObjectURL(url);
		}
		this.mediaUrls.clear();
		// 关闭目标图为本图的阅读标签（模式切换的 detach 由 suppress 拦截）
		this.plugin.linkedCloseReader(linkedMapId);
	}

	// ---------- 卡片变更事件（跨视图同步，⑨-B） ----------

	/** 订阅卡片变更/删除（回调只做内存与 DOM 更新，禁止写库——契约见 card-bus.ts） */
	private subscribeCardBus(): void {
		// 新建卡的自动入图已上移插件级订阅（㉗，见 main.ts setupAutoCollect）——
		// 视图不再订阅 created（变更双发里的 changed 足够跨视图同步）
		this.cardBusOffs.push(
			this.plugin.cardBus.onCardChanged((card) => this.applyCardUpdate(card)),
			this.plugin.cardBus.onCardRemoved((cardId) => this.applyCardRemoval(cardId)),
		);
	}

	/** 卡片被改（标题/批注/OCR 文本/回填快照等）：图内命中节点就地重渲染三栏，不动布局 */
	private applyCardUpdate(card: Card): void {
		const local = this.nodes.find((n) => n.cardId === card.id);
		if (!local) {
			return; // 不在当前图：与本视图无关
		}
		local.card = card;
		const el = this.nodeEls.get(local.id);
		if (!el) {
			return;
		}
		this.renderNodeContent(el, card);
		// 三栏高度可能变化（批注栏出现/消失、文字行数变化、媒体增删）——重锚连线
		// （㊺ 前纯文本路径不重画是既有缺口：批注栏出现后连线锚点悬空）
		this.drawEdges();
	}

	/** 卡片被删：DB 级联已删节点行（SET NULL 上浮语义一致），本地同步移除节点 */
	private applyCardRemoval(cardId: string): void {
		const local = this.nodes.find((n) => n.cardId === cardId);
		if (local) {
			this.releaseMediaUrl(local.card);
			this.removeNodeLocal(local.id);
		}
	}

	// ---------- 摘录自动入图（㉗：插件级服务 + 本视图的开关/固定根 UI） ----------

	/**
	 * 「添加到脑图」总开关（全局持久化，默认开）：任何阅读器的新摘录自动入图——
	 * 固定根节点优先，否则按书目标图（阅读器「脑图」按钮可切换），无覆盖时
	 * 进同名默认图（见 src/mindmap/auto-collect.ts，㊴ 三级落点）。
	 */
	private async toggleAutoAdd(): Promise<void> {
		this.plugin.settings.autoAddToMindmap = !this.plugin.settings.autoAddToMindmap;
		try {
			await this.plugin.saveData({ ...this.plugin.settings });
		} catch (err) {
			console.error("[MarinMind] 设置保存失败", err);
		}
		this.syncHeaderButtons();
		new Notice(
			this.plugin.settings.autoAddToMindmap
				? "添加到脑图已开启：新摘录将自动入图（固定根节点优先，否则进入本书目标图，默认为同名脑图）"
				: "添加到脑图已关闭：新摘录不再自动入图",
		);
	}

	/**
	 * 「固定根」按钮：已固定时点击取消（回到书籍默认脑图路径）；
	 * 未固定时提示去节点右键菜单设定。
	 */
	private toggleFixedRoot(): void {
		const fixed = this.plugin.mindmaps.fixedRoot();
		if (!fixed) {
			new Notice("尚无固定根节点：在任意节点上右键 →「设为固定根节点」");
			return;
		}
		this.clearFixedRoot(fixed.mapId);
	}

	/** 节点右键「设为固定根节点」（㉗）：先清掉其他图的固定根（全局唯一）再落到本节点 */
	private setFixedRootFor(node: MindmapNodeWithCard): void {
		const prev = this.plugin.mindmaps.fixedRoot();
		if (!this.plugin.mindmaps.setFixedRoot(node.mapId, node.id)) {
			new Notice("设定失败：节点已不存在");
			return;
		}
		new Notice("已设为固定根节点：之后的新摘录将自动挂到该节点下");
		if (prev && prev.mapId !== node.mapId) {
			refreshActiveMindmaps(prev.mapId); // 原固定所在图同步摘掉徽标
		}
		refreshActiveMindmaps(node.mapId);
	}

	/** 取消固定根（头按钮 / 节点右键共用）：新摘录回到各书的目标图（默认同名图） */
	private clearFixedRoot(mapId: string): void {
		this.plugin.mindmaps.setFixedRoot(mapId, null);
		new Notice("已取消固定根节点：新摘录回到各书的目标图（默认为同名脑图）");
		refreshActiveMindmaps(mapId);
	}

	/** header 两个开关按钮的激活态同步（buildSkeleton/loadMap/开关切换后调用） */
	private syncHeaderButtons(): void {
		const on = this.plugin.settings.autoAddToMindmap;
		this.autoAddBtn?.classList.toggle("is-active", on);
		this.autoAddBtn?.setAttribute("aria-pressed", String(on));
		const fixed = this.fixedRootId != null;
		this.fixedRootBtn?.classList.toggle("is-active", fixed);
		this.fixedRootBtn?.setAttribute("aria-pressed", String(fixed));
	}

	/** 正在展示 mapId 时重拉画布（插件级写图的外部同步入口；平移缩放保持） */
	public refreshIfShowing(mapId: string): void {
		if (this.mapId === mapId && this.viewportEl) {
			this.loadMap(mapId);
		}
	}

	// ---------- 数据加载 ----------

	/** 打开指定图（图已被删则回选图器） */
	public loadMap(mapId: string): void {
		this.closeNodeEditor(false); // 面板在 viewport 不在 world：rebuildWorld 清不到，防悬空
		const map = this.plugin.mindmaps.get(mapId);
		if (!map) {
			new Notice("该思维导图已不存在");
			this.clearMap();
			this.showPicker();
			return;
		}
		this.mapId = mapId;
		this.mapDefault = map.defaultBranchStyle;
		// 固定根节点（㉗）：全局唯一，可能是本图节点也可能在别的图——
		// 徽标只标在命中的节点上；头按钮的激活态看它是否存在
		this.fixedRootId = this.plugin.mindmaps.fixedRoot()?.nodeId ?? null;
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
		this.closeNodeEditor(false); // ㊺ 防面板悬空（见 loadMap 同款注释）
		this.mapId = null;
		this.mapDefault = "tree";
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
	 * 一键自动布局：按各节点生效分支样式分层整列（layoutTree 纯函数）→
	 * applyLayout 单事务写回 → 全量重拉 → 视口适配。
	 * 覆盖全部节点手动位置（含折叠隐藏的子树），先确认再执行。
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
			"将按各节点的分支样式重新排列全部节点（含折叠隐藏的子树），覆盖当前手动位置。继续吗？",
			() => {
				if (!this.mapId) {
					return;
				}
				// 布局输入注入 DOM 实测高（媒体图节点远高于估值，不注入则间距按 72 排导致视觉重叠）
				this.plugin.mindmaps.applyLayout(this.mapId, layoutTree(this.measuredNodes(), this.mapDefault));
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

		// header：图名 + 节点数 + 视图模式切换条 + 重命名 / 删除
		const header = this.contentEl.createDiv({ cls: "marinmind-mm-header" });
		this.titleSpan = header.createSpan({ cls: "marinmind-mm-title" });
		this.titleSpan.textContent = "未打开脑图";
		this.countSpan = header.createSpan({ cls: "marinmind-mm-count" });
		// 图级默认分支样式选择器（⑱）：未覆盖的节点全部跟随；节点可在右键菜单单独覆盖
		this.styleSelect = header.createEl("select", {
			cls: "marinmind-mm-style-select",
			attr: { "aria-label": "默认分支样式" },
		});
		for (const s of BRANCH_STYLES) {
			this.styleSelect.createEl("option", {
				value: s,
				text: BRANCH_STYLE_LABELS[s],
			});
		}
		this.styleSelect.addEventListener("change", () => {
			if (!this.styleSelect) {
				return;
			}
			if (!this.mapId) {
				new Notice("请先打开或创建一张脑图");
				this.styleSelect.value = this.mapDefault;
				return;
			}
			this.setDefaultStyle(this.styleSelect.value as BranchStyle);
		});
		// 「添加到脑图」总开关（㉗，MN4「自动添加到脑图」对齐，默认开）：
		// 全局持久化（settings.autoAddToMindmap）——新摘录自动入图，
		// 固定根节点优先，否则加入该书的默认脑图（见 auto-collect.ts）
		this.autoAddBtn = header.createEl("button", {
			cls: "marinmind-mm-autocollect",
			attr: { type: "button", "aria-pressed": "true", title: "开关：新摘录自动添加到脑图" },
		});
		// P2-1 图标语言统一：emoji → lucide（zap 留给闪卡语义，入图取脑图家族 git-fork）
		setIcon(this.autoAddBtn.createSpan({ cls: "marinmind-mm-btn-icon" }), "git-fork");
		this.autoAddBtn.createSpan({ text: "添加到脑图" });
		this.autoAddBtn.addEventListener("click", () => void this.toggleAutoAdd());
		// 「固定根」状态按钮（㉗）：显示当前固定态，点击取消固定；
		// 设定入口在节点右键菜单「设为固定根节点」
		this.fixedRootBtn = header.createEl("button", {
			cls: "marinmind-mm-autocollect",
			attr: {
				type: "button",
				"aria-pressed": "false",
				title: "固定根节点：新摘录都挂到该节点下。在节点上右键设定；点此取消",
			},
		});
		setIcon(this.fixedRootBtn.createSpan({ cls: "marinmind-mm-btn-icon" }), "pin");
		this.fixedRootBtn.createSpan({ text: "固定根" });
		this.fixedRootBtn.addEventListener("click", () => this.toggleFixedRoot());
		// 复习入口（㉑，MN4 学习集「复习」按钮）：打开/复用复习窗格并开始到期会话
		const reviewBtn = header.createEl("button", {
			cls: "marinmind-mm-autocollect",
			attr: { type: "button", "aria-label": "开始复习（到期闪卡）" },
		});
		setIcon(reviewBtn.createSpan({ cls: "marinmind-mm-btn-icon" }), "swords");
		reviewBtn.createSpan({ text: "复习" });
		reviewBtn.addEventListener("click", () => void this.plugin.openReview());
		// 三态视图模式切换条 [文档|脑图|联动] 靠右（与阅读器工具行同款，⑰）
		this.viewModeOff?.();
		const modeBar = createViewModeBar(this.plugin);
		this.viewModeOff = modeBar.off;
		header.createEl("div", { cls: "marinmind-mm-header-spacer" });
		header.appendChild(modeBar.el);
		const renameBtn = header.createEl("button", {
			cls: "marinmind-mm-header-btn clickable-icon",
			attr: { "aria-label": "重命名" },
		});
		setIcon(renameBtn, "pencil");
		renameBtn.addEventListener("click", () => this.renameMap());
		const deleteBtn = header.createEl("button", {
			cls: "marinmind-mm-header-btn clickable-icon",
			attr: { "aria-label": "删除脑图" },
		});
		setIcon(deleteBtn, "trash-2");
		deleteBtn.addEventListener("click", () => this.deleteMap());

		// 画布：事件宿主是 viewport（world 是 0×0 的 transform 容器，收不到事件）
		this.viewportEl = this.contentEl.createDiv({ cls: "marinmind-mm-viewport" });
		this.worldEl = this.viewportEl.createDiv({ cls: "marinmind-mm-world" });
		this.edgesSvg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
		this.edgesSvg.setAttribute("class", "marinmind-mm-edges");
		this.worldEl.appendChild(this.edgesSvg);

		// 空态提示（无节点时显示，不挡指针；内容由 updateHeader→syncEmptyHint 按状态填充）
		this.emptyEl = this.viewportEl.createDiv({ cls: "marinmind-mm-empty" });

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

		// ---------- 稳定骨架区（renderNodeContent 不重建——监听重建即丢） ----------
		// meta 行：renderNodeContent 以其为三栏内容的插入锚点
		const meta = document.createElement("div");
		meta.className = "marinmind-mm-node-meta";
		el.appendChild(meta);

		// 固定根节点徽标（㉗）：pin 图标提示新摘录的固定挂载点
		if (this.fixedRootId === node.id) {
			const pin = document.createElement("span");
			pin.className = "marinmind-mm-pin";
			setIcon(pin, "pin");
			pin.title = "固定根节点：新摘录自动挂到该节点下（右键可取消）";
			el.appendChild(pin);
		}

		// 折叠开关（仅有子节点的节点显示）：chevron + 折叠时的后代计数。
		// pointerdown/click 双 stopPropagation：不触发节点拖拽与画布平移/双击。
		if (this.nodes.some((n) => n.parentId === node.id)) {
			const toggle = document.createElement("button");
			toggle.className = "marinmind-mm-toggle";
			// 镜像树样式子节点在左：折叠钮放左缘，避让右侧入线位置（⑱）
			if (this.styleOf(node.id) === "tree-left") {
				toggle.classList.add("marinmind-mm-toggle-left");
			}
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

		// ---------- 三栏内容（㊺ MN3 式：标题栏/摘录内容/批注栏） ----------
		this.renderNodeContent(el, node.card);

		world.appendChild(el);
		this.nodeEls.set(node.id, el);
	}

	/**
	 * 渲染节点三栏内容（㊺ MN3 式）：上栏标题栏（摘录色系 tint 背景 + card.title，
	 * 默认 "…"）→ 中栏摘录内容（媒体图 + 摘录文字/形态占位）→ 下栏批注栏（有批注才渲染）。
	 * createNodeEl 建骨架后调用、applyCardUpdate 复用重渲染——单一改动点。
	 * 稳定区（meta/pin/toggle）不在此重建：监听挂在这些元素上，重建即丢。
	 */
	private renderNodeContent(el: HTMLElement, card: Card): void {
		const meta = el.querySelector<HTMLElement>(":scope > .marinmind-mm-node-meta");
		const anchor = meta ?? null; // 兜底插入锚点（无 meta 的异常 DOM）
		// 中栏先取引用：重渲染时 remove 旧 head/note 后剩 [body][meta]，上栏若锚到
		// meta 会落到 body 之后，三栏翻转为 中→上→下（㊺-A 修复）——必须锚到 body 之前
		let body = el.querySelector<HTMLElement>(":scope > .marinmind-mm-node-body");

		// 上/下栏纯文本直接重建
		for (const part of Array.from(
			el.querySelectorAll(
				":scope > .marinmind-mm-node-head, :scope > .marinmind-mm-node-note",
			),
		)) {
			part.remove();
		}

		// ① 上栏：标题栏（背景色 = 摘录色系 tint，标题默认三个点）
		const head = document.createElement("div");
		head.className = "marinmind-mm-node-head";
		head.dataset.color = card.color ?? "";
		const titleEl = document.createElement("span");
		titleEl.className = "marinmind-mm-node-title";
		titleEl.textContent = card.title ?? "…";
		head.appendChild(titleEl);
		el.insertBefore(head, body ?? anchor);

		// ② 中栏：摘录内容。媒体 body 同 ref 复用现有 img（㊺ 防闪烁——
		// 重渲染高频发生在批注/标题编辑，图片无谓重建会闪）
		const hasMedia = card.excerptRef != null && card.excerptType !== "audio";
		if (body && body.dataset.ref !== (card.excerptRef ?? undefined)) {
			body.remove(); // ref 变化/失去媒体：整栏重建
			body = null;
		}
		if (!body) {
			body = document.createElement("div");
			body.className = "marinmind-mm-node-body";
			if (hasMedia) {
				body.dataset.ref = card.excerptRef!;
				el.insertBefore(body, anchor);
				this.attachNodeMedia(body, card);
			} else {
				el.insertBefore(body, anchor);
			}
		}
		// 中栏文字：摘录文字（有媒体时作图注，无文字不渲染；无媒体无文字给形态占位）
		let text = body.querySelector<HTMLElement>(":scope > .marinmind-mm-node-text");
		const wanted = hasMedia ? card.excerptText : this.nodeText(card);
		if (wanted) {
			if (!text) {
				text = document.createElement("div");
				text.className = "marinmind-mm-node-text";
				body.appendChild(text);
			}
			text.textContent = wanted;
		} else if (text) {
			text.remove();
		}

		// ③ 下栏：批注栏（默认不显示——无批注不渲染）
		if (card.note?.trim()) {
			const noteEl = document.createElement("div");
			noteEl.className = "marinmind-mm-node-note";
			noteEl.textContent = card.note;
			el.insertBefore(noteEl, anchor);
		}

		// meta 行文本随卡片刷新（页面信息稳定但保持单一来源；㊼ epub 书「章」）
		if (meta) {
			const doc = card.documentId
				? this.plugin.documents.get(card.documentId)
				: undefined;
			meta.textContent = card.documentId
				? card.page != null
					? `第 ${card.page} ${doc ? pageWordOf(doc.filePath) : "页"}`
					: "文档卡片"
				: "手工";
		}
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

	/** 中栏显示文本：摘录文字 > 形态占位（批注独立成下栏，㊺ 不再参与中栏） */
	private nodeText(card: Card): string {
		if (card.excerptText) {
			return card.excerptText;
		}
		return card.excerptType === "area" ? "（区域摘录）" : `（${card.excerptType} 摘录）`;
	}

	/**
	 * 节点媒体区（⑳）：excerptRef 的图片（区域/套索快照、手写、照片）——
	 * ㊺ 起挂中栏 body 容器（图片在上、文字图注在下）。
	 * fire-and-forget 加载（节点可能随刷新立即移除，isConnected 守卫丢弃），
	 * blob URL 按 ref 视图级缓存复用；图片加载完成会改变节点高度，触发连线重锚
	 */
	private attachNodeMedia(el: HTMLElement, card: Card): void {
		const ref = card.excerptRef;
		if (!ref) {
			return;
		}
		const media = document.createElement("div");
		media.className = "marinmind-mm-media";
		const img = document.createElement("img");
		img.alt = "摘录内容快照";
		img.decoding = "async";
		// 图片改变节点实际高度：加载完成后重画连线重锚（drawEdges 实测 offsetHeight）
		img.onload = () => this.drawEdges();
		media.appendChild(img);
		el.appendChild(media);

		const cached = this.mediaUrls.get(ref);
		if (cached) {
			img.src = cached;
			return;
		}
		void this.plugin.attachments
			.read(ref)
			.then((bytes) => {
				if (!img.isConnected) {
					return; // 节点已随刷新/删除移除：URL 不入缓存，让字节随 GC 走
				}
				const url = URL.createObjectURL(new Blob([bytes]));
				this.mediaUrls.set(ref, url);
				img.src = url;
			})
			.catch(() => undefined); // 附件缺失：保持无图，标题文字兜底
	}

	/** 释放卡片的媒体 blob URL（一卡一附件，删卡即无消费者；节点移出图不释放——卡还在） */
	private releaseMediaUrl(card: Card): void {
		const ref = card.excerptRef;
		if (!ref) {
			return;
		}
		const url = this.mediaUrls.get(ref);
		if (url) {
			URL.revokeObjectURL(url);
			this.mediaUrls.delete(ref);
		}
	}

	/** 节点生效分支样式（自身覆盖 > 祖先覆盖 > 图默认）——连线形状与折叠钮侧边依据 */
	private styleOf(nodeId: string): BranchStyle {
		return effectiveBranchStyle(this.nodes, nodeId, this.mapDefault);
	}

	/**
	 * 全量重画连线与收纳框（⑱ 分支样式）：连线形状由父节点生效样式决定；
	 * 框架样式的父节点画子节点收纳框代替连线；任一端被折叠隐藏的边/框跳过。
	 */
	private drawEdges(): void {
		const svg = this.edgesSvg;
		if (!svg) {
			return;
		}
		svg.replaceChildren();
		const byId = new Map(this.nodes.map((n) => [n.id, n]));
		const visible = visibleNodes(this.nodes);
		// svg 视口必须覆盖全部几何（⑲-4）：Chromium 对 0×0 尺寸的 svg 即便
		// overflow:visible 也整体不绘制（实测复现，连线自 v1 起不可见的根因）——
		// 每次重画按可见节点包围盒设 viewBox 与 CSS 尺寸，路径坐标仍是世界坐标零改动；
		// PAD 覆盖框架收纳框外扩（FRAME_PADDING）与描边半宽
		const PAD = FRAME_PADDING + 4;
		let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
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
		if (Number.isFinite(minX)) {
			const w = maxX - minX + PAD * 2;
			const h = maxY - minY + PAD * 2;
			// svg 元素必须锚在 viewBox 原点上：用户坐标 (x,y) 实际渲染于
			// (x - vbX, y - vbY) + 元素位置。元素钉死 (0,0) 而 viewBox 随包围盒平移时，
			// 路径坐标与 viewBox 位移相消——整图拖动（如拖根节点）连线在屏幕上冻结不动、
			// 静止时也带 (PAD - minX) 常量偏移（㉜-3 修复：元素位置跟随包围盒）
			svg.setAttribute("viewBox", `${minX - PAD} ${minY - PAD} ${w} ${h}`);
			svg.style.left = `${minX - PAD}px`;
			svg.style.top = `${minY - PAD}px`;
			svg.style.width = `${w}px`;
			svg.style.height = `${h}px`;
		} else {
			// 无可见节点：视口归零避免残留旧内容
			svg.removeAttribute("viewBox");
			svg.style.left = "0px";
			svg.style.top = "0px";
			svg.style.width = "0px";
			svg.style.height = "0px";
		}
		const childrenMap = buildChildrenMap(this.nodes);
		// 框架收纳框先画（垫在连线与节点之下）
		for (const n of this.nodes) {
			if (!visible.has(n.id) || this.styleOf(n.id) !== "frame") {
				continue;
			}
			const kids = (childrenMap.get(n.id) ?? []).filter((c) => visible.has(c.id));
			const rect = frameRectFor(
				kids.map((c) => ({
					x: c.x,
					y: c.y,
					w: NODE_WIDTH,
					h: this.nodeEls.get(c.id)?.offsetHeight ?? NODE_HEIGHT_EST,
				})),
			);
			if (!rect) {
				continue;
			}
			const r = document.createElementNS("http://www.w3.org/2000/svg", "rect");
			r.setAttribute("class", "marinmind-mm-frame");
			r.setAttribute("x", String(rect.x));
			r.setAttribute("y", String(rect.y));
			r.setAttribute("width", String(rect.w));
			r.setAttribute("height", String(rect.h));
			r.setAttribute("rx", "12");
			svg.appendChild(r);
		}
		// 连线（按父节点生效样式分形；框架父节点不画线）
		for (const n of this.nodes) {
			if (!n.parentId || !visible.has(n.id)) {
				continue;
			}
			const parent = byId.get(n.parentId);
			if (!parent || !visible.has(parent.id)) {
				continue;
			}
			const d = edgePath(
				{ x: parent.x, y: parent.y, h: this.nodeEls.get(parent.id)?.offsetHeight },
				{ x: n.x, y: n.y, h: this.nodeEls.get(n.id)?.offsetHeight },
				this.styleOf(parent.id),
			);
			if (d == null) {
				continue; // frame：连线由收纳框替代
			}
			const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
			path.setAttribute("class", "marinmind-mm-edge");
			path.setAttribute("d", d);
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
		if (this.styleSelect) {
			this.styleSelect.value = this.mapDefault;
		}
		if (this.emptyEl) {
			this.emptyEl.style.display = this.nodes.length ? "none" : "";
			this.syncEmptyHint();
		}
		this.syncHeaderButtons();
	}

	/**
	 * 空态提示内容按状态切换（㊿-A）：未开图 = 「选择脑图…」按钮（替代旧版
	 * onOpen 自动弹选图器——程序化打开时弹窗抢跑，见 onOpen 注释）；已开图
	 * 无节点 = 建卡提示。每次重渲染重建按钮（loadMap/clearMap 必经
	 * updateHeader，监听不堆积）。
	 */
	private syncEmptyHint(): void {
		const el = this.emptyEl;
		if (!el) {
			return;
		}
		el.replaceChildren();
		if (!this.mapId) {
			el.createSpan({ text: "未打开脑图：" });
			el.createEl("button", {
				cls: "marinmind-mm-empty-btn",
				attr: { type: "button" },
				text: "选择脑图…",
			}).addEventListener("click", () => this.showPicker());
			return;
		}
		el.createSpan({ text: "画布空白：双击新建文字卡片，或用右上角工具栏添加卡片" });
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
		const { parentId, x: wx, y: wy } = dropPlacement(
			this.nodes,
			hitId,
			this.toWorld(x, y),
			this.mapDefault,
		);
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

	// ---------- 联动定位（文档→脑图，⑰） ----------

	/**
	 * 定位到卡片对应节点：平移画布使节点居中（保持当前缩放）并闪烁高亮。
	 * 节点不在本图 / 被折叠隐藏时返回 false（调用方继续尝试其他脑图视图）。
	 */
	public locateCard(cardId: string): boolean {
		const node = this.nodes.find((n) => n.cardId === cardId);
		const vp = this.viewportEl;
		if (!node || !vp) {
			return false;
		}
		if (!visibleNodes(this.nodes).has(node.id)) {
			return false; // 折叠隐藏的后代：v1 不自动展开
		}
		const h = this.nodeEls.get(node.id)?.offsetHeight ?? NODE_HEIGHT_EST;
		const rect = vp.getBoundingClientRect();
		// 节点中心（世界坐标）→ 视口中心：tx = cx - worldX × scale
		this.tx = rect.width / 2 - (node.x + NODE_WIDTH / 2) * this.scale;
		this.ty = rect.height / 2 - (node.y + h / 2) * this.scale;
		this.applyTransform();
		const el = this.nodeEls.get(node.id);
		if (el) {
			el.classList.remove("marinmind-mm-flash");
			void el.offsetWidth; // 强制 reflow：连续定位可重启动画
			el.classList.add("marinmind-mm-flash");
			window.setTimeout(() => el.classList.remove("marinmind-mm-flash"), 1600);
		}
		return true;
	}

	// ---------- 坐标与变换 ----------

	private applyTransform(): void {
		if (this.worldEl) {
			this.worldEl.style.transform = `translate(${this.tx}px, ${this.ty}px) scale(${this.scale})`;
		}
		// ㊺ 编辑器面板挂 viewport（不随 world 变换）：平移/缩放/fit 后跟随节点重摆
		this.repositionNodeEditor();
	}

	/** 客户端坐标 → 世界坐标（唯一换算点） */
	private toWorld(clientX: number, clientY: number): { x: number; y: number } {
		const rect = this.viewportEl!.getBoundingClientRect();
		return {
			x: (clientX - rect.left - this.tx) / this.scale,
			y: (clientY - rect.top - this.ty) / this.scale,
		};
	}

	/** 世界坐标 → 视口局部坐标（toWorld 逆运算；㊺ 编辑器定位用——面板挂 viewport） */
	private toLocal(wx: number, wy: number): { x: number; y: number } {
		return {
			x: this.tx + wx * this.scale,
			y: this.ty + wy * this.scale,
		};
	}

	// ---------- 节点编辑器（㊺ 标题/批注编辑；㊺-A 入口 = 右键菜单「编辑标题/批注」） ----------

	/**
	 * 打开节点编辑器（入口 = 右键菜单「编辑标题/批注」，㊺-A：单击节点已回归直接跳原文）。
	 * 同节点已开 → 忽略（幂等，防重复开面板）。
	 */
	private openNodeEditor(node: MindmapNodeWithCard): void {
		const vp = this.viewportEl;
		if (!vp) {
			return;
		}
		if (this.nodeEditor?.nodeId === node.id) {
			return; // 同节点重复打开：忽略
		}
		this.closeNodeEditor(false); // 换节点：旧面板取消保存

		const el = document.createElement("div");
		el.className = "marinmind-mm-editor";
		// 面板内部指针交互不得触发画布平移/节点拖拽
		el.addEventListener("pointerdown", (evt) => evt.stopPropagation());

		const titleLabel = document.createElement("label");
		titleLabel.textContent = "标题";
		const title = document.createElement("input");
		title.type = "text";
		title.placeholder = "默认显示 “…”";
		title.value = node.card.title ?? "";
		titleLabel.appendChild(title);
		el.appendChild(titleLabel);

		const noteLabel = document.createElement("label");
		noteLabel.textContent = "批注";
		const note = document.createElement("textarea");
		note.rows = 4;
		note.placeholder = "复习正面的问题（留空则用摘录内容）";
		note.value = node.card.note ?? "";
		noteLabel.appendChild(note);
		el.appendChild(noteLabel);

		const actions = document.createElement("div");
		actions.className = "marinmind-mm-editor-actions";
		const cancel = document.createElement("button");
		cancel.textContent = "取消";
		cancel.addEventListener("click", () => this.closeNodeEditor(false));
		actions.appendChild(cancel);
		// 库内有归属才给跳原文出口（手工卡无原文可跳）
		if (node.card.documentId) {
			const src = document.createElement("button");
			setIcon(src.createSpan({ cls: "marinmind-mm-btn-icon" }), "arrow-up-right");
			src.createSpan({ text: "原文" });
			src.addEventListener("click", () => {
				this.closeNodeEditor(false);
				void this.plugin.openCardSource(node.card);
			});
			actions.appendChild(src);
		}
		const save = document.createElement("button");
		save.className = "marinmind-mm-editor-save";
		save.textContent = "保存";
		save.addEventListener("click", () => this.closeNodeEditor(true));
		actions.appendChild(save);
		el.appendChild(actions);

		// 面板级键盘：Esc 取消（stopPropagation 免触画布 Esc 路由）、Ctrl/Cmd+Enter 保存
		el.addEventListener("keydown", (evt) => {
			if (
				evt.key === "Escape" &&
				!evt.ctrlKey &&
				!evt.metaKey &&
				!evt.altKey &&
				!evt.shiftKey
			) {
				evt.stopPropagation();
				this.closeNodeEditor(false);
			} else if (evt.key === "Enter" && (evt.ctrlKey || evt.metaKey)) {
				evt.stopPropagation();
				this.closeNodeEditor(true);
			}
		});

		vp.appendChild(el);
		this.nodeEditor = { nodeId: node.id, el, title, note };
		// 无标题聚焦标题框（引导起名）、有标题聚焦批注框（常见操作：补批注）
		(node.card.title ? note : title).focus();
		this.repositionNodeEditor();
	}

	/**
	 * 关闭节点编辑器。save=true 时落库：trim 空串归一 null（零写入契约），
	 * 同值不写库；cards.update → cardBus changed 回环 applyCardUpdate 刷新节点三栏。
	 * 幂等：未开面板时 no-op（loadMap/clearMap/删除路径多处调用）。
	 * 编辑器开着时外部（跨视图/回灌）改卡：面板输入不动，保存为最后写者。
	 */
	private closeNodeEditor(save: boolean): void {
		const ed = this.nodeEditor;
		this.nodeEditor = null;
		if (!ed) {
			return;
		}
		if (save) {
			const title = ed.title.value.trim() || null;
			const note = ed.note.value.trim() || null;
			const card = this.nodes.find((n) => n.id === ed.nodeId)?.card;
			if (card && (card.title !== title || card.note !== note)) {
				this.plugin.cards.update(card.id, { title, note });
			}
		}
		ed.el.remove();
	}

	/** 重摆编辑器面板：跟随节点世界坐标（pan/缩放/fit 全路径——applyTransform 尾部钩） */
	private repositionNodeEditor(): void {
		const ed = this.nodeEditor;
		const vp = this.viewportEl;
		if (!ed || !vp) {
			return;
		}
		const node = this.nodes.find((n) => n.id === ed.nodeId);
		const nodeEl = this.nodeEls.get(ed.nodeId);
		if (!node || !nodeEl) {
			return; // 节点已消失：面板由清理路径关闭，这里不重摆
		}
		const rect = vp.getBoundingClientRect();
		const p = this.toLocal(node.x, node.y);
		const h = ed.el.offsetHeight;
		// 默认摆节点正下方，视口放不下翻上方；左右钳制留 4px 边距
		let x = p.x;
		let y = p.y + nodeEl.offsetHeight * this.scale + NODE_EDITOR_GAP;
		if (y + h > rect.height - 4) {
			y = Math.max(4, p.y - h - NODE_EDITOR_GAP);
		}
		x = Math.min(Math.max(4, x), Math.max(4, rect.width - NODE_EDITOR_W - 4));
		ed.el.style.left = `${x}px`;
		ed.el.style.top = `${y}px`;
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

		// Esc 取消进行中的节点拖拽（㊳）：keydown 挂 document + activeLeaf 守卫
		// （同 reader-view 的 Esc 先例）；弹窗/菜单/输入态让位（它们自己消费 Esc）。
		// 守卫带 moved 与 contextmenu 取消路径对齐——未过 4px 阈值的预备拖拽不取消；
		// 取消后指针仍按下，后续 pointerup 走 drag == null 早退，无需额外清理
		this.registerDomEvent(document, "keydown", (evt: KeyboardEvent) => {
			if (evt.key !== "Escape" || evt.ctrlKey || evt.metaKey || evt.altKey || evt.shiftKey) {
				return;
			}
			if (this.app.workspace.activeLeaf !== this.leaf) {
				return;
			}
			const target = evt.target as HTMLElement | null;
			if (target?.closest?.(".modal-container, .menu, input, textarea, [contenteditable]")) {
				return;
			}
			// ㊺ 编辑器开着 → Esc 关面板（取消）；焦点在面板输入内时已被面板级 keydown 截获
			if (this.nodeEditor) {
				evt.preventDefault();
				this.closeNodeEditor(false);
				return;
			}
			const drag = this.drag;
			if (drag?.kind === "node" && drag.moved) {
				evt.preventDefault();
				this.cancelDrag();
			}
		});
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
				// ㉜ 落点提示在 pointermove 中实时更新
				dropTargetId: null,
				dropZone: null,
				dropAxis: "v",
				subtreeCollected: false,
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
			// ㉜ 拖动整棵子树（含折叠隐藏后代）：一次性收集 el 与世界坐标快照，
			// 后续 pointermove 对整棵子树施加位移——子树不散架。
			this.collectSubtreeSnapshot(drag);
			if (this.subtreeSnapshot) {
				for (const snap of this.subtreeSnapshot.values()) {
					snap.el.classList.add("marinmind-mm-subtree-dim");
				}
			}
		}
		// ㉜ 指针距视口边缘 < EDGE_SCROLL_PX 时自动平移画布（先平移再算世界坐标跟随子树）
		this.scrollCanvasNearEdge(evt.clientX, evt.clientY);
		const w = this.toWorld(evt.clientX, evt.clientY);
		// 先更新被拖节点的内存坐标（拖自己的节点）
		const node = this.nodes.find((n) => n.id === drag.nodeId);
		if (!node) {
			return;
		}
		node.x = w.x - drag.grabOffset.x;
		node.y = w.y - drag.grabOffset.y;
		drag.el.style.left = `${node.x}px`;
		drag.el.style.top = `${node.y}px`;
		// 子树其余节点跟随同一世界位移
		if (this.subtreeSnapshot) {
			for (const [nid, snap] of this.subtreeSnapshot) {
				if (nid === drag.nodeId) {
					continue;
				}
				const n = this.nodes.find((m) => m.id === nid);
				if (n) {
					n.x = snap.worldX + (node.x - drag.startPos.x);
					n.y = snap.worldY + (node.y - drag.startPos.y);
				}
				snap.el.style.left = `${n?.x ?? snap.worldX}px`;
				snap.el.style.top = `${n?.y ?? snap.worldY}px`;
			}
		}
		// ㉜ 落点实时提示：命中节点 → 分区高亮/插入线；命中自己或后代不提示
		this.updateInsertHint(drag);
		this.drawEdges();
	}

	private onPointerUp(evt: PointerEvent): void {
		const drag = this.drag;
		if (!drag) {
			return;
		}
		this.drag = null;
		this.clearInsertHint();
		if (this.subtreeSnapshot) {
			for (const snap of this.subtreeSnapshot.values()) {
				snap.el.classList.remove("marinmind-mm-subtree-dim");
			}
			this.subtreeSnapshot = null;
		}
		if (drag.kind === "pan" || !drag.moved) {
			// 未升级的节点点击 = 联动定位跳原文（㊺-A 回调：单击恢复直接跳原文，
			// 标题/批注编辑收口到右键菜单「编辑标题/批注」）
			if (drag.kind === "node") {
				const node = this.nodes.find((n) => n.id === drag.nodeId);
				if (this.nodeEditor) {
					this.closeNodeEditor(false); // 点节点 = 离开编辑语境，面板取消
				}
				// 单脑图模式下无阅读标签不动作（避免点击意外改变布局）；
				// 手工卡（无文档归属）也没有可跳的原文
				if (
					node &&
					node.card.documentId &&
					this.app.workspace.getLeavesOfType(READER_VIEW_TYPE).length > 0
				) {
					void this.plugin.revealCardInReader(node.card);
				}
			} else if (this.nodeEditor) {
				// 点击画布空白：关闭面板（取消语义）
				this.closeNodeEditor(false);
			}
			return; // 平移结束 / 未升级的点击：无写库
		}
		drag.el.style.pointerEvents = "";
		drag.el.classList.remove("marinmind-mm-dragging");

		const node = this.nodes.find((n) => n.id === drag.nodeId);
		if (!node) {
			return;
		}
		const x = Math.round(node.x);
		const y = Math.round(node.y);
		const targetId = drag.dropTargetId;
		const zone = drag.dropZone;

		// 未命中目标（空白）= 自由定位：位置落库，整棵子树一并写，不整理
		if (targetId == null) {
			this.applySubtreePositions();
			this.drawEdges();
			return;
		}

		// 命中自己或自己的后代 = 成环：拒绝父子关系，但位置照常落库
		// （与 MarginNote 一致：拒绝的是关系，不是位置）
		if (isDescendantOrSelf(this.nodes, node.id, targetId)) {
			new Notice("不能移动到自己的子节点上");
			this.applySubtreePositions();
			this.drawEdges();
			return;
		}

		// ㉜ 结构性放置：inside 挂为子（末位）；before/after 插同级
		if (zone === "inside") {
			// 新父 = target，新序 = 该父下兄弟数（追加末位）
			// prevParentId 必须在 setParent 前捕获——之后 node.parentId 已是新父，旧父分支不会回流
			const prevParentId = node.parentId;
			const siblings = this.nodes.filter((n) => n.parentId === targetId);
			const order = siblings.length;
			const updated = this.plugin.mindmaps.setParent(node.id, targetId, order);
			if (updated) {
				node.parentId = updated.parentId;
				node.order = updated.order;
			}
			this.applySubtreePositions();
			this.tidyAffected(prevParentId, targetId);
			return;
		}
		// before/after：新父 = target 的父（根目标 = null）
		const prevParentId = node.parentId;
		const target = this.nodes.find((n) => n.id === targetId);
		const newParentId = target?.parentId ?? null;
		const siblings = this.nodes.filter(
			(n) => n.parentId === newParentId && n.id !== node.id,
		);
		// zone 在此分支由 before/after 控制流收窄；null 已由上面 inside 分支 return
		const order = insertOrder(siblings, targetId, zone as "before" | "after");
		const updated = this.plugin.mindmaps.setParent(node.id, newParentId, order);
		if (updated) {
			node.parentId = updated.parentId;
			node.order = updated.order;
		}
		this.applySubtreePositions();
		this.tidyAffected(prevParentId, newParentId);
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

	/** 还原节点拖动到按下前位置（㉜：取消时同时撤掉子树 DOM 快照与插入线） */
	private cancelDrag(): void {
		const drag = this.drag;
		this.drag = null;
		this.clearInsertHint();
		if (drag?.kind !== "node") {
			return;
		}
		drag.el.style.pointerEvents = "";
		drag.el.classList.remove("marinmind-mm-dragging");
		if (drag.moved) {
			// ㉜ 子树恢复：整棵子树回 snap，避免只还原拖动节点留下的错位后代
			const snapshot = this.subtreeSnapshot;
			if (snapshot) {
				for (const snap of snapshot.values()) {
					snap.el.classList.remove("marinmind-mm-subtree-dim");
					snap.el.style.left = `${snap.startLeft}px`;
					snap.el.style.top = `${snap.startTop}px`;
				}
				this.subtreeSnapshot = null;
			}
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

	/** ㉜ 收集被拖节点整棵子树（含折叠隐藏后代）的 DOM 与世界坐标快照 */
	private collectSubtreeSnapshot(drag: Extract<DragState, { kind: "node" }>): void {
		if (drag.subtreeCollected) {
			return;
		}
		drag.subtreeCollected = true;
		const ids = subtreeIds(this.nodes, drag.nodeId);
		const snap = new Map<string, { el: HTMLElement; startLeft: number; startTop: number; worldX: number; worldY: number }>();
		for (const id of ids) {
			const n = this.nodes.find((m) => m.id === id);
			const el = this.nodeEls.get(id);
			if (!n || !el) {
				continue;
			}
			snap.set(id, {
				el,
				startLeft: el.offsetLeft,
				startTop: el.offsetTop,
				worldX: n.x,
				worldY: n.y,
			});
		}
		this.subtreeSnapshot = snap;
	}

	/** ㉜ 指针距视口边小于 EDGE_SCROLL_PX 时自动平移画布（每事件最多 EDGE_SCROLL_SPEED px） */
	private scrollCanvasNearEdge(clientX: number, clientY: number): void {
		const vp = this.viewportEl;
		if (!vp) {
			return;
		}
		const rect = vp.getBoundingClientRect();
		let dx = 0;
		let dy = 0;
		const margin = EDGE_SCROLL_PX;
		if (clientX < rect.left + margin) {
			dx = -((margin - (clientX - rect.left)) / margin) * EDGE_SCROLL_SPEED;
		} else if (clientX > rect.right - margin) {
			dx = +((margin - (rect.right - clientX)) / margin) * EDGE_SCROLL_SPEED;
		}
		if (clientY < rect.top + margin) {
			dy = -((margin - (clientY - rect.top)) / margin) * EDGE_SCROLL_SPEED;
		} else if (clientY > rect.bottom - margin) {
			dy = +((margin - (rect.bottom - clientY)) / margin) * EDGE_SCROLL_SPEED;
		}
		if (dx === 0 && dy === 0) {
			return;
		}
		this.tx += dx;
		this.ty += dy;
		this.applyTransform();
	}

	/**
	 * ㉜ 落点实时提示：命中节点 → 分区高亮/插入线；命中自己或后代不提示（会触发环检测）；
	 * 空白 = 全清（不画虚线框）。
	 * axis 由目标父的生效样式决定（tree-down → "h"，其余 → "v"）。
	 */
	private updateInsertHint(drag: Extract<DragState, { kind: "node" }>): void {
		const vp = this.viewportEl;
		if (!vp) {
			return;
		}
		this.clearInsertHint();
		const hit = document
			.elementFromPoint(drag.startClient.x, drag.startClient.y)
			?.closest<HTMLElement>(".marinmind-mm-node");
		const hitId = hit?.dataset.nodeId ?? null;
		if (!hitId || !this.nodeEls.has(hitId)) {
			// 空白 / 命中非本视图节点 → 仅 viewport 轮廓
			vp.classList.add("marinmind-mm-droptarget");
			drag.dropTargetId = null;
			drag.dropZone = null;
			return;
		}
		const target = this.nodes.find((n) => n.id === hitId);
		if (!target) {
			return;
		}
		// 命中自己或自己的后代：不画提示（会触发成环拒绝，避免误导）
		if (isDescendantOrSelf(this.nodes, drag.nodeId, hitId)) {
			return;
		}
		const hitEl = this.nodeEls.get(hitId)!;
		const rect = hitEl.getBoundingClientRect();
		const pointerWorld = this.toWorld(drag.startClient.x, drag.startClient.y);
		const targetStyle = target.branchStyle != null && isBranchStyle(target.branchStyle)
			? target.branchStyle
			: this.mapDefault;
		const axis: "v" | "h" = targetStyle === "tree-down" ? "h" : "v";
		// 根节点（parent=null）恒 v 轴（根均纵向堆叠）
		const resolvedAxis = target.parentId === null ? "v" : axis;
		const zone = dropZoneFor(
			{ x: target.x, y: target.y, w: NODE_WIDTH, h: hitEl.offsetHeight },
			pointerWorld,
			resolvedAxis,
		);
		drag.dropTargetId = hitId;
		drag.dropAxis = resolvedAxis;
		drag.dropZone = zone;
		if (zone === "inside") {
			hitEl.classList.add("marinmind-mm-node-droptarget");
		} else {
			this.showInsertLine(resolvedAxis, target, zone, hitEl);
		}
	}

	/** ㉜ 在 worldEl 内画一条"插入线"（3px 圆角横/竖线，置于目标的上/下/左/外缘） */
	private showInsertLine(
		axis: "v" | "h",
		target: MindmapNodeWithCard,
		side: "before" | "after",
		targetEl: HTMLElement,
	): void {
		const world = this.worldEl;
		if (!world) {
			return;
		}
		const line = this.ensureInsertLineEl();
		const tW = NODE_WIDTH;
		const tH = targetEl.offsetHeight;
		// 世界坐标偏移（worldEl 是 0,0 原点，css transform 已剥离）
		if (axis === "v") {
			// 纵向堆叠：插入线横贯目标上下缘，横穿目标水平中心
			line.style.width = `${tW}px`;
			line.style.height = `${INSERT_LINE_W}px`;
			line.style.left = `${target.x}px`;
			line.style.top = side === "before"
				? `${target.y - INSERT_LINE_W / 2}px`
				: `${target.y + tH - INSERT_LINE_W / 2}px`;
		} else {
			// 横向行（tree-down）：插入线竖穿目标左右缘，纵穿目标垂直中心
			line.style.width = `${INSERT_LINE_W}px`;
			line.style.height = `${tH}px`;
			line.style.left = side === "before"
				? `${target.x - INSERT_LINE_W / 2}px`
				: `${target.x + tW - INSERT_LINE_W / 2}px`;
			line.style.top = `${target.y + tH / 2 - INSERT_LINE_W / 2}px`;
		}
		line.style.display = "";
	}

	private ensureInsertLineEl(): HTMLElement {
		if (!this.insertLineEl) {
			this.insertLineEl = document.createElement("div");
			this.insertLineEl.className = "marinmind-mm-insert-line";
			this.worldEl?.appendChild(this.insertLineEl);
		}
		return this.insertLineEl;
	}

	private clearInsertHint(): void {
		const vp = this.viewportEl;
		vp?.classList.remove("marinmind-mm-droptarget");
		if (this.insertLineEl) {
			this.insertLineEl.style.display = "none";
		}
		for (const el of this.nodeEls.values()) {
			el.classList.remove("marinmind-mm-node-droptarget");
		}
	}

	/** ㉜ 把整棵被拖子树的新坐标一次性落库（自由定位 / 结构性放置都走） */
	private applySubtreePositions(): void {
		if (!this.subtreeSnapshot || !this.mapId) {
			return;
		}
		const positions = new Map<string, { x: number; y: number }>();
		for (const [id, snap] of this.subtreeSnapshot) {
			const n = this.nodes.find((m) => m.id === id);
			if (n) {
				positions.set(id, { x: n.x, y: n.y });
				snap.el.style.left = `${n.x}px`;
				snap.el.style.top = `${n.y}px`;
			}
		}
		this.plugin.mindmaps.applyLayout(this.mapId, positions);
	}

	/**
	 * ㉜ 结构性放置后整理受影响分支。
	 * 只对 旧父 / 新父 两棵子树各跑一次布局（**父节点锚定不动，仅回流其子代**）——
	 * 不从整图根重排，无关分支的连线与位置一律不动（曾因整树重排导致"很多连线都动"）。
	 * 仅当拖动改变根层成员（进出根层）时才 restackRoots 全图根重堆；
	 * 每步布局后把结果同步回 this.nodes，后续重堆读到的是新坐标而非拖放前的旧快照。
	 */
	private tidyAffected(oldParentId: string | null, newParentId: string | null): void {
		if (!this.mapId) {
			return;
		}
		const branchIds = new Set<string>();
		// 旧父分支（腾位后兄弟回流；与旧父同支则由新父一次覆盖）
		if (oldParentId != null && oldParentId !== newParentId) {
			branchIds.add(oldParentId);
		}
		// 新父分支（被拖节点与既有兄弟按 order 归位）
		if (newParentId != null) {
			branchIds.add(newParentId);
		}
		for (const pid of branchIds) {
			const pos = layoutSubtree(this.measuredNodes(), pid, this.mapDefault);
			if (pos.size > 0) {
				this.applyLayoutSync(pos);
			}
		}
		// 根层成员变化（挂出根 / 脱离根）才重堆根；普通支内挪动不动其他根的子树
		if (oldParentId == null || newParentId == null) {
			const restack = restackRoots(this.measuredNodes());
			if (restack.size > 0) {
				this.applyLayoutSync(restack);
			}
		}
		this.loadMap(this.mapId);
	}

	/**
	 * this.nodes + DOM 实测高（nodeEls offsetHeight）→ 布局输入。
	 * 媒体图节点实际远高于估值 72，不注入实测高会导致布局间距按估值排、
	 * 渲染后视觉重叠（"部分节点之间无间隔"的根因）。折叠隐藏节点无 DOM 回退估值。
	 */
	private measuredNodes(): GraphNode[] {
		return this.nodes.map((n) => {
			const h = this.nodeEls.get(n.id)?.offsetHeight;
			// offsetHeight 为 0（隐藏/未挂载）时按无实测处理
			return h ? { ...n, h } : n;
		});
	}

	/** applyLayout 落库 + 同步 this.nodes 内存坐标（后续步骤读到新位置而非旧快照） */
	private applyLayoutSync(pos: Map<string, { x: number; y: number }>): void {
		if (this.mapId) {
			this.plugin.mindmaps.applyLayout(this.mapId, pos);
		}
		for (const [id, p] of pos) {
			const n = this.nodes.find((m) => m.id === id);
			if (n) {
				n.x = Math.round(p.x);
				n.y = Math.round(p.y);
			}
		}
	}

	/**
	 * 双击：空白 = 就地新建文字卡片（手工卡，无文档归属）。
	 * ㊺-A：节点双击无绑定（单击已直接跳原文，双击会重复触发）；编辑器面板内
	 * 双击（输入框选词）同样让位。
	 */
	private onDblClick(evt: MouseEvent): void {
		const target = evt.target as HTMLElement;
		// 编辑器面板内双击（如输入框选词）不触发任何画布语义
		if (target.closest(".marinmind-mm-editor")) {
			return;
		}
		if (target.closest(".marinmind-mm-node") || !this.mapId) {
			return; // 节点双击无绑定；无图时不新建
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

	/** 节点右键菜单：跳原文 / 编辑标题批注 / 闪卡开关 / 移出脑图 / 删除卡片 */
	private showNodeMenu(node: MindmapNodeWithCard, evt: MouseEvent): void {
		const card = node.card;
		// 菜单头摘要：标题优先（㊺ 与节点标题栏同源）
		const info = card.title ?? card.note ?? card.excerptText ?? "区域摘录";
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
					.onClick(() => {
						this.closeNodeEditor(false);
						void this.plugin.openCardSource(card);
					}),
			);
		}
		menu.addItem((item) =>
			item
				.setTitle("编辑标题/批注")
				.setIcon("pencil")
				.onClick(() => this.openNodeEditor(node)),
		);
		// 卡片互链（㊻-A）：复制 wikilink / 嵌入语法，贴到普通笔记或 Canvas 白板
		menu.addItem((item) =>
			item
				.setTitle("复制卡片链接")
				.setIcon("link")
				.onClick(() => void this.plugin.copyCardLink(card, "link")),
		);
		menu.addItem((item) =>
			item
				.setTitle("复制嵌入代码")
				.setIcon("copy")
				.onClick(() => void this.plugin.copyCardLink(card, "embed")),
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
		// 分支样式（⑱）：作用于该节点的子树（其子节点如何挂出）
		menu.addItem((item) =>
			item
				.setTitle("分支样式…")
				.setIcon("git-branch")
				.onClick(() => this.showBranchStyleMenu(node, evt)),
		);
		// 固定根节点（㉗）：全局唯一——设定后所有新摘录直挂该节点之下
		const pinned = this.plugin.mindmaps.fixedRoot();
		if (pinned?.nodeId === node.id) {
			menu.addItem((item) =>
				item
					.setTitle("取消固定根节点")
					.setIcon("pin-off")
					.onClick(() => this.clearFixedRoot(node.mapId)),
			);
		} else {
			menu.addItem((item) =>
				item
					.setTitle("设为固定根节点")
					.setIcon("pin")
					.onClick(() => this.setFixedRootFor(node)),
			);
		}
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

	/**
	 * 分支样式菜单（⑱，参照 MN4）：跟随全局 + 六种样式，作用于该节点的子树。
	 * 当前生效样式随"跟随全局"展示；显式覆盖的样式带勾选标记。
	 */
	private showBranchStyleMenu(node: MindmapNodeWithCard, evt: MouseEvent): void {
		const eff = this.styleOf(node.id);
		const menu = new Menu();
		menu.addItem((item) =>
			item
				.setTitle(`跟随全局（${BRANCH_STYLE_LABELS[eff]}）`)
				.setIcon(node.branchStyle ? "circle" : "check")
				.onClick(() => this.applyBranchStyle(node.id, null)),
		);
		menu.addSeparator();
		for (const s of BRANCH_STYLES) {
			menu.addItem((item) =>
				item
					.setTitle(BRANCH_STYLE_LABELS[s])
					.setIcon(node.branchStyle === s ? "check" : "circle")
					.onClick(() => this.applyBranchStyle(node.id, s)),
			);
		}
		menu.showAtMouseEvent(evt);
	}

	/** 应用节点分支样式覆盖：写库后重拉（重建连线/收纳框与折叠钮侧边；平移缩放保持） */
	private applyBranchStyle(nodeId: string, style: BranchStyle | null): void {
		if (!this.mapId) {
			return;
		}
		this.plugin.mindmaps.setBranchStyle(nodeId, style);
		this.loadMap(this.mapId);
	}

	/** 图级默认分支样式切换：写库后重拉（未覆盖的节点全部跟随新样式） */
	private setDefaultStyle(style: BranchStyle): void {
		if (!this.mapId) {
			return;
		}
		this.plugin.mindmaps.setDefaultBranchStyle(this.mapId, style);
		this.loadMap(this.mapId);
	}

	/** 本地移除节点（库已删）：子上浮为根原位保留，仅重画连线 */
	private removeNodeLocal(nodeId: string): void {
		// 编辑器开着的目标节点被移除：面板悬空，立即关（面板在 viewport 不在 world，
		// rebuildWorld 清不到）
		if (this.nodeEditor?.nodeId === nodeId) {
			this.closeNodeEditor(false);
		}
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
				// ㊺ 传实测高度：三栏节点普遍高于估值 72，只看 y 顶点会排进上一根身位
				this.nodes
					.filter((n) => n.parentId === null)
					.map((n) => ({ x: n.x, y: n.y, h: this.nodeEls.get(n.id)?.offsetHeight })),
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
