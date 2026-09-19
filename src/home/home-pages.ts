import { DropdownComponent, Menu, Notice, Platform, setIcon, TFile } from "obsidian";
import type { App } from "obsidian";
import type MarinMindPlugin from "../main";
import { t } from "../i18n/i18n";
import type { BookDocument, Card, Mindmap } from "../types";
import { now } from "../utils";
import { ConfirmModal } from "../mindmap/confirm-modal";
import { confirmDeleteMindmap } from "../mindmap/map-delete";
import { refreshActiveMindmaps } from "../mindmap/mindmap-view";
import { DocumentManagerModal } from "../documents/document-manager-modal";
import { ReviewStatsModal } from "../review/review-stats-modal";
import { copyExternalIntoVault } from "../documents/copy-into-vault";
import { isAbsoluteFsPath, pageWordOf } from "../storage/paths";
import { resolveDocPresence, type DocPresence } from "../documents/doc-presence";
import { confirmDeleteDocument, confirmDeleteDocuments } from "../documents/doc-delete";
import { highlightFallbackColor, HIGHLIGHT_COLORS } from "../reader/highlight-colors";
import { MSG_EXTERNAL_DOC_MOBILE } from "../constants";
import {
	activeDeckPath,
	buildCategoryTree,
	buildDeckTree,
	cardPreview,
	cardRowSummary,
	distinctColors,
	distinctTags,
	EXCERPT_LABELS,
	filterCards,
	filterCardsByQuery,
	filterDocsByCategory,
	filterDocsByQuery,
	flattenCategoryTree,
	formatRelativeTime,
	injectCategoryPath,
	inPathSubtree,
	normalizeCategory,
	pageCount,
	paginate,
	UNSET_COLOR,
	UNSET_DECK,
	type CardsPageState,
	type CategoryNode,
	type CategorySelection,
	type CategoryTree,
} from "./home-data";
import { getDocCover } from "./doc-covers";
import { createLazyQueue } from "./lazy-cover-queue";
import { CardPreviewModal } from "./card-preview-modal";
import { DocumentAssignModal } from "./document-assign-modal";
import { CategoryAssignModal } from "./category-assign-modal";
import { deleteCardCascade, promptPathName } from "./card-actions";

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
	/** 卡片页搜索关键词（139-F；视图持有，整页重渲染回填不抢焦点；输入时只局部刷新列表） */
	readonly cardQuery: string;
	setCardQuery(q: string): void;
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
	const brick = container.createDiv({
		cls: onClick ? "marinmind-home-stat is-clickable" : "marinmind-home-stat",
	});
	brick.createDiv({ cls: "marinmind-home-stat-value", text: String(value) });
	brick.createDiv({ cls: "marinmind-home-stat-label", text: label });
	if (onClick) {
		brick.addEventListener("click", onClick);
		enableKeyboardActivation(brick);
	}
}

