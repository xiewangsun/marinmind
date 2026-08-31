import { DropdownComponent, Menu, Notice, Platform, setIcon, TFile } from "obsidian";
import type { App } from "obsidian";
import type MarinMindPlugin from "../main";
import type { BookDocument, Card, Mindmap } from "../types";
import { now, mapLimit } from "../utils";
import { ConfirmModal } from "../mindmap/confirm-modal";
import { DocumentManagerModal } from "../documents/document-manager-modal";
import { copyExternalIntoVault } from "../documents/copy-into-vault";
import { isAbsoluteFsPath, pageWordOf } from "../storage/paths";
import { resolveDocPresence, type DocPresence } from "../documents/doc-presence";
import { TextPromptModal } from "../reader/note-edit-modal";
import { highlightFallbackColor } from "../reader/highlight-colors";
import { MSG_EXTERNAL_DOC_MOBILE } from "../constants";
import {
	buildCategoryTree,
	cardPreview,
	CATEGORY_MAX_LENGTH,
	EXCERPT_LABELS,
	filterCards,
	filterDocsByCategory,
	filterDocsByQuery,
	formatRelativeTime,
	injectCategoryPath,
	normalizeCategory,
	pageCount,
	paginate,
	type CardsPageState,
	type CategoryNode,
	type CategorySelection,
	type CategoryTree,
} from "./home-data";
import { getDocCover } from "./doc-covers";
import { CardPreviewModal } from "./card-preview-modal";

/** 主页导航页标识（与 home-view NAV_ITEMS 对应） */
export type HomePage = "overview" | "documents" | "cards" | "maps";

/**
 * 页面渲染上下文：页面函数不直接持有视图类，全部动作经 ctx
 * 走 plugin 公开面或视图提供的窄接口（便于单独审视页面行为）。
 */
export interface HomeRenderCtx {
	plugin: MarinMindPlugin;
	switchPage(page: HomePage): void;
	/** 文档页当前选中的分类（视图持有，刷新不丢）：null=未分类, "all"=全部 */
	readonly selectedCategory: CategorySelection;
	setSelectedCategory(c: CategorySelection): void;
	/** 文档页搜索关键词（视图持有，整页重渲染回填不抢焦点；输入时只局部刷新列表） */
	readonly docQuery: string;
	setDocQuery(q: string): void;
	/** 卡片页筛选与分页（视图持有，刷新不丢；筛选条件变化自动回第 1 页） */
	readonly cardsFilter: CardsPageState;
	setCardsFilter(patch: Partial<CardsPageState>): void;
	refresh(): void;
}

// ---------------------------------------------------------------------------
// 共享小组件
// ---------------------------------------------------------------------------

/** 卡片出处标签：《书名》 · 第 N 页/章 / 手工卡片 */
function cardSource(plugin: MarinMindPlugin, card: Card): string {
	const doc = card.documentId ? plugin.documents.get(card.documentId) : undefined;
	if (!doc) return "手工卡片";
	return `《${doc.title}》${card.page != null ? ` · 第 ${card.page} ${pageWordOf(doc.filePath)}` : ""}`;
}

/** 区块标题（Linear 风：小字号 muted，无边框） */
function sectionHeading(container: HTMLElement, text: string, actions?: HTMLElement): HTMLElement {
	const head = container.createDiv({ cls: "marinmind-home-heading" });
	head.createDiv({ cls: "marinmind-home-heading-text", text });
	if (actions) head.appendChild(actions);
	return head;
}

/** 统计砖：数字 + 标签，可点击（onClick 缺省为纯展示） */
function statBrick(
	container: HTMLElement,
	value: string | number,
	label: string,
	onClick?: () => void,
): void {
	const brick = container.createDiv({ cls: onClick ? "marinmind-home-stat is-clickable" : "marinmind-home-stat" });
	brick.createDiv({ cls: "marinmind-home-stat-value", text: String(value) });
	brick.createDiv({ cls: "marinmind-home-stat-label", text: label });
	if (onClick) {
		brick.addEventListener("click", onClick);
		enableKeyboardActivation(brick);
	}
}

/** ghost 操作按钮行 */
function actionButton(container: HTMLElement, label: string, icon: string, onClick: () => void): void {
	const btn = container.createDiv({ cls: "marinmind-home-btn" });
	const iconEl = btn.createSpan({ cls: "marinmind-home-btn-icon" });
	setIcon(iconEl, icon);
	btn.createSpan({ text: label });
	btn.addEventListener("click", onClick);
	enableKeyboardActivation(btn);
}

/** 空态提示 */
function emptyHint(container: HTMLElement, text: string): void {
	container.createDiv({ cls: "marinmind-home-empty", text });
}

/** 键盘可达（P0-1）：可点 div 补 role="button" + Tab 焦点 + Enter/Space 触发
 *  click——键盘与鼠标共用同一处理器（列表行/瓷片/导航项等 div 控件统一接线；
 *  焦点环由 styles.css 的全局 :focus-visible 规则承担） */
export function enableKeyboardActivation(el: HTMLElement): void {
	el.setAttribute("role", "button");
	el.tabIndex = 0;
	el.addEventListener("keydown", (evt) => {
		if (evt.key !== "Enter" && evt.key !== " ") return;
		evt.preventDefault(); // Space 防页面滚动
		el.click();
	});
}

