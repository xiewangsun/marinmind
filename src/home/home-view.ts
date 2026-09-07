import { ItemView, setIcon } from "obsidian";
import type { ViewStateResult, WorkspaceLeaf } from "obsidian";
import type MarinMindPlugin from "../main";
import { WebclipModal } from "../webclip/webclip-modal";
import type { CardsPageState, CategorySelection } from "./home-data";
import {
	renderCardsPage,
	renderDocumentsPage,
	enableKeyboardActivation,
	renderMapsPage,
	renderOverviewPage,
	clearBatchSelection,
	type HomePage,
} from "./home-pages";

/** 主页视图类型标识（main.ts registerView / openHome 共用） */
export const HOME_VIEW_TYPE = "marinmind-home";

/** 主页导航页合法值（getState/setState 持久化用） */
const HOME_PAGES: readonly HomePage[] = ["overview", "documents", "cards", "maps"];

/** 主页导航页元数据（侧栏渲染） */
const NAV_ITEMS: { page: HomePage; icon: string; label: string; section: 0 | 1 }[] = [
	{ page: "overview", icon: "gauge", label: "概览", section: 0 },
	{ page: "documents", icon: "folder-open", label: "文档", section: 1 },
	{ page: "cards", icon: "layers", label: "卡片", section: 1 },
	{ page: "maps", icon: "git-fork", label: "脑图", section: 1 },
];

/**
 * MarinMind 主页视图（㉟）：Linear 风左侧栏导航 + 四页内容
 * （概览/文档/卡片/脑图）。主题三态机制（㊲ 起，㊸ 加浅色）：布局基调在
 * .marinmind-home，深/浅变量覆盖在 .marinmind-home-dark / -light
 * （settings.homeTheme 控制挂载，auto 时两类皆摘走全局变量）。
 * ribbon 点击与本视图关联（原 PDF 选择器入口移至主页按钮 + 命令面板）。
 */
export class MarinMindHomeView extends ItemView {
	/** setState 先于 onOpen 的暂存导航页（镜像 mindmap pendingMapId / reader pendingFile 先例） */
	private pendingPage: HomePage | null = null;
	private currentPage: HomePage = "overview";
	/** 文档页选中的分类（会话内状态，不持久化；null=未分类, "all"=全部） */
	private selectedCategory: CategorySelection = "all";
	/** 文档页搜索关键词（会话内状态，不持久化；输入时只局部刷新列表，整页重渲染回填） */
	private docQuery = "";
	/** 卡片页筛选与分页（会话内状态，不持久化；筛选条件变化自动回第 1 页） */
	private cardsFilter: CardsPageState = {
		documentId: null,
		excerptType: null,
		deck: null,
		tag: null,
		color: null,
		page: 1,
	};
	private cardBusOffs: Array<() => void> = [];
	/** cardBus 高频事件（AI 批量建卡）合并刷新的防抖句柄 */
	private refreshTimer: ReturnType<typeof setTimeout> | null = null;
	private navCountEls = new Map<HomePage, HTMLElement>();

	constructor(
		leaf: WorkspaceLeaf,
		private readonly plugin: MarinMindPlugin,
	) {
		super(leaf);
	}

	getViewType(): string {
		return HOME_VIEW_TYPE;
	}

	getDisplayText(): string {
		return "MarinMind 主页";
	}

	getIcon(): string {
		return "layout-dashboard";
	}

	getState(): Record<string, unknown> {
		// 只持久化导航页——重启 Obsidian 后恢复退出前所在页
		return { ...super.getState(), page: this.currentPage };
	}

	async setState(
		state: { page?: string } & Record<string, unknown>,
		result: ViewStateResult,
	): Promise<void> {
		const raw = state.page;
		this.pendingPage =
			typeof raw === "string" && (HOME_PAGES as readonly string[]).includes(raw)
				? (raw as HomePage)
				: null; // 非法/缺失值不动当前页（onOpen 默认 overview）
		await super.setState(state, result);
	}

	async onOpen(): Promise<void> {
		// 消费 setState 暂存的导航页（工作区恢复/deferred 场景 setState 先于 onOpen）
		if (this.pendingPage) {
			this.currentPage = this.pendingPage;
			this.pendingPage = null;
		}
		await this.plugin.whenReady();

		this.contentEl.empty();
		this.contentEl.classList.add("marinmind-home");
		this.applyTheme();
		this.renderSkeleton();
		this.renderCurrentPage();
		this.subscribeCardBus();
	}