/** ghost 操作按钮行 */
function actionButton(
	container: HTMLElement,
	label: string,
	icon: string,
	onClick: () => void,
): void {
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

/**
 * 最近卡片行列表（概览 8 条 / 卡片页 50 条共用）。
 * opts.ctx（73 卡组批）：行挂 card-row 类 + 行尾卡组徽标 + 右键归组菜单与拖拽
 * 归组源；概览页缺省不传——无徽标无右键无拖拽，点击仍弹摘录预览（逐行为与旧版一致）。
 */
function renderCardRows(
	container: HTMLElement,
	plugin: MarinMindPlugin,
	cards: Card[],
	opts?: { ctx?: HomeRenderCtx },
): void {
	const list = container.createDiv({ cls: "marinmind-home-rows" });
	const ts = now();
	for (const card of cards) {
		// 74 批选模式：仅卡片页（opts.ctx）进入时行首插纯视觉 checkbox + 勾选态类
		const batch = opts?.ctx != null && batchSelectMode;
		const selected = batch && batchSelectedIds.has(card.id);
		const row = list.createDiv({
			cls: `marinmind-home-row is-clickable${opts?.ctx ? " marinmind-home-card-row" : ""}${selected ? " is-batch-selected" : ""}`,
			attr: batch ? { "data-card-id": card.id } : {},
		});
		if (batch) {
			// checkbox 纯视觉（pointer-events:none）——行 click 单一交互源，防冒泡双 toggle
			const box = row.createEl("input", {
				cls: "marinmind-home-batch-check",
				type: "checkbox",
			}) as HTMLInputElement;
			box.checked = selected;
			box.setAttribute("aria-hidden", "true"); // 行本身已是 checkbox 角色，内嵌框不重复报读
		}
		const main = row.createDiv({ cls: "marinmind-home-row-main" });
		// P1-b 墨色随卡走：标题前墨点 = 卡片身份色（highlightFallbackColor 对
		// null 色卡按形态回退；存量旧色相 teal/orange/purple/pink 原样透传）
		const titleLine = main.createDiv({ cls: "marinmind-home-row-title-line" });
		titleLine.createSpan({ cls: "marinmind-home-ink-dot" }).dataset.color =
			highlightFallbackColor(card);
		titleLine.createDiv({ cls: "marinmind-home-row-title", text: cardPreview(card) });
		// 91 批摘要第二行：标题行未吸收的字段（批注 > 摘录文字，OCR 卡正文首屏可见），
		// 最多两行截断；全被吸收不渲染（不空占位）
		const summary = cardRowSummary(card);
		if (summary) {
			main.createDiv({ cls: "marinmind-home-row-summary", text: summary });
		}
		main.createDiv({
			cls: "marinmind-home-row-sub",
			text: `${cardSource(plugin, card)} · ${formatRelativeTime(card.updatedAt, ts)}`,
		});
		if (opts?.ctx) {
			// 73 卡组徽标（镜像文档行分类徽标；marinmind-doc-badge 为纯视觉类两页通吃）
			if (card.deck) {
				row.createDiv({ cls: "marinmind-doc-badge", text: card.deck });
			}
			// 74 批选模式不挂右键菜单与拖拽（纯选择语义；长按/拖拽与勾选手势互斥）
			if (!batchSelectMode) bindCardActions(row, opts.ctx, card);
		}
		row.addEventListener("click", () => {
			// 74 批选模式：行 click = 勾选/取消（就地更新，不整页重建）；概览页无 ctx 不进入
			if (opts?.ctx && batchSelectMode) {
				toggleBatchSelected(card.id, row);
				return;
			}
			// 㶈 点卡片先弹摘录预览（只有摘录区域的图 + 上下文），需要时再「跳原文」
			new CardPreviewModal(plugin.app, plugin, card).open();
		});
		enableKeyboardActivation(row);
		if (batch) {
			// 键盘可达基类挂的是 role=button，批选行覆写为 checkbox 语义（Enter/Space 走同一 click）
			row.setAttribute("role", "checkbox");
			row.setAttribute("aria-checked", String(selected));
		}
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
	new Notice(
		`「${doc.title}」的原文文件已失联，请到文档管理面板重关联（卡片与复习进度会保留）`,
		6000,
	);
}

// ---------------------------------------------------------------------------
// 概览页
// ---------------------------------------------------------------------------

/** 概览页：统计四砖 + 快捷操作 + 最近卡片 + 最近文档 + 脑图快捷 */
export function renderOverviewPage(container: HTMLElement, ctx: HomeRenderCtx): void {
	const { plugin } = ctx;
	const wrap = container.createDiv({ cls: "marinmind-home-page" });
	wrap.createDiv({ cls: "marinmind-home-page-title", text: t("概览") });

	// 统计行
	const stats = wrap.createDiv({ cls: "marinmind-home-stats" });
	statBrick(stats, plugin.documents.count(), "本书", () => ctx.switchPage("documents"));
	statBrick(stats, plugin.cards.count(), "张卡片", () => ctx.switchPage("cards"));
	statBrick(stats, plugin.reviews.dueCount(), "待复习", () => void plugin.openReview());
	statBrick(stats, plugin.mindmaps.list().length, "张脑图", () => ctx.switchPage("maps"));

	// 快捷操作
	const quick = wrap.createDiv({ cls: "marinmind-home-quick" });
	actionButton(quick, "打开文档", "file-plus", () => plugin.openPdfPicker());
	// 90 批 MN3 对照：复习=学习语义 graduation-cap（原 swords，与阅读器/脑图入口对齐）
	actionButton(quick, "开始复习", "graduation-cap", () => void plugin.openReview());
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
	const moreMaps = mapsHead.createDiv({
		cls: "marinmind-home-heading-action",
		text: t("查看全部"),
	});
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

/** 书架封面视口观察器（127 惰性渲染）：列表局部刷新/整页重渲染重建前 disconnect
 *  旧观察器，防脱离文档的瓷片仍被持有（在途渲染由 isConnected 守卫丢弃） */
let gridCoverObserver: IntersectionObserver | null = null;

/** 文档页：左列分类文件夹树 + 右侧搜索框与文档列表（归档经右键菜单/拖拽） */
export async function renderDocumentsPage(
	container: HTMLElement,
	ctx: HomeRenderCtx,
): Promise<void> {
	const { plugin } = ctx;
	const wrap = container.createDiv({ cls: "marinmind-home-page marinmind-home-page-docs" });
	wrap.createDiv({ cls: "marinmind-home-page-title", text: t("文档") });
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
	// 76 显式清单 union：空分类持久可见（store 可能降级 undefined——可选链兜底）
	renderFolderTree(folders, ctx, buildCategoryTree(docs, plugin.store?.getFolders() ?? []), docs);

	// ---- 右侧：搜索行（搜索框 + 列表/窗格切换）+ 文档列表（探活并发判定后一次渲染） ----
	const listWrap = body.createDiv({ cls: "marinmind-home-doc-list-wrap" });
	// 搜索行只在整页渲染时重建；输入与视图切换均仅局部刷新下方列表（中文 IME 组字不被打断）
	const searchRow = listWrap.createDiv({ cls: "marinmind-home-search-row" });
	const search = searchRow.createEl("input", {
		cls: "marinmind-home-search",
		// R3（W-04）：占位符不构成可访问名，补 aria-label
		attr: {
			type: "text",
			placeholder: t("搜索标题或路径…"),
			"aria-label": t("搜索文档（标题或路径）"),
		},
	});
	search.value = ctx.docQuery;
	// ㊸ 文件夹栏整栏收起：单钮组就地切换（panel-left 图标名经 obsidian.asar 注册表验证；
	// 镜像 homeDocsView 先例——页内切换即主界面，不重建 DOM 不打断搜索输入）
	const folderToggle = searchRow.createDiv({ cls: "marinmind-home-view-toggle" });
	const folderBtn = folderToggle.createDiv({
		cls: "marinmind-home-view-toggle-btn",
		attr: { "aria-label": t("显示/隐藏文件夹栏"), title: t("显示/隐藏文件夹栏") },
	});
	setIcon(folderBtn, "panel-left");
	const syncFoldersBtn = (): void => {
		folderBtn.classList.toggle("is-active", !plugin.settings.homeFoldersHidden);
		// R3（W-12）：开合状态同步 aria-pressed（镜像阅读器工具行先例）
		folderBtn.setAttribute("aria-pressed", String(!plugin.settings.homeFoldersHidden));
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
		attr: { "aria-label": t("列表视图"), title: t("列表视图") },
	});
	setIcon(listBtn, "list");
	const gridBtn = toggle.createDiv({
		cls: "marinmind-home-view-toggle-btn",
		attr: { "aria-label": t("窗格视图（封面书架）"), title: t("窗格视图（封面书架）") },
	});
	setIcon(gridBtn, "layout-grid");
	// ㊾ 批量管理开关（配方同卡片页批选；开 = 行/瓷片出勾选框、点击即勾选、批量操作行浮现）
	const docBatchToggle = searchRow.createDiv({ cls: "marinmind-home-view-toggle" });
	const docBatchBtn = docBatchToggle.createDiv({
		cls: "marinmind-home-view-toggle-btn",
		attr: {
			"aria-label": t("批量选择"),
			title: t("批量选择（批量删除 / 移动分类）"),
			"aria-pressed": String(docBatchSelectMode),
		},
	});
	setIcon(docBatchBtn, "list-checks");
	docBatchBtn.classList.toggle("is-active", docBatchSelectMode);
	docBatchBtn.addEventListener("click", () => {
		if (docBatchSelectMode) {
			clearDocBatchSelection(); // 关闭模式并清空选择
		} else {
			docBatchSelectMode = true;
		}
		ctx.refresh(); // 整页重渲染显隐勾选框与批量操作行（刚点击按钮，搜索框无 IME 组字顾虑）
	});
	enableKeyboardActivation(docBatchBtn);

	// ㊾ 批量操作行（批选模式时渲染在搜索行与列表之间）：计数 + 全选 + 批量删除 + 批量移动分类
	if (docBatchSelectMode) {
		const batchRow = listWrap.createDiv({ cls: "marinmind-home-doc-batch-row" });
		const countEl = batchRow.createDiv({ cls: "marinmind-home-cards-count", text: t("") }); // docBatchUiSync 填数
		const selectAllBtn = batchRow.createEl("button", {
			cls: "marinmind-home-cards-review",
			text: t("全选"),
			attr: { type: "button", title: t("勾选/取消当前筛选下全部文档") },
		});
		selectAllBtn.addEventListener("click", () => {
			const fresh = filterDocsByQuery(
				filterDocsByCategory(plugin.documents.list(), ctx.selectedCategory),
				ctx.docQuery,
			);
			const allIn = fresh.length > 0 && fresh.every((d) => docBatchSelectedIds.has(d.id));
			for (const d of fresh) {
				if (allIn) docBatchSelectedIds.delete(d.id);
				else docBatchSelectedIds.add(d.id);
			}
			// 就地更新可见行/瓷片勾选态（属性选择器同时命中两种形态，不整页重建）
			for (const rowEl of rowsHost.querySelectorAll<HTMLElement>("[data-doc-id]")) {
				const id = rowEl.getAttribute("data-doc-id");
				if (id != null) applyBatchRowState(rowEl, docBatchSelectedIds.has(id));
			}
			docBatchUiSync?.();
		});
		const batchDeleteBtn = batchRow.createEl("button", {
			cls: "marinmind-home-cards-review marinmind-home-batch-delete",
			text: t("删除"),
			attr: { type: "button", title: t("删除全部已勾选文档的记录（书籍文件保留）") },
		});
		batchDeleteBtn.addEventListener("click", () => {
			const ids = [...docBatchSelectedIds];
			if (ids.length === 0) return;
			const picked = ids
				.map((id) => plugin.documents.get(id))
				.filter((d): d is BookDocument => d != null); // 活取防批选期间外部删除
			if (picked.length === 0) return;
			confirmDeleteDocuments(plugin.app, plugin, picked, () => {
				clearDocBatchSelection();
				ctx.refresh(); // 左列树计数随整页重渲染同步
			});
		});
		const batchMoveBtn = batchRow.createEl("button", {
			cls: "marinmind-home-cards-review",
			text: t("移动分类"),
			attr: { type: "button", title: t("移动全部已勾选文档到其他分类") },
		});
		batchMoveBtn.addEventListener("click", () => {
			if (docBatchSelectedIds.size === 0) return;
			new CategoryAssignModal(plugin.app, plugin, docBatchSelectedIds.size, (item) => {
				// 移动落地：活取逐本判活，目标归一后与当前一致的本跳过（防无谓写盘，
				// 镜像 renameCategory 的 cur===category 守卫）
				const apply = (category: string | null): void => {
					let moved = 0;
					for (const id of docBatchSelectedIds) {
						const d = plugin.documents.get(id);
						if (!d) continue;
						const cur = d.category ? normalizeCategory(d.category) : null;
						if (cur === category) continue;
						plugin.documents.update(id, { category });
						moved++;
					}
					new Notice(
						moved > 0
							? `已移动 ${moved} 本到「${category ?? "未分类"}」`
							: "所选文档已在该分类",
					);
					clearDocBatchSelection();
					ctx.refresh(); // 左列分类树计数随整页重渲染同步
				};
				if (item.kind === "category") {
					apply(item.path);
				} else if (item.kind === "remove") {
					apply(null);
				} else {
					// 新建分类：promptPathName 输入 + 显式清单持久化（不 setSelectedCategory
					// 跳视图——批量管理上下文里用户可能继续操作，与单本右键有意不同）
					promptPathName(
						plugin.app,
						{
							title: t("新建分类"),
							placeholder: t("分类名称（支持多层，如：学习/英语）"),
						},
						(normalized) => {
							plugin.store?.addFolder(normalized);
							apply(normalized);
						},
					);
				}
			}).open();
		});
		// 就地同步器（闭包实时重算 filtered——ctx getter 是活值；局部刷新 rerenderList
		// 不重建本行，搜索/切视图后计数与按钮态靠它保持真）
		docBatchUiSync = () => {
			const fresh = filterDocsByQuery(
				filterDocsByCategory(plugin.documents.list(), ctx.selectedCategory),
				ctx.docQuery,
			);
			countEl.setText(
				docBatchSelectMode
					? `已选 ${docBatchSelectedIds.size} / ${fresh.length} 本`
					: `${fresh.length} 本`,
			);
			const allIn = fresh.length > 0 && fresh.every((d) => docBatchSelectedIds.has(d.id));
			selectAllBtn.setText(allIn ? "取消全选" : "全选");
			selectAllBtn.classList.toggle("is-disabled", fresh.length === 0);
			selectAllBtn.setAttribute("aria-disabled", String(fresh.length === 0));
			const n = docBatchSelectedIds.size;
			batchDeleteBtn.setText(`删除 ${n} 本`);
			batchDeleteBtn.classList.toggle("is-disabled", n === 0);
			batchDeleteBtn.setAttribute("aria-disabled", String(n === 0));
			batchMoveBtn.setText(`移动分类 ${n} 本`);
			batchMoveBtn.classList.toggle("is-disabled", n === 0);
			batchMoveBtn.setAttribute("aria-disabled", String(n === 0));
		};
		docBatchUiSync();
	} else {
		docBatchUiSync = null;
	}
	const rowsHost = listWrap.createDiv(); // 列表宿主（批量行之后，位于搜索行与列表之间）

	const rerenderList = async (): Promise<void> => {
		gridCoverObserver?.disconnect(); // 127：上一轮视口观察器随列表重建失效
		gridCoverObserver = null;
		const fresh = plugin.documents.list();
		// ㊾ 批选存活修剪：选择只经本页操作产生，外部删书后残留 id 清掉（计数不失真）
		if (docBatchSelectedIds.size > 0) {
			const alive = new Set(fresh.map((d) => d.id));
			for (const id of [...docBatchSelectedIds]) {
				if (!alive.has(id)) docBatchSelectedIds.delete(id);
			}
		}
		const inCategory = filterDocsByCategory(fresh, ctx.selectedCategory);
		const filtered = filterDocsByQuery(inCategory, ctx.docQuery);
		rowsHost.empty();
		if (filtered.length === 0) {
			if (inCategory.length === 0) {
				emptyHint(
					rowsHost,
					ctx.selectedCategory === "all"
						? "书库为空——点「打开文档」加入第一本书。"
						: "该分类下暂无文档（右键文档或拖拽到左侧文件夹可归入）。",
				);
			} else {
				emptyHint(rowsHost, `没有匹配「${ctx.docQuery.trim()}」的文档。`);
			}
			docBatchUiSync?.(); // ㊾ 空态提前返回也要同步计数与按钮态（"0 / 0 本"）
			return;
		}
		const presences = await Promise.all(
			filtered.map((doc) => resolveDocPresence(plugin.app, doc.filePath)),
		);
		const ts = now();
		if (plugin.settings.homeDocsView === "grid") {
			// 127 视口惰性：占位瓷片滚入视口（rootMargin 预载一屏）才入队渲染——
			// 书库数百本不再首屏一次性排队；LRU 缓存/在途单飞语义不变，只改「何时发起」
			const grid = rowsHost.createDiv({ cls: "marinmind-home-doc-grid" });
			const pending: { doc: BookDocument; cover: HTMLElement; img: HTMLImageElement }[] = [];
			filtered.forEach((doc, i) => {
				const entry = renderDocTile(grid, ctx, doc, presences[i], ts);
				if (entry) {
					pending.push(entry);
				}
			});
			// 并发 ≤ 3；getDocCover 契约永不 reject、DOM 段不抛——mapLimit「任一
			// fn 抛错整批 reject」的顾虑在队列层同样自吞（createLazyQueue 防御）
			type TileEntry = { doc: BookDocument; cover: HTMLElement; img: HTMLImageElement };
			const queue = createLazyQueue<TileEntry>(3, async (e) => {
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
			const byCover = new Map<Element, TileEntry>(pending.map((e) => [e.cover, e]));
			const io = new IntersectionObserver(
				(entries) => {
					for (const en of entries) {
						if (!en.isIntersecting) continue;
						io.unobserve(en.target); // 每瓷片只入队一次
						const e = byCover.get(en.target);
						if (e) queue.add(e);
					}
				},
				// 滚动容器 = 主页内容区（.marinmind-home-content overflow-y:auto）；
				// 结构变化时 closest 落空回退视口根（祖先裁剪仍被计算，仅预载边距参照不同）
				{ root: grid.closest(".marinmind-home-content"), rootMargin: "240px" },
			);
			gridCoverObserver = io; // 局部/整页重建前 disconnect（见 rerenderList 开头）
			for (const e of pending) io.observe(e.cover);
		} else {
			const list = rowsHost.createDiv({ cls: "marinmind-home-rows" });
			filtered.forEach((doc, i) => {
				renderDocRow(list, ctx, doc, presences[i], ts);
			});
		}
		docBatchUiSync?.(); // ㊾ 局部刷新不重建批量行，末尾同步计数与按钮态
	};
	// ㊵ 切换条高亮同步：按当前设置挂 is-active（整页重渲染后亦然）
	const syncToggle = (): void => {
		const grid = plugin.settings.homeDocsView === "grid";
		listBtn.classList.toggle("is-active", !grid);
		gridBtn.classList.toggle("is-active", grid);
		// R3（W-12）：选中态同步 aria-pressed（镜像阅读器工具行先例）
		listBtn.setAttribute("aria-pressed", String(!grid));
		gridBtn.setAttribute("aria-pressed", String(grid));
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
		// ㊾ 搜索变化只清选择集、保留批选模式（整清模式会让不重建的开关钮 is-active
		// 与无勾选框的行并存——UI 自相矛盾；清集已足以防"滤出视图的选中项被误删"）
		docBatchSelectedIds.clear();
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
		{ sel: "all", label: t("全部"), count: tree.all, icon: "library" },
		{ sel: null, label: t("未分类"), count: tree.uncategorized, icon: "file" },
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

	const createBtn = folders.createDiv({
		cls: "marinmind-home-folder-create",
		text: t("＋ 新建分类"),
	});
	createBtn.addEventListener("click", () => promptNewCategory(ctx));
	enableKeyboardActivation(createBtn);
}

/** 用户手动折叠过的分类/卡组节点 key（127 会话态不持久化；key = fullName 唯一路径，
 *  默认全展开，重开主页/重启回全展开——镜像阅读器 tocCollapsedKeys 先例） */
const folderCollapsedKeys = new Set<string>();
const deckCollapsedKeys = new Set<string>();

/** 树节点折叠钮接线（127）：键盘可达 + click/keydown 双向 stopPropagation——
 *  行 click 有实质语义（选中分类/卡组），与阅读器 TOC 先例（行 click 无冲突）的关键差异 */
function wireTreeChevron(chev: HTMLElement, toggle: () => void): void {
	chev.setAttribute("role", "button");
	chev.tabIndex = 0;
	chev.setAttribute("aria-label", "展开/折叠");
	chev.addEventListener("click", (evt) => {
		evt.stopPropagation();
		toggle();
	});
	chev.addEventListener("keydown", (evt) => {
		if (evt.key !== "Enter" && evt.key !== " ") return;
		evt.preventDefault();
		evt.stopPropagation(); // 防冒泡触发行键盘激活（行 Enter = 选中分类/卡组）
		toggle();
	});
}

/** 折叠开关动作：翻转子级容器显隐 + 图标 + aria + 会话态 key 集 */
function toggleTreeCollapse(
	chev: HTMLElement,
	kids: HTMLElement,
	keys: Set<string>,
	key: string,
): void {
	const collapsed = kids.classList.toggle("is-collapsed");
	setIcon(chev, collapsed ? "chevron-right" : "chevron-down");
	chev.setAttribute("aria-expanded", String(!collapsed));
	if (collapsed) keys.add(key);
	else keys.delete(key);
}

/** 递归渲染分类树节点（127 节点级折叠：chevron 开关 + 子级 kids 容器承担缩进；
 *  行内 paddingLeft 恒定 8px，层级缩进改嵌套式——镜像阅读器目录先例） */
function renderFolderNode(
	container: HTMLElement,
	ctx: HomeRenderCtx,
	node: CategoryNode,
	docs: readonly BookDocument[],
	depth: number,
): void {
	const isActive = ctx.selectedCategory === node.fullName;
	const open = !folderCollapsedKeys.has(node.fullName);
	const entry = container.createDiv({
		cls: `marinmind-home-folder marinmind-home-folder-nested${isActive ? " is-active" : ""}`,
		// 74 可达性：重命名/删除入口由右键（移动端长按）承载，hover 提示降低发现门槛
		attr: { title: t("右键或长按：重命名 / 删除") },
	});
	// DOM 序：行在前、子级容器随后（chevron 闭包引用，先建后接线）
	const kids =
		node.children.length > 0
			? container.createDiv({ cls: "marinmind-home-folder-kids" })
			: null;
	if (kids) {
		kids.classList.toggle("is-collapsed", !open);
		kids.classList.toggle("is-max", depth >= 6); // 超深截断缩进（R2 挂账顺带消化）
	}
	entry.setCssStyles({ paddingLeft: "8px" });
	entry.addEventListener("click", () => ctx.setSelectedCategory(node.fullName));
	entry.addEventListener("contextmenu", (evt) => {
		evt.preventDefault();
		showFolderMenu(ctx, node, docs, evt);
	});
	enableKeyboardActivation(entry);
	enableFolderDrop(entry, ctx, node.fullName);
	if (kids) {
		const chev = entry.createDiv({ cls: "marinmind-home-folder-chev" });
		setIcon(chev, open ? "chevron-down" : "chevron-right");
		chev.setAttribute("aria-expanded", String(open));
		wireTreeChevron(chev, () =>
			toggleTreeCollapse(chev, kids, folderCollapsedKeys, node.fullName),
		);
	} else {
		// 叶子占位（保持与有子级条目的图标列对齐，镜像 TOC is-leaf）
		entry.createDiv({ cls: "marinmind-home-folder-chev is-leaf" });
	}
	const iconEl = entry.createSpan({ cls: "marinmind-home-folder-icon" });
	setIcon(iconEl, "folder");
	entry.createSpan({ cls: "marinmind-home-folder-label", text: node.name });
	entry.createSpan({ cls: "marinmind-home-folder-count", text: String(node.total) });
	for (const child of node.children) renderFolderNode(kids!, ctx, child, docs, depth + 1);
}

/** 新建分类：写入显式清单持久保留（76——空分类重开主页/重启仍在树上）；支持多层路径 */
function promptNewCategory(ctx: HomeRenderCtx): void {
	promptPathName(
		ctx.plugin.app,
		{ title: t("新建分类"), placeholder: t("分类名称（支持多层，如：学习/英语）") },
		(normalized) => {
			ctx.plugin.store?.addFolder(normalized);
			ctx.setSelectedCategory(normalized);
		},
	);
}

/** 分类文件夹右键菜单：重命名（级联子路径）/ 删除（子树文档移入未分类） */
function showFolderMenu(
	ctx: HomeRenderCtx,
	node: CategoryNode,
	docs: readonly BookDocument[],
	evt: MouseEvent,
): void {
	const category = node.fullName;
	const menu = new Menu();
	menu.addItem((item) =>
		item
			.setTitle(t("重命名分类"))
			.setIcon("pencil")
			.onClick(() => {
				promptPathName(
					ctx.plugin.app,
					{ title: t("重命名分类"), initialText: category },
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
			.setTitle(t("删除分类"))
			.setIcon("trash-2")
			.onClick(() => {
				// 子树 = 该分类本身 + 多层子孙路径下的全部文档
				const victims = docs.filter((d) => {
					const c = d.category ? normalizeCategory(d.category) : null;
					return c !== null && inPathSubtree(c, category);
				});
				// 76 清单内是否仍有子分类（空分组实体的"纯空组"判定另一半）
				const hasChildren =
					ctx.plugin.store?.groupListHasChildren("folders", category) ?? false;
				const doDelete = (): void => {
					for (const d of victims) {
						ctx.plugin.documents.update(d.id, { category: null });
					}
					// 76 清单子树一并删（空分组实体本体在清单里）
					ctx.plugin.store?.removeFoldersUnder(category);
					if (
						typeof ctx.selectedCategory === "string" &&
						inPathSubtree(ctx.selectedCategory, category)
					) {
						ctx.setSelectedCategory("all");
					} else {
						ctx.refresh();
					}
					new Notice(`已删除分类「${category}」`);
				};
				// 纯空组（无文档且清单内无子分类）：无破坏性，直接删免确认
				if (victims.length === 0 && !hasChildren) {
					doDelete();
					return;
				}
				new ConfirmModal(
					ctx.plugin.app,
					"删除分类",
					`删除分类「${category}」后，其下 ${victims.length} 个文档（含子分类）将移入「未分类」，子分类一并删除（文档与卡片不受影响）。继续？`,
					doDelete,
				).open();
			}),
	);
	menu.showAtMouseEvent(evt);
}

/**
 * 重命名分类：级联子路径（「学习」→「study」时「学习/英语」→「study/英语」，
 * 不级联会产生两棵分裂子树）。批量更新（每文件一次防抖写）。
 * 76 起清单内路径前缀级联同改（空分类/空子分类实体在清单里），文档有无统一走
 * 同一逻辑（0 文档时空转无害）。
 */
function renameCategory(ctx: HomeRenderCtx, oldName: string, newName: string): void {
	const docs = ctx.plugin.documents.list().filter((d) => {
		const c = d.category ? normalizeCategory(d.category) : null;
		return c !== null && inPathSubtree(c, oldName);
	});
	ctx.plugin.store?.renameFoldersPrefix(oldName, newName);
	for (const d of docs) {
		// 写回归一值（顺手收敛手编产生的空白变体）
		const c = normalizeCategory(d.category!)!;
		ctx.plugin.documents.update(d.id, {
			category: c === oldName ? newName : newName + c.slice(oldName.length),
		});
	}
	if (typeof ctx.selectedCategory === "string" && inPathSubtree(ctx.selectedCategory, oldName)) {
		ctx.setSelectedCategory(newName + ctx.selectedCategory.slice(oldName.length));
	} else {
		ctx.refresh();
	}
	new Notice(`已重命名分类「${oldName}」→「${newName}」（${docs.length} 个文档）`);
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

/** 文档行：标题/路径/徽标/卡数/时间 + 点击打开 + 右键归档菜单 + 拖拽归档源；
 *  ㊾ 批选模式 = 行首纯视觉 checkbox + 点击勾选（镜像卡片行批分支） */
function renderDocRow(
	list: HTMLElement,
	ctx: HomeRenderCtx,
	doc: BookDocument,
	presence: DocPresence,
	ts: number,
): void {
	const { plugin } = ctx;
	const batch = docBatchSelectMode;
	const selected = batch && docBatchSelectedIds.has(doc.id);
	const row = list.createDiv({
		cls: `marinmind-home-row is-clickable marinmind-home-doc-row${selected ? " is-batch-selected" : ""}`,
		attr: batch ? { "data-doc-id": doc.id } : {},
	});
	if (batch) {
		// checkbox 纯视觉（pointer-events:none）且为行直接子元素——applyBatchRowState
		// 的 `:scope >` 选择器依赖（行 click 单一交互源，防冒泡双 toggle）
		const box = row.createEl("input", {
			cls: "marinmind-home-batch-check",
			type: "checkbox",
		}) as HTMLInputElement;
		box.checked = selected;
		box.setAttribute("aria-hidden", "true"); // 行本身已是 checkbox 角色，内嵌框不重复报读
	}
	const main = row.createDiv({ cls: "marinmind-home-row-main" });
	main.createDiv({ cls: "marinmind-home-row-title", text: doc.title });
	main.createDiv({ cls: "marinmind-home-row-sub", text: doc.filePath });
	presenceBadge(row, presence);
	if (doc.category) {
		row.createDiv({ cls: "marinmind-doc-badge", text: doc.category });
	}
	// 163 作者前缀（元数据来自 epub dc:creator / mobi EXTH 100；长名 24 字截断）
	const author = doc.author
		? `${doc.author.slice(0, 24)}${doc.author.length > 24 ? "…" : ""} · `
		: "";
	row.createDiv({
		cls: "marinmind-home-row-meta",
		text: `${author}${plugin.cards.count(doc.id)} 卡 · ${formatRelativeTime(doc.updatedAt, ts)}`,
	});
	if (batch) {
		wireDocBatchInteractions(row, doc, selected);
	} else {
		bindDocActions(row, ctx, doc);
	}
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

/** ㊾ 批选模式交互绑定（行/瓷片共用）：点击勾选、不开/不右键/不拖拽，键盘可达 + checkbox 语义 */
function wireDocBatchInteractions(el: HTMLElement, doc: BookDocument, selected: boolean): void {
	el.addEventListener("click", () => toggleDocBatchSelected(doc.id, el));
	enableKeyboardActivation(el);
	// 键盘可达基类挂的是 role=button，批选覆写为 checkbox 语义（Enter/Space 走同一 click）
	el.setAttribute("role", "checkbox");
	el.setAttribute("aria-checked", String(selected));
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
	const batch = docBatchSelectMode;
	const selected = batch && docBatchSelectedIds.has(doc.id);
	const tile = grid.createDiv({
		cls: `marinmind-home-doc-tile is-clickable${selected ? " is-batch-selected" : ""}`,
		attr: batch ? { "data-doc-id": doc.id } : {},
	});
	if (batch) {
		// checkbox 叠放封面左上角（绝对定位见 CSS）：必须是 tile 直接子元素——
		// applyBatchRowState 的 `:scope >` 选择器依赖（嵌进 cover 会被裁剪且选择器落空）
		const box = tile.createEl("input", {
			cls: "marinmind-home-batch-check",
			type: "checkbox",
		}) as HTMLInputElement;
		box.checked = selected;
		box.setAttribute("aria-hidden", "true");
	}
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
	if (batch) {
		wireDocBatchInteractions(tile, doc, selected); // ㊾ 批选：勾选交互替代打开/右键/拖拽
	} else {
		bindDocActions(tile, ctx, doc);
	}
	if (presence !== "ok" && presence !== "external-ok") {
		// 失联 / 移动端库外（external-unknown 读不了文件）：不排队，直接占位
		cover.removeClass("is-loading");
		setIcon(cover.createSpan({ cls: "marinmind-home-tile-fallback" }), "file");
		return null;
	}
	return { doc, cover, img };
}

/** 文档行右键菜单：打开 / 归入分类（扁平项）/ 移入未分类 / 文档管理 / 删除文档 */
function showDocMenu(ctx: HomeRenderCtx, doc: BookDocument, evt: MouseEvent): void {
	const { plugin } = ctx;
	const menu = new Menu();
	menu.addItem((item) =>
		item
			.setTitle(t("打开"))
			.setIcon("book-open")
			.onClick(() => void openDocRecord(plugin.app, plugin, doc)),
	);
	// ㊳ 一键复制入库（仅桌面库外文档）：复制到 vault 根并改道记录（备份可打包、跨机器不失联）
	if (isAbsoluteFsPath(doc.filePath) && Platform.isDesktopApp) {
		menu.addItem((item) =>
			item
				.setTitle(t("复制入库"))
				.setIcon("copy-plus")
				.onClick(
					() =>
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
	// 归入分类：多层树扁平化为全路径文本（obsidian Menu 无 addSubMenu，只能扁平项）；
	// 76 显式清单一并进树——新建的空分类立刻出现在归入菜单
	const tree = buildCategoryTree(plugin.documents.list(), plugin.store?.getFolders() ?? []);
	const paths = flattenCategoryTree(tree.roots);
	menu.addItem((item) => item.setTitle(t("归入分类：")).setDisabled(true));
	if (paths.length === 0) {
		menu.addItem((item) => item.setTitle(t("（暂无分类）")).setDisabled(true));
	}
	const cur = doc.category ? normalizeCategory(doc.category) : null;
	for (const p of paths) {
		if (p === cur) continue; // 已在该分类
		// R2（E2-12）：Obsidian Menu 不截断长文本，分类路径上限 120 字符会撑爆
		// 菜单宽——显示层 40 字截断（比 30 字基线宽，保留层级语义可辨），
		// onClick 仍用完整路径
		const pBrief = p.length > 40 ? `${p.slice(0, 40)}…` : p;
		menu.addItem((item) =>
			item
				.setTitle(pBrief)
				.setIcon("folder")
				.onClick(() => {
					plugin.documents.update(doc.id, { category: p });
					ctx.refresh();
					new Notice(`已归入「${p}」`);
				}),
		);
	}
	menu.addItem((item) =>
		item
			.setTitle(t("新建分类并归入…"))
			.setIcon("folder-plus")
			.onClick(() => {
				promptPathName(
					plugin.app,
					{ title: t("新建分类"), placeholder: t("分类名称（支持多层，如：学习/英语）") },
					(normalized) => {
						plugin.store?.addFolder(normalized); // 76 显式清单：创建即持久
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
				.setTitle(t("移入未分类"))
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
			.setTitle(t("文档管理…"))
			.setIcon("settings-2")
			.onClick(() => new DocumentManagerModal(plugin.app, plugin).open()),
	);
	// 删除文档：仅删 MarinMind 记录（卡片/附件/脑图关联/数据文件），书籍文件保留；
	// 与文档管理弹窗「删除记录」单源共享（doc-delete.ts）。危险操作置菜单最末（项目惯例）
	menu.addItem((item) =>
		item
			.setTitle(t("删除文档…"))
			.setIcon("trash-2")
			.onClick(() => confirmDeleteDocument(plugin.app, plugin, doc, () => ctx.refresh())),
	);
	menu.showAtMouseEvent(evt);
}

// ---------------------------------------------------------------------------
// 卡片页
// ---------------------------------------------------------------------------

/** 卡片页每页条数（与 recent 列表同量级） */
const CARDS_PAGE_SIZE = 50;

// ---------------------------------------------------------------------------
// 卡组树（73：镜像文档页文件夹树全套机制——树/拖拽/右键/前缀级联/空组本地注入）
// ---------------------------------------------------------------------------

/** 左列卡组树：全部/未分组 + 多层卡组树（段级缩进）+ 新建卡组入口 */
function renderDeckTree(
	folders: HTMLElement,
	ctx: HomeRenderCtx,
	tree: CategoryTree,
	cards: readonly Card[],
): void {
	folders.empty();
	// 固定项：deck 筛选三态——null=全部 / UNSET_DECK 哨兵=未分组 / 路径=归一子树匹配
	// （未分组用 inbox：layers 已被侧栏「卡片」导航占用，语义撞车走 E-19 同款审查）
	const fixed: { deck: string | null; label: string; count: number; icon: string }[] = [
		{ deck: null, label: t("全部"), count: tree.all, icon: "library" },
		{ deck: UNSET_DECK, label: t("未分组"), count: tree.uncategorized, icon: "inbox" },
	];
	for (const item of fixed) {
		const isActive = ctx.cardsFilter.deck === item.deck;
		const entry = folders.createDiv({
			cls: `marinmind-home-folder${isActive ? " is-active" : ""}`,
		});
		entry.addEventListener("click", () => ctx.setCardsFilter({ deck: item.deck }));
		enableKeyboardActivation(entry);
		// 未分组可作拖放目标（deck 置 null 移出；全部是全局视图无归组语义不挂）
		if (item.deck !== null) enableDeckDrop(entry, ctx, null);
		const iconEl = entry.createSpan({ cls: "marinmind-home-folder-icon" });
		setIcon(iconEl, item.icon);
		entry.createSpan({ cls: "marinmind-home-folder-label", text: item.label });
		entry.createSpan({ cls: "marinmind-home-folder-count", text: String(item.count) });
	}

	// 本地新建的空卡组注入树（未写库也可选中/作拖放目标）；哨兵先剥防长出假节点（73 坑 B）
	const roots = injectCategoryPath(tree.roots, activeDeckPath(ctx.cardsFilter.deck));
	for (const node of roots) renderDeckNode(folders, ctx, node, cards, 0);

	const createBtn = folders.createDiv({
		cls: "marinmind-home-folder-create",
		text: t("＋ 新建卡组"),
	});
	createBtn.addEventListener("click", () => promptNewDeck(ctx));
	enableKeyboardActivation(createBtn);
}

/** 递归渲染卡组树节点（127 节点级折叠：与分类树同构；count 徽标 = total 含子孙） */
function renderDeckNode(
	container: HTMLElement,
	ctx: HomeRenderCtx,
	node: CategoryNode,
	cards: readonly Card[],
	depth: number,
): void {
	const isActive = ctx.cardsFilter.deck === node.fullName;
	const open = !deckCollapsedKeys.has(node.fullName);
	const entry = container.createDiv({
		cls: `marinmind-home-folder marinmind-home-folder-nested${isActive ? " is-active" : ""}`,
		// 74 可达性：重命名/删除入口由右键（移动端长按）承载，hover 提示降低发现门槛
		attr: { title: t("右键或长按：重命名 / 删除") },
	});
	const kids =
		node.children.length > 0
			? container.createDiv({ cls: "marinmind-home-folder-kids" })
			: null;
	if (kids) {
		kids.classList.toggle("is-collapsed", !open);
		kids.classList.toggle("is-max", depth >= 6);
	}
	entry.setCssStyles({ paddingLeft: "8px" });
	entry.addEventListener("click", () => ctx.setCardsFilter({ deck: node.fullName }));
	entry.addEventListener("contextmenu", (evt) => {
		evt.preventDefault();
		showDeckMenu(ctx, node, cards, evt);
	});
	enableKeyboardActivation(entry);
	enableDeckDrop(entry, ctx, node.fullName);
	if (kids) {
		const chev = entry.createDiv({ cls: "marinmind-home-folder-chev" });
		setIcon(chev, open ? "chevron-down" : "chevron-right");
		chev.setAttribute("aria-expanded", String(open));
		wireTreeChevron(chev, () =>
			toggleTreeCollapse(chev, kids, deckCollapsedKeys, node.fullName),
		);
	} else {
		entry.createDiv({ cls: "marinmind-home-folder-chev is-leaf" });
	}
	const iconEl = entry.createSpan({ cls: "marinmind-home-folder-icon" });
	setIcon(iconEl, "folder");
	entry.createSpan({ cls: "marinmind-home-folder-label", text: node.name });
	entry.createSpan({ cls: "marinmind-home-folder-count", text: String(node.total) });
	for (const child of node.children) renderDeckNode(kids!, ctx, child, cards, depth + 1);
}

/** 新建卡组：写入显式清单持久保留（76——镜像空分类先例）；支持多层路径 */
function promptNewDeck(ctx: HomeRenderCtx): void {
	promptPathName(
		ctx.plugin.app,
		{ title: t("新建卡组"), placeholder: t("卡组名称（支持多层，如：学习/英语）") },
		(normalized) => {
			ctx.plugin.store?.addDeck(normalized);
			ctx.setCardsFilter({ deck: normalized });
		},
	);
}

/** 卡组右键菜单：重命名（级联子路径）/ 删除（子树卡片移出卡组，卡片本身不受影响） */
function showDeckMenu(
	ctx: HomeRenderCtx,
	node: CategoryNode,
	cards: readonly Card[],
	evt: MouseEvent,
): void {
	const deck = node.fullName;
	const menu = new Menu();
	menu.addItem((item) =>
		item
			.setTitle(t("重命名卡组"))
			.setIcon("pencil")
			.onClick(() => {
				promptPathName(
					ctx.plugin.app,
					{ title: t("重命名卡组"), initialText: deck },
					(normalized) => {
						if (normalized === deck) return;
						renameDeck(ctx, deck, normalized);
					},
				);
			}),
	);
	menu.addSeparator();
	menu.addItem((item) =>
		item
			.setTitle(t("删除卡组"))
			.setIcon("trash-2")
			.onClick(() => {
				// 子树 = 该卡组本身 + 多层子孙路径下的全部卡片
				const victims = cards.filter((c) => {
					const d = c.deck ? normalizeCategory(c.deck) : null;
					return d !== null && inPathSubtree(d, deck);
				});
				// 76 清单内是否仍有子卡组（"纯空组"判定另一半）
				const hasChildren = ctx.plugin.store?.groupListHasChildren("decks", deck) ?? false;
				const doDelete = (): void => {
					for (const c of victims) {
						ctx.plugin.cards.update(c.id, { deck: null });
					}
					// 76 清单子树一并删（空卡组实体本体在清单里）
					ctx.plugin.store?.removeDecksUnder(deck);
					// 选中在子树内回「全部」，否则仅刷新（树计数收缩）
					const sel = ctx.cardsFilter.deck;
					if (typeof sel === "string" && sel !== UNSET_DECK && inPathSubtree(sel, deck)) {
						ctx.setCardsFilter({ deck: null });
					} else {
						ctx.refresh();
					}
					new Notice(`已删除卡组「${deck}」`);
				};
				// 纯空组（无卡片且清单内无子卡组）：无破坏性，直接删免确认
				if (victims.length === 0 && !hasChildren) {
					doDelete();
					return;
				}
				new ConfirmModal(
					ctx.plugin.app,
					"删除卡组",
					`删除卡组「${deck}」后，其下 ${victims.length} 张卡片（含子卡组）将移出卡组，子卡组一并删除（卡片本身不受影响）。继续？`,
					doDelete,
				).open();
			}),
	);
	menu.showAtMouseEvent(evt);
}

/**
 * 重命名卡组：级联子路径（「学习」→「study」时「学习/英语」→「study/英语」，
 * 不级联会分裂两棵子树）。批量更新写回归一值（列表刷新与树收缩由 cardBus
 * 100ms 尾随防抖回环合并承接）。76 起清单内路径前缀级联同改，卡片有无统一走
 * 同一逻辑（0 张时空转无害）。
 */
function renameDeck(ctx: HomeRenderCtx, oldName: string, newName: string): void {
	const victims = ctx.plugin.cards.listAll().filter((c) => {
		const d = c.deck ? normalizeCategory(c.deck) : null;
		return d !== null && inPathSubtree(d, oldName);
	});
	ctx.plugin.store?.renameDecksPrefix(oldName, newName);
	for (const c of victims) {
		// 写回归一值（顺手收敛存量空白变体）
		const d = normalizeCategory(c.deck!)!;
		ctx.plugin.cards.update(c.id, {
			deck: d === oldName ? newName : newName + d.slice(oldName.length),
		});
	}
	// 选中态级联跟随（子树内的选中改指对应新路径），子树外仅刷新
	const sel = ctx.cardsFilter.deck;
	if (typeof sel === "string" && sel !== UNSET_DECK && inPathSubtree(sel, oldName)) {
		ctx.setCardsFilter({ deck: newName + sel.slice(oldName.length) });
	} else {
		ctx.refresh();
	}
	new Notice(`已重命名卡组「${oldName}」→「${newName}」（${victims.length} 张卡片）`);
}

// ---- 卡片拖拽归组（73：镜像文档拖拽归档——卡片行 → 左列卡组；与右键菜单并存） ----

/** 当前拖拽中的卡片 id（dragstart 写入 / dragend 清空；drop 优先取此值，dataTransfer 兜底） */
let draggingCardId: string | null = null;

/** 卡片行启用拖拽源（dataTransfer 需有数据 Firefox 才启动；实际取值走闭包/模块态） */
function enableCardDrag(row: HTMLElement, card: Card): void {
	row.draggable = true;
	row.addEventListener("dragstart", (evt) => {
		draggingCardId = card.id;
		evt.dataTransfer?.setData("text/plain", card.id);
		if (evt.dataTransfer) evt.dataTransfer.effectAllowed = "move";
		row.addClass("is-dragging");
	});
	row.addEventListener("dragend", () => {
		draggingCardId = null;
		row.removeClass("is-dragging");
	});
}

/** 卡组行启用拖放目标（dragover 高亮 + drop 归入；deck null = 移出卡组） */
function enableDeckDrop(entry: HTMLElement, ctx: HomeRenderCtx, deck: string | null): void {
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
		const cardId = draggingCardId ?? evt.dataTransfer?.getData("text/plain") ?? "";
		if (!cardId) return;
		// 查错仓储（文档 id 误落卡组）得 undefined 早退——两页不同时渲染，纯防御
		const target = ctx.plugin.cards.get(cardId);
		if (!target) return;
		const cur = target.deck ? normalizeCategory(target.deck) : null;
		if (cur === deck) return; // 已在该卡组（等价跳过不写盘；归一后比较变体也识别）
		ctx.plugin.cards.update(cardId, { deck });
		ctx.refresh();
		new Notice(deck === null ? "已移出卡组" : `已归入「${deck}」`);
	});
}

/** 卡片行右键菜单：归入卡组（扁平项）/ 新建卡组并归入 / 移出卡组（镜像文档右键归档区） */
function showCardMenu(ctx: HomeRenderCtx, card: Card, evt: MouseEvent): void {
	const { plugin } = ctx;
	const menu = new Menu();
	// 多层卡组树扁平化为全路径文本（obsidian Menu 无 addSubMenu，只能扁平项）；
	// 76 显式清单一并进树——新建的空卡组立刻出现在归入菜单
	const tree = buildDeckTree(plugin.cards.listAll(), plugin.store?.getDecks() ?? []);
	const paths = flattenCategoryTree(tree.roots);
	menu.addItem((item) => item.setTitle(t("归入卡组：")).setDisabled(true));
	if (paths.length === 0) {
		menu.addItem((item) => item.setTitle(t("（暂无卡组）")).setDisabled(true));
	}
	const cur = card.deck ? normalizeCategory(card.deck) : null;
	for (const p of paths) {
		if (p === cur) continue; // 已在该卡组
		// 显示层 40 字截断（镜像文档菜单先例），onClick 仍用完整路径
		const pBrief = p.length > 40 ? `${p.slice(0, 40)}…` : p;
		menu.addItem((item) =>
			item
				.setTitle(pBrief)
				.setIcon("folder")
				.onClick(() => {
					plugin.cards.update(card.id, { deck: p });
					ctx.refresh();
					new Notice(`已归入「${p}」`);
				}),
		);
	}
	menu.addItem((item) =>
		item
			.setTitle(t("新建卡组并归入…"))
			.setIcon("folder-plus")
			.onClick(() => {
				promptPathName(
					plugin.app,
					{ title: t("新建卡组"), placeholder: t("卡组名称（支持多层，如：学习/英语）") },
					(normalized) => {
						plugin.store?.addDeck(normalized); // 76 显式清单：创建即持久
						plugin.cards.update(card.id, { deck: normalized });
						ctx.setCardsFilter({ deck: normalized }); // 选中跳到新组即时可见
						new Notice(`已归入「${normalized}」`);
					},
				);
			}),
	);
	if (card.deck) {
		menu.addItem((item) =>
			item
				.setTitle(t("移出卡组"))
				.setIcon("file-minus")
				.onClick(() => {
					plugin.cards.update(card.id, { deck: null });
					ctx.refresh();
				}),
		);
	}
	menu.showAtMouseEvent(evt);
}

// ---- 卡片批量删除（74：模块态镜像 draggingCardId 先例；home-view 两钩子清态） ----

/** 批选模式开关（仅卡片页右列生效；概览页 renderCardRows 无 ctx 不受影响） */
let batchSelectMode = false;
/** 已勾选卡片 id（唯一权威：整页重渲染由 set 恢复勾选态，DOM 就地更新只是快捷路径） */
const batchSelectedIds = new Set<string>();
/** 批选 UI 就地同步器（renderCardsPage 渲染时重建；行勾选/全选本页后调用，不整页重建） */
let batchUiSync: (() => void) | null = null;

/** 退出批选并清空选择（home-view 筛选变化/离开卡片页/关视图三钩子调用） */
export function clearBatchSelection(): void {
	batchSelectMode = false;
	batchSelectedIds.clear();
}

/** 批选行就地视觉同步（高亮类/aria/勾选框）——set 为唯一权威，整页重渲染由 set 恢复 */
function applyBatchRowState(row: HTMLElement, on: boolean): void {
	row.classList.toggle("is-batch-selected", on);
	row.setAttribute("aria-checked", String(on));
	const box = row.querySelector(":scope > .marinmind-home-batch-check");
	if (box instanceof HTMLInputElement) box.checked = on;
}

/** 批选行点击：翻转 set + 就地 DOM 更新 + 计数与操作钮文案同步 */
function toggleBatchSelected(cardId: string, row: HTMLElement): void {
	const on = !batchSelectedIds.has(cardId);
	if (on) batchSelectedIds.add(cardId);
	else batchSelectedIds.delete(cardId);
	applyBatchRowState(row, on);
	batchUiSync?.();
}

// ---- 文档批量管理（㊾：模块态镜像卡片批选；行/瓷片双形态，applyBatchRowState 共用） ----

/** 文档批选模式开关（仅文档页右列生效） */
let docBatchSelectMode = false;
/** 已勾选文档 id（唯一权威：整页/局部重渲染由 set 恢复勾选态） */
const docBatchSelectedIds = new Set<string>();
/** 文档批选 UI 就地同步器（renderDocumentsPage 渲染时重建；rerenderList 各出口调用） */
let docBatchUiSync: (() => void) | null = null;

/** 退出文档批选并清空选择（home-view 切页/切分类/关视图钩子调用） */
export function clearDocBatchSelection(): void {
	docBatchSelectMode = false;
	docBatchSelectedIds.clear();
}

/** 文档批选行/瓷片点击：翻转 set + 就地 DOM 更新 + 批量行同步（applyBatchRowState 形状无关共用） */
function toggleDocBatchSelected(docId: string, row: HTMLElement): void {
	const on = !docBatchSelectedIds.has(docId);
	if (on) docBatchSelectedIds.add(docId);
	else docBatchSelectedIds.delete(docId);
	applyBatchRowState(row, on);
	docBatchUiSync?.();
}

/** 卡片行交互绑定（73）：右键归组菜单 + 拖拽归组源（点击/键盘由 renderCardRows 统一接线） */
function bindCardActions(el: HTMLElement, ctx: HomeRenderCtx, card: Card): void {
	el.addEventListener("contextmenu", (evt) => {
		evt.preventDefault();
		showCardMenu(ctx, card, evt);
	});
	enableCardDrag(el, card);
}

/**
 * 卡片页（73 两列化，镜像文档页）：统计砖全宽在前 + 左列卡组树 + 右列四维
 * 筛选（书籍/形态/标签/颜色）与分页列表。点击弹摘录预览；右键/拖拽归组。
 */
export function renderCardsPage(container: HTMLElement, ctx: HomeRenderCtx): void {
	const { plugin } = ctx;
	const wrap = container.createDiv({ cls: "marinmind-home-page marinmind-home-page-cards" });
	wrap.createDiv({ cls: "marinmind-home-page-title", text: t("卡片") });

	const stats = wrap.createDiv({ cls: "marinmind-home-stats" });
	statBrick(stats, plugin.cards.count(), "张卡片");
	statBrick(stats, plugin.reviews.dueCount(), "待复习", () => void plugin.openReview());
	// 69 统计弱链接：热力图/到期分布/连续天数面板（快照渲染，重开即新）
	const statsLink = stats.createEl("button", {
		cls: "marinmind-home-stats-link",
		text: t("统计"),
	});
	statsLink.addEventListener("click", () => new ReviewStatsModal(plugin.app, plugin).open());

	// ---- 两列主体：左列卡组树 + 右列筛选与列表（结构镜像文档页） ----
	const allCards = plugin.cards.listAll();
	// 130 闪卡 id 集：卡上无 isFlashcard 字段，判定源在 ReviewState
	// （plugin.reviews.get(id)?.isFlashcard 是全库既有惯用法；全量遍历一次建集）
	const flashIds = new Set<string>();
	for (const r of plugin.store?.reviews.values() ?? []) {
		if (r.isFlashcard) flashIds.add(r.cardId);
	}
	const body = wrap.createDiv({ cls: "marinmind-home-cards-body" });
	if (plugin.settings.homeCardsFoldersHidden) {
		body.addClass("is-folders-hidden"); // 左列收起态（页内切换就地 toggle 不重建）
	}

	// ---- 左列：卡组树 ----
	const folders = body.createDiv({ cls: "marinmind-home-folders" });
	// 76 显式清单 union：空卡组持久可见（镜像分类树）
	renderDeckTree(folders, ctx, buildDeckTree(allCards, plugin.store?.getDecks() ?? []), allCards);

	// ---- 右列：搜索行 + 筛选行 + 结果列表（doc-list-wrap 为纯结构布局类，两页共用） ----
	const listWrap = body.createDiv({ cls: "marinmind-home-doc-list-wrap" });
	// 139-F 卡片全文搜索：摘录正文（text/OCR）/批注/标签小写包含。
	// 搜索行只在整页渲染时重建；输入仅局部刷新下方结果区（中文 IME 组字不被打断）
	const searchRow = listWrap.createDiv({ cls: "marinmind-home-search-row" });
	const search = searchRow.createEl("input", {
		cls: "marinmind-home-search",
		attr: {
			type: "text",
			placeholder: t("搜索卡片正文、批注或标签…"),
			"aria-label": t("搜索卡片（正文、批注或标签）"),
		},
	});
	search.value = ctx.cardQuery;
	// 筛选行：卡组树栏收起单钮（镜像文档页 panel-left 先例：就地切换不重建 DOM）+
	// 书籍/形态/标签/颜色四下拉（卡组维度 73 起由左列树唯一承载，原卡组下拉删除）
	const filterRow = listWrap.createDiv({ cls: "marinmind-home-cards-filter" });
	const folderToggle = filterRow.createDiv({ cls: "marinmind-home-view-toggle" });
	const folderBtn = folderToggle.createDiv({
		cls: "marinmind-home-view-toggle-btn",
		attr: { "aria-label": t("显示/隐藏卡组栏"), title: t("显示/隐藏卡组栏") },
	});
	setIcon(folderBtn, "panel-left");
	const syncFoldersBtn = (): void => {
		folderBtn.classList.toggle("is-active", !plugin.settings.homeCardsFoldersHidden);
		// R3（W-12）：开合状态同步 aria-pressed（镜像文档页同款）
		folderBtn.setAttribute("aria-pressed", String(!plugin.settings.homeCardsFoldersHidden));
	};
	syncFoldersBtn();
	folderBtn.addEventListener("click", () => {
		plugin.settings.homeCardsFoldersHidden = !plugin.settings.homeCardsFoldersHidden;
		void plugin.saveData({ ...plugin.settings }); // 即时持久化（合并式加载，老 data.json 自动补默认）
		body.classList.toggle("is-folders-hidden", plugin.settings.homeCardsFoldersHidden);
		syncFoldersBtn();
	});
	enableKeyboardActivation(folderBtn);

	// 四下拉（dropdown 走 obsidian 全局类，主页变量覆盖自动跟随深浅主题）
	const docSel = new DropdownComponent(filterRow).addOption("", t("全部书籍"));
	for (const d of plugin.documents.list()) docSel.addOption(d.id, d.title);
	docSel.setValue(ctx.cardsFilter.documentId ?? "");
	docSel.onChange((v) => ctx.setCardsFilter({ documentId: v || null }));

	const typeSel = new DropdownComponent(filterRow).addOption("", t("全部形态"));
	for (const [type, label] of Object.entries(EXCERPT_LABELS)) typeSel.addOption(type, t(label));
	typeSel.setValue(ctx.cardsFilter.excerptType ?? "");
	typeSel.onChange((v) => ctx.setCardsFilter({ excerptType: v || null }));

	const tagSel = new DropdownComponent(filterRow).addOption("", t("全部标签"));
	for (const tag of distinctTags(allCards)) tagSel.addOption(tag, `#${tag}`);
	tagSel.setValue(ctx.cardsFilter.tag ?? "");
	tagSel.onChange((v) => ctx.setCardsFilter({ tag: v || null }));

	// 70 颜色下拉：候选从实际卡片派生（distinctColors 含旧色相与「未设色」哨兵，
	// 不取 settings.excerptColors——那是四工具色配置不是存量卡全集）
	const colorSel = new DropdownComponent(filterRow).addOption("", t("全部颜色"));
	for (const color of distinctColors(allCards)) {
		colorSel.addOption(
			color,
			color === UNSET_COLOR
				? t("未设色")
				: t(HIGHLIGHT_COLORS.find((c) => c.value === color)?.label ?? color),
		);
	}
	colorSel.setValue(ctx.cardsFilter.color ?? "");
	colorSel.onChange((v) => ctx.setCardsFilter({ color: v || null }));

	// 130 只显示闪卡开关（第六维筛选，配方同批量选择 toggle）：zap 图标 + 全库闪卡计数
	const fcToggle = filterRow.createDiv({ cls: "marinmind-home-view-toggle" });
	const fcBtn = fcToggle.createDiv({
		cls: "marinmind-home-view-toggle-btn marinmind-home-view-toggle-btn-wide",
		attr: {
			"aria-label": t("只显示闪卡"),
			title: `只显示已转为闪卡的卡片（共 ${flashIds.size} 张）`,
			"aria-pressed": String(ctx.cardsFilter.flashcard === true),
		},
	});
	setIcon(fcBtn, "zap");
	fcBtn.createSpan({ cls: "marinmind-home-view-toggle-count", text: String(flashIds.size) });
	fcBtn.classList.toggle("is-active", ctx.cardsFilter.flashcard === true);
	fcBtn.addEventListener("click", () => {
		ctx.setCardsFilter({ flashcard: ctx.cardsFilter.flashcard === true ? null : true });
	});
	enableKeyboardActivation(fcBtn);

	// 74 批量删除：批选模式开关（配方同收起钮；开 = 行首出勾选框、点击即勾选）
	const batchToggle = filterRow.createDiv({ cls: "marinmind-home-view-toggle" });
	const batchBtn = batchToggle.createDiv({
		cls: "marinmind-home-view-toggle-btn",
		attr: { "aria-label": t("批量选择"), title: t("批量选择（批量删除卡片）") },
	});
	setIcon(batchBtn, "list-checks");
	batchBtn.classList.toggle("is-active", batchSelectMode);
	// R3（W-12）：批选模式开合状态同步 aria-pressed（整页重渲染重建按钮，创建时即终态）
	batchBtn.setAttribute("aria-pressed", String(batchSelectMode));
	batchBtn.addEventListener("click", () => {
		if (batchSelectMode) {
			clearBatchSelection(); // 关闭模式并清空选择
		} else {
			batchSelectMode = true;
		}
		ctx.refresh(); // 整页重渲染显隐勾选框（搜索框随之重建并回填值；按钮点击无 IME 组字顾虑）
	});
	enableKeyboardActivation(batchBtn);

	// ---- 结果区（139-F 局部刷新闭包，镜像文档页 rerenderList 先例）----
	// 搜索输入只重建本区（计数/批量行/复习入口/列表/分页都依赖结果集），
	// 搜索行与筛选行不动——中文 IME 组字与焦点不受扰。
	const resultHost = listWrap.createDiv();
	const rerenderList = (): void => {
		resultHost.empty();
		// 六维筛选 → 关键词过滤（正文/批注/标签）→ 分页切片；空态与分页条渲染进
		// 右列——左列树常驻不被吞
		const filtered = filterCardsByQuery(
			filterCards(allCards, ctx.cardsFilter, flashIds),
			ctx.cardQuery,
		);
		const pageCards = paginate(filtered, ctx.cardsFilter.page, CARDS_PAGE_SIZE);
		// 74 批选存活修剪：选择只经本页操作产生，外部删卡后残留 id 清掉（计数不失真）
		if (batchSelectedIds.size > 0) {
			const alive = new Set(allCards.map((c) => c.id));
			for (const id of [...batchSelectedIds]) {
				if (!alive.has(id)) batchSelectedIds.delete(id);
			}
		}
		// 操作行（复用筛选行 flex 布局）：计数 + 批选钮/复习入口——依赖结果集的
		// 动态件全部落局部刷新区，搜索/筛选变化即重建（标签计数不失真）
		const actionRow = resultHost.createDiv({ cls: "marinmind-home-cards-filter" });
		const countEl = actionRow.createDiv({
			cls: "marinmind-home-cards-count",
			text: batchSelectMode
				? `已选 ${batchSelectedIds.size} / ${filtered.length} 张`
				: `${filtered.length} 张`,
		});
		// 74 批选模式：本页全选/删除所选（复习入口让位——纯选择语义）
		if (batchSelectMode) {
			const selectPageBtn = actionRow.createEl("button", {
				cls: "marinmind-home-cards-review",
				text: t("全选本页"),
				attr: { type: "button", title: t("勾选/取消当前页全部卡片") },
			});
			selectPageBtn.addEventListener("click", () => {
				const pageIds = pageCards.map((c) => c.id);
				const allIn = pageIds.length > 0 && pageIds.every((id) => batchSelectedIds.has(id));
				for (const id of pageIds) {
					if (allIn) batchSelectedIds.delete(id);
					else batchSelectedIds.add(id);
				}
				// 就地更新本页行勾选态（不整页重建）
				for (const rowEl of resultHost.querySelectorAll<HTMLElement>(
					".marinmind-home-card-row",
				)) {
					const id = rowEl.getAttribute("data-card-id");
					if (id != null) applyBatchRowState(rowEl, batchSelectedIds.has(id));
				}
				batchUiSync?.();
			});
			const deleteBtn = actionRow.createEl("button", {
				cls: "marinmind-home-cards-review marinmind-home-batch-delete",
				text: `删除 ${batchSelectedIds.size} 张`,
				attr: { type: "button", title: t("删除全部已勾选卡片") },
			});
			deleteBtn.addEventListener("click", () => {
				const ids = [...batchSelectedIds];
				if (ids.length === 0) return;
				new ConfirmModal(
					plugin.app,
					"批量删除卡片",
					`将删除所选 ${ids.length} 张卡片，连同附件、双向链接、脑图节点与复习进度，且无法恢复。`,
					() => {
						let deleted = 0;
						for (const id of ids) {
							const card = plugin.cards.get(id);
							if (!card) continue; // 已被外部删除（存活修剪兜底，理论不达）
							deleteCardCascade(plugin, card);
							deleted++;
						}
						new Notice(`已删除 ${deleted} 张卡片`);
						clearBatchSelection();
						// 立即退出批选态重渲染；后续 cardBus removed 事件再经 100ms
						// 尾随防抖合并刷新一次（含全部删光无事件也已有本次兜底）
						ctx.refresh();
					},
				).open();
			});
			// 127 批量移动文档：选目标（文档或未归类）→ 含锚点卡先警告（移动即清锚点）
			// → 逐卡 move（异常逐卡跳过计数）——目标消失等竞态不阻断整批
			const moveBtn = actionRow.createEl("button", {
				cls: "marinmind-home-cards-review",
				text: `移动 ${batchSelectedIds.size} 张`,
				attr: { type: "button", title: t("移动所选卡片到其他文档（原文锚点将清除）") },
			});
			moveBtn.addEventListener("click", () => {
				const ids = [...batchSelectedIds];
				if (ids.length === 0) return;
				const first = plugin.cards.get(ids[0]);
				new DocumentAssignModal(plugin.app, plugin, first?.documentId ?? null, (item) => {
					const targetId = item.kind === "doc" ? item.doc.id : null;
					const targetLabel = item.kind === "doc" ? item.doc.title : "未归类卡片";
					const doMove = (): void => {
						let moved = 0;
						for (const id of ids) {
							if (!plugin.cards.get(id)) continue; // 已被外部删除（存活修剪兜底）
							try {
								plugin.cards.move(id, targetId);
								moved++;
							} catch (err) {
								console.warn("[MarinMind] 卡片移动失败（已跳过）", err);
							}
						}
						new Notice(`已移动 ${moved} 张卡片到「${targetLabel}」`);
						clearBatchSelection();
						ctx.refresh();
					};
					// 带原文锚点的卡移动即清锚点——确认弹窗明示（不静默丢定位）
					const anchored = ids.filter((id) => {
						const c = plugin.cards.get(id);
						return (
							c != null && (c.page != null || c.rects.length > 0 || c.polygon != null)
						);
					}).length;
					if (anchored > 0) {
						new ConfirmModal(
							plugin.app,
							"移动卡片",
							`所选 ${ids.length} 张卡片中 ${anchored} 张带原文锚点，移动后页码/区域定位将被清除（卡片内容、附件与复习进度保留）。继续？`,
							doMove,
						).open();
					} else {
						doMove();
					}
				}).open();
			});
			batchUiSync = () => {
				countEl.setText(`已选 ${batchSelectedIds.size} / ${filtered.length} 张`);
				const pageIds = pageCards.map((c) => c.id);
				selectPageBtn.setText(
					pageIds.length > 0 && pageIds.every((id) => batchSelectedIds.has(id))
						? t("取消本页")
						: t("全选本页"),
				);
				const n = batchSelectedIds.size;
				deleteBtn.setText(`删除 ${n} 张`);
				deleteBtn.classList.toggle("is-disabled", n === 0);
				deleteBtn.setAttribute("aria-disabled", String(n === 0));
				moveBtn.setText(`移动 ${n} 张`);
				moveBtn.classList.toggle("is-disabled", n === 0);
				moveBtn.setAttribute("aria-disabled", String(n === 0));
			};
			batchUiSync();
		} else {
			batchUiSync = null;
		}
		// 卡组路径选中时给「复习本组」直达入口——activeDeckPath 剥哨兵：未分组/全部
		// 无「组」可练不出现（73 坑 A；openReviewDeck 按子树开练与树选中同语义）
		const deckPath = activeDeckPath(ctx.cardsFilter.deck);
		if (deckPath && !batchSelectMode) {
			const link = actionRow.createEl("button", {
				cls: "marinmind-home-cards-review",
				text: t("复习本组"),
				attr: { type: "button", title: t("按当前卡组（含子卡组）开始复习") },
			});
			link.addEventListener("click", () => void plugin.openReviewDeck(deckPath));
		}
		// 70 任一筛选（或 139-F 搜索词）激活时给「复习筛选结果」入口：当前可见集
		// 取 id → cards 范围开练（搜索与所见即所练一致）
		const filterActive =
			(Object.keys(ctx.cardsFilter) as (keyof typeof ctx.cardsFilter)[]).some(
				(k) => k !== "page" && ctx.cardsFilter[k] != null,
			) || ctx.cardQuery.trim() !== "";
		if (filterActive && !batchSelectMode) {
			const link = actionRow.createEl("button", {
				cls: "marinmind-home-cards-review",
				text: t("复习筛选结果"),
				attr: { type: "button", title: t("按当前筛选与搜索条件复习到期卡片") },
			});
			link.addEventListener("click", () => {
				const ids = filterCardsByQuery(
					filterCards(allCards, ctx.cardsFilter, flashIds),
					ctx.cardQuery,
				).map((c) => c.id);
				void plugin.openReviewCards(ids, "筛选结果");
			});
		}
		if (filtered.length === 0) {
			emptyHint(
				resultHost,
				plugin.cards.count() === 0
					? "还没有卡片——在阅读器中摘录即自动生成。"
					: "当前筛选或搜索条件下没有卡片。",
			);
			return;
		}
		renderCardRows(resultHost, plugin, pageCards, { ctx });

		// ---- 分页条（仅一页时隐藏；页码越界按最后一页显示） ----
		const totalPages = pageCount(filtered.length, CARDS_PAGE_SIZE);
		if (totalPages <= 1) return;
		const cur = Math.min(ctx.cardsFilter.page, totalPages);
		const pager = resultHost.createDiv({ cls: "marinmind-home-pager" });
		const prev = pager.createDiv({ cls: "marinmind-home-pager-btn" });
		// P2-1：分页箭头 ‹› → lucide chevron（与复习导航条同款图标语言）
		setIcon(prev.createSpan({ cls: "marinmind-home-pager-icon" }), "chevron-left");
		prev.createSpan({ text: t("上一页") });
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
		next.createSpan({ text: t("下一页") });
		if (cur >= totalPages) {
			next.addClass("is-disabled");
			next.setAttribute("aria-disabled", "true");
		} else {
			enableKeyboardActivation(next);
			next.addEventListener("click", () => ctx.setCardsFilter({ page: cur + 1 }));
		}
	};
	search.addEventListener("input", () => {
		ctx.setCardQuery(search.value);
		// ㊾ 搜索变化只清选择集、保留批选模式（镜像文档页先例——清集已足以防
		// "滤出视图的选中项被误删"，整清模式会让不重建的开关钮与行自相矛盾）
		batchSelectedIds.clear();
		void rerenderList();
	});
	rerenderList();
}

// ---------------------------------------------------------------------------
// 脑图页
// ---------------------------------------------------------------------------

/** 脑图页：新建入口 + 图列表（节点数/最近更新/书籍图徽标） */
export function renderMapsPage(container: HTMLElement, ctx: HomeRenderCtx): void {
	const { plugin } = ctx;
	const wrap = container.createDiv({ cls: "marinmind-home-page" });
	const titleRow = wrap.createDiv({ cls: "marinmind-home-title-row" });
	titleRow.createDiv({ cls: "marinmind-home-page-title", text: t("脑图") });
	const createBtn = titleRow.createDiv({ cls: "marinmind-home-btn marinmind-home-btn-primary" });
	createBtn.createSpan({ text: t("＋ 新建脑图") });
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
		renderMapRow(list, ctx, m, ts);
	}
}

function renderMapRow(list: HTMLElement, ctx: HomeRenderCtx, m: Mindmap, ts: number): void {
	const { plugin } = ctx;
	const row = list.createDiv({ cls: "marinmind-home-row is-clickable" });
	const main = row.createDiv({ cls: "marinmind-home-row-main" });
	main.createDiv({ cls: "marinmind-home-row-title", text: m.name });
	main.createDiv({
		cls: "marinmind-home-row-sub",
		text: `${plugin.mindmaps.countNodes(m.id)} 个节点 · ${formatRelativeTime(m.updatedAt, ts)}`,
	});
	if (m.documentId) {
		const doc = plugin.documents.get(m.documentId);
		// R2：自动书图的图名=书名，同名时省略徽标防同一标题重复显示两次
		if (doc && doc.title !== m.name) {
			row.createDiv({ cls: "marinmind-doc-badge", text: `📖 ${doc.title}` });
		}
	}
	row.addEventListener("click", () => void plugin.openMindmap(m.id));
	enableKeyboardActivation(row);
	// 主页脑图删除（镜像文档行右键先例）：右键菜单承载，删除置菜单最末（项目惯例）
	row.addEventListener("contextmenu", (evt) => {
		evt.preventDefault();
		showMapMenu(ctx, m, evt);
	});
}

/** 脑图行右键菜单：打开 + 删除脑图（危险操作置最末，镜像 showDocMenu 惯例） */
function showMapMenu(ctx: HomeRenderCtx, m: Mindmap, evt: MouseEvent): void {
	const { plugin } = ctx;
	const menu = new Menu();
	menu.addItem((item) =>
		item
			.setTitle(t("打开"))
			.setIcon("brain")
			.onClick(() => void plugin.openMindmap(m.id)),
	);
	menu.addSeparator();
	// 删除脑图：卡片保留仅删组织结构（map-delete.ts 单源）；打开中的视图经
	// refreshActiveMindmaps → loadMap 自愈回选图器（本文件接线，map-delete 保持轻依赖）
	menu.addItem((item) =>
		item
			.setTitle(t("删除脑图…"))
			.setIcon("trash-2")
			.onClick(() =>
				confirmDeleteMindmap(plugin.app, plugin, m, () => {
					refreshActiveMindmaps(m.id);
					ctx.refresh();
				}),
			),
	);
	menu.showAtMouseEvent(evt);
}