/** 最近卡片行列表（概览 8 条 / 卡片页 50 条共用） */
function renderCardRows(container: HTMLElement, plugin: MarinMindPlugin, cards: Card[]): void {
	const list = container.createDiv({ cls: "marinmind-home-rows" });
	const ts = now();
	for (const card of cards) {
		const row = list.createDiv({ cls: "marinmind-home-row is-clickable" });
		const main = row.createDiv({ cls: "marinmind-home-row-main" });
		// P1-b 墨色随卡走：标题前墨点 = 卡片身份色（highlightFallbackColor 对
		// null 色卡按形态回退；存量旧色相 teal/orange/purple/pink 原样透传）
		const titleLine = main.createDiv({ cls: "marinmind-home-row-title-line" });
		titleLine.createSpan({ cls: "marinmind-home-ink-dot" }).dataset.color =
			highlightFallbackColor(card);
		titleLine.createDiv({ cls: "marinmind-home-row-title", text: cardPreview(card) });
		main.createDiv({
			cls: "marinmind-home-row-sub",
			text: `${cardSource(plugin, card)} · ${formatRelativeTime(card.updatedAt, ts)}`,
		});
		row.addEventListener("click", () => {
			// 㶈 点卡片先弹摘录预览（只有摘录区域的图 + 上下文），需要时再「跳原文」
			new CardPreviewModal(plugin.app, plugin, card).open();
		});
		enableKeyboardActivation(row);
	}
}

/** 文档就位徽标（复用文档管理面板的语义与配色；正常不显示） */
function presenceBadge(row: HTMLElement, presence: DocPresence): void {
	const missing = presence === "missing" || presence === "external-missing";
	const external = presence.startsWith("external");
	if (!missing && !external) return; // 正常：不占位
	const text =
		presence === "external-ok" || presence === "external-unknown"
			? "库外"
			: presence === "external-missing"
				? "库外·已失联"
				: "已失联";
	row.createDiv({
		cls: missing
			? "marinmind-doc-badge marinmind-doc-badge-missing"
			: "marinmind-doc-badge marinmind-doc-badge-external",
		text,
	});
}

/**
 * 打开文档记录（主页行点击）：库外桌面直读 / 库内解析 TFile /
 * 失联给重关联指引。与 DocumentManagerModal.openDoc 同语义（主页复刻轻量版）。
 */
async function openDocRecord(app: App, plugin: MarinMindPlugin, doc: BookDocument): Promise<void> {
	const presence = await resolveDocPresence(app, doc.filePath);
	if (presence === "ok") {
		const file = app.vault.getAbstractFileByPath(doc.filePath);
		if (file instanceof TFile) {
			await plugin.openInReader(file);
			return;
		}
	} else if (presence === "external-ok") {
		await plugin.openInReader(doc.filePath);
		return;
	} else if (presence === "external-unknown") {
		new Notice(MSG_EXTERNAL_DOC_MOBILE);
		return;
	}
	new Notice(`「${doc.title}」的原文文件已失联，请到文档管理面板重关联（卡片与复习进度会保留）`, 6000);
}

// ---------------------------------------------------------------------------
// 概览页
// ---------------------------------------------------------------------------

/** 概览页：统计四砖 + 快捷操作 + 最近卡片 + 最近文档 + 脑图快捷 */
export function renderOverviewPage(container: HTMLElement, ctx: HomeRenderCtx): void {
	const { plugin } = ctx;
	const wrap = container.createDiv({ cls: "marinmind-home-page" });
	wrap.createDiv({ cls: "marinmind-home-page-title", text: "概览" });

	// 统计行
	const stats = wrap.createDiv({ cls: "marinmind-home-stats" });
	statBrick(stats, plugin.documents.count(), "本书", () => ctx.switchPage("documents"));
	statBrick(stats, plugin.cards.count(), "张卡片", () => ctx.switchPage("cards"));
	statBrick(stats, plugin.reviews.dueCount(), "待复习", () => void plugin.openReview());
	statBrick(stats, plugin.mindmaps.list().length, "张脑图", () => ctx.switchPage("maps"));

	// 快捷操作
	const quick = wrap.createDiv({ cls: "marinmind-home-quick" });
	actionButton(quick, "打开文档", "file-plus", () => plugin.openPdfPicker());
	actionButton(quick, "开始复习", "swords", () => void plugin.openReview());
	actionButton(quick, "新建脑图", "git-fork", () => plugin.openMindmapPicker());

	// 最近卡片
	sectionHeading(wrap, "最近卡片");
	const recentCards = plugin.cards.recent(8);
	if (recentCards.length === 0) {
		emptyHint(wrap, "还没有卡片——在阅读器中摘录即自动生成。");
	} else {
		renderCardRows(wrap, plugin, recentCards);
	}

	// 最近文档
	sectionHeading(wrap, "最近文档");
	const recentDocs = plugin.documents.list().slice(0, 5);
	if (recentDocs.length === 0) {
		emptyHint(wrap, "还没有文档——点上方「打开文档」加入书库。");
	} else {
		const list = wrap.createDiv({ cls: "marinmind-home-rows" });
		const ts = now();
		for (const doc of recentDocs) {
			const row = list.createDiv({ cls: "marinmind-home-row is-clickable" });
			const main = row.createDiv({ cls: "marinmind-home-row-main" });
			main.createDiv({ cls: "marinmind-home-row-title", text: doc.title });
			main.createDiv({
				cls: "marinmind-home-row-sub",
				text: `${plugin.cards.count(doc.id)} 张卡片 · ${formatRelativeTime(doc.updatedAt, ts)}`,
			});
			// 概览页不做异步就位探活（保持渲染轻量）；失联在点击打开时判定并提示
			row.addEventListener("click", () => void openDocRecord(plugin.app, plugin, doc));
			enableKeyboardActivation(row);
		}
	}

	// 脑图快捷
	const mapsHead = sectionHeading(wrap, "脑图");
	const moreMaps = mapsHead.createDiv({ cls: "marinmind-home-heading-action", text: "查看全部" });
	moreMaps.addEventListener("click", () => ctx.switchPage("maps"));
	enableKeyboardActivation(moreMaps);
	const maps = plugin.mindmaps.list().slice(0, 3);
	if (maps.length === 0) {
		emptyHint(wrap, "还没有脑图——摘录自动入图（默认开）或手动新建。");
	} else {
		const list = wrap.createDiv({ cls: "marinmind-home-rows" });
		const ts = now();
		for (const m of maps) {
			const row = list.createDiv({ cls: "marinmind-home-row is-clickable" });
			const main = row.createDiv({ cls: "marinmind-home-row-main" });
			main.createDiv({ cls: "marinmind-home-row-title", text: m.name });
			main.createDiv({
				cls: "marinmind-home-row-sub",
				text: `${plugin.mindmaps.countNodes(m.id)} 个节点 · ${formatRelativeTime(m.updatedAt, ts)}`,
			});
			row.addEventListener("click", () => void plugin.openMindmap(m.id));
			enableKeyboardActivation(row);
		}
	}
}