	/**
	 * 应用主题（㊲ 起，㊸ 三态）：dark 挂 .marinmind-home-dark 强制 Linear 深色（默认）/
	 * light 挂 .marinmind-home-light 强制 Linear 浅色（㊸ 变量镜像组）/
	 * auto 两类皆摘，子树引用 Obsidian 全局变量自动跟随亮/暗主题。
	 * 设置页切换即时调用，无需重开视图。
	 */
	applyTheme(): void {
		const theme = this.plugin.settings.homeTheme;
		this.contentEl.classList.toggle("marinmind-home-dark", theme === "dark");
		this.contentEl.classList.toggle("marinmind-home-light", theme === "light");
	}

	async onClose(): Promise<void> {
		for (const off of this.cardBusOffs) off();
		this.cardBusOffs = [];
		if (this.refreshTimer) clearTimeout(this.refreshTimer);
		this.refreshTimer = null;
		// 74 批选：模块态随视图关闭清空（防下次打开主页时残留勾选模式）
		clearBatchSelection();
	}

	/** 建立侧栏 + 内容区骨架（onOpen 一次；refresh 只重填内容） */
	private renderSkeleton(): void {
		this.contentEl.empty();
		const sidebar = this.contentEl.createDiv({ cls: "marinmind-home-sidebar" });

		sidebar.createDiv({ cls: "marinmind-home-brand", text: "MarinMind" });

		const nav = sidebar.createDiv({ cls: "marinmind-home-nav" });
		let lastSection = -1;
		this.navCountEls.clear();
		for (const item of NAV_ITEMS) {
			if (item.section !== lastSection && item.section === 1) {
				// 「知识库」分节标签（概览与库内容之间）
				nav.createDiv({ cls: "marinmind-home-nav-section", text: "知识库" });
				lastSection = 1;
			} else {
				lastSection = item.section;
			}
			const entry = nav.createDiv({
				cls: `marinmind-home-nav-item${item.page === this.currentPage ? " is-active" : ""}`,
			});
			entry.addEventListener("click", () => this.switchPage(item.page));
			enableKeyboardActivation(entry); // P0-1：侧栏导航键盘可达
			const iconEl = entry.createDiv({ cls: "marinmind-home-nav-icon" });
			setIcon(iconEl, item.icon);
			entry.createDiv({ cls: "marinmind-home-nav-label", text: item.label });
			const count = entry.createDiv({ cls: "marinmind-home-nav-count" });
			this.navCountEls.set(item.page, count);
		}
		this.refreshSidebarCounts();

		// 侧栏底部：原 ribbon 的文档选择器入口（㉟ 起降级至此 + 命令面板；㊻-B 起兼收 md）
		const footer = sidebar.createDiv({ cls: "marinmind-home-sidebar-footer" });
		const openPdf = footer.createDiv({
			cls: "marinmind-home-nav-item marinmind-home-sidebar-open",
		});
		openPdf.addEventListener("click", () => this.plugin.openPdfPicker());
		enableKeyboardActivation(openPdf); // P0-1：底部「打开文档」键盘可达
		const iconEl = openPdf.createDiv({ cls: "marinmind-home-nav-icon" });
		setIcon(iconEl, "file-plus");
		openPdf.createDiv({ cls: "marinmind-home-nav-label", text: "打开文档" });

		// 113 剪藏网页：footer 第二入口（与打开文档同为「获取素材」动作）
		const clip = footer.createDiv({
			cls: "marinmind-home-nav-item marinmind-home-sidebar-open",
		});
		clip.addEventListener("click", () => new WebclipModal(this.plugin.app, this.plugin).open());
		enableKeyboardActivation(clip); // P0-1：底部「剪藏网页」键盘可达
		const clipIcon = clip.createDiv({ cls: "marinmind-home-nav-icon" });
		setIcon(clipIcon, "globe");
		clip.createDiv({ cls: "marinmind-home-nav-label", text: "剪藏网页" });

		this.contentEl.createDiv({ cls: "marinmind-home-content" });
	}

