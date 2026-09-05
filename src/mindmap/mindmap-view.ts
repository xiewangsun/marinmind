import { ItemView, Menu, Notice, setIcon } from "obsidian";
import type { TFile, ViewStateResult, WorkspaceLeaf } from "obsidian";
import type MarinMindPlugin from "../main";
import type { BranchStyle, Card, MindmapNodeWithCard } from "../types";
import { BRANCH_STYLES, BRANCH_STYLE_LABELS, isBranchStyle } from "../types";
import { READER_VIEW_TYPE } from "../reader/reader-view";
import { TextPromptModal } from "../reader/note-edit-modal";
import { CardPickerModal } from "./card-picker-modal";
import { LinkPickerModal } from "./link-picker-modal";
import { ConfirmModal } from "./confirm-modal";
import { NodeSearchModal } from "./node-search-modal";
import { deleteCardCascade, promptCardLinks } from "../home/card-actions";
import { buildCardCopyText } from "../links/card-links";
import { createViewModeBar } from "../ui/view-mode-bar";
import { setIconSafe } from "../ui/icon-resolve";
import { isHiddenVaultDir, fsBasename, pageWordOf, docExtOf } from "../storage/paths";
import { readExternalBinary } from "../storage/external-file";
import { acquirePdf, pdfCacheKey } from "../reader/pdf-cache";
import { parseEpub, epubOutline } from "../reader/epub-document";
import { measureMdOutline } from "./md-outline-measure";
import { PdfPickerModal, pickTarget } from "../reader/pdf-picker-modal";
import { buildOutlineMarkdown, buildOutlineOpml } from "./outline-export";
import { allocateExportPath, exportMindmapPng } from "./map-image-export";
import { planOutlineChapters, type ChapterPlanItem } from "./pdf-outline";
import type { OutlineEntry } from "../reader/pdf-document";
import { collectTargetOf, ensureGroupCard } from "./auto-collect";
import { AiOrganizeModal } from "../ai/ai-organize-modal";
import {
	ORGANIZE_NODE_CAP,
	wouldCycle,
	type OrganizeCandidate,
	type OrganizeGroupPlan,
} from "../ai/ai-plan";
import {
	buildChildrenMap,
	bulkCollapsePlan,
	dropPlacement,
	dropZoneFor,
	edgeDots,
	edgePath,
	compareSiblings,
	collapsedAncestorsOf,
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
	type NavigateDir,
	navigateTree,
	linkEdgePath,
	NODE_HEIGHT_EST,
	NODE_WIDTH,
	restackRoots,
	snapDragPosition,
	type SnapGuide,
	subtreeIds,
	suggestChildPosition,
	suggestRootPosition,
	visibleNodes,
} from "./mindmap-graph";
import { MindmapPickerModal } from "./mindmap-picker-modal";
import { MergePickerModal } from "./merge-picker-modal";
import { mergeCardsInto } from "./card-merge";
import {
	applyUndoEntry,
	buildUndoEntry,
	captureMapState,
	MindmapUndoStack,
	type MapSnapshot,
} from "./undo-stack";

/** 思维导图视图的 viewType */
export const MINDMAP_VIEW_TYPE = "marinmind-mindmap";

/** 活跃脑图视图注册表（onOpen 加入 / onClose 移除），供阅读器拖拽入图定位目标 */
const activeViews = new Set<MarinMindMindmapView>();

/**
 * 更新全部活跃脑图的落点提示（悬停的 viewport/节点上高亮类）。
 * 返回指针悬停的视图（无则 null）——阅读器拖卡的 pointermove/pointerup 调用。
 */
/**
 * 拖拽落点提示汇总（阅读器拖卡）：全部活跃脑图依次尝试，返回指针下的视图。
 * doc 过滤（79-6 多窗口）：只允许"坐标所属文档"的视图吃提示——两窗并屏时
 * 他窗视口矩形与本窗 client 坐标可能数值重叠，不过滤会串窗误亮；
 * 非匹配视图只清不加（指针不在其坐标空间）。缺省 = 不过滤（旧语义）。
 */
export function updateMindmapDropHint(
	x: number,
	y: number,
	doc?: Document,
): MarinMindMindmapView | null {
	let hovered: MarinMindMindmapView | null = null;
	for (const view of activeViews) {
		if (!doc || view.contentEl.ownerDocument === doc) {
			if (view.updateDropHint(x, y)) {
				hovered = view;
			}
		} else {
			view.clearDropHint();
		}
	}
	return hovered;
}

/**
 * 清除全部活跃脑图的落点提示（拖拽结束/取消时调用）。
 * doc 过滤（79-6）：只清指定文档的视图——跨窗拖拽期间源窗与他窗提示
 * 由各自坐标路径分管；缺省 = 全部清（拖拽结束语义）。
 */
export function clearMindmapDropHints(doc?: Document): void {
	for (const view of activeViews) {
		if (!doc || view.contentEl.ownerDocument === doc) {
			view.clearDropHint();
		}
	}
}