// ---------------------------------------------------------------------------
// 文档页（分类 = 虚拟文件夹）
// ---------------------------------------------------------------------------

/** 文档页：左列分类文件夹树 + 右侧搜索框与文档列表（归档经右键菜单/拖拽） */
export async function renderDocumentsPage(container: HTMLElement, ctx: HomeRenderCtx): Promise<void> {
	const { plugin } = ctx;
	const wrap = container.createDiv({ cls: "marinmind-home-page marinmind-home-page-docs" });
	wrap.createDiv({ cls: "marinmind-home-page-title", text: "文档" });
	if (plugin.settings.homeDocsView === "grid") {
		wrap.addClass("is-grid"); // ㊵ 书架模式加宽内容区（列表维持默认基调）
	}

	const docs = plugin.documents.list();
	const body = wrap.createDiv({ cls: "marinmind-home-docs" });
	if (plugin.settings.homeFoldersHidden) {
		body.addClass("is-folders-hidden"); // ㊸ 左列收起态（页内切换就地 toggle 不重建）
	}

	// ---- 左列：分类文件夹树 ----
	const folders = body.createDiv({ cls: "marinmind-home-folders" });
	renderFolderTree(folders, ctx, buildCategoryTree(docs), docs);

	// ---- 右侧：搜索行（搜索框 + 列表/窗格切换）+ 文档列表（探活并发判定后一次渲染） ----
	const listWrap = body.createDiv({ cls: "marinmind-home-doc-list-wrap" });
	// 搜索行只在整页渲染时重建；输入与视图切换均仅局部刷新下方列表（中文 IME 组字不被打断）
	const searchRow = listWrap.createDiv({ cls: "marinmind-home-search-row" });
	const search = searchRow.createEl("input", {
		cls: "marinmind-home-search",
		attr: { type: "text", placeholder: "搜索标题或路径…" },
	});
	search.value = ctx.docQuery;
	// ㊸ 文件夹栏整栏收起：单钮组就地切换（panel-left 图标名经 obsidian.asar 注册表验证；
	// 镜像 homeDocsView 先例——页内切换即主界面，不重建 DOM 不打断搜索输入）
	const folderToggle = searchRow.createDiv({ cls: "marinmind-home-view-toggle" });
	const folderBtn = folderToggle.createDiv({
		cls: "marinmind-home-view-toggle-btn",
		attr: { "aria-label": "显示/隐藏文件夹栏", title: "显示/隐藏文件夹栏" },
	});
	setIcon(folderBtn, "panel-left");
	const syncFoldersBtn = (): void => {
		folderBtn.classList.toggle("is-active", !plugin.settings.homeFoldersHidden);
	};
	syncFoldersBtn();
	folderBtn.addEventListener("click", () => {
		plugin.settings.homeFoldersHidden = !plugin.settings.homeFoldersHidden;
		void plugin.saveData({ ...plugin.settings }); // 即时持久化（合并式加载，老 data.json 自动补默认）
		body.classList.toggle("is-folders-hidden", plugin.settings.homeFoldersHidden);
		syncFoldersBtn();
	});
	enableKeyboardActivation(folderBtn);
	// ㊵ 视图切换：相连双图标按钮（图标名经 obsidian.asar 注册表验证）
	const toggle = searchRow.createDiv({ cls: "marinmind-home-view-toggle" });
	const listBtn = toggle.createDiv({
		cls: "marinmind-home-view-toggle-btn",
		attr: { "aria-label": "列表视图", title: "列表视图" },
	});
	setIcon(listBtn, "list");
	const gridBtn = toggle.createDiv({
		cls: "marinmind-home-view-toggle-btn",
		attr: { "aria-label": "窗格视图（封面书架）", title: "窗格视图（封面书架）" },
	});
	setIcon(gridBtn, "layout-grid");
	const rowsHost = listWrap.createDiv();

	const rerenderList = async (): Promise<void> => {
		const fresh = plugin.documents.list();
		const inCategory = filterDocsByCategory(fresh, ctx.selectedCategory);
		const filtered = filterDocsByQuery(inCategory, ctx.docQuery);
		rowsHost.empty();
		if (filtered.length === 0) {
			if (inCategory.length === 0) {
				emptyHint(rowsHost, ctx.selectedCategory === "all" ? "书库为空——点「打开文档」加入第一本书。" : "该分类下暂无文档（右键文档或拖拽到左侧文件夹可归入）。");
			} else {
				emptyHint(rowsHost, `没有匹配「${ctx.docQuery.trim()}」的文档。`);
			}
			return;
		}
		const presences = await Promise.all(filtered.map((doc) => resolveDocPresence(plugin.app, doc.filePath)));
		const ts = now();
		if (plugin.settings.homeDocsView === "grid") {
			// ㊵ 窗格：先铺占位瓷片，封面批量按需渲染（并发 ≤ 3；getDocCover 契约
			// 永不 reject、DOM 段不抛——mapLimit「任一 fn 抛错整批 reject」的前提不存在）
			const grid = rowsHost.createDiv({ cls: "marinmind-home-doc-grid" });
			const pending: { doc: BookDocument; cover: HTMLElement; img: HTMLImageElement }[] = [];
			filtered.forEach((doc, i) => {
				const entry = renderDocTile(grid, ctx, doc, presences[i], ts);
				if (entry) {
					pending.push(entry);
				}
			});
			void mapLimit(pending, 3, async (e) => {
				const url = await getDocCover(plugin, e.doc);
				if (!e.cover.isConnected) {
					return; // 渲染期间列表已重建（输入/切模式/翻类）——丢弃
				}
				if (url) {
					e.img.src = url;
					e.cover.removeClass("is-loading");
					e.cover.addClass("is-loaded");
				} else {
					e.cover.removeClass("is-loading");
					setIcon(e.cover.createSpan({ cls: "marinmind-home-tile-fallback" }), "file");
				}
			});
		} else {
			const list = rowsHost.createDiv({ cls: "marinmind-home-rows" });
			filtered.forEach((doc, i) => {
				renderDocRow(list, ctx, doc, presences[i], ts);
			});
		}
	};
	// ㊵ 切换条高亮同步：按当前设置挂 is-active（整页重渲染后亦然）
	const syncToggle = (): void => {
		const grid = plugin.settings.homeDocsView === "grid";
		listBtn.classList.toggle("is-active", !grid);
		gridBtn.classList.toggle("is-active", grid);
	};
	syncToggle();
	const setDocsView = (mode: "list" | "grid"): void => {
		if (plugin.settings.homeDocsView === mode) {
			return;
		}
		plugin.settings.homeDocsView = mode;
		void plugin.saveData({ ...plugin.settings }); // 即时持久化（合并式加载，老 data.json 自动补默认）
		syncToggle();
		wrap.classList.toggle("is-grid", mode === "grid"); // 书架模式加宽内容区
		void rerenderList(); // 局部刷新：搜索框与左列文件夹树不动（IME/焦点不受扰）
	};
	listBtn.addEventListener("click", () => setDocsView("list"));
	gridBtn.addEventListener("click", () => setDocsView("grid"));
	enableKeyboardActivation(listBtn);
	enableKeyboardActivation(gridBtn);
	search.addEventListener("input", () => {
		ctx.setDocQuery(search.value);
		void rerenderList();
	});
	await rerenderList();
}