	/** 刷新侧栏导航计数（数据层未就绪时静默置空） */
	private refreshSidebarCounts(): void {
		const p = this.plugin;
		const counts: Record<HomePage, string> = {
			overview: "",
			documents: p.documents ? String(p.documents.count()) : "",
			cards: p.cards ? String(p.cards.count()) : "",
			maps: p.mindmaps ? String(p.mindmaps.list().length) : "",
		};
		for (const [page, el] of this.navCountEls) {
			el.setText(counts[page]);
		}
	}

	/** 切换导航页：高亮 + 内容区重渲染 */
	private switchPage(page: HomePage): void {
		if (page === this.currentPage && this.contentEl.querySelector(".marinmind-home-content")) {
			return; // 重复点击当前页：不重渲染（防抖动）
		}
		// 74 批选：离开卡片页清模式与选择（防回页时行 click 突然变勾选的陈旧态惊喜）
		if (page !== "cards") clearBatchSelection();
		this.currentPage = page;
		for (const [p, el] of this.navCountEls) {
			// navCountEls 的 key 是导航项，找其父节点切 is-active
			const item = el.parentElement;
			item?.classList.toggle("is-active", p === page);
		}
		this.renderCurrentPage();
	}

	/** 重渲染当前页内容区（视图已关/未就绪时跳过） */
	private renderCurrentPage(): void {
		const content = this.contentEl.querySelector(":scope > .marinmind-home-content");
		if (!(content instanceof HTMLElement)) return;
		content.empty();
		if (!this.plugin.store) {
			content.createEl("p", {
				cls: "marinmind-home-empty",
				text: "数据层未就绪，无法展示主页内容。",
			});
			return;
		}
		const view = this;
		const ctx = {
			plugin: this.plugin,
			switchPage: (page: HomePage) => this.switchPage(page),
			get selectedCategory(): CategorySelection {
				return view.selectedCategory;
			},
			setSelectedCategory: (c: CategorySelection) => {
				this.selectedCategory = c;
				this.renderCurrentPage();
			},
			get docQuery(): string {
				return view.docQuery;
			},
			setDocQuery: (q: string) => {
				// 只更新状态不重渲染——列表局部刷新由文档页搜索回调自行触发（IME 安全）
				this.docQuery = q;
			},
			get cardsFilter(): CardsPageState {
				return view.cardsFilter;
			},
			setCardsFilter: (patch: Partial<CardsPageState>) => {
				// 筛选条件变化重置回第 1 页（翻页 patch 带页码不影响）
				const { page: _page, ...filters } = patch;
				let changed = false;
				for (const [key, value] of Object.entries(filters)) {
					if (this.cardsFilter[key as keyof CardsPageState] !== value) {
						this.cardsFilter.page = 1;
						changed = true;
					}
				}
				// 74 批选：筛选条件变化清选择与模式（选择只对当前筛选集有意义，防跨筛选误删；
				// 翻页 patch 只有 page 键不清——跨页保留选择）
				if (changed) clearBatchSelection();
				Object.assign(this.cardsFilter, patch);
				this.renderCurrentPage();
			},
			refresh: () => this.refresh(),
		};
		switch (this.currentPage) {
			case "overview":
				renderOverviewPage(content, ctx);
				break;
			case "documents":
				void renderDocumentsPage(content, ctx);
				break;
			case "cards":
				renderCardsPage(content, ctx);
				break;
			case "maps":
				renderMapsPage(content, ctx);
				break;
		}
	}

	/** 全量刷新（侧栏计数 + 当前页）；cardBus 事件经防抖合并触发 */
	refresh(): void {
		if (!this.contentEl.isConnected) return;
		this.refreshSidebarCounts();
		this.renderCurrentPage();
	}

	/**
	 * 订阅卡片变更事件（契约：回调只读仓储 + DOM 更新，禁止写库）。
	 * 高频事件（AI 批量建卡）经 100ms 尾随防抖合并成一次重渲染。
	 */
	private subscribeCardBus(): void {
		const schedule = () => {
			if (this.refreshTimer) clearTimeout(this.refreshTimer);
			this.refreshTimer = setTimeout(() => {
				this.refreshTimer = null;
				this.refresh();
			}, 100);
		};
		const bus = this.plugin.cardBus;
		this.cardBusOffs.push(
			bus.onCardCreated(schedule),
			bus.onCardChanged(schedule),
			bus.onCardRemoved(schedule),
		);
	}
}