/** 活跃脑图视图快照出口（79-6 跨窗口拖卡按窗口分组遍历；只读用途） */
export function activeMindmapViews(): MarinMindMindmapView[] {
	return [...activeViews];
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
	/** 「添加到脑图」总开关按钮（header 内，㉗；89-B 起 icon-only）：全局持久化 settings.autoAddToMindmap */
	private autoAddBtn: HTMLElement | null = null;
	/** ⋯ 溢出菜单按钮（header 内，89-B）：分支样式/固定根/重命名/删除/自动布局/
	 *  目录建框架/撤销/重做/刷新折叠于此 */
	private headerOverflowBtn: HTMLElement | null = null;
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
	/** 58 对齐吸附参考线元素（拖节点吸附时 worldEl 内的 1px 强调色线，最多一竖一横） */
	private snapGuideEls: HTMLElement[] = [];
	/** ㉜ 被拖子树 DOM 快照：nodeId → {el, startLeft, startTop, worldX, worldY}（含折叠隐藏后代） */
	private subtreeSnapshot: Map<
		string,
		{ el: HTMLElement; startLeft: number; startTop: number; worldX: number; worldY: number }
	> | null = null;
	/** cardBus 退订器（onClose 统一退订防泄漏） */
	private cardBusOffs: Array<() => void> = [];
	/** 51 折叠全部/展开全部双态钮（标签页头部）：图标与禁用态随图数据同步 */
	private collapseBtnEl: HTMLElement | null = null;
	/** 59 全局撤销/重做双栈（随视图生命周期；换图/清图整体作废）；
	 *  89-B 起头部按钮并入 ⋯ 菜单，栈空态由菜单项打开时 setDisabled 现读 */
	private readonly undoStack = new MindmapUndoStack();
	/** 59 进行中的撤销捕获（begin→写路径→commit；同步区间无交错，防御换图丢弃） */
	private undoCapture: { mapId: string; nodes: MapSnapshot; mapDefault: BranchStyle } | null =
		null;
	/** 52 键盘选中节点 id（node.id 键）：单击/右键节点即选中（跳原文照旧），
	 * 方向键导航 / Tab 建子 / Enter 建兄弟 / Delete 移出以它为锚 */
	private selectedNodeId: string | null = null;
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
	/** keydown 宿主文档（bindKeydown 记录，unbindKeydown 解绑用；弹窗/主窗随 ownerDocument 切换） */
	private keydownDoc: Document | null = null;
	/** 文档级 keydown 处理器（箭头字段持有 this 绑定，绑/解同一引用） */
	private readonly onDocKeydown = (evt: KeyboardEvent): void => {
		this.onKeydown(evt);
	};
	/** 无选中时键盘操作提示是否已弹过（实例级一次；避免每次按键都 Notice 刷屏） */
	private keyHintShown = false;

	constructor(leaf: WorkspaceLeaf, plugin: MarinMindPlugin) {
		super(leaf);
		this.plugin = plugin;

		// 90 批顶栏合一：原头部 addAction 四枚（添加卡片/新建文字卡片/导出/折叠全部）
		// 迁入视图内 header 与 ⋯ 菜单（buildSkeleton / openHeaderOverflowMenu）——
		// 原生标题行已由 CSS 隐藏，header 成为唯一顶栏。自动布局/目录建框架/
		// 撤销/重做/刷新同在 ⋯ 菜单（撤销重做 Ctrl+Z/Ctrl+Shift+Z 快捷键不受影响）
		// keydown 解绑兜底：popout 迁移等路径若漏调 onClose 的显式解绑，卸载时兜底清理
		this.register(() => this.unbindKeydown());
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
		this.unbindKeydown(); // 文档级 keydown 显式解绑（幂等）
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
		this.undoStack.clear(); // 59 视图销毁，撤销/重做栈随废
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

	/** header「添加到脑图」开关按钮的激活态同步（buildSkeleton/loadMap/开关切换后调用；
	 *  89-B 起固定根无行内按钮，固定态由 ⋯ 菜单打开时现读 fixedRootId） */
	private syncHeaderButtons(): void {
		const on = this.plugin.settings.autoAddToMindmap;
		this.autoAddBtn?.classList.toggle("is-active", on);
		this.autoAddBtn?.setAttribute("aria-pressed", String(on));
	}

	/**
	 * 复习入口「本书」推导（91 批）：当前图绑定的文档（书的默认同名图）优先；
	 * 主题图无归属时回退阅读器当前书（联动一对一语义——正读的书即"本书"）；
	 * 仍无 → null（全部书籍，openReview 缺省语义）。
	 */
	private reviewBookId(): string | null {
		const map = this.mapId ? this.plugin.mindmaps.get(this.mapId) : null;
		return map?.documentId ?? this.plugin.activeReaderDocId();
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
		if (mapId !== this.mapId) {
			// 换图：栈内条目全部指向旧图节点，整体作废（同图刷新/重拉不走此分支保留栈）
			this.undoStack.clear();
		}
		this.mapId = mapId;
		this.mapDefault = map.defaultBranchStyle;
		// 固定根节点（㉗）：全局唯一，可能是本图节点也可能在别的图——
		// 徽标只标在命中的节点上；头按钮的激活态看它是否存在
		this.fixedRootId = this.plugin.mindmaps.fixedRoot()?.nodeId ?? null;
		this.nodes = this.plugin.mindmaps.listNodes(mapId);
		this.rebuildWorld();
		this.updateHeader();
		this.syncCollapseButton();
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
		this.undoStack.clear(); // 59 图已卸载，栈作废
		this.rebuildWorld();
		this.updateHeader();
		this.syncCollapseButton();
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
				// 59 布局前后快照进全局撤销栈（51 单槽快照被取代——连续撤销可穿过多命令）
				this.beginUndoCapture();
				// 布局输入注入 DOM 实测高（媒体图节点远高于估值，不注入则间距按 72 排导致视觉重叠）
				this.plugin.mindmaps.applyLayout(
					this.mapId,
					layoutTree(this.measuredNodes(), this.mapDefault),
				);
				this.loadMap(this.mapId);
				this.fitToContent();
				this.commitUndo("自动布局");
			},
		).open();
	}

	/**
	 * 批量折叠/展开全部（51）：bulkCollapsePlan 只取真正需要变化的节点；
	 * 逐节点 setCollapsed（markDirty 同 scope 经 2s 防抖合并为一次落盘，无写放大），
	 * 单次 loadMap 重拉画布（平移缩放保持）。
	 */
	private bulkCollapse(collapseAll: boolean): void {
		if (!this.mapId) {
			new Notice("请先打开或创建一张脑图");
			return;
		}
		const plan = bulkCollapsePlan(this.nodes, collapseAll);
		if (plan.length === 0) {
			new Notice(collapseAll ? "没有可折叠的节点" : "没有已折叠的节点");
			return;
		}
		this.beginUndoCapture(); // 59 整批一个条目
		for (const item of plan) {
			this.plugin.mindmaps.setCollapsed(item.id, item.collapsed);
		}
		this.loadMap(this.mapId);
		this.commitUndo(collapseAll ? "折叠全部" : "展开全部");
	}

	/** 51 折叠双态钮刷新：有"有子未折叠"→ 折叠全部；否则有折叠 → 展开全部；都无禁用。
	 * setIcon 只替换按钮内部 svg，addAction 挂在按钮上的点击回调不受影响 */
	private syncCollapseButton(): void {
		const btn = this.collapseBtnEl;
		if (!btn) {
			return;
		}
		const planCollapse = bulkCollapsePlan(this.nodes, true).length > 0;
		const planExpand = bulkCollapsePlan(this.nodes, false).length > 0;
		if (planCollapse) {
			btn.removeClass("is-disabled");
			const label = "折叠全部";
			btn.setAttribute("aria-label", label);
			btn.setAttribute("title", label);
			setIcon(btn, "chevrons-down-up");
		} else if (planExpand) {
			btn.removeClass("is-disabled");
			const label = "展开全部";
			btn.setAttribute("aria-label", label);
			btn.setAttribute("title", label);
			setIcon(btn, "chevrons-up-down");
		} else {
			btn.addClass("is-disabled");
			const label = "没有可折叠/展开的节点";
			btn.setAttribute("aria-label", label);
			btn.setAttribute("title", label);
		}
	}

	// ---------- 全局撤销/重做（59；51 布局单槽被取代；89-B 起入口在 ⋯ 菜单） ----------

	/**
	 * 开始一次撤销捕获：从 repo 读操作前快照（**绝不读 this.nodes**——拖拽
	 * pointermove 已就地改写视图内存，repo 才是真正的操作前状态）。
	 * begin → 既有写路径原样执行 → commitUndo 差分进栈；同步区间无交错。
	 */
	private beginUndoCapture(): void {
		if (!this.mapId) {
			return;
		}
		this.undoCapture = {
			mapId: this.mapId,
			nodes: captureMapState(this.plugin.mindmaps, this.mapId),
			mapDefault: this.mapDefault,
		};
	}

	/**
	 * 结束捕获并差分进栈：after 快照同样从 repo 读；图默认样式变化自动入补丁
	 * （setDefaultStyle 无需额外参数）；无 diff 不进栈（等价操作不占深度）。
	 * 换图/清图丢弃（条目混图不可重放）。
	 */
	private commitUndo(label: string): void {
		const cap = this.undoCapture;
		this.undoCapture = null;
		if (!cap || !this.mapId || cap.mapId !== this.mapId) {
			return;
		}
		const after = captureMapState(this.plugin.mindmaps, cap.mapId);
		const defaultPatch =
			cap.mapDefault !== this.mapDefault
				? { before: cap.mapDefault, after: this.mapDefault }
				: null;
		const entry = buildUndoEntry(cap.mapId, label, cap.nodes, after, defaultPatch);
		if (entry) {
			this.undoStack.push(entry);
		}
	}

	/** 撤销最近一条命令：重放 before 侧（悬空节点 repo 静默跳过——契约见 undo-stack.ts） */
	private undoHistory(): void {
		const entry = this.undoStack.undo();
		if (!entry) {
			new Notice("没有可撤销的操作");
			return;
		}
		applyUndoEntry(this.plugin.mindmaps, entry, "before");
		if (this.mapId === entry.mapId) {
			this.loadMap(entry.mapId);
		}
		new Notice(`已撤销：${entry.label}`);
	}

	/** 重做最近一条被撤销的命令：重放 after 侧 */
	private redoHistory(): void {
		const entry = this.undoStack.redo();
		if (!entry) {
			new Notice("没有可重做的操作");
			return;
		}
		applyUndoEntry(this.plugin.mindmaps, entry, "after");
		if (this.mapId === entry.mapId) {
			this.loadMap(entry.mapId);
		}
		new Notice(`已重做：${entry.label}`);
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

		// header（89-B MN3 式单行 icon-only；90 批起为唯一顶栏）：图名 + 节点数 +
		// 添加到脑图 + 复习 + 搜索 + 折叠全部 + 视图循环钮 + ⋯。添加卡片/新建文字
		// 卡片/导出/分支样式/固定根/重命名/删除/自动布局/目录建框架/撤销/重做/刷新
		// 折叠进 ⋯ 溢出菜单（openHeaderOverflowMenu 五组）
		const header = this.contentEl.createDiv({ cls: "marinmind-mm-header" });
		this.titleSpan = header.createSpan({ cls: "marinmind-mm-title" });
		this.titleSpan.textContent = "未打开脑图";
		this.countSpan = header.createSpan({ cls: "marinmind-mm-count" });
		header.createEl("div", { cls: "marinmind-tool-sep" });
		// 「添加到脑图」总开关（㉗，MN4「自动添加到脑图」对齐，默认开）：
		// 全局持久化（settings.autoAddToMindmap）——新摘录自动入图，
		// 固定根节点优先，否则加入该书的默认脑图（见 auto-collect.ts）。
		// 89-B 起 icon-only（ghost 风格 .marinmind-tool-btn，与阅读器工具行统一——
		// R4 评审 D1-01「复习入口三处重量不一」随本次对齐收敛）
		this.autoAddBtn = header.createEl("button", {
			cls: "marinmind-tool-btn",
			attr: {
				type: "button",
				"aria-pressed": "true",
				"aria-label": "添加到脑图",
				title: "开关：新摘录自动添加到脑图",
			},
		});
		// 90 批 MN3 对照：入图=节点连线图 network（原 git-fork 像版本控制；zap 留给
		// 闪卡语义）；低版本 Obsidian 缺名时依次降级 share-2 → git-fork
		setIconSafe(this.autoAddBtn, "network", "share-2", "git-fork");
		this.autoAddBtn.addEventListener("click", () => void this.toggleAutoAdd());
		// 复习入口（㉑，MN4 学习集「复习」按钮）：打开/复用复习窗格并开始到期会话。
		// 91 批默认只考本书（与阅读器工具行入口同语义）：当前图绑定的文档优先，
		// 主题图无归属回退阅读器当前书，仍无才全部书籍（进入后可切全部书籍）
		const reviewBtn = header.createEl("button", {
			cls: "marinmind-tool-btn",
			attr: {
				type: "button",
				"aria-label": "复习本书到期闪卡",
				title: "复习本书到期闪卡（跨书主题图回退当前书/全部书籍）",
			},
		});
		// 90 批 MN3 对照：复习=学习语义 graduation-cap（原 swords 像对战；与阅读器
		// 工具行/节点编辑器/主页入口对齐，语义沿革见评估报告 E-19 与 P2-1 表）
		setIcon(reviewBtn, "graduation-cap");
		reviewBtn.addEventListener(
			"click",
			() => void this.plugin.openReview(this.reviewBookId() ?? undefined),
		);
		// 节点搜索（89-C，MN3 搜索一级入口对齐）：标题/批注/摘录匹配 → 定位居中闪烁
		const searchBtn = header.createEl("button", {
			cls: "marinmind-tool-btn",
			attr: {
				type: "button",
				"aria-label": "搜索脑图节点",
				title: "搜索脑图节点（标题 / 批注 / 摘录）",
			},
		});
		setIcon(searchBtn, "search");
		searchBtn.addEventListener("click", () => this.openNodeSearch());
		// 折叠全部/展开全部双态钮（90 批从原头部 addAction 迁入）：icon/禁用态由
		// syncCollapseButton 动态刷新（setIcon 只换 svg，不破坏点击回调）；创建后
		// 立即刷一次补初始态（此前仅 loadMap 路径调用，header 骨架期会漏）
		this.collapseBtnEl = header.createEl("button", {
			cls: "marinmind-tool-btn",
			attr: {
				type: "button",
				"aria-label": "折叠全部",
				title: "折叠全部",
			},
		});
		setIcon(this.collapseBtnEl, "chevrons-down-up");
		// 93 批：点击行为随双态走——有可折叠 → 折叠全部，否则（已有折叠）→ 展开全部
		// （与 syncCollapseButton 同一判定，按钮标签/图标在折叠完成后已切到另一态）
		this.collapseBtnEl.addEventListener("click", () => {
			this.bulkCollapse(bulkCollapsePlan(this.nodes, true).length > 0);
		});
		this.syncCollapseButton();
		// 三态视图循环钮（90 批单 icon 化）靠右（与阅读器工具行同款，⑰）
		this.viewModeOff?.();
		const modeBar = createViewModeBar(this.plugin);
		this.viewModeOff = modeBar.off;
		header.createEl("div", { cls: "marinmind-mm-header-spacer" });
		header.appendChild(modeBar.el);
		// ⋯ 溢出菜单（89-B；90 批扩组）：低频图级操作折叠收纳，菜单项每次打开现读状态
		this.headerOverflowBtn = header.createEl("button", {
			cls: "marinmind-tool-btn",
			attr: {
				type: "button",
				"aria-label": "更多操作",
				title: "更多操作（添加卡片 / 新建文字卡片 / 分支样式 / 固定根 / 重命名 / 删除 / 导出 / 自动布局 / 目录建框架 / 撤销 / 重做 / 刷新）",
			},
		});
		setIcon(this.headerOverflowBtn, "more-horizontal");
		this.headerOverflowBtn.addEventListener("click", (evt) => this.openHeaderOverflowMenu(evt));

		// 画布：事件宿主是 viewport（world 是 0×0 的 transform 容器，收不到事件）
		this.viewportEl = this.contentEl.createDiv({ cls: "marinmind-mm-viewport" });
		this.worldEl = this.viewportEl.createDiv({ cls: "marinmind-mm-world" });
		this.edgesSvg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
		this.edgesSvg.setAttribute("class", "marinmind-mm-edges");
		this.worldEl.appendChild(this.edgesSvg);

		// 空态提示（无节点时显示，不挡指针；内容由 updateHeader→syncEmptyHint 按状态填充）
		this.emptyEl = this.viewportEl.createDiv({ cls: "marinmind-mm-empty" });

		const hint = this.contentEl.createDiv({ cls: "marinmind-mm-hint" });
		hint.textContent =
			"拖节点到另一节点=连线（挂为子节点）· 拖空白=平移 · Ctrl+滚轮=缩放 · 双击空白=新建卡片 · 节点右缘 ▾=折叠/展开子树 · 右键节点=更多操作 · 点选节点后：Tab=建子卡 · Enter=建兄弟卡 · Delete=移出 · 方向键=导航";

		this.registerCanvasEvents();
		this.applyTransform();
	}

	/**
	 * ⋯ 溢出菜单（89-B；90 批新增卡片组+导出，五组）：卡片（添加已有卡片/新建文字
	 * 卡片，原头部 addAction 迁入）｜图（分支样式…/固定根）｜管理（重命名/删除脑图/
	 * 导出）｜排版（自动布局/从文档目录建框架）｜历史（撤销/重做/刷新）。
	 * 图标+文字，Menu 即开即建，勾选/禁用态每次打开现读（mapDefault/fixedRootId/undoStack）。
	 */
	private openHeaderOverflowMenu(evt: MouseEvent): void {
		const menu = new Menu();
		// 卡片组（90 批迁入；无图时方法内 Notice 兜底）
		menu.addItem((mi) =>
			mi
				.setTitle("添加已有卡片…")
				.setIcon("list-plus")
				.onClick(() => this.openCardPicker()),
		);
		menu.addItem((mi) =>
			mi
				.setTitle("新建文字卡片")
				.setIcon("plus")
				.onClick(() => this.createTextCard()),
		);
		// 图组
		menu.addSeparator();
		menu.addItem((mi) =>
			mi
				.setTitle("分支样式…")
				.setIcon("git-branch")
				.onClick(() => this.showMapStyleMenu(evt)),
		);
		menu.addItem((mi) =>
			mi
				.setTitle("固定根")
				.setIcon("pin")
				.setChecked(this.fixedRootId != null)
				.onClick(() => this.toggleFixedRoot()),
		);
		// 管理组
		menu.addSeparator();
		menu.addItem((mi) =>
			mi
				.setTitle("重命名")
				.setIcon("pencil")
				.onClick(() => this.renameMap()),
		);
		menu.addItem((mi) =>
			mi
				.setTitle("删除脑图")
				.setIcon("trash-2")
				.onClick(() => this.deleteMap()),
		);
		// 90 批导出迁入管理组（原头部 addAction；二级菜单定位沿用外层 ⋯ 事件的
		// 捕获传参模式——MenuItem onClick 参数为 MouseEvent|KeyboardEvent 不能直传）
		menu.addItem((mi) =>
			mi
				.setTitle("导出（大纲 / OPML / 图片）…")
				.setIcon("download")
				.onClick(() => this.openExportMenu(evt)),
		);
		// 排版组
		menu.addSeparator();
		menu.addItem((mi) =>
			mi
				.setTitle("自动布局")
				.setIcon("layout-template")
				.onClick(() => this.autoLayout()),
		);
		menu.addItem((mi) =>
			mi
				.setTitle("从文档目录建框架")
				.setIcon("list-tree")
				.onClick(() => this.pickOutlineSource()),
		);
		// 100 AI 整理：根级散卡语义归组（子级整理在节点右键菜单）
		menu.addItem((mi) =>
			mi
				.setTitle("AI 整理…")
				.setIcon("wand")
				.onClick(() => this.openAiOrganize(null)),
		);
		// 历史组（快捷键仍在：onKeydown Ctrl+Z / Ctrl+Shift+Z；栈空挂禁用）
		menu.addSeparator();
		menu.addItem((mi) =>
			mi
				.setTitle("撤销 (Ctrl+Z)")
				.setIcon("undo-2")
				.setDisabled(!this.undoStack.canUndo())
				.onClick(() => this.undoHistory()),
		);
		menu.addItem((mi) =>
			mi
				.setTitle("重做 (Ctrl+Shift+Z)")
				.setIcon("redo-2")
				.setDisabled(!this.undoStack.canRedo())
				.onClick(() => this.redoHistory()),
		);
		menu.addItem((mi) =>
			mi
				.setTitle("刷新")
				.setIcon("rotate-cw")
				.onClick(() => this.refresh()),
		);
		menu.showAtMouseEvent(evt);
	}

	/**
	 * 图级默认分支样式二段菜单（⑱ select 的菜单化替代，89-B）：九种样式单选
	 * （勾选 = 当前 mapDefault），选中即 setDefaultStyle（未覆盖的节点全部跟随）。
	 */
	private showMapStyleMenu(evt: MouseEvent): void {
		if (!this.mapId) {
			new Notice("请先打开或创建一张脑图");
			return;
		}
		const menu = new Menu();
		for (const s of BRANCH_STYLES) {
			menu.addItem((mi) =>
				mi
					.setTitle(BRANCH_STYLE_LABELS[s])
					.setChecked(s === this.mapDefault)
					.onClick(() => this.setDefaultStyle(s)),
			);
		}
		menu.showAtMouseEvent(evt);
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
		// 58 参考线元素随 worldEl 清空销毁，数组同步重置（防 clearSnapGuides 摸已死引用）
		this.snapGuideEls = [];
		const visible = visibleNodes(this.nodes);
		for (const node of this.nodes) {
			if (!visible.has(node.id)) {
				continue;
			}
			this.createNodeEl(node);
		}
		this.drawEdges();
		// 52 选中态重挂：节点 el 全新（类名随 DOM 销毁）——命中且可见才恢复，
		// 否则清空（换图 / 节点消失 / 折叠隐藏三态统一收口）
		const sel = this.selectedNodeId;
		if (sel) {
			this.selectedNodeId = null;
			if (this.nodeEls.has(sel) && visible.has(sel)) {
				this.setSelected(sel);
			}
		}
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

		// 子脑图 portal 徽标（61）：子树已坍缩进独立图，双击进入。
		// 读侧防御收口：引用悬空（子图被外部删除而清扫未落盘前）不显示，
		// openChildMap 的 get 守卫负责自愈
		if (node.childMapId && this.plugin.mindmaps.get(node.childMapId)) {
			const portal = document.createElement("span");
			portal.className = "marinmind-mm-portal";
			setIcon(portal, "folder-tree");
			portal.title = "子脑图：双击打开";
			el.appendChild(portal);
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
			toggle.setAttribute("aria-label", node.collapsed ? "展开子树" : "折叠子树");
			toggle.textContent = node.collapsed ? `▸ ${this.descendantCount(node.id)}` : "▾";
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
		// 71 遮挡徽标：已设遮挡的卡在标题栏右侧给 eye-off 小标（复习正面会遮住
		// 对应区域——脑图上一眼可见该卡是"挖空卡"；cardBus changed 重渲染天然同步）
		if (card.occlusions.length > 0) {
			const occ = document.createElement("span");
			occ.className = "marinmind-mm-node-occ";
			occ.title = "已设遮挡（复习时遮住对应区域）";
			setIcon(occ, "eye-off");
			head.appendChild(occ);
		}
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
			const doc = card.documentId ? this.plugin.documents.get(card.documentId) : undefined;
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
		this.beginUndoCapture(); // 59
		this.plugin.mindmaps.setCollapsed(nodeId, !node.collapsed);
		this.loadMap(this.mapId);
		this.commitUndo(node.collapsed ? "展开子树" : "折叠子树");
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
		let minX = Infinity,
			minY = Infinity,
			maxX = -Infinity,
			maxY = -Infinity;
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
			// 57 标题栏式：框围住 父+子 并集（父嵌框内顶部）
			const rect = frameRectFor(
				{
					x: n.x,
					y: n.y,
					w: NODE_WIDTH,
					h: this.nodeEls.get(n.id)?.offsetHeight ?? NODE_HEIGHT_EST,
				},
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
			const parentBox = {
				x: parent.x,
				y: parent.y,
				h: this.nodeEls.get(parent.id)?.offsetHeight,
			};
			const childBox = { x: n.x, y: n.y, h: this.nodeEls.get(n.id)?.offsetHeight };
			const style = this.styleOf(parent.id);
			const d = edgePath(parentBox, childBox, style);
			if (d == null) {
				continue; // frame：连线由收纳框替代
			}
			const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
			path.setAttribute("class", "marinmind-mm-edge");
			path.setAttribute("d", d);
			svg.appendChild(path);
			// 57 line 族端点圆点（MN4 直线细节）：两端实心圆点，端点在节点盒缘上不扩包围盒
			const dots = edgeDots(parentBox, childBox, style);
			if (dots) {
				for (const p of dots) {
					const dot = document.createElementNS("http://www.w3.org/2000/svg", "circle");
					dot.setAttribute("class", "marinmind-mm-edge-dot");
					dot.setAttribute("cx", String(p.x));
					dot.setAttribute("cy", String(p.y));
					dot.setAttribute("r", "3");
					svg.appendChild(dot);
				}
			}
		}
		// 53 卡片互链虚线边：单遍遍历全库链接（勿用 neighbors()——O(节点×链接) 退化），
		// 两端卡片都在本图且可见才画；端点取节点盒内相邻侧中点，不扩包围盒
		const links = this.plugin.store?.links;
		if (links && links.size > 0) {
			const byCardId = new Map(this.nodes.map((n) => [n.cardId, n]));
			for (const link of links.values()) {
				const a = byCardId.get(link.sourceId);
				const b = byCardId.get(link.targetId);
				if (!a || !b || !visible.has(a.id) || !visible.has(b.id)) {
					continue;
				}
				const d = linkEdgePath(
					{ x: a.x, y: a.y, h: this.nodeEls.get(a.id)?.offsetHeight },
					{ x: b.x, y: b.y, h: this.nodeEls.get(b.id)?.offsetHeight },
				);
				const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
				path.setAttribute("class", "marinmind-mm-link");
				path.setAttribute("d", d);
				svg.appendChild(path);
			}
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
		// 89-B 分支样式无行内 select：当前 mapDefault 由 ⋯ 菜单打开时现读勾选
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
		const inside = x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom;
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
		const {
			parentId,
			x: wx,
			y: wy,
		} = dropPlacement(this.nodes, hitId, this.toWorld(x, y), this.mapDefault);
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
	 * elementFromPoint 用本视图所在窗口的 document（79-6 跨 popout：popout 内
	 * 视图只有其 ownerDocument 认得自己的坐标空间，全局 document 命中不了他窗）。
	 * 归属验证 nodeEls.get(id) === el：多脑图同屏时 elementFromPoint 可能命中他图节点。
	 */
	private hitNodeAt(x: number, y: number): string | null {
		const hit = this.contentEl.ownerDocument
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
	 * 节点被折叠隐藏时自动展开祖先链后定位（79-2）；不在本图返回 false
	 * （调用方继续尝试其他脑图视图）。
	 */
	public locateCard(cardId: string): boolean {
		const vp = this.viewportEl;
		let node = this.nodes.find((n) => n.cardId === cardId);
		if (!node || !vp) {
			return false;
		}
		if (!visibleNodes(this.nodes).has(node.id)) {
			// 79-2 折叠隐藏的后代：自动展开祖先链后重定位。repo setCollapsed 直写
			// 不进撤销栈——展开属定位的视图便利而非内容编辑（toggleCollapsed 视图
			// 写路径才进栈）；无折叠祖先可救（孤儿/脏数据）仍返回 false
			const anc = collapsedAncestorsOf(this.nodes, node.id);
			if (anc.length === 0 || !this.mapId) {
				return false;
			}
			for (const id of anc) {
				this.plugin.mindmaps.setCollapsed(id, false);
			}
			// 折叠隐藏节点无 DOM：loadMap 重建；平移缩放保持（createChildCard 先例）
			this.loadMap(this.mapId);
			node = this.nodes.find((n) => n.cardId === cardId) ?? node; // loadMap 重建 this.nodes，重取
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

	/**
	 * 节点搜索入口（89-C，MN3 搜索一级入口对齐）：标题/批注/摘录匹配；
	 * 选中后 locateCard 定位（居中 + 展开折叠祖先 + 闪烁全内建），
	 * 节点被跨标签删除时兜底提示。
	 */
	private openNodeSearch(): void {
		if (!this.mapId) {
			new Notice("请先打开或创建一张脑图");
			return;
		}
		if (this.nodes.length === 0) {
			new Notice("当前脑图没有节点");
			return;
		}
		new NodeSearchModal(this.app, {
			nodes: () => this.nodes,
			onChoose: (node) => {
				if (!this.locateCard(node.cardId)) {
					new Notice("该节点已不在当前脑图中（可能已被删除）");
				}
			},
		}).open();
	}

	// ---------- 52 键盘操作（选中态 + 方向键导航 + Tab/Enter/Delete） ----------

	/** 选中节点（键盘锚点）：旧 el 摘类 → 新 el 挂类（el 不存在——折叠隐藏瞬间，容忍保留 id） */
	private setSelected(nodeId: string | null): void {
		if (this.selectedNodeId === nodeId) {
			return;
		}
		const prev = this.selectedNodeId;
		this.selectedNodeId = nodeId;
		if (prev) {
			this.nodeEls.get(prev)?.removeClass("marinmind-mm-selected");
		}
		if (nodeId) {
			this.nodeEls.get(nodeId)?.addClass("marinmind-mm-selected");
		}
	}

	/** 选中节点滚入视口：屏幕矩形出视口（40px 余量）才平移居中（复用 locateCard 数学，保持缩放） */
	private ensureNodeVisible(nodeId: string): void {
		const vp = this.viewportEl;
		const el = this.nodeEls.get(nodeId);
		if (!vp || !el) {
			return;
		}
		const vr = vp.getBoundingClientRect();
		const r = el.getBoundingClientRect();
		const margin = 40;
		if (
			r.top >= vr.top + margin &&
			r.bottom <= vr.bottom - margin &&
			r.left >= vr.left + margin &&
			r.right <= vr.right - margin
		) {
			return;
		}
		const node = this.nodes.find((n) => n.id === nodeId);
		if (!node) {
			return;
		}
		const h = el.offsetHeight || NODE_HEIGHT_EST;
		this.tx = vr.width / 2 - (node.x + NODE_WIDTH / 2) * this.scale;
		this.ty = vr.height / 2 - (node.y + h / 2) * this.scale;
		this.applyTransform();
	}

	/** Tab 建子节点：选中节点折叠中先展开再挂接；弹窗取消不建（选中保持） */
	private createChildCard(parentNodeId: string): void {
		const mapId = this.mapId;
		if (!mapId) {
			return;
		}
		const parent = this.nodes.find((n) => n.id === parentNodeId);
		if (!parent) {
			return;
		}
		if (parent.collapsed) {
			// 展开子树（loadMap 平移缩放保持；选中态经 rebuildWorld 尾部重挂）
			this.plugin.mindmaps.setCollapsed(parent.id, false);
			this.loadMap(mapId);
		}
		new TextPromptModal(
			this.app,
			{ title: "新建子卡片", placeholder: "输入卡片内容…" },
			(text) => {
				if (!text) {
					return;
				}
				this.addKeyboardCard(text, parentNodeId);
			},
		).open();
	}

	/** Enter 建兄弟节点：选中节点为根时 = 建新根 */
	private createSiblingCard(nodeId: string): void {
		const node = this.nodes.find((n) => n.id === nodeId);
		if (!node) {
			return;
		}
		const parentId = node.parentId;
		new TextPromptModal(
			this.app,
			{
				title: parentId ? "新建兄弟卡片" : "新建根节点卡片",
				placeholder: "输入卡片内容…",
			},
			(text) => {
				if (!text) {
					return;
				}
				this.addKeyboardCard(text, parentId);
			},
		).open();
	}

	/**
	 * 键盘建卡落库（52）：有父 → suggestChildPosition（按父生效样式，兄弟顺延）；
	 * 无父 → suggestRootPosition 新根。保存回调内重找节点——弹窗期间图可能被
	 * 重拉/目标节点被移除（竞态防御，节点消失 Notice 中止）。
	 */
	private addKeyboardCard(text: string, parentId: string | null): void {
		const mapId = this.mapId;
		if (!mapId) {
			return;
		}
		const parent = parentId ? this.nodes.find((n) => n.id === parentId) : undefined;
		if (parentId && !parent) {
			new Notice("目标节点已不存在");
			return;
		}
		const pos = parent
			? suggestChildPosition(
					parent,
					this.nodes.filter((n) => n.parentId === parentId),
					this.styleOf(parent.id),
				)
			: suggestRootPosition(
					// ㊺ 同款：传实测高防新根排进矮估的上一根身位
					this.nodes
						.filter((n) => n.parentId === null)
						.map((n) => ({ x: n.x, y: n.y, h: this.nodeEls.get(n.id)?.offsetHeight })),
				);
		const card = this.plugin.cards.create({
			documentId: null,
			page: null,
			rects: [],
			excerptType: "text",
			excerptText: text,
		});
		const added = this.plugin.mindmaps.addNode(
			mapId,
			card.id,
			parentId,
			Math.round(pos.x),
			Math.round(pos.y),
		);
		if (!added) {
			new Notice("该卡片已在此图中");
			return;
		}
		this.nodes.push(added);
		this.createNodeEl(added);
		this.drawEdges();
		this.updateHeader();
		this.setSelected(added.id); // 建卡后锚点转移到新节点（可连续 Enter/Tab 建链）
	}

	/** Delete 移出脑图（= 右键「移出脑图」语义，卡片保留可重加）：选中转移到父节点 */
	private removeSelectedNode(node: MindmapNodeWithCard): void {
		const nextSel = node.parentId; // removeNodeLocal 会清命中选中，先捕获父
		this.plugin.mindmaps.removeNode(node.id);
		this.removeNodeLocal(node.id);
		// portal 被移出（61）：其子图保留为独立图不随之删除（无损），与菜单移出同提示
		if (node.childMapId) {
			const kept = this.plugin.mindmaps.get(node.childMapId);
			if (kept) {
				new Notice(`节点已移出；其子脑图《${kept.name}》已保留为独立脑图`);
			}
		}
		if (nextSel) {
			this.setSelected(nextSel);
		}
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

		// 85-D 摘录只读块：OCR/划选文字存 excerptText，编辑器此前只读写
		// title/note——用户在面板里"看不到 OCR 文字"。只读展示（OCR 纠错走
		// 阅读器覆盖确认流程，编辑面不改 excerptText 语义）。
		const excerpt = node.card.excerptText?.trim();
		if (excerpt) {
			const excerptBlock = document.createElement("div");
			excerptBlock.className = "marinmind-mm-editor-excerpt";
			const excerptLabel = document.createElement("div");
			excerptLabel.className = "marinmind-mm-editor-excerpt-label";
			excerptLabel.textContent = "摘录（只读）";
			const excerptBody = document.createElement("div");
			excerptBody.className = "marinmind-mm-editor-excerpt-body";
			excerptBody.textContent = excerpt;
			excerptBlock.appendChild(excerptLabel);
			excerptBlock.appendChild(excerptBody);
			el.appendChild(excerptBlock);
		}

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

		// 52 键盘操作（MarginNote 风格）：Esc 取消（㊳ 拖拽取消扩展）+ 方向键树内导航 +
		// Tab 建子 / Enter 建兄弟 / Delete 移出。keydown 挂视图宿主文档 + activeLeaf 守卫
		// （同 reader-view 的 Esc 先例）；弹窗/菜单/输入态让位（它们自己消费按键）。
		// 绑 contentEl.ownerDocument 而非全局 document：弹出窗口（popout）里主文档收不到
		// 键盘事件；且 Obsidian 迁移 popout 会 onClose→onOpen 重跑，registerDomEvent 会
		// 累积重复处理器——改手动绑/解（bindKeydown/unbindKeydown）幂等可重入。
		this.bindKeydown();
	}

	/** 绑定文档级 keydown（幂等：已绑先解再绑，onOpen/popout 迁移重跑安全） */
	private bindKeydown(): void {
		this.unbindKeydown();
		const doc = this.contentEl.ownerDocument;
		doc.addEventListener("keydown", this.onDocKeydown);
		this.keydownDoc = doc;
	}

	/** 解绑文档级 keydown（onClose 调用；this.register 兜底防泄漏） */
	private unbindKeydown(): void {
		if (this.keydownDoc) {
			this.keydownDoc.removeEventListener("keydown", this.onDocKeydown);
			this.keydownDoc = null;
		}
	}

	/**
	 * 联动定位原文后归还 activeLeaf（Tab 键失效修复）：
	 * revealCardInReader 内部 setActiveLeaf(readerLeaf) 会把 activeLeaf 抢给阅读器，
	 * 而 onKeydown 以 activeLeaf !== this.leaf 守卫让位——点完节点后 Tab/Enter/
	 * Delete/方向键全部失效。await 完成后把 activeLeaf 拿回本视图（不抢 DOM 焦点，
	 * focus:false 阅读器侧滚动定位不受影响）。
	 */
	private async revealAndRestoreFocus(card: Card): Promise<void> {
		await this.plugin.revealCardInReader(card);
		if (!this.contentEl.isConnected) {
			return; // await 期间视图被拆（关闭/换窗）：不再归还
		}
		this.app.workspace.setActiveLeaf(this.leaf, { focus: false });
	}

	/** 键盘路由：59 撤销重做（Ctrl+Z 系）→ 白名单 → 修饰键/焦点让位 → Esc 既有链（编辑器 > 拖拽取消 > 清选中）→ 六键分发 */
	private onKeydown(evt: KeyboardEvent): void {
		const key = evt.key;
		// 59 撤销/重做：Ctrl/Cmd+Z 撤销、Ctrl+Shift+Z 或 Ctrl+Y 重做。
		// 必须在 navKeys 白名单早退**之前**（"z"/"y" 不在白名单会被吞掉）；
		// 让位链：activeLeaf → 弹窗/输入态（输入框内 Ctrl+Z = 原生文本撤销）→
		// 节点编辑器（undo 的 loadMap 首行会静默关面板丢未保存编辑），再 preventDefault。
		if (
			(evt.ctrlKey || evt.metaKey) &&
			!evt.altKey &&
			(key === "z" || key === "Z" || key === "y" || key === "Y")
		) {
			if (this.app.workspace.activeLeaf !== this.leaf) {
				return;
			}
			const target = evt.target as HTMLElement | null;
			if (target?.closest?.(".modal-container, .menu, input, textarea, [contenteditable]")) {
				return;
			}
			if (this.nodeEditor) {
				return;
			}
			evt.preventDefault();
			if (key === "y" || key === "Y" || evt.shiftKey) {
				this.redoHistory();
			} else {
				this.undoHistory();
			}
			return;
		}
		const navKeys = new Set([
			"ArrowUp",
			"ArrowDown",
			"ArrowLeft",
			"ArrowRight",
			"Tab",
			"Enter",
			"Delete",
		]);
		if (key !== "Escape" && !navKeys.has(key)) {
			return;
		}
		if (evt.ctrlKey || evt.metaKey || evt.altKey || evt.shiftKey) {
			return; // 组合键（含 Shift+Tab 焦点回退）让位
		}
		if (this.app.workspace.activeLeaf !== this.leaf) {
			return;
		}
		const target = evt.target as HTMLElement | null;
		if (target?.closest?.(".modal-container, .menu, input, textarea, [contenteditable]")) {
			return; // 弹窗/菜单/输入态让位（TextPromptModal 开着自然让位，选中保持）
		}
		// Esc：既有链顺序不变（㊳/㊺），链末追加清空键盘选中
		if (key === "Escape") {
			// ㊺ 编辑器开着 → Esc 关面板（取消）；焦点在面板输入内时已被面板级 keydown 截获
			if (this.nodeEditor) {
				evt.preventDefault();
				this.closeNodeEditor(false);
				return;
			}
			// ㊳ 进行中的节点拖拽 → 还原子树快照
			const drag = this.drag;
			if (drag?.kind === "node" && drag.moved) {
				evt.preventDefault();
				this.cancelDrag();
				return;
			}
			if (this.selectedNodeId) {
				this.setSelected(null);
			}
			return;
		}
		// 其余六键：节点编辑器开着让位（面板输入框已有上面的 input 让位，此处兜 DOM 焦点在面板按钮的场景）
		if (this.nodeEditor) {
			return;
		}
		const sel = this.selectedNodeId;
		if (!this.mapId || !sel) {
			// 六键无锚点时一次性提示（此前静默 no-op，用户不知道为何 Tab 不生效）
			if (!this.keyHintShown) {
				this.keyHintShown = true;
				new Notice(
					"请先点选一个节点：Tab=建子卡 · Enter=建兄弟卡 · Delete=移出 · 方向键=导航",
				);
			}
			return;
		}
		const node = this.nodes.find((n) => n.id === sel);
		if (!node) {
			this.setSelected(null);
			return;
		}
		if (key.startsWith("Arrow")) {
			const dir: NavigateDir =
				key === "ArrowUp"
					? "parent"
					: key === "ArrowDown"
						? "firstChild"
						: key === "ArrowLeft"
							? "prevSibling"
							: "nextSibling";
			const next = navigateTree(this.nodes, sel, dir);
			if (next) {
				evt.preventDefault(); // 阻断画布滚动
				this.setSelected(next);
				this.ensureNodeVisible(next);
			}
			return;
		}
		if (key === "Tab") {
			evt.preventDefault(); // 阻断焦点移动
			this.createChildCard(node.id);
			return;
		}
		if (key === "Enter") {
			evt.preventDefault();
			this.createSiblingCard(node.id);
			return;
		}
		// Delete：移出脑图（= 右键「移出脑图」语义——卡片保留可重加，不加确认）
		evt.preventDefault();
		this.removeSelectedNode(node);
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
			this.viewportEl!.setPointerCapture?.(evt.pointerId);
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
		// 58 先判落点（结构化目标 / 空白）再定位——命中提示只看指针下元素，不依赖被拖
		// 节点位置；此前误用按下时坐标（drag.startClient）做 elementFromPoint，命中检测
		// 停留在起拖点，结构化放置实时提示失效（3f3f247 引入的回归，此处一并修复）
		this.updateInsertHint(drag, evt.clientX, evt.clientY);
		const node = this.nodes.find((n) => n.id === drag.nodeId);
		if (!node) {
			return;
		}
		const rawX = w.x - drag.grabOffset.x;
		const rawY = w.y - drag.grabOffset.y;
		// 58 吸附：仅空白自由拖动时生效（悬停结构化目标时给精准分区提示，磁吸不干扰）；
		// 吸附后坐标直接进内存 + DOM，pointerup 的 applySubtreePositions 原样落库 = 固化
		if (drag.dropTargetId == null) {
			const snapped = snapDragPosition(rawX, rawY, this.snapCandidates(drag.nodeId));
			node.x = snapped.x;
			node.y = snapped.y;
			this.showSnapGuides(snapped.guides);
		} else {
			node.x = rawX;
			node.y = rawY;
			this.showSnapGuides([]);
		}
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
		this.drawEdges();
	}

	private onPointerUp(_evt: PointerEvent): void {
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
				// 52 单击即选中（键盘操作锚点；跳原文逻辑不变）
				this.setSelected(node?.id ?? null);
				// 单脑图模式下无阅读标签不动作（避免点击意外改变布局）；
				// 手工卡（无文档归属）也没有可跳的原文——此时单击 = 仅选中
				if (
					node &&
					node.card.documentId &&
					this.app.workspace.getLeavesOfType(READER_VIEW_TYPE).length > 0
				) {
					void this.revealAndRestoreFocus(node.card);
				}
			} else {
				// 点击画布空白：关闭面板（取消语义）+ 清空键盘选中（52）
				if (this.nodeEditor) {
					this.closeNodeEditor(false);
				}
				this.setSelected(null);
			}
			return; // 平移结束 / 未升级的点击：无写库
		}
		drag.el.style.pointerEvents = "";
		drag.el.classList.remove("marinmind-mm-dragging");

		const node = this.nodes.find((n) => n.id === drag.nodeId);
		if (!node) {
			return;
		}
		const targetId = drag.dropTargetId;
		const zone = drag.dropZone;
		// 59 撤销捕获起点：此刻 repo 仍是操作前状态（pointermove 只改了视图内存），
		// 三分支共用一次 begin，各自落库后 commit
		this.beginUndoCapture();

		// 未命中目标（空白）= 自由定位：位置落库，整棵子树一并写，不整理
		if (targetId == null) {
			this.applySubtreePositions();
			this.drawEdges();
			this.commitUndo("移动节点");
			return;
		}

		// 命中自己或自己的后代 = 成环：拒绝父子关系，但位置照常落库
		// （与 MarginNote 一致：拒绝的是关系，不是位置）
		if (isDescendantOrSelf(this.nodes, node.id, targetId)) {
			new Notice("不能移动到自己的子节点上");
			this.applySubtreePositions();
			this.drawEdges();
			this.commitUndo("移动节点");
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
			// 59 tidy 连带坐标全量入 diff（commit 在 tidy 后）——撤销 = 整体还原，
			// 不做「只还原用户意图」的半还原态
			this.commitUndo("挂接节点");
			return;
		}
		// before/after：新父 = target 的父（根目标 = null）
		const prevParentId = node.parentId;
		const target = this.nodes.find((n) => n.id === targetId);
		const newParentId = target?.parentId ?? null;
		const siblings = this.nodes.filter((n) => n.parentId === newParentId && n.id !== node.id);
		// zone 在此分支由 before/after 控制流收窄；null 已由上面 inside 分支 return
		const order = insertOrder(siblings, targetId, zone as "before" | "after");
		const updated = this.plugin.mindmaps.setParent(node.id, newParentId, order);
		if (updated) {
			node.parentId = updated.parentId;
			node.order = updated.order;
		}
		this.applySubtreePositions();
		this.tidyAffected(prevParentId, newParentId);
		this.commitUndo("调整节点顺序");
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
			this.setSelected(node.id); // 52 右键节点 = 键盘选中（菜单照常弹出）
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
		const snap = new Map<
			string,
			{ el: HTMLElement; startLeft: number; startTop: number; worldX: number; worldY: number }
		>();
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
	 * 58 起指针坐标由调用方传入（pointermove 的当前 evt 坐标）——不能用 drag.startClient
	 * （按下时坐标），否则命中检测停留在起拖点。
	 */
	private updateInsertHint(
		drag: Extract<DragState, { kind: "node" }>,
		clientX: number,
		clientY: number,
	): void {
		const vp = this.viewportEl;
		if (!vp) {
			return;
		}
		this.clearInsertHint();
		const hit = document
			.elementFromPoint(clientX, clientY)
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
		const pointerWorld = this.toWorld(clientX, clientY);
		const targetStyle =
			target.branchStyle != null && isBranchStyle(target.branchStyle)
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
			line.style.top =
				side === "before"
					? `${target.y - INSERT_LINE_W / 2}px`
					: `${target.y + tH - INSERT_LINE_W / 2}px`;
		} else {
			// 横向行（tree-down）：插入线竖穿目标左右缘，纵穿目标垂直中心
			line.style.width = `${INSERT_LINE_W}px`;
			line.style.height = `${tH}px`;
			line.style.left =
				side === "before"
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
		this.clearSnapGuides();
	}

	/** 58 吸附候选：其余**可见**节点左上角世界坐标（排除被拖子树自身——吸到自己后代无意义） */
	private snapCandidates(excludeRootId: string): Array<{ x: number; y: number }> {
		const excluded = new Set(subtreeIds(this.nodes, excludeRootId));
		const visible = visibleNodes(this.nodes);
		const out: Array<{ x: number; y: number }> = [];
		for (const n of this.nodes) {
			if (excluded.has(n.id) || !visible.has(n.id)) {
				continue;
			}
			out.push({ x: n.x, y: n.y });
		}
		return out;
	}

	/** 58 画对齐吸附参考线（最多一竖一横，跨当前可见包围盒通长）；guides 空 = 清线 */
	private showSnapGuides(guides: SnapGuide[]): void {
		const world = this.worldEl;
		if (!world) {
			return;
		}
		this.clearSnapGuides();
		if (guides.length === 0) {
			return;
		}
		// 通长跨当前可见节点包围盒，上下/左右各放出一段方便肉眼追踪
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
		if (!Number.isFinite(minX)) {
			return;
		}
		const EXT = 40;
		for (const g of guides) {
			const el = document.createElement("div");
			el.className = "marinmind-mm-guide";
			if (g.axis === "v") {
				el.style.left = `${g.at}px`;
				el.style.top = `${minY - EXT}px`;
				el.style.width = "1px";
				el.style.height = `${maxY - minY + EXT * 2}px`;
			} else {
				el.style.left = `${minX - EXT}px`;
				el.style.top = `${g.at}px`;
				el.style.width = `${maxX - minX + EXT * 2}px`;
				el.style.height = "1px";
			}
			world.appendChild(el);
			this.snapGuideEls.push(el);
		}
	}

	/** 58 清除吸附参考线（元素已随 rebuildWorld 销毁时 remove 幂等，数组重置） */
	private clearSnapGuides(): void {
		for (const el of this.snapGuideEls) {
			el.remove();
		}
		this.snapGuideEls = [];
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
	 * 双击：portal 节点 = 进入子脑图（61）；空白 = 就地新建文字卡片（手工卡，无文档归属）。
	 * ㊺-A：普通节点双击无绑定（单击已直接跳原文，双击会重复触发）；编辑器面板内
	 * 双击（输入框选词）同样让位。
	 */
	private onDblClick(evt: MouseEvent): void {
		const target = evt.target as HTMLElement;
		// 编辑器面板内双击（如输入框选词）不触发任何画布语义
		if (target.closest(".marinmind-mm-editor")) {
			return;
		}
		// 子脑图 portal（61）：双击进入子图；悬空引用由 openChildMap 内 get 守卫自愈
		const hitEl = target.closest<HTMLElement>(".marinmind-mm-node");
		if (hitEl) {
			const hit = this.nodes.find((n) => n.id === hitEl.dataset.nodeId);
			if (hit?.childMapId) {
				this.openChildMap(hit);
			}
			return; // 普通节点双击无绑定（㊺-A）
		}
		if (!this.mapId) {
			return; // 无图时不新建
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
		// R4 D4-01: 脑图节点右键菜单分组（定位/编辑/链接/复习/脑图/危险）
		menu.addSeparator();
		// 定位组
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
		// 编辑组
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
		// 链接组
		// 卡片互链（53）：建链入口 + 有邻居时的解链入口（数据层 CardLink 早已就绪）
		menu.addItem((item) =>
			item
				.setTitle("链接到卡片…")
				.setIcon("link-2")
				.onClick(() => this.openLinkPicker(card)),
		);
		// 99 相关卡片（AI 推荐）：同文档候选 LLM 推荐 → 勾选写入双向链接
		// （card-actions 单源，建链后受影响图重画由弹窗承接）；无文档归属卡不给入口
		if (card.documentId != null) {
			menu.addItem((item) =>
				item
					.setTitle("相关卡片（AI）…")
					.setIcon("git-compare")
					.onClick(() => {
						this.closeNodeEditor(false);
						promptCardLinks(this.app, this.plugin, card);
					}),
			);
		}
		const neighborIds = this.plugin.links.neighbors(card.id);
		if (neighborIds.length > 0) {
			menu.addItem((item) =>
				item
					.setTitle("解除卡片链接…")
					.setIcon("corner-up-left")
					.onClick(() => this.unlinkCard(card, neighborIds, evt)),
			);
		}
		// 卡片合并（60）：源卡并入目标（文本并入、节点/链接/复习态转移、源卡删除）
		menu.addItem((item) =>
			item
				.setTitle("合并到卡片…")
				.setIcon("git-merge")
				.onClick(() => this.openMergePicker(card)),
		);
		// 复习组
		// 闪卡开关：每次打开菜单即时查 DB（卡片可能在会话外被改变）。
		// 81 书名分组卡不进复习队列（结构卡不纳入卡片系统），不提供开关
		if (!card.group) {
			const isFlashcard = this.plugin.reviews.get(card.id)?.isFlashcard ?? false;
			menu.addItem((item) =>
				item
					.setTitle(isFlashcard ? "取消闪卡" : "转为闪卡")
					.setIcon(isFlashcard ? "zap" : "graduation-cap")
					.onClick(() => {
						if (isFlashcard) {
							this.plugin.reviews.disable(card.id);
						} else {
							this.plugin.reviews.enable(card.id);
						}
					}),
			);
		}
		// 复习此分支（70）：整子树卡片（含折叠隐藏后代）的 cards 范围复习——
		// 复习视图 dueByIds 直查，未启用/未到期的子树卡自然缺席
		menu.addItem((item) =>
			item
				.setTitle("复习此分支")
				.setIcon("graduation-cap")
				.onClick(() => {
					const byId = new Map(this.nodes.map((n) => [n.id, n]));
					const cardIds = subtreeIds(this.nodes, node.id)
						.map((id) => byId.get(id)?.cardId)
						.filter((id): id is string => !!id);
					if (cardIds.length === 0) {
						new Notice("该分支没有卡片");
						return;
					}
					void this.plugin.openReviewCards(cardIds, info.slice(0, 12));
				}),
		);
		// 脑图组
		// 分支样式（⑱）：作用于该节点的子树（其子节点如何挂出）
		menu.addItem((item) =>
			item
				.setTitle("分支样式…")
				.setIcon("git-branch")
				.onClick(() => this.showBranchStyleMenu(node, evt)),
		);
		// 100 AI 整理子级：该节点直接子级的语义归组（组卡挂本节点下）
		if (this.nodes.filter((n) => n.parentId === node.id).length >= 4) {
			menu.addItem((item) =>
				item
					.setTitle("AI 整理子级…")
					.setIcon("wand")
					.onClick(() => {
						this.closeNodeEditor(false);
						this.openAiOrganize(node.id);
					}),
			);
		}
		// 子脑图（61）：portal 的打开/解除入口；非 portal 且有子的坍缩入口
		if (node.childMapId) {
			menu.addItem((item) =>
				item
					.setTitle("打开子脑图")
					.setIcon("external-link")
					.onClick(() => this.openChildMap(node)),
			);
			menu.addItem((item) =>
				item
					.setTitle("解除子脑图")
					.setIcon("unfold-vertical")
					.onClick(() => this.uncollapseChildMap(node)),
			);
		} else if (this.nodes.some((n) => n.parentId === node.id)) {
			menu.addItem((item) =>
				item
					.setTitle("坍缩为子脑图")
					.setIcon("fold-vertical")
					.onClick(() => this.collapseToChildMap(node)),
			);
		}
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
		// 危险操作（删除）
		menu.addItem((item) =>
			item
				.setTitle("移出脑图")
				.setIcon("unlink")
				.onClick(() => {
					this.plugin.mindmaps.removeNode(node.id);
					this.removeNodeLocal(node.id);
					// portal 被移出（61）：其子图保留为独立图不随之删除（无损）
					if (node.childMapId) {
						const kept = this.plugin.mindmaps.get(node.childMapId);
						if (kept) {
							new Notice(`节点已移出；其子脑图《${kept.name}》已保留为独立脑图`);
						}
					}
				}),
		);
		menu.addSeparator();
		menu.addItem((item) =>
			item
				.setTitle("删除卡片")
				.setIcon("trash-2")
				.onClick(() => {
					// 节点移除由 cardBus 删除事件回环完成（DB 级联删行 + applyCardRemoval）；
					// 51 附件级联清理由 deleteCardCascade 承担（发起方职责，修复删卡不删附件孤儿 bug）
					deleteCardCascade(this.plugin, card);
				}),
		);
		menu.showAtMouseEvent(evt);
	}

	/** 53 建链入口：选择对端卡片（自身/已链不出现）；成功后重画虚线边 */
	private openLinkPicker(card: Card): void {
		new LinkPickerModal(this.app, this.plugin, card.id, (target) => {
			try {
				const created = this.plugin.links.link(card.id, target.id);
				if (!created) {
					new Notice("这两张卡片已经链接");
					return;
				}
				// 无链接事件总线：本图手动重画（与节点结构变化手动刷新的既有取舍一致）
				this.drawEdges();
				new Notice("已建立卡片链接");
			} catch (err) {
				// 弹窗期间对端被删（竞态）：link 校验两端存在时 throw
				console.error("[MarinMind] 建立卡片链接失败", err);
				new Notice("建立卡片链接失败：对端卡片可能已被删除");
			}
		}).open();
	}

	/**
	 * 53 解链入口：唯一邻居直接解；多个弹二级菜单列出邻居标题逐个解除。
	 * 解除是全局语义——邻居不必在本图（虚线边只画两端同图的链接）。
	 */
	private unlinkCard(card: Card, neighborIds: string[], evt: MouseEvent): void {
		const doUnlink = (otherId: string): void => {
			this.plugin.links.unlink(card.id, otherId);
			this.drawEdges();
			new Notice("已解除卡片链接");
		};
		if (neighborIds.length === 1) {
			doUnlink(neighborIds[0]);
			return;
		}
		const menu = new Menu();
		for (const otherId of neighborIds) {
			const other = this.plugin.cards.get(otherId);
			const info = other
				? (other.title ?? other.note ?? other.excerptText ?? "（区域摘录）")
				: "（卡片已删除）";
			menu.addItem((item) =>
				item
					.setTitle(info.length > 30 ? `${info.slice(0, 30)}…` : info)
					.onClick(() => doUnlink(otherId)),
			);
		}
		menu.showAtMouseEvent(evt);
	}

	/**
	 * 60 合并入口：选目标卡 → 确认（写明源卡删除、文本并入、锚点与媒体保留目标）
	 * → mergeCardsInto → 受影响脑图重拉 + 发起方清源附件（镜像 deleteCardCascade 职责）。
	 */
	private openMergePicker(card: Card): void {
		new MergePickerModal(this.app, this.plugin, card.id, (target) => {
			new ConfirmModal(
				this.app,
				"合并卡片",
				`将源卡片并入「${(target.title ?? target.excerptText ?? target.excerptType).slice(0, 30)}」：\n\n源卡片将被删除；批注/文字等文本内容并入目标（目标已有内容不覆盖）；脑图节点、卡片链接与复习进度转移到目标；原文锚点与媒体附件以目标为准。`,
				() => {
					if (!this.plugin.store) {
						return;
					}
					const result = mergeCardsInto(
						{
							cards: this.plugin.cards,
							mindmaps: this.plugin.mindmaps,
							links: this.plugin.links,
							reviews: this.plugin.reviews,
							store: this.plugin.store,
						},
						card.id,
						target.id,
					);
					if (!result.ok) {
						new Notice(`合并失败：${result.reason}`);
						return;
					}
					// 发起方清源附件（≠目标 ref 才删；uid 一卡一附件）
					if (card.excerptRef && card.excerptRef !== target.excerptRef) {
						void this.plugin.attachments.remove(card.excerptRef).catch(() => undefined);
					}
					for (const mapId of result.affectedMapIds) {
						refreshActiveMindmaps(mapId);
					}
					new Notice("已合并卡片");
				},
			).open();
		}).open();
	}

	// ---------- 子脑图坍缩（61：portal 身份 + 三操作） ----------

	/**
	 * 坍缩为子脑图：X 的直接子（各带整棵子树）迁入新建图，X 变 portal（双击进入）。
	 * 新图 documentId=null——永不是书籍默认图，摘录自动入图路径不命中。
	 * 事务性：目标为全新空图，一图一卡整批预检不可能失败，全顺序安排无半态。
	 */
	private collapseToChildMap(node: MindmapNodeWithCard): void {
		const children = this.nodes.filter((n) => n.parentId === node.id).sort(compareSiblings);
		if (children.length === 0) {
			new Notice("该节点没有子节点，无需坍缩为子脑图");
			return;
		}
		const raw = node.card.title ?? node.card.note ?? node.card.excerptText ?? "子脑图";
		const name = raw.length > 20 ? `${raw.slice(0, 20)}…` : raw;
		const child = this.plugin.mindmaps.create(name, null);
		for (const c of children) {
			// 直接子逐个迁移：targetParentId 缺省 null → B 内根序 = 原兄弟序（order 保留）
			this.plugin.mindmaps.moveSubtreeToMap(c.id, child.id);
		}
		this.plugin.mindmaps.setChildMap(node.id, child.id);
		this.loadMap(node.mapId);
		new Notice(`已坍缩为子脑图《${name}》（双击节点进入）`);
	}

	/** 打开子脑图（portal 双击 / 右键入口）：悬空引用读取侧自愈为普通节点 */
	private openChildMap(node: MindmapNodeWithCard): void {
		if (!node.childMapId) {
			return;
		}
		const child = this.plugin.mindmaps.get(node.childMapId);
		if (!child) {
			// 悬空自愈：子图已被删除（正常路径 delete 已清扫，此处防御手编/外部改文件）
			this.plugin.mindmaps.setChildMap(node.id, null);
			this.loadMap(node.mapId);
			new Notice("子脑图已不存在，已还原为普通节点");
			return;
		}
		void this.plugin.openMindmap(child.id);
	}

	/**
	 * 解除子脑图：子图全部根（各带整棵子树）迁回 portal 之下（追加末位——
	 * 排在坍缩期间新挂的子之后），portal 还原普通节点，子图删除（已空）。
	 * 整批碰撞预检：子图任一卡已在本图（一图一卡）→ 整体拒绝，子图保留。
	 */
	private uncollapseChildMap(node: MindmapNodeWithCard): void {
		if (!node.childMapId) {
			return;
		}
		const child = this.plugin.mindmaps.get(node.childMapId);
		if (!child) {
			this.plugin.mindmaps.setChildMap(node.id, null);
			this.loadMap(node.mapId);
			new Notice("子脑图已不存在，已还原为普通节点");
			return;
		}
		const childNodes = this.plugin.mindmaps.listNodes(child.id);
		if (childNodes.some((n) => this.plugin.mindmaps.hasCard(node.mapId, n.cardId))) {
			new Notice("子脑图内有卡片已在本图出现（一图一卡），无法解除——请先移出冲突卡片");
			return;
		}
		// 子图根集合：parentId 为 null 或父缺失的孤儿（镜像 restackRoots 上浮规则）
		const ids = new Set(childNodes.map((n) => n.id));
		const roots = childNodes
			.filter((n) => n.parentId === null || !ids.has(n.parentId))
			.sort(compareSiblings);
		const doUncollapse = (): void => {
			for (const r of roots) {
				this.plugin.mindmaps.moveSubtreeToMap(r.id, node.mapId, node.id);
			}
			this.plugin.mindmaps.setChildMap(node.id, null);
			if (node.collapsed) {
				// portal 期间无子不显折叠钮；解除后还原展开，防旧折叠态隐藏刚迁回的子
				this.plugin.mindmaps.setCollapsed(node.id, false);
			}
			this.plugin.mindmaps.delete(child.id); // 节点已全部迁出，删除仅清图壳
			this.loadMap(node.mapId);
			new Notice(`已解除子脑图《${child.name}》，节点已并回本图`);
		};
		if (childNodes.length > 50) {
			new ConfirmModal(
				this.app,
				"解除子脑图",
				`子脑图《${child.name}》内有 ${childNodes.length} 个节点，解除后将全部并回本图（挂在原节点之下）。继续？`,
				doUncollapse,
			).open();
		} else {
			doUncollapse();
		}
	}

	/**
	 * 导出 Markdown 大纲（54）：脑图树 → vault 根 `${图名} 大纲.md`。
	 * 正常路径每行 = 卡片 wikilink（点击跳书文件锚点）；fs 数据根 / 隐藏目录
	 * 降级纯标题（镜像 copyCardLink 三态——指向不可解析的链接不如不给）。
	 * 刻意不写数据根（store 会认领数据根内 MarinMind 格式 md）；重名 -2/-3 递增。
	 */
	private async exportOutline(): Promise<void> {
		const store = this.plugin.store;
		const mapId = this.mapId;
		if (!store || !mapId) {
			new Notice("请先打开或创建一张脑图");
			return;
		}
		const map = this.plugin.mindmaps.get(mapId);
		if (!map) {
			return;
		}
		if (this.nodes.length === 0) {
			new Notice("画布为空，无可导出内容");
			return;
		}
		// 链接可用性判定 + 锚点保底（缺 ^card-<id> 行的书文件先补写，已最新零写）
		const loc = this.plugin.dataLoc;
		const linkable = loc.kind === "vault" && !isHiddenVaultDir(loc.rootDir);
		if (linkable) {
			const docIds = new Set<string>();
			for (const n of this.nodes) {
				if (n.card.documentId) {
					docIds.add(n.card.documentId);
				}
			}
			await Promise.all(Array.from(docIds, (id) => store.ensureBookWritten(id)));
		}
		const linkOf = (card: Card): string | null => {
			if (!linkable) {
				return null;
			}
			const book = store.bookOfCard(card.id);
			if (!book) {
				return null; // 无书归属（手工卡/orphan）：纯标题
			}
			return buildCardCopyText("link", loc.rootDir, book.relPath, card);
		};
		const md = buildOutlineMarkdown(this.nodes, linkOf);
		// 写 vault 根（copy-into-vault 冲突 -2/-3 先例）
		const vault = this.app.vault;
		let target = `${map.name} 大纲.md`;
		for (let i = 2; vault.getAbstractFileByPath(target) != null; i++) {
			target = `${map.name} 大纲-${i}.md`;
		}
		try {
			await vault.create(target, md);
		} catch (err) {
			console.error("[MarinMind] 大纲导出失败", err);
			new Notice("大纲导出失败：无法写入笔记文件", 6000);
			return;
		}
		if (linkable) {
			new Notice(`已导出大纲：${target}`);
		} else {
			new Notice(
				`已导出大纲（纯标题版）：${target}——数据目录在库外或隐藏目录，卡片链接不可用`,
				6000,
			);
		}
	}

	/**
	 * 导出菜单（63）：download 单按钮改弹三选——Markdown 大纲（54）/
	 * OPML 大纲（63，可导入 XMind/Workflowy 等大纲工具）/ PNG 图片（63，
	 * 所见即所得整图快照）。图标经 asar 注册表验证（file-text/code/image）。
	 */
	private openExportMenu(evt: MouseEvent): void {
		const menu = new Menu();
		menu.addItem((item) =>
			item
				.setTitle("导出 Markdown 大纲")
				.setIcon("file-text")
				.onClick(() => void this.exportOutline()),
		);
		menu.addItem((item) =>
			item
				.setTitle("导出 OPML 大纲")
				.setIcon("code")
				.onClick(() => void this.exportOpml()),
		);
		menu.addItem((item) =>
			item
				.setTitle("导出 PNG 图片")
				.setIcon("image")
				.onClick(() => void this.exportPng()),
		);
		menu.showAtMouseEvent(evt);
	}

	/**
	 * 导出 OPML 2.0 大纲（63）：脑图树 → vault 根 `${图名}.opml`（-2/-3 递增）。
	 * 纯文本大纲交换格式不承载 wikilink（外部工具不认识），节点文本与 Markdown
	 * 大纲降级态同源（outlineLineText）；与 exportOutline 共用空图/数据层守卫。
	 */
	private async exportOpml(): Promise<void> {
		const store = this.plugin.store;
		const mapId = this.mapId;
		if (!store || !mapId) {
			new Notice("请先打开或创建一张脑图");
			return;
		}
		const map = this.plugin.mindmaps.get(mapId);
		if (!map) {
			return;
		}
		if (this.nodes.length === 0) {
			new Notice("画布为空，无可导出内容");
			return;
		}
		const opml = buildOutlineOpml(this.nodes, map.name);
		const vault = this.app.vault;
		const target = allocateExportPath(
			map.name,
			"opml",
			(p) => vault.getAbstractFileByPath(p) != null,
		);
		try {
			await vault.create(target, opml);
		} catch (err) {
			console.error("[MarinMind] OPML 导出失败", err);
			new Notice("OPML 导出失败：无法写入笔记文件", 6000);
			return;
		}
		new Notice(`已导出 OPML 大纲：${target}`);
	}

	/**
	 * 导出 PNG 图片（63）：整图所见即所得快照（取景 = 连线 svg 的 viewBox）。
	 * 编排细节在 map-image-export（媒体等待/瞬态类摘除/主题底色/倍率钳制）；
	 * 此处只做画布元素与图名守卫。
	 */
	private async exportPng(): Promise<void> {
		const store = this.plugin.store;
		const mapId = this.mapId;
		if (!store || !mapId) {
			new Notice("请先打开或创建一张脑图");
			return;
		}
		const map = this.plugin.mindmaps.get(mapId);
		if (!map) {
			return;
		}
		if (!this.worldEl || !this.edgesSvg) {
			return;
		}
		await exportMindmapPng(this.plugin, this.worldEl, this.edgesSvg, map.name);
	}

	/**
	 * 从文档目录建框架（55 PDF；62 起三态泛化 epub/md）入口：选择库内/库外文档
	 * （picker 收 pdf+md+epub——库外按钮只收 pdf+epub，md 天然仅库内）。
	 */
	private pickOutlineSource(): void {
		if (!this.mapId) {
			new Notice("请先打开或创建一张脑图");
			return;
		}
		new PdfPickerModal(
			this.app,
			(pick) => void this.buildOutlineFramework(pickTarget(pick)),
			[],
			{ extensions: ["pdf", "md", "epub"], plugin: this.plugin },
		).open();
	}

	/**
	 * 按所选文档的目录在当前图建章节骨架框架（55 PDF；62 三态）：
	 * 解析目录（pdf=内嵌大纲共享解析 / epub=nav-ncx 结构 / md=隐藏渲染量测标题 y）
	 * → 建档 → 防重 → 确认规模 → createOutlineCards 建树。
	 * 新摘录归章由 autoAddCard 的 chapterParentFor 承接（摘录目标图为本图时生效）。
	 */
	private async buildOutlineFramework(target: TFile | string): Promise<void> {
		if (!this.plugin.store || !this.mapId) {
			return;
		}
		const mapId = this.mapId;
		const filePath = typeof target === "string" ? target : target.path;
		const title = typeof target === "string" ? fsBasename(target) : target.basename;
		const ext = docExtOf(filePath);

		// 1) 解析目录（62 按扩展三态分流）；建档在解析后——epub 的 dc:title
		//    优先（对齐阅读器语义），解析失败时尚未建档零残留
		let entries: Array<OutlineEntry & { anchorY?: number | null }>;
		let bookTitle = title;
		if (ext === "epub") {
			// 读字节：库内 TFile 直读 / 库外绝对路径桌面直读（移动端弹中文错误）
			let bytes: ArrayBuffer;
			try {
				bytes =
					typeof target === "string"
						? await readExternalBinary(target)
						: await this.app.vault.readBinary(target);
			} catch (err) {
				new Notice(err instanceof Error ? err.message : "读取 EPUB 失败", 6000);
				return;
			}
			try {
				const book = parseEpub(new Uint8Array(bytes));
				bookTitle = book.title || title; // dc:title 优先 basename 兜底
				entries = epubOutline(book); // page = spine 序号 + 1，与摘录卡同基
			} catch (err) {
				console.error("[MarinMind] EPUB 目录解析失败", err);
				new Notice(
					err instanceof Error ? err.message : "EPUB 解析失败，无法读取目录",
					6000,
				);
				return;
			}
		} else if (ext === "md") {
			// md 必须库内 TFile（库外 md 阅读器本就不支持，建框架同拒）
			if (typeof target === "string") {
				new Notice("库外 Markdown 不支持建目录框架，请先复制入库", 6000);
				return;
			}
			let text: string;
			try {
				text = await this.app.vault.cachedRead(target);
			} catch (err) {
				new Notice(err instanceof Error ? err.message : "读取 Markdown 失败", 6000);
				return;
			}
			new Notice("正在渲染文档以定位标题位置（大文件可能数秒）…", 4000);
			entries = await measureMdOutline(this.app, this, text);
		} else {
			let bytes: ArrayBuffer;
			try {
				bytes =
					typeof target === "string"
						? await readExternalBinary(target)
						: await this.app.vault.readBinary(target);
			} catch (err) {
				new Notice(err instanceof Error ? err.message : "读取 PDF 失败", 6000);
				return;
			}
			// pdf 内嵌大纲（共享解析缓存：双开的 PDF 免重复解析；finally 必还引用）
			try {
				const handle = await acquirePdf(pdfCacheKey(filePath), bytes);
				try {
					entries = await handle.doc.outline();
				} finally {
					handle.release();
				}
			} catch (err) {
				console.error("[MarinMind] PDF 目录解析失败", err);
				new Notice("PDF 解析失败，无法读取目录", 6000);
				return;
			}
		}
		if (entries.length === 0) {
			new Notice(
				`《${bookTitle}》没有可用的目录（${ext === "md" ? "无标题" : "书签大纲"}），无法建框架`,
				6000,
			);
			return;
		}

		// 2) 建档：与阅读器打开同语义（已存在则只刷新 updatedAt 与标题）
		const doc = this.plugin.documents.upsertByPath(filePath, bookTitle);

		// 3) 防重：当前图已有该书框架即拒（同书可在另一图各建一份）
		if (this.nodes.some((n) => n.card.outline && n.card.documentId === doc.id)) {
			new Notice(`当前脑图已有《${bookTitle}》的目录框架`);
			return;
		}

		// 4) 建卡计划：损坏条目（page null）由纯函数跳过并就近重挂子级
		const plan = planOutlineChapters(entries);
		if (plan.length === 0) {
			new Notice(`《${bookTitle}》的目录条目均无法解析页码，无法建框架`, 6000);
			return;
		}
		new ConfirmModal(
			this.app,
			"从文档目录建框架",
			`将按《${bookTitle}》的目录创建 ${plan.length} 张章节骨架卡，挂到当前脑图的《${bookTitle}》分组下。${
				plan.length > 300 ? "\n\n条目较多，创建与首次落盘可能需要数秒。" : ""
			}`,
			() => this.createOutlineCards(mapId, doc.id, doc.title, plan),
		).open();
	}

	/**
	 * 建章节骨架卡与树（55）：顶层挂《书名》组卡下，子级挂 parentIndex 指向的
	 * 已建章节（plan 深度优先序保证父先建）。落位随父生效分支样式顺延，兄弟
	 * 坐标本地缓存增量追加（不逐卡 listNodes——千章书 O(N²) 重拉不可接受）。
	 * try/catch 包整段：残余异常呈现已建部分树，用户可整支移出清理。
	 */
	private createOutlineCards(
		mapId: string,
		documentId: string,
		bookTitle: string,
		plan: ChapterPlanItem[],
	): void {
		const map = this.plugin.mindmaps.get(mapId);
		if (!map) {
			return;
		}
		const host = {
			documents: this.plugin.documents,
			cards: this.plugin.cards,
			mindmaps: this.plugin.mindmaps,
		};
		let created = 0;
		try {
			const groupNodeId = ensureGroupCard(host, map, { id: documentId, title: bookTitle });
			if (!groupNodeId) {
				new Notice("无法确保分组节点，已中止", 6000);
				return;
			}
			const nodes0 = this.plugin.mindmaps.listNodes(mapId);
			const groupNode = nodes0.find((n) => n.id === groupNodeId);
			if (!groupNode) {
				new Notice("分组节点缺失，已中止", 6000);
				return;
			}
			// 兄弟坐标缓存：种子 = 既有节点（组卡可能已挂直挂摘录），建卡增量追加
			const sibPts = new Map<string, { x: number; y: number }[]>();
			for (const n of nodes0) {
				if (n.parentId == null) {
					continue;
				}
				const arr = sibPts.get(n.parentId);
				if (arr) {
					arr.push({ x: n.x, y: n.y });
				} else {
					sibPts.set(n.parentId, [{ x: n.x, y: n.y }]);
				}
			}
			const groupStyle = effectiveBranchStyle(nodes0, groupNodeId, map.defaultBranchStyle);
			// 已建章节：新节点无样式覆盖，生效样式 = 父的生效样式（传递继承）
			const made: Array<{ id: string; x: number; y: number; style: BranchStyle }> = [];
			for (const item of plan) {
				const parent = item.parentIndex == null ? null : made[item.parentIndex];
				if (item.parentIndex != null && !parent) {
					continue; // 防御：父项建卡失败时子级跳过（正常流程不会发生）
				}
				const parentId = parent ? parent.id : groupNodeId;
				const parentPos = parent
					? { x: parent.x, y: parent.y }
					: { x: groupNode.x, y: groupNode.y };
				let sibs = sibPts.get(parentId);
				if (!sibs) {
					sibs = [];
					sibPts.set(parentId, sibs);
				}
				const pos = suggestChildPosition(
					parentPos,
					sibs,
					parent ? parent.style : groupStyle,
				);
				const card = this.plugin.cards.create({
					documentId,
					page: item.page,
					// 62 md 框架：合成归一化锚 rect——跳原文 locateCard/jumpAnchorY 精确定位
					// 与归章同页 y 比较全链路复用（h 极小不显形；pdf/epub anchorY null 仍空）
					rects: item.anchorY != null ? [{ x: 0, y: item.anchorY, w: 1, h: 0.001 }] : [],
					excerptType: "text",
					excerptText: item.title,
					title: item.title,
					outline: true,
				});
				const node = this.plugin.mindmaps.addNode(
					mapId,
					card.id,
					parentId,
					Math.round(pos.x),
					Math.round(pos.y),
				);
				if (!node) {
					continue;
				}
				made.push({
					id: node.id,
					x: node.x,
					y: node.y,
					style: parent ? parent.style : groupStyle,
				});
				sibs.push({ x: node.x, y: node.y });
				created++;
			}
			this.loadMap(mapId);
			new Notice(`已创建 ${created} 张章节骨架卡，本书新摘录将按页码归入对应章节`);
		} catch (err) {
			console.error("[MarinMind] 目录框架创建中断", err);
			this.loadMap(mapId);
			new Notice(`框架创建中断：已建 ${created} 张章节卡（可整支移出清理）`, 6000);
			return;
		}
		// 归章衔接提示：该书摘录目标图不是本图时（覆盖他图 / 同名默认图未指向本图），
		// 新摘录落别处不进本框架——提示引导在阅读器「脑图」按钮切换目标
		const target = collectTargetOf(host, documentId);
		if (target?.map.id !== mapId) {
			new Notice(
				`注意：《${bookTitle}》的摘录目标图${
					target ? `是《${target.map.name}》` : "是同名默认脑图"
				}，新摘录不会归入本框架——可在阅读器工具行「脑图」按钮切换目标到本图`,
				8000,
			);
		}
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
		this.beginUndoCapture(); // 59
		this.plugin.mindmaps.setBranchStyle(nodeId, style);
		this.loadMap(this.mapId);
		this.commitUndo("切换分支样式");
	}

	/** 图级默认分支样式切换：写库后重拉（未覆盖的节点全部跟随新样式） */
	private setDefaultStyle(style: BranchStyle): void {
		if (!this.mapId) {
			return;
		}
		this.beginUndoCapture(); // 59（图默认样式变化经 commitUndo 自动入补丁）
		this.plugin.mindmaps.setDefaultBranchStyle(this.mapId, style);
		this.loadMap(this.mapId);
		this.commitUndo("切换默认样式");
	}

	/**
	 * AI 整理入口（100 P4）：收集候选（根级散卡或指定节点的直接子级）→
	 * AiOrganizeModal 推荐/勾选 → applyAiOrganize 执行。结构卡（group）与
	 * portal 节点不参与整理（它们是骨架不是内容）；<4 个不整理（归组无意义）。
	 */
	private openAiOrganize(anchorParentId: string | null): void {
		if (!this.mapId) {
			new Notice("请先打开或创建一张脑图");
			return;
		}
		const candidates: OrganizeCandidate[] = this.nodes
			.filter((n) => n.parentId === anchorParentId && !n.card.group && n.childMapId == null)
			.map((n) => ({
				nodeId: n.id,
				// 摘要择优：标题 → 批注 → 摘录文字 → 类型兜底（媒体卡无文字也能归组）
				text: n.card.title ?? n.card.note ?? n.card.excerptText ?? n.card.excerptType,
			}))
			.slice(0, ORGANIZE_NODE_CAP);
		if (candidates.length < 4) {
			new Notice(
				anchorParentId
					? "该节点的子级太少（不足 4 个），无需 AI 整理"
					: "根级卡片太少（不足 4 张），无需 AI 整理",
			);
			return;
		}
		new AiOrganizeModal(this.app, this.plugin, {
			candidates,
			anchorParentId,
			onApply: (groups) => this.applyAiOrganize(anchorParentId, groups),
		}).open();
	}

	/**
	 * 执行 AI 整理（100）：beginUndoCapture → 逐组建**全新**组卡（group 结构卡，
	 * documentId=null——auto-collect 拦截不触发自动入图回环）+ setParent 移入 →
	 * layoutTree 自动布局 → commitUndo **单步撤销**（父子/坐标一并回退；组卡
	 * 本身是新建不进栈——撤销后空组留在原位，与建删卡不进栈取舍一致）。
	 */
	private applyAiOrganize(anchorParentId: string | null, groups: OrganizeGroupPlan[]): void {
		const mapId = this.mapId;
		if (!mapId || !this.plugin.mindmaps.get(mapId)) {
			return;
		}
		this.beginUndoCapture();
		let madeGroups = 0;
		let moved = 0;
		try {
			const nodes0 = this.plugin.mindmaps.listNodes(mapId);
			const byId = new Map(nodes0.map((n) => [n.id, n]));
			const parentOf = new Map(nodes0.map((n) => [n.id, n.parentId] as const));
			// 组卡初始落位（锚父/首个成员附近；layoutTree 随后统一重排）
			const anchorNode = anchorParentId != null ? byId.get(anchorParentId) : undefined;
			const firstMember = groups
				.flatMap((g) => g.nodeIds)
				.map((id) => byId.get(id))
				.find(Boolean);
			const base = anchorNode ?? firstMember ?? { x: 0, y: 0 };
			groups.forEach((group, i) => {
				const groupCard = this.plugin.cards.create({
					// 防自动入图回环（auto-collect 拦 documentId null）+ 结构卡不进卡片系统
					documentId: null,
					page: null,
					rects: [],
					excerptType: "text",
					excerptText: group.name,
					title: group.name,
					group: true,
				});
				const gnode = this.plugin.mindmaps.addNode(
					mapId,
					groupCard.id,
					anchorParentId,
					Math.round(base.x + 60 + i * 40),
					Math.round(base.y + i * 260),
				);
				if (!gnode) {
					return;
				}
				madeGroups++;
				for (const nodeId of group.nodeIds) {
					// 防御性环检测（组卡是全新节点无后代，结构上不可能成环）
					if (!wouldCycle(parentOf, nodeId, gnode.id)) {
						if (this.plugin.mindmaps.setParent(nodeId, gnode.id)) {
							moved++;
						}
					}
				}
			});
			// 分组落位自动布局（同一撤销条目内）：实测高注入防媒体节点重叠
			this.loadMap(mapId);
			this.plugin.mindmaps.applyLayout(
				mapId,
				layoutTree(this.measuredNodes(), this.mapDefault),
			);
			this.loadMap(mapId);
			this.fitToContent();
			this.commitUndo("AI 整理");
			new Notice(`AI 整理完成：新建 ${madeGroups} 个分组、归入 ${moved} 张卡片`, 5000);
		} catch (err) {
			console.error("[MarinMind] AI 整理中断", err);
			this.loadMap(mapId);
			this.commitUndo("AI 整理");
			new Notice(
				`AI 整理中断：已建 ${madeGroups} 组、移动 ${moved} 张（可 Ctrl+Z 回退）`,
				6000,
			);
		}
	}

	/** 本地移除节点（库已删）：子上浮为根原位保留，仅重画连线 */
	private removeNodeLocal(nodeId: string): void {
		// 编辑器开着的目标节点被移除：面板悬空，立即关（面板在 viewport 不在 world，
		// rebuildWorld 清不到）
		if (this.nodeEditor?.nodeId === nodeId) {
			this.closeNodeEditor(false);
		}
		// 52 选中节点被移除：锚点清空（removeSelectedNode 随后会显式转移到父）
		if (this.selectedNodeId === nodeId) {
			this.selectedNodeId = null;
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