/** 左列文件夹树：全部/未分类 + 多层分类树（段级缩进）+ 新建分类入口 */
function renderFolderTree(
	folders: HTMLElement,
	ctx: HomeRenderCtx,
	tree: CategoryTree,
	docs: readonly BookDocument[],
): void {
	folders.empty();
	const fixed: { sel: CategorySelection; label: string; count: number; icon: string }[] = [
		{ sel: "all", label: "全部", count: tree.all, icon: "library" },
		{ sel: null, label: "未分类", count: tree.uncategorized, icon: "file" },
	];
	for (const item of fixed) {
		const isActive = ctx.selectedCategory === item.sel;
		const entry = folders.createDiv({
			cls: `marinmind-home-folder${isActive ? " is-active" : ""}`,
		});
		entry.addEventListener("click", () => ctx.setSelectedCategory(item.sel));
		enableKeyboardActivation(entry);
		// 未分类可作拖放目标（全部是全局视图无归档语义）
		if (item.sel !== "all") enableFolderDrop(entry, ctx, item.sel);
		const iconEl = entry.createSpan({ cls: "marinmind-home-folder-icon" });
		setIcon(iconEl, item.icon);
		entry.createSpan({ cls: "marinmind-home-folder-label", text: item.label });
		entry.createSpan({ cls: "marinmind-home-folder-count", text: String(item.count) });
	}

	// 本地新建的空分类注入树（未写文件也可选中/作拖放目标）
	const roots = injectCategoryPath(tree.roots, ctx.selectedCategory);
	for (const node of roots) renderFolderNode(folders, ctx, node, docs, 0);

	const createBtn = folders.createDiv({ cls: "marinmind-home-folder-create", text: "＋ 新建分类" });
	createBtn.addEventListener("click", () => promptNewCategory(ctx));
	enableKeyboardActivation(createBtn);
}

/** 递归渲染分类树节点（多层缩进；个人规模默认全展开，不做折叠态） */
function renderFolderNode(
	container: HTMLElement,
	ctx: HomeRenderCtx,
	node: CategoryNode,
	docs: readonly BookDocument[],
	depth: number,
): void {
	const isActive = ctx.selectedCategory === node.fullName;
	const entry = container.createDiv({
		cls: `marinmind-home-folder marinmind-home-folder-nested${isActive ? " is-active" : ""}`,
	});
	entry.style.paddingLeft = `${6 + depth * 14}px`;
	entry.addEventListener("click", () => ctx.setSelectedCategory(node.fullName));
	entry.addEventListener("contextmenu", (evt) => {
		evt.preventDefault();
		showFolderMenu(ctx, node, docs, evt);
	});
	enableKeyboardActivation(entry);
	enableFolderDrop(entry, ctx, node.fullName);
	const iconEl = entry.createSpan({ cls: "marinmind-home-folder-icon" });
	setIcon(iconEl, "folder");
	entry.createSpan({ cls: "marinmind-home-folder-label", text: node.name });
	entry.createSpan({ cls: "marinmind-home-folder-count", text: String(node.total) });
	for (const child of node.children) renderFolderNode(container, ctx, child, docs, depth + 1);
}

/** 新建分类：仅本地选中（空分类不写文件，直到有文档归入）；支持多层路径 */
function promptNewCategory(ctx: HomeRenderCtx): void {
	new TextPromptModal(
		ctx.plugin.app,
		{ title: "新建分类", placeholder: "分类名称（支持多层，如：学习/英语）", multiline: false },
		(name) => {
			const raw = name ?? "";
			const normalized = normalizeCategory(raw);
			if (!normalized) {
				// 空 = 取消；非空但归一失败（超长）给提示
				if (raw.trim()) new Notice(`分类名无效（为空或超过 ${CATEGORY_MAX_LENGTH} 字符）`);
				return;
			}
			ctx.setSelectedCategory(normalized);
		},
	).open();
}

/** 归一输入并校验；返回 null 表示取消或无效（无效时已 Notice） */
function promptCategoryName(
	app: App,
	options: { title: string; initialText?: string; placeholder?: string },
	onOk: (normalized: string) => void,
): void {
	new TextPromptModal(
		app,
		{ title: options.title, initialText: options.initialText, placeholder: options.placeholder, multiline: false },
		(name) => {
			const raw = name ?? "";
			const normalized = normalizeCategory(raw);
			if (!normalized) {
				if (raw.trim()) new Notice(`分类名无效（为空或超过 ${CATEGORY_MAX_LENGTH} 字符）`);
				return;
			}
			onOk(normalized);
		},
	).open();
}

/** 分类路径是否落入 target 子树（target 本身或以其为前缀的路径） */
function inCategorySubtree(path: string, target: string): boolean {
	return path === target || path.startsWith(`${target}/`);
}

/** 分类文件夹右键菜单：重命名（级联子路径）/ 删除（子树文档移入未分类） */
function showFolderMenu(ctx: HomeRenderCtx, node: CategoryNode, docs: readonly BookDocument[], evt: MouseEvent): void {
	const category = node.fullName;
	const menu = new Menu();
	menu.addItem((item) =>
		item
			.setTitle("重命名分类")
			.setIcon("pencil")
			.onClick(() => {
				promptCategoryName(
					ctx.plugin.app,
					{ title: "重命名分类", initialText: category },
					(normalized) => {
						if (normalized === category) return;
						renameCategory(ctx, category, normalized);
					},
				);
			}),
	);
	menu.addSeparator();
	menu.addItem((item) =>
		item
			.setTitle("删除分类")
			.setIcon("trash-2")
			.onClick(() => {
				// 子树 = 该分类本身 + 多层子孙路径下的全部文档
				const victims = docs.filter((d) => {
					const c = d.category ? normalizeCategory(d.category) : null;
					return c !== null && inCategorySubtree(c, category);
				});
				new ConfirmModal(
					ctx.plugin.app,
					"删除分类",
					`删除分类「${category}」后，其下 ${victims.length} 个文档（含子分类）将移入「未分类」（文档与卡片不受影响）。继续？`,
					() => {
						for (const d of victims) {
							ctx.plugin.documents.update(d.id, { category: null });
						}
						if (typeof ctx.selectedCategory === "string" && inCategorySubtree(ctx.selectedCategory, category)) {
							ctx.setSelectedCategory("all");
						} else {
							ctx.refresh();
						}
						new Notice(`已删除分类「${category}」`);
					},
				).open();
			}),
	);
	menu.showAtMouseEvent(evt);
}

/**
 * 重命名分类：级联子路径（「学习」→「study」时「学习/英语」→「study/英语」，
 * 不级联会产生两棵分裂子树）。批量更新（每文件一次防抖写）。
 */
function renameCategory(ctx: HomeRenderCtx, oldName: string, newName: string): void {
	const docs = ctx.plugin.documents.list().filter((d) => {
		const c = d.category ? normalizeCategory(d.category) : null;
		return c !== null && inCategorySubtree(c, oldName);
	});
	if (docs.length === 0) {
		ctx.setSelectedCategory(newName); // 空分类：仅本地改名
		return;
	}
	for (const d of docs) {
		// 写回归一值（顺手收敛手编产生的空白变体）
		const c = normalizeCategory(d.category!)!;
		ctx.plugin.documents.update(d.id, { category: c === oldName ? newName : newName + c.slice(oldName.length) });
	}
	if (typeof ctx.selectedCategory === "string" && inCategorySubtree(ctx.selectedCategory, oldName)) {
		ctx.setSelectedCategory(newName + ctx.selectedCategory.slice(oldName.length));
	} else {
		ctx.refresh();
	}
	new Notice(`已重命名分类「${oldName}」→「${newName}」（${docs.length} 个文档）`);
}

/** 分类树扁平化为全路径清单（深度优先，右键菜单/下拉用） */
function flattenCategoryTree(nodes: readonly CategoryNode[], out: string[] = []): string[] {
	for (const n of nodes) {
		out.push(n.fullName);
		flattenCategoryTree(n.children, out);
	}
	return out;
}

// ---- 拖拽归档（㊲ HTML5 DnD：文档行 → 左列文件夹；与右键菜单并存） ----

/** 当前拖拽中的文档 id（dragstart 写入 / dragend 清空；drop 优先取此值，dataTransfer 兜底） */
let draggingDocId: string | null = null;

/** 文档行启用拖拽源（dataTransfer 需有数据 Firefox 才启动；实际取值走闭包/模块态） */
function enableDocDrag(row: HTMLElement, doc: BookDocument): void {
	row.draggable = true;
	row.addEventListener("dragstart", (evt) => {
		draggingDocId = doc.id;
		evt.dataTransfer?.setData("text/plain", doc.id);
		if (evt.dataTransfer) evt.dataTransfer.effectAllowed = "move";
		row.addClass("is-dragging");
	});
	row.addEventListener("dragend", () => {
		draggingDocId = null;
		row.removeClass("is-dragging");
	});
}

/** 文件夹行启用拖放目标（dragover 高亮 + drop 归入；category null = 移入未分类） */
function enableFolderDrop(entry: HTMLElement, ctx: HomeRenderCtx, category: string | null): void {
	entry.addEventListener("dragover", (evt) => {
		evt.preventDefault(); // 不阻止则不触发 drop
		if (evt.dataTransfer) evt.dataTransfer.dropEffect = "move";
		entry.addClass("is-droptarget");
	});
	entry.addEventListener("dragleave", (evt) => {
		// 移入子元素（图标/文本 span）也发 dragleave，只在外出时才撤高亮防闪烁
		if (!entry.contains(evt.relatedTarget as Node | null)) entry.removeClass("is-droptarget");
	});
	entry.addEventListener("drop", (evt) => {
		evt.preventDefault();
		entry.removeClass("is-droptarget");
		const docId = draggingDocId ?? evt.dataTransfer?.getData("text/plain") ?? "";
		if (!docId) return;
		const target = ctx.plugin.documents.get(docId);
		if (!target) return;
		const cur = target.category ? normalizeCategory(target.category) : null;
		if (cur === category) return; // 已在该分类（等价跳过，不触发写盘）
		ctx.plugin.documents.update(docId, { category });
		ctx.refresh();
		new Notice(category === null ? "已移入未分类" : `已归入「${category}」`);
	});
}

/** 文档行：标题/路径/徽标/卡数/时间 + 点击打开 + 右键归档菜单 + 拖拽归档源 */
function renderDocRow(
	list: HTMLElement,
	ctx: HomeRenderCtx,
	doc: BookDocument,
	presence: DocPresence,
	ts: number,
): void {
	const { plugin } = ctx;
	const row = list.createDiv({ cls: "marinmind-home-row is-clickable marinmind-home-doc-row" });
	const main = row.createDiv({ cls: "marinmind-home-row-main" });
	main.createDiv({ cls: "marinmind-home-row-title", text: doc.title });
	main.createDiv({ cls: "marinmind-home-row-sub", text: doc.filePath });
	presenceBadge(row, presence);
	if (doc.category) {
		row.createDiv({ cls: "marinmind-doc-badge", text: doc.category });
	}
	row.createDiv({
		cls: "marinmind-home-row-meta",
		text: `${plugin.cards.count(doc.id)} 卡 · ${formatRelativeTime(doc.updatedAt, ts)}`,
	});
	bindDocActions(row, ctx, doc);
}

/** 行/瓷片共用交互绑定：点击打开 + 右键归档菜单 + 拖拽归档源（㊵ 抽出共用） */
function bindDocActions(el: HTMLElement, ctx: HomeRenderCtx, doc: BookDocument): void {
	const { plugin } = ctx;
	el.addEventListener("click", () => void openDocRecord(plugin.app, plugin, doc));
	el.addEventListener("contextmenu", (evt) => {
		evt.preventDefault();
		showDocMenu(ctx, doc, evt);
	});
	enableDocDrag(el, doc);
	enableKeyboardActivation(el); // P0-1：行/瓷片键盘可达（单点接线两形态共用）
}

/**
 * 文档瓷片（㊵ 窗格模式）：封面占位框（3/4 统一开本 + 徽标右上叠放）+ 标题 +
 * 卡数/时间；交互与行一致（bindDocActions）。失联/移动端库外不排封面队列，
 * 就地弱化图标占位并返回 null；可封面化返回待渲染条目（供 mapLimit 批量回填）。
 */
function renderDocTile(
	grid: HTMLElement,
	ctx: HomeRenderCtx,
	doc: BookDocument,
	presence: DocPresence,
	ts: number,
): { doc: BookDocument; cover: HTMLElement; img: HTMLImageElement } | null {
	const { plugin } = ctx;
	const tile = grid.createDiv({ cls: "marinmind-home-doc-tile is-clickable" });
	const cover = tile.createDiv({ cls: "marinmind-home-tile-cover is-loading" });
	// draggable=false：防 img 默认拖拽行为劫持瓷片归档拖拽；is-loaded 前不显示
	const img = cover.createEl("img", {
		cls: "marinmind-home-tile-img",
		attr: { alt: "", draggable: "false" },
	});
	// 徽标（状态 + 分类）叠放封面右上，pointer-events:none 不拦截点击/拖拽
	const badges = cover.createDiv({ cls: "marinmind-home-tile-badges" });
	presenceBadge(badges, presence);
	if (doc.category) {
		badges.createDiv({ cls: "marinmind-doc-badge", text: doc.category });
	}
	tile.createDiv({ cls: "marinmind-home-tile-title", text: doc.title });
	tile.createDiv({
		cls: "marinmind-home-tile-meta",
		text: `${plugin.cards.count(doc.id)} 卡 · ${formatRelativeTime(doc.updatedAt, ts)}`,
	});
	bindDocActions(tile, ctx, doc);
	if (presence !== "ok" && presence !== "external-ok") {
		// 失联 / 移动端库外（external-unknown 读不了文件）：不排队，直接占位
		cover.removeClass("is-loading");
		setIcon(cover.createSpan({ cls: "marinmind-home-tile-fallback" }), "file");
		return null;
	}
	return { doc, cover, img };
}

/** 文档行右键菜单：打开 / 归入分类（扁平项）/ 移入未分类 / 文档管理 */
function showDocMenu(ctx: HomeRenderCtx, doc: BookDocument, evt: MouseEvent): void {
	const { plugin } = ctx;
	const menu = new Menu();
	menu.addItem((item) =>
		item
			.setTitle("打开")
			.setIcon("book-open")
			.onClick(() => void openDocRecord(plugin.app, plugin, doc)),
	);
	// ㊳ 一键复制入库（仅桌面库外文档）：复制到 vault 根并改道记录（备份可打包、跨机器不失联）
	if (isAbsoluteFsPath(doc.filePath) && Platform.isDesktopApp) {
		menu.addItem((item) =>
			item
				.setTitle("复制入库")
				.setIcon("copy-plus")
				.onClick(() =>
					void copyExternalIntoVault(plugin, doc.filePath).then((file) => {
						if (file) {
							new Notice(`已复制入库：${file.path}（卡片与复习进度保留）`);
							plugin.externalWatcher?.sync();
							ctx.refresh();
						}
					}),
				),
		);
	}
	menu.addSeparator();
	// 归入分类：多层树扁平化为全路径文本（obsidian Menu 无 addSubMenu，只能扁平项）
	const tree = buildCategoryTree(plugin.documents.list());
	const paths = flattenCategoryTree(tree.roots);
	menu.addItem((item) => item.setTitle("归入分类：").setDisabled(true));
	if (paths.length === 0) {
		menu.addItem((item) => item.setTitle("（暂无分类）").setDisabled(true));
	}
	const cur = doc.category ? normalizeCategory(doc.category) : null;
	for (const p of paths) {
		if (p === cur) continue; // 已在该分类
		menu.addItem((item) =>
			item.setTitle(p).setIcon("folder").onClick(() => {
				plugin.documents.update(doc.id, { category: p });
				ctx.refresh();
				new Notice(`已归入「${p}」`);
			}),
		);
	}
	menu.addItem((item) =>
		item
			.setTitle("新建分类并归入…")
			.setIcon("folder-plus")
			.onClick(() => {
				promptCategoryName(
					plugin.app,
					{ title: "新建分类", placeholder: "分类名称（支持多层，如：学习/英语）" },
					(normalized) => {
						plugin.documents.update(doc.id, { category: normalized });
						ctx.setSelectedCategory(normalized);
						new Notice(`已归入「${normalized}」`);
					},
				);
			}),
	);
	if (doc.category) {
		menu.addItem((item) =>
			item
				.setTitle("移入未分类")
				.setIcon("file-minus")
				.onClick(() => {
					plugin.documents.update(doc.id, { category: null });
					ctx.refresh();
				}),
		);
	}
	menu.addSeparator();
	menu.addItem((item) =>
		item
			.setTitle("文档管理…")
			.setIcon("settings-2")
			.onClick(() => new DocumentManagerModal(plugin.app, plugin).open()),
	);
	menu.showAtMouseEvent(evt);
}

// ---------------------------------------------------------------------------
// 卡片页
// ---------------------------------------------------------------------------

/** 卡片页每页条数（与 recent 列表同量级） */
const CARDS_PAGE_SIZE = 50;

/** 卡片页：统计 + 文档/形态筛选 + 分页浏览（点击跳原文，按更新时间降序） */
export function renderCardsPage(container: HTMLElement, ctx: HomeRenderCtx): void {
	const { plugin } = ctx;
	const wrap = container.createDiv({ cls: "marinmind-home-page" });
	wrap.createDiv({ cls: "marinmind-home-page-title", text: "卡片" });

	const stats = wrap.createDiv({ cls: "marinmind-home-stats" });
	statBrick(stats, plugin.cards.count(), "张卡片");
	statBrick(stats, plugin.reviews.dueCount(), "待复习", () => void plugin.openReview());

	// ---- 筛选行：文档/形态下拉（dropdown 走 obsidian 全局类，主页变量覆盖自动跟随深色） ----
	const filterRow = wrap.createDiv({ cls: "marinmind-home-cards-filter" });
	const docSel = new DropdownComponent(filterRow).addOption("", "全部文档");
	for (const d of plugin.documents.list()) docSel.addOption(d.id, d.title);
	docSel.setValue(ctx.cardsFilter.documentId ?? "");
	docSel.onChange((v) => ctx.setCardsFilter({ documentId: v || null }));

	const typeSel = new DropdownComponent(filterRow).addOption("", "全部形态");
	for (const [type, label] of Object.entries(EXCERPT_LABELS)) typeSel.addOption(type, label);
	typeSel.setValue(ctx.cardsFilter.excerptType ?? "");
	typeSel.onChange((v) => ctx.setCardsFilter({ excerptType: v || null }));

	// ---- 结果列表（筛选 → 分页切片） ----
	const filtered = filterCards(plugin.cards.listAll(), ctx.cardsFilter);
	filterRow.createDiv({ cls: "marinmind-home-cards-count", text: `${filtered.length} 张` });
	if (filtered.length === 0) {
		emptyHint(
			wrap,
			plugin.cards.count() === 0
				? "还没有卡片——在阅读器中摘录即自动生成。"
				: "当前筛选条件下没有卡片。",
		);
		return;
	}
	renderCardRows(wrap, plugin, paginate(filtered, ctx.cardsFilter.page, CARDS_PAGE_SIZE));

	// ---- 分页条（仅一页时隐藏；页码越界按最后一页显示） ----
	const totalPages = pageCount(filtered.length, CARDS_PAGE_SIZE);
	if (totalPages <= 1) return;
	const cur = Math.min(ctx.cardsFilter.page, totalPages);
	const pager = wrap.createDiv({ cls: "marinmind-home-pager" });
	const prev = pager.createDiv({ cls: "marinmind-home-pager-btn" });
	// P2-1：分页箭头 ‹› → lucide chevron（与复习导航条同款图标语言）
	setIcon(prev.createSpan({ cls: "marinmind-home-pager-icon" }), "chevron-left");
	prev.createSpan({ text: "上一页" });
	if (cur <= 1) {
		prev.addClass("is-disabled");
		prev.setAttribute("aria-disabled", "true"); // P0-1：禁用态语义化（无 tabindex，键盘不进入）
	} else {
		enableKeyboardActivation(prev);
		prev.addEventListener("click", () => ctx.setCardsFilter({ page: cur - 1 }));
	}
	pager.createDiv({ cls: "marinmind-home-pager-info", text: `第 ${cur} / ${totalPages} 页` });
	const next = pager.createDiv({ cls: "marinmind-home-pager-btn" });
	setIcon(next.createSpan({ cls: "marinmind-home-pager-icon" }), "chevron-right");
	next.createSpan({ text: "下一页" });
	if (cur >= totalPages) {
		next.addClass("is-disabled");
		next.setAttribute("aria-disabled", "true");
	} else {
		enableKeyboardActivation(next);
		next.addEventListener("click", () => ctx.setCardsFilter({ page: cur + 1 }));
	}
}

// ---------------------------------------------------------------------------
// 脑图页
// ---------------------------------------------------------------------------

/** 脑图页：新建入口 + 图列表（节点数/最近更新/书籍图徽标） */
export function renderMapsPage(container: HTMLElement, ctx: HomeRenderCtx): void {
	const { plugin } = ctx;
	const wrap = container.createDiv({ cls: "marinmind-home-page" });
	const titleRow = wrap.createDiv({ cls: "marinmind-home-title-row" });
	titleRow.createDiv({ cls: "marinmind-home-page-title", text: "脑图" });
	const createBtn = titleRow.createDiv({ cls: "marinmind-home-btn marinmind-home-btn-primary" });
	createBtn.createSpan({ text: "＋ 新建脑图" });
	createBtn.addEventListener("click", () => plugin.openMindmapPicker());
	enableKeyboardActivation(createBtn);

	const maps = plugin.mindmaps.list();
	if (maps.length === 0) {
		emptyHint(wrap, "还没有脑图——点上方「＋ 新建脑图」，或靠摘录自动入图（默认开启）。");
		return;
	}
	const list = wrap.createDiv({ cls: "marinmind-home-rows" });
	const ts = now();
	for (const m of maps) {
		renderMapRow(list, plugin, m, ts);
	}
}

function renderMapRow(list: HTMLElement, plugin: MarinMindPlugin, m: Mindmap, ts: number): void {
	const row = list.createDiv({ cls: "marinmind-home-row is-clickable" });
	const main = row.createDiv({ cls: "marinmind-home-row-main" });
	main.createDiv({ cls: "marinmind-home-row-title", text: m.name });
	main.createDiv({
		cls: "marinmind-home-row-sub",
		text: `${plugin.mindmaps.countNodes(m.id)} 个节点 · ${formatRelativeTime(m.updatedAt, ts)}`,
	});
	if (m.documentId) {
		const doc = plugin.documents.get(m.documentId);
		if (doc) row.createDiv({ cls: "marinmind-doc-badge", text: `📖 ${doc.title}` });
	}
	row.addEventListener("click", () => void plugin.openMindmap(m.id));
	enableKeyboardActivation(row);
}
