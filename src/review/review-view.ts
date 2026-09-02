import { DropdownComponent, ItemView, Menu, Notice, setIcon } from "obsidian";
import type { WorkspaceLeaf } from "obsidian";
import type MarinMindPlugin from "../main";
import type { BookDocument, Card, DocRect, MindmapNodeWithCard, ReviewGrade, ReviewState } from "../types";
import { ReviewSession } from "./review-session";
import { buildSessionRows, sessionRowTitle, type SessionListFilter, type SessionSortKey } from "./session-list";
import { ContextPreviewRenderer } from "./context-preview";
import { buildMapContext } from "./map-context";
import { buildMapThumbnailSvg } from "./map-thumbnail";
import { DeckPickerModal } from "./deck-picker-modal";
import { ReviewStatsModal } from "./review-stats-modal";
import { CardPreviewModal } from "../home/card-preview-modal";
import { deleteCardCascade, promptCardDeck, promptCardNote, promptCardTags } from "../home/card-actions";
import { ConfirmModal } from "../mindmap/confirm-modal";
import { occlusionBounds, occlusionPercent } from "../reader/rect-utils";
import { renderExcerptVisual } from "../reader/excerpt-visual";
import { HIGHLIGHT_COLORS, highlightFallbackColor, highlightLineColor } from "../reader/highlight-colors";
import { pageWordOf } from "../storage/paths";

/** 复习视图的 viewType */
export const REVIEW_VIEW_TYPE = "marinmind-review";

/**
 * 复习范围四态：null = 全部书籍；book = 限定某书（阅读器/学习模式入口）；
 * deck = 限定某卡组（命令「按卡组复习」/主页「复习本组」入口）；
 * cards = 泛化临时范围（70：主页「复习筛选结果」/脑图「复习此分支」入口，
 * 任意卡片 id 集合 + 显示用 label）。
 * 判别联合让"至多一个范围生效"由类型系统表达（main.ts 已 import 本文件）。
 * **零持久化风险**：本视图无 getState/setState——scope 纯运行时状态，
 * 扩展 kind 不会进工作区布局 JSON（结论经核查，写注释钉住）。
 */
export type ReviewScope =
	| null
	| { kind: "book"; docId: string }
	| { kind: "deck"; deck: string }
	| { kind: "cards"; cardIds: string[]; label: string };

/** 四档评分：标签与按键（1-4） */
const GRADES: { grade: ReviewGrade; label: string; key: string }[] = [
	{ grade: "again", label: "重来", key: "1" },
	{ grade: "hard", label: "困难", key: "2" },
	{ grade: "good", label: "良好", key: "3" },
	{ grade: "easy", label: "简单", key: "4" },
];

/** 数字键 → 档位 */
const GRADE_KEYS: Record<string, ReviewGrade> = Object.fromEntries(
	GRADES.map((g) => [g.key, g.grade]),
);

/** 档位 → 标签（"已考"徽标用） */
const GRADE_LABELS = Object.fromEntries(GRADES.map((g) => [g.grade, g.label])) as Record<
	ReviewGrade,
	string
>;

/** 70 列表筛选下拉的哨兵 value（映射 SessionListFilter 的 null 语义；不与真实 id/颜色撞） */
const FREE_DOC_KEY = "__mm_free__";
const NO_COLOR_KEY = "__mm_nocolor__";

/** 颜色显示名（四色用名单源 label，旧色相回退键名本身） */
function colorOptionLabel(color: string): string {
	return HIGHLIGHT_COLORS.find((c) => c.value === color)?.label ?? color;
}

/** 媒体形态的正面标签 */
function mediaLabel(card: Card): string {
	if (card.excerptType === "audio") {
		return "语音摘录";
	}
	if (card.excerptType === "handwriting") {
		return "手写摘录";
	}
	if (card.excerptType === "area") {
		return "区域摘录";
	}
	if (card.excerptType === "lasso") {
		return "套索摘录";
	}
	if (card.excerptType === "blank") {
		return "留白摘录";
	}
	return "照片摘录";
}

/**
 * MarinMind 复习视图：到期闪卡的浏览 + 翻面 + 四档评分 + 跳转原文。
 *
 * 状态机：Empty（无到期/DB 未就绪）→ Front（正面）→ Back（翻面，可评分）→ Done（统计），
 * 每次评分后整体重渲染（视图简单，不做局部更新）。
 * 会话为 due 快照：again 卡由 ReviewSession 本地队尾重现，DB 侧 SM-2 照常调度。
 *
 * ㉑ 复习界面 v2（MN4 对齐）：
 * - 顶部导航条 ◀/▶ + 方向键在卡片间浏览切换（含已考/未考卡；评分只作用于待考卡）
 * - MN4 正反面语义：有批注时正面=批注（问题）、背面=摘录内容（答案）；
 *   无批注时正面=摘录内容本身
 *
 * ㉒ 溯源上下文（MN4 全屏复习模式，手册"闪卡复习②"）：
 * - 上下文默认收起——先回忆，记不起来再看（手册明确：一开始就看会降低主动回忆）
 * - 翻面后底部「溯源上下文」切换条：📄 文档栏（页缩略图+高亮）/
 *   🧠 脑图栏（卡片在各图中的 祖先›本卡›子/同级 位置摘要，纯函数 buildMapContext）
 * - 换卡/评分后自动收起；无文档定位的卡（photo/audio/自由卡）提示走脑图栏
 * - 修复：render 整体重渲染前清空 contentEl——此前只有 startSession 清空，
 *   导航/翻面只会往下叠加旧 stage，◀ ▶ 看似"没生效"的真根因（v1 起就存在）
 *
 * ㊷ 卡片/闪卡区分（正反面语义扩展）：
 * - 正面遮挡：带 occlusions 的卡正面出图（excerpt-visual 共享管线）+ 实心遮挡块
 *   盖住重点区域，点击单块临时揭开 /「显示全部遮挡」全揭；翻面与已考回看显示
 *   同一张视觉、不叠遮挡块（㊿-B：把遮挡区域去除即是答案，各形态与正面一致）
 *
 * 卡组与卡片管理（复习卡组批）：
 * - 范围三态 ReviewScope（㊷ 按书范围泛化）：null 全部书籍 / book 限书
 *   （阅读器·学习模式入口）/ deck 限卡组（命令「按卡组复习」·主页「复习本组」）；
 *   范围 chip 从 topbar 下沉到出处 meta 行（topbar 只留 ◀ 第 i/N 张 ▶ + ⋯管理 + ↗原文）
 * - topbar「⋯ 管理」：查看卡片 / 打标签 / 设卡组 / 删除——已考回看与后面的卡同可用
 *   （不套 ↗原文 的 doc/page 守卫，自由卡片与照片/语音卡也可管理）；动作与
 *   卡片预览弹窗经 card-actions 单源共享，删除后会话剔除由 cardBus removed 订阅完成
 * - cardBus 订阅：removed → session.remove 剔除重渲染（外部删卡同路径）；
 *   changed → 队列内的卡被外部改（标签/卡组/批注）后重渲染取最新快照
 *
 * 67 浏览态撤销评分：
 * - Ctrl+Z / topbar undo-2：session 撤销栈（深 20，grade 的 index 单调性保栈顶
 *   恒为最近评分）回退会话态——计数递减、again 重现实例出队、落回被撤销卡未翻面态；
 *   视图快照栈 restoreReview 直写评分前快照（时间倒流不走 SM-2）+ 复习日志镜像回退
 * - 单一时间源：评分 ts 视图捕获一次贯穿 review() 日志与快照；双栈压栈同一同步
 *   闭包栈顶对应，remove/新会话同步清栈，失配全清宁拒不赌；改评 = 撤销后重评
 */
export class MarinMindReviewView extends ItemView {
	private readonly plugin: MarinMindPlugin;
	private session: ReviewSession | null = null;
	/** excerptRef → blob URL（同 ref 复用；onClose 统一 revoke，翻页渲染不回收） */
	private readonly mediaUrls = new Map<string, string>();
	/** 原文上下文缩略图渲染器（缓存 PDF 文档；onClose 统一 destroy）——构造器内初始化（依赖 plugin） */
	private readonly context: ContextPreviewRenderer;
	/** 溯源上下文当前展开的栏（null = 收起；MN4：默认不显示，先回忆再看） */
	private contextTab: "doc" | "map" | null = null;
	/**
	 * 71 自动展开溯源上下文（会话级开关，不持久化）：开启时翻面默认展开
	 * 上次选择的栏（lastContextTab）；换卡/评分照常收起后翻面再自动展开。
	 */
	private autoExpandContext = false;
	/** 71 自动展开回落的栏（用户最后一次手动点开的 doc/map，缺省文档栏） */
	private lastContextTab: "doc" | "map" = "doc";
	/**
	 * 复习范围三态（卡组批，㊷ scopeDocId 泛化）：null = 全部书籍。
	 * 命名避开基类 View.scope（obsidian DOM 事件 Scope，撞名会 override 冲突）
	 */
	private reviewScope: ReviewScope = null;
	/** cardBus 退订函数（constructor 订阅 / onClose 头部统一退订） */
	private readonly cardBusOffs: (() => void)[] = [];
	/** 遮挡正面经 excerpt-visual 管线创建的 blob URL（onClose 统一 revoke；换卡重渲染不逐个回收，会话量小） */
	private readonly occlusionUrls = new Set<string>();
	/**
	 * 67 撤销快照双栈（视图侧）：与 session.undoStack 压栈同一同步闭包、栈顶一一对
	 * 应——session 管会话态回退，这里管 DB 态回退（评分前 ReviewState 快照 + ts）。
	 * before=null 表示该次评分未落库（卡被删 review 返 undefined）——撤销只回会话态。
	 * session.remove 清栈时这里同步全清（cardBus removed 订阅），新会话重建时清空。
	 */
	private undoSnapshots: { cardId: string; grade: ReviewGrade; before: ReviewState | null; ts: number }[] = [];
	/**
	 * 70 卡片组列表：左侧可收起面板（会话态不持久化，默认收起）。
	 * 排序/筛选只影响列表行序与可见性——不动队列本体，SRS 语义零干扰。
	 */
	private listOpen = false;
	private listSort: SessionSortKey = "queue";
	private listFilter: SessionListFilter = {};

	constructor(leaf: WorkspaceLeaf, plugin: MarinMindPlugin) {
		super(leaf);
		this.plugin = plugin;
		this.context = new ContextPreviewRenderer(plugin);
		// cardBus 订阅（卡组批）：契约——回调零写库，只做内存/DOM 更新。
		// removed：本会话或外部（阅读器/主页/预览弹窗）删卡 → 会话剔除并重渲染；
		// changed：队列内的卡被外部改（标签/卡组/批注/OCR 写回）→ 重渲染取最新
		this.cardBusOffs.push(
			plugin.cardBus.onCardRemoved((cardId) => {
				if (this.session?.remove(cardId)) {
					// 67 对齐：session.remove 开头清了会话撤销栈，视图快照栈同步全清
					//（删除的 graded 重键破坏栈内 index 有效性，双栈一起作废）
					this.undoSnapshots.length = 0;
					this.render();
				}
			}),
		);
		this.cardBusOffs.push(
			plugin.cardBus.onCardChanged((card) => {
				// includes 过滤（含 again 重现实例）防全库改卡风暴重渲染
				if (this.session?.includes(card.id)) {
					this.render();
				}
			}),
		);
	}

	getViewType(): string {
		return REVIEW_VIEW_TYPE;
	}

	getDisplayText(): string {
		return "MarinMind 复习";
	}

	getIcon(): string {
		return "layers";
	}

	async onOpen(): Promise<void> {
		// contentEl 是 div 不可聚焦，键盘事件挂 document（仅激活标签页响应）
		this.registerDomEvent(document, "keydown", (evt) => this.onKeydown(evt));
		await this.startSession();
	}

	/**
	 * 拉取到期快照并重建会话（onOpen 首次 + 命令复用标签页重启都走这里）。
	 * scope 三态：undefined = 保持当前范围（视图内「再查一批」沿用——命脉语义，
	 * 调用方要清范围必须显式传 null，不能省略参数）；null = 全部书籍；对象 = 切换范围。
	 */
	async startSession(scope?: ReviewScope): Promise<void> {
		if (scope !== undefined) {
			this.reviewScope = scope;
		}
		this.contentEl.empty();
		this.contentEl.classList.add("marinmind-review");
		this.contextTab = null;
		await this.plugin.whenReady();
		if (!this.plugin.store) {
			this.session = null;
			this.renderMessage("数据层未就绪，无法复习。");
			return;
		}
		// 范围分派（70 cards 泛化）：cards → id 集合直查（dueByIds 无 limit——
		// 集合本身就是调用方框定的范围，截断反而漏卡）；book/deck → due 过滤。
		// cards 范围「再查一批」重查 dueByIds：已评分卡不再到期自然收敛到空，语义正确
		let cards: Card[];
		if (this.reviewScope?.kind === "cards") {
			cards = this.plugin.reviews.dueByIds(this.reviewScope.cardIds, {
				newPerDay: this.plugin.settings.reviewNewPerDay,
			});
		} else {
			const docId = this.reviewScope?.kind === "book" ? this.reviewScope.docId : undefined;
			const deck = this.reviewScope?.kind === "deck" ? this.reviewScope.deck : undefined;
			cards = this.plugin.reviews.due(
				undefined,
				this.plugin.settings.reviewBatchSize,
				docId,
				deck,
				this.plugin.settings.reviewNewPerDay,
			);
		}
		this.undoSnapshots.length = 0;
		this.session = new ReviewSession(
			cards,
			(cardId, grade) => {
				// 67 单一时间源：一次评分的 ts 捕获一次，贯穿 review() 的日志记录
				// 与撤销快照（跨午夜撤销回退 ts 对齐依赖此点）
				const ts = Date.now();
				const before = this.plugin.reviews.get(cardId);
				// 卡片可能在会话中被删除：review 返回 undefined 被忽略，会话照常推进；
				// 此时无 DB 写入，快照记 before=null（撤销只回退会话态不写库）
				const next = this.plugin.reviews.review(cardId, grade, ts);
				this.undoSnapshots.push({
					cardId,
					grade,
					before: next && before ? before : null,
					ts,
				});
			},
		);
		this.render();
	}

	// ---------- 内部实现 ----------

	private render(): void {
		// 整体重渲染前必须清空旧内容：翻面/评分/导航都走这里（㉒ 修复：
		// 此前只有 startSession 清空，重渲染往下叠加旧 stage，切换看似无效）
		this.contentEl.empty();
		const s = this.session;
		if (!s) {
			return;
		}
		// 70 卡片组列表开启且有卡时：左侧面板 + 右侧舞台分栏（空会话面板无意义不建）
		let stage: HTMLElement;
		if (this.listOpen && s.total > 0) {
			const split = this.contentEl.createDiv({ cls: "marinmind-review-split" });
			this.renderSessionList(split.createDiv({ cls: "marinmind-review-list" }), s);
			stage = split.createDiv({ cls: "marinmind-review-stage" });
		} else {
			stage = this.contentEl.createDiv({ cls: "marinmind-review-stage" });
		}
		const card = s.current;
		if (!card) {
			if (s.total === 0) {
				this.renderMessage(this.emptyText(), stage);
			} else {
				this.renderDone(stage, s);
			}
			return;
		}
		this.renderCard(stage, s, card);
	}

	/** Empty 屏文案按范围四态区分（全部/本书/卡组/自定义范围） */
	private emptyText(): string {
		if (this.reviewScope?.kind === "book") return "本书当前没有到期闪卡 🎉";
		if (this.reviewScope?.kind === "deck") return `本组「${this.reviewScope.deck}」当前没有到期闪卡 🎉`;
		if (this.reviewScope?.kind === "cards") return `本范围「${this.reviewScope.label}」当前没有到期闪卡 🎉`;
		return "当前没有到期卡片 🎉";
	}

	/** 空态 / DB 未就绪提示（带"再查一批"按钮） */
	private renderMessage(text: string, stage?: HTMLElement): void {
		const box = (stage ?? this.contentEl.createDiv({ cls: "marinmind-review-stage" })).createDiv({
			cls: "marinmind-review-message",
		});
		box.textContent = text;
		const refresh = box.createEl("button", {
			cls: "marinmind-review-link",
			text: "再查一批到期卡片",
		});
		refresh.addEventListener("click", () => void this.startSession());
		// 范围限定下加"考全部书籍"入口（Empty 屏 / 数据层未就绪共用）；
		// 「按卡组复习…」需查库派生卡组名——数据层未就绪时 plugin.cards 为空不挂
		if (this.reviewScope !== null) {
			const all = box.createEl("button", {
				cls: "marinmind-review-link",
				text: "考全部书籍",
			});
			all.addEventListener("click", () => void this.startSession(null));
		}
		if (this.plugin.store) {
			const deck = box.createEl("button", {
				cls: "marinmind-review-link",
				text: "按卡组复习…",
			});
			deck.addEventListener("click", () => {
				new DeckPickerModal(this.app, this.plugin, (name) => {
					void this.startSession({ kind: "deck", deck: name });
				}).open();
			});
		}
	}

	private renderCard(stage: HTMLElement, s: ReviewSession, snapshot: Card): void {
		// 会话队列是 due 快照：cardBus changed 重渲染时取库中最新（外部改卡后
		// 标签/卡组/批注/颜色立即生效）；库中已无（删除瞬间竞态）回退快照
		const card = this.plugin.cards?.get(snapshot.id) ?? snapshot;
		const doc = card.documentId ? this.plugin.documents.get(card.documentId) : undefined;
		// 浏览到已考过的卡：直接显示正反面（只读）；待考卡按翻面态；未考预览只显示正面
		const showBack = s.isRevealed || s.gradedAt != null;

		// 顶部导航条：📋 ◀ 第 i/N 张 ▶ …… ↗ 原文（正面即可跳转，MN4 文档栏入口）
		const topbar = stage.createDiv({ cls: "marinmind-review-topbar" });
		// 70 卡片组列表开关（panel-left 与主页文件夹收起同图标语言；空会话无列表可开）
		const listBtn = topbar.createEl("button", {
			cls: "marinmind-review-nav-btn",
			attr: { type: "button", "aria-label": "卡片组列表", title: "卡片组列表（排序 / 筛选 / 跳转）" },
		});
		setIcon(listBtn, "panel-left");
		if (this.listOpen) {
			listBtn.addClass("is-active");
		}
		listBtn.disabled = s.total === 0;
		listBtn.addEventListener("click", () => {
			this.listOpen = !this.listOpen;
			this.render();
		});
		const prev = topbar.createEl("button", {
			cls: "marinmind-review-nav-btn",
			attr: { type: "button", "aria-label": "上一张（←）", title: "上一张（←）" },
		});
		setIcon(prev, "chevron-left");
		prev.disabled = !s.canPrev;
		prev.addEventListener("click", () => this.navigate(() => s.goPrev()));
		topbar.createSpan({
			cls: "marinmind-review-pos",
			text: `第 ${Math.min(s.positionNo + 1, s.total)} / ${s.total} 张`,
		});
		const next = topbar.createEl("button", {
			cls: "marinmind-review-nav-btn",
			attr: { type: "button", "aria-label": "下一张（→）", title: "下一张（→）" },
		});
		setIcon(next, "chevron-right");
		next.disabled = !s.canNext;
		next.addEventListener("click", () => this.navigate(() => s.goNext()));
		topbar.createEl("div", { cls: "marinmind-review-topbar-spacer" });
		// 67 撤销上次评分（Ctrl+Z）：会话态 + DB SM-2/日志 一并回退；改评 = 撤销后重评
		const undo = topbar.createEl("button", {
			cls: "marinmind-review-nav-btn",
			attr: { type: "button", "aria-label": "撤销上次评分 (Ctrl+Z)", title: "撤销上次评分 (Ctrl+Z)" },
		});
		setIcon(undo, "undo-2");
		undo.disabled = s.undoDepth === 0;
		undo.addEventListener("click", () => this.undoLastGrade());
		// ⋯ 管理（卡组批）：查看 / 打标签 / 设卡组 / 删除——任何卡都有，不套 ↗原文
		// 的 doc/page 守卫（自由卡片与照片/语音卡同样可管理；已考回看/后面的卡同可用）
		const manage = topbar.createEl("button", {
			cls: "marinmind-review-link",
			attr: { type: "button", title: "管理卡片（查看 / 标签 / 卡组 / 删除）" },
		});
		setIcon(manage.createSpan({ cls: "marinmind-review-link-icon" }), "more-horizontal");
		manage.createSpan({ text: "管理" });
		manage.addEventListener("click", (evt) => this.openManageMenu(evt, card));
		if (doc && card.documentId && card.page != null) {
			const jump = topbar.createEl("button", { cls: "marinmind-review-link" });
			// P2-1 图标语言统一：字符 ↗ → lucide arrow-up-right（与脑图节点编辑器/主页预览弹窗同款）
			setIcon(jump.createSpan({ cls: "marinmind-review-link-icon" }), "arrow-up-right");
			jump.createSpan({ text: "原文" });
			jump.addEventListener("click", () => void this.plugin.openCardSource(card));
		}

		// 出处 meta 行（卡组批书名下沉）：[范围 chip（scoped 时）] [出处段] [剩余 N 张]。
		// 结构化 DOM 替代原 textContent 拼串——chip 是可点击按钮，进不了纯文本
		const meta = stage.createDiv({ cls: "marinmind-review-meta" });
		this.renderScopeChip(meta);
		// 出处段：book 范围书名已在 chip 不重复；deck 范围组内跨书需完整出处
		let source: string;
		if (this.reviewScope?.kind === "book") {
			source = card.page != null ? `第 ${card.page} ${doc ? pageWordOf(doc.filePath) : "页"}` : "";
		} else if (doc) {
			source = `《${doc.title}》${card.page != null ? ` · 第 ${card.page} ${pageWordOf(doc.filePath)}` : ""}`;
		} else {
			source = "自由卡片";
		}
		if (source) {
			meta.createSpan({ cls: "marinmind-review-meta-item", text: source });
		}
		meta.createSpan({ cls: "marinmind-review-meta-item", text: `剩余 ${s.remaining} 张` });

		const cardBox = stage.createDiv({ cls: "marinmind-review-card" });
		// P1-c 墨色随卡走：顶缘墨线 = 卡片身份色（highlightFallbackColor 对
		// null 色卡按形态回退；翻面/换卡重渲染时墨线从左展开，见 CSS 编排注释）
		cardBox.dataset.color = highlightFallbackColor(card);
		// 正面（MN4：问题）：有批注时批注即问题，摘录内容移到背面作答案
		if (card.note) {
			const q = cardBox.createDiv({ cls: "marinmind-review-question" });
			q.createSpan({ cls: "marinmind-review-block-label", text: "问题" });
			q.createDiv({ cls: "marinmind-review-note", text: card.note });
		}
		// ㊷ 有遮挡的卡：正面出图并遮住重点区域（有批注时问题块与遮挡图共存）；
		// 翻面/已考回看 = 同一张视觉、不叠遮挡块（㊿-B 把遮挡区域去除即是答案）
		if (card.occlusions.length > 0 && !showBack) {
			this.renderOcclusionFront(cardBox, card);
		} else if (!card.note) {
			if (card.occlusions.length > 0) {
				this.renderExcerptVisualPlain(cardBox, card);
			} else {
				this.renderExcerptBody(cardBox, card);
			}
		}

		// 背面（MN4：全部内容）：摘录内容（正面显示过则不重复）+ 批注（正面未显示时）+ 出处
		if (showBack) {
			const back = cardBox.createDiv({ cls: "marinmind-review-back" });
			if (card.note) {
				// 正面是批注（问题）：摘录内容是答案主体
				const a = back.createDiv({ cls: "marinmind-review-answer" });
				a.createSpan({ cls: "marinmind-review-block-label", text: "内容" });
				if (card.occlusions.length > 0) {
					this.renderExcerptVisualPlain(a, card);
				} else {
					this.renderExcerptBody(a, card);
				}
			}
			const source = back.createDiv({ cls: "marinmind-review-source" });
			source.textContent = doc
				? `《${doc.title}》${card.page != null ? ` · 第 ${card.page} ${pageWordOf(doc.filePath)}` : ""}`
				: "无出处信息";
			// 溯源上下文切换条（㉒）：翻面后才出现，默认收起
			this.renderContextToggle(back, card, doc);
		}

		// 操作区：待考卡 = 翻面/四档评分；浏览态 = 状态徽标
		const actions = stage.createDiv({ cls: "marinmind-review-actions" });
		if (s.isCurrentPending) {
			if (!s.isRevealed) {
				const btn = actions.createEl("button", {
					cls: "marinmind-review-btn",
					text: "翻面看答案",
				});
				btn.addEventListener("click", () => {
					s.reveal();
					this.render();
				});
			} else {
				for (const { grade, label, key } of GRADES) {
					const btn = actions.createEl("button", {
						cls: "marinmind-review-btn",
						text: `${label}(${key})`,
					});
					btn.dataset.grade = grade;
					btn.addEventListener("click", () => this.grade(grade));
				}
			}
		} else if (s.gradedAt) {
			actions.createDiv({
				cls: "marinmind-review-badge",
				text: `已考 · ${GRADE_LABELS[s.gradedAt]}`,
			});
		} else {
			actions.createDiv({
				cls: "marinmind-review-badge",
				text: "后面的卡 · 未考",
			});
		}

		const hint = stage.createDiv({ cls: "marinmind-review-hint" });
		if (s.isCurrentPending) {
			hint.textContent = s.isRevealed ? "按 1-4 评分 · ← → 切换卡片" : "空格 / 回车翻面 · ← → 切换卡片";
		} else if (s.gradedAt) {
			hint.textContent = "已考过的卡（只读）· ← → 继续浏览";
		} else {
			hint.textContent = "后面的卡（只看正面）· ← → 切换";
		}
	}

	/**
	 * 正面遮挡渲染（㊷）：摘录视觉（附件快照 / 原文页裁剪——excerpt-visual 共享管线，
	 * 与主页卡片预览同一出图）+ 实心遮挡块按页归一化坐标换算到视觉窗口内百分比定位。
	 * 点击单块临时揭开（再点重遮）；「显示全部遮挡」一键全揭/重遮（不翻面）。
	 * 换卡/翻面/评分整体重渲染，揭开态自然复位。
	 */
	private renderOcclusionFront(cardBox: HTMLElement, card: Card): void {
		const wrap = cardBox.createDiv({ cls: "marinmind-review-occlusion-wrap" });
		// stage 收缩到视觉实际宽度（inline-block），遮挡块 % 定位才与视觉边缘对齐；
		// 视觉与遮挡分层挂载，遮挡层永远在图之上
		const stage = wrap.createDiv({ cls: "marinmind-review-occlusion-stage" });
		const visualHost = stage.createDiv({ cls: "marinmind-review-occlusion-visual" });
		const layer = stage.createDiv({ cls: "marinmind-review-occlusion-layer" });
		const blocks = card.occlusions.map(() =>
			layer.createDiv({ cls: "marinmind-review-occlusion" }),
		);
		// 遮挡块色系随摘录色（㊿-C）：--mm-occ-line 驱动实心填充与揭开态描边，
		// 与阅读器高亮/paintCardHighlights 同一取色源（highlightLineColor）
		this.applyOcclusionColor(blocks, card);
		// 出图解析完成后才知道视觉对应的页归一化窗口（快照图 = rects 包围盒 /
		// 页裁剪 = 裁剪窗口），届时按窗口钳制摆位；失败用 occlusionBounds 估算
		const place = (bounds: DocRect) => {
			card.occlusions.forEach((occ, i) => {
				const pos = occlusionPercent(occ, bounds);
				Object.assign(blocks[i].style, pos);
			});
		};
		void renderExcerptVisual(this.plugin, card, visualHost).then((result) => {
			if (result.objectUrl) {
				this.occlusionUrls.add(result.objectUrl);
			}
			if (!stage.isConnected) {
				return; // 渲染期间换卡/翻面：DOM 已拆，无需摆位
			}
			place(result.bounds ?? occlusionBounds(card));
			if (!result.rendered) {
				// 视觉不可用兜底：摘录文字直接展示，遮挡块按估算位置近似遮住对应区域
				visualHost.createDiv({
					cls: "marinmind-review-excerpt",
					// P3-1 措辞对齐 card-preview-modal 同款兜底文案（统一「或」）
				text: card.excerptText || "（摘录图不可用——附件缺失或原文文件无法读取）",
				});
			}
		});
		blocks.forEach((el) => {
			// 单块点击临时揭开，再点重遮（换卡/翻面重渲染自然复位）
			el.addEventListener("click", () => el.classList.toggle("is-peeked"));
		});
		const bar = wrap.createDiv({ cls: "marinmind-review-occlusion-bar" });
		const btn = bar.createEl("button", {
			cls: "marinmind-review-link",
			text: "显示全部遮挡",
			attr: { type: "button" },
		});
		btn.addEventListener("click", () => {
			const allPeeked = blocks.every((el) => el.hasClass("is-peeked"));
			blocks.forEach((el) => el.toggleClass("is-peeked", !allPeeked));
			btn.setText(allPeeked ? "显示全部遮挡" : "重新遮住");
		});
	}

	/**
	 * 遮挡卡翻面/已考回看的内容形态（㊿-B）：与正面同一张摘录视觉
	 * （excerpt-visual 共享管线），只是遮挡块换成答案形态——**透明底 + 同色系
	 * 虚线边框**（㊿-C 用户反馈：遮挡区域去除但边框保留，位置感不丢），
	 * 各摘录形态（文字/区域/套索/留白）观感与正面一致。视觉不可用回退
	 * renderExcerptBody（文字/媒体兜底）。此前背面走 renderExcerptBody：
	 * 文字摘录翻面显示纯文本，与正面的图形态割裂。
	 */
	private renderExcerptVisualPlain(parent: HTMLElement, card: Card): void {
		// 与 renderOcclusionFront 同款 wrap/stage 结构（居中 + inline-block 收缩），
		// 遮挡层只画边框不填充
		const wrap = parent.createDiv({ cls: "marinmind-review-occlusion-wrap" });
		const stage = wrap.createDiv({ cls: "marinmind-review-occlusion-stage" });
		const visualHost = stage.createDiv({ cls: "marinmind-review-occlusion-visual" });
		const layer = stage.createDiv({ cls: "marinmind-review-occlusion-layer" });
		const blocks = card.occlusions.map(() =>
			layer.createDiv({ cls: "marinmind-review-occlusion is-answer" }),
		);
		this.applyOcclusionColor(blocks, card);
		void renderExcerptVisual(this.plugin, card, visualHost).then((result) => {
			if (result.objectUrl) {
				this.occlusionUrls.add(result.objectUrl);
			}
			if (!stage.isConnected) {
				return; // 渲染期间翻面/换卡：DOM 已拆，无需兜底
			}
			const bounds = result.bounds ?? occlusionBounds(card);
			card.occlusions.forEach((occ, i) => {
				Object.assign(blocks[i].style, occlusionPercent(occ, bounds));
			});
			if (!result.rendered) {
				// 视觉不可用：无图可叠边框，撤掉答案块退回文字/媒体主体
				for (const b of blocks) {
					b.remove();
				}
				this.renderExcerptBody(visualHost, card);
			}
		});
	}

	/**
	 * 遮挡块挂色系变量（㊿-C）：摘录色（card.color，空则按形态回退）→
	 * highlightLineColor 线色写入 --mm-occ-line，CSS 侧实心填充/揭开与答案
	 * 形态的虚线描边统一消费——与阅读器高亮/溯源缩略图同一取色源。
	 */
	private applyOcclusionColor(blocks: HTMLElement[], card: Card): void {
		const line = highlightLineColor(highlightFallbackColor(card));
		for (const b of blocks) {
			b.style.setProperty("--mm-occ-line", line);
		}
	}

	/** 摘录内容主体：文字 / 媒体（img/audio）/ 占位提示 */
	private renderExcerptBody(parent: HTMLElement, card: Card): void {
		if (card.excerptText) {
			const excerpt = parent.createDiv({ cls: "marinmind-review-excerpt" });
			excerpt.textContent = card.excerptText;
			return;
		}
		if (card.excerptRef) {
			// fire-and-forget 加载附件：渲染后视图可能立刻被翻页重绘，isConnected 守卫丢弃
			if (card.excerptType === "audio") {
				const audio = parent.createEl("audio", { cls: "marinmind-review-media" });
				audio.controls = true;
				audio.preload = "metadata";
				void this.mediaUrl(card.excerptRef).then((url) => {
					if (audio.isConnected) {
						audio.src = url;
					}
				});
			} else {
				const img = parent.createEl("img", { cls: "marinmind-review-media" });
				img.alt = mediaLabel(card);
				void this.mediaUrl(card.excerptRef).then((url) => {
					if (img.isConnected) {
						img.src = url;
					}
				});
			}
			const ph = parent.createDiv({ cls: "marinmind-review-placeholder" });
			ph.textContent =
				card.page != null
					? `${mediaLabel(card)} · 第 ${card.page} ${this.pageWordOfCard(card)}`
					: mediaLabel(card);
			return;
		}
		const ph = parent.createDiv({ cls: "marinmind-review-placeholder" });
		ph.textContent =
			card.page != null
				? `区域摘录 · 第 ${card.page} ${this.pageWordOfCard(card)}`
				: "区域摘录";
	}

	/** 页码量词（㊼）：epub 书「章」其余「页」；文档失联/手工卡兜底「页」 */
	private pageWordOfCard(card: Card): string {
		const doc = card.documentId ? this.plugin.documents.get(card.documentId) : undefined;
		return doc ? pageWordOf(doc.filePath) : "页";
	}

	/**
	 * 溯源上下文切换条（㉒，MN4 全屏复习：翻面后查看脑图/文档栏）。
	 * 默认收起——手册明确提示"一开始就查看上下文会降低主动回忆效果"，
	 * 所以只在背面出现、换卡自动收起、点开才懒加载。
	 */
	private renderContextToggle(
		parent: HTMLElement,
		card: Card,
		doc: BookDocument | undefined,
	): void {
		// 71 自动展开：开启时翻面默认展开上次选择的栏（收起不影响开关——
		// 换卡/评分收起后下张卡翻面再次自动展开；关闭时维持既有"默认收起"）
		if (this.autoExpandContext && this.contextTab === null) {
			this.contextTab = this.lastContextTab;
		}
		const bar = parent.createDiv({ cls: "marinmind-review-ctx-bar" });
		bar.createSpan({ cls: "marinmind-review-ctx-label", text: "溯源上下文" });
		// P2-2：分组容器套 .marinmind-segmented 共享配方（与三视图模式条/目录分页同形态）
		const group = bar.createDiv({ cls: "marinmind-segmented" });
		const tabs: { key: "doc" | "map"; label: string }[] = [
			{ key: "doc", label: "📄 文档" },
			{ key: "map", label: "🧠 脑图" },
		];
		for (const { key, label } of tabs) {
			const btn = group.createEl("button", {
				cls: "marinmind-segmented-btn",
				text: label,
				attr: { type: "button", title: `${label.slice(2)}上下文（再次点击收起）` },
			});
			if (this.contextTab === key) {
				btn.addClass("is-active");
			}
			btn.addEventListener("click", () => {
				this.contextTab = this.contextTab === key ? null : key;
				if (this.contextTab) {
					this.lastContextTab = this.contextTab; // 71 记住手动选择，自动展开回落用
				}
				this.render();
			});
		}
		// 71 自动展开开关（会话级，eye/eye-off 状态即语义）
		const autoBtn = bar.createEl("button", {
			cls: "clickable-icon marinmind-review-ctx-auto",
			attr: {
				type: "button",
				title: this.autoExpandContext ? "自动展开溯源上下文：开（点击关闭）" : "自动展开溯源上下文：关（点击开启）",
			},
		});
		setIcon(autoBtn, this.autoExpandContext ? "eye" : "eye-off");
		if (this.autoExpandContext) {
			autoBtn.addClass("is-active");
		}
		autoBtn.addEventListener("click", () => {
			this.autoExpandContext = !this.autoExpandContext;
			this.render();
		});
		if (!this.contextTab) {
			return;
		}
		const panel = parent.createDiv({ cls: "marinmind-review-ctx-panel" });
		if (this.contextTab === "doc") {
			this.renderDocContext(panel, card, doc);
		} else {
			this.renderMapContext(panel, card);
		}
	}

	/** 文档栏：摘录所在页缩略图 + 高亮（复用 ContextPreviewRenderer，懒渲染） */
	private renderDocContext(panel: HTMLElement, card: Card, doc: BookDocument | undefined): void {
		// photo/audio 无矩形、自由卡无文档：无定位可展示（MN4 Q6——此时只剩脑图上下文）
		if (!doc || card.page == null || card.rects.length === 0) {
			panel.createDiv({
				cls: "marinmind-review-ctx-hint",
				text: "该卡片没有文档定位（照片/语音摘录或自由卡片），可切换「🧠 脑图」查看它在知识体系中的位置。",
			});
			return;
		}
		void this.context.renderInto(panel, card);
	}

	/** 脑图栏：卡片在各图中的位置摘要（祖先 › 本卡 › 子节点/同级），未入图给提示 */
	private renderMapContext(panel: HTMLElement, card: Card): void {
		if (!this.plugin.store) {
			panel.createDiv({ cls: "marinmind-review-ctx-hint", text: "数据层未就绪。" });
			return;
		}
		const hits = this.plugin.mindmaps.nodesByCard(card.id);
		if (hits.length === 0) {
			panel.createDiv({
				cls: "marinmind-review-ctx-hint",
				text: "该卡片尚未加入任何脑图（在阅读器把高亮拖入脑图，或开启脑图的「添加到脑图」开关）。",
			});
			return;
		}
		// 按图分组拉全图节点算位置摘要——只在点开脑图栏时查（节点典型百级，不拖累翻卡）
		const byMap = new Map<string, MindmapNodeWithCard[]>();
		for (const hit of hits) {
			if (!byMap.has(hit.mapId)) {
				byMap.set(hit.mapId, this.plugin.mindmaps.listNodes(hit.mapId));
			}
		}
		for (const [mapId, nodes] of byMap) {
			const map = this.plugin.mindmaps.get(mapId);
			const entry = buildMapContext(nodes, map?.name ?? "（已删除的图）", card.id);
			if (!entry) {
				continue;
			}
			const block = panel.createDiv({ cls: "marinmind-review-ctx-map" });
			block.createDiv({
				cls: "marinmind-review-ctx-map-title",
				text: `🗺 《${entry.mapTitle}》`,
			});
			// 71 缩略图：可见节点包围盒 SVG 路标，当前卡 accent 描边；点击跳真实
			// 视图定位（缩略图 h 估值仅示意，跳转后以真实布局为权威）。
			if (map) {
				const svg = buildMapThumbnailSvg(nodes, card.id, map.defaultBranchStyle);
				if (svg) {
					const thumb = block.createDiv({
						cls: "marinmind-review-ctx-thumb",
						attr: { title: "点击在脑图中定位此卡片" },
					});
					thumb.innerHTML = svg;
					thumb.addEventListener("click", () => {
						void this.plugin.openMindmapAtCard(mapId, card.id);
					});
				}
			}
			// 位置路径：祖先（远 → 近）› 本卡（加粗强调）
			const path = block.createDiv({ cls: "marinmind-review-ctx-path" });
			for (const t of entry.ancestors) {
				path.createSpan({ cls: "marinmind-review-ctx-node", text: t });
				path.createSpan({ cls: "marinmind-review-ctx-sep", text: "›" });
			}
			path.createSpan({ cls: "marinmind-review-ctx-node is-self", text: entry.selfTitle });
			if (entry.childCount > 0) {
				const more = entry.childCount > entry.childTitles.length ? " …" : "";
				block.createDiv({
					cls: "marinmind-review-ctx-sub",
					text: `子节点 ${entry.childCount} 个：${entry.childTitles.join(" · ")}${more}`,
				});
			}
			if (entry.siblingCount > 0) {
				block.createDiv({
					cls: "marinmind-review-ctx-sub",
					text: `同级 ${entry.siblingCount} 个节点`,
				});
			}
		}
	}

	private renderDone(stage: HTMLElement, s: ReviewSession): void {
		const done = stage.createDiv({ cls: "marinmind-review-done" });
		// 两种末尾态：真正考完（isDone）vs 一路 ▶ 浏览到末尾还没考（仍有待考卡）
		done.createDiv({
			cls: "marinmind-review-done-title",
			text: s.isDone ? "本组复习完成 🎉" : `已浏览到末尾 · 还有 ${s.remaining} 张待考`,
		});
		const stats = done.createDiv({ cls: "marinmind-review-stats" });
		for (const { grade, label } of GRADES) {
			const cell = stats.createDiv({ cls: "marinmind-review-stat" });
			cell.createDiv({ cls: "marinmind-review-stat-num", text: String(s.stats[grade]) });
			cell.createDiv({ cls: "marinmind-review-stat-label", text: label });
		}
		done.createDiv({
			cls: "marinmind-review-hint",
			text: `共评分 ${s.stats.total} 次（"重来"的卡片会在同组重现）`,
		});
		const more = done.createEl("button", {
			cls: "marinmind-review-link",
			text: "再查一批到期卡片",
		});
		more.addEventListener("click", () => void this.startSession());
		// 69 统计面板入口：复习收尾正是看回顾的时刻（快照渲染，重开即新）
		if (this.plugin.store) {
			const stats = done.createEl("button", {
				cls: "marinmind-review-link",
				text: "查看统计面板",
			});
			stats.addEventListener("click", () => {
				new ReviewStatsModal(this.app, this.plugin).open();
			});
		}
		// 范围限定下的切换入口（与 Empty 屏一致）
		if (this.reviewScope !== null) {
			const all = done.createEl("button", {
				cls: "marinmind-review-link",
				text: "考全部书籍",
			});
			all.addEventListener("click", () => void this.startSession(null));
		}
		if (this.plugin.store) {
			const deck = done.createEl("button", {
				cls: "marinmind-review-link",
				text: "按卡组复习…",
			});
			deck.addEventListener("click", () => {
				new DeckPickerModal(this.app, this.plugin, (name) => {
					void this.startSession({ kind: "deck", deck: name });
				}).open();
			});
		}
		// 未考完的浏览末尾：一键回到待考卡继续；考完后 ◀ 回看本组已考的卡（浏览态只读）
		if (!s.isDone) {
			const back = done.createEl("button", {
				cls: "marinmind-review-link",
				text: "▶ 回到待考卡",
			});
			back.addEventListener("click", () => this.navigate(() => s.jumpToPending()));
		} else if (s.canPrev) {
			const back = done.createEl("button", {
				cls: "marinmind-review-link",
				text: "◀ 回看本组卡片",
			});
			back.addEventListener("click", () => this.navigate(() => s.goPrev()));
		}
	}

	/**
	 * 70 卡片组列表（左侧面板）：排序（队列/文档/文本）+ 筛选（书籍/颜色）下拉 +
	 * 行列表（状态徽标 + 标题单行省略；点击 goTo 跳转浏览位置——已评分下标自动只读态）。
	 * 排序/筛选只经 buildSessionRows 重排行序与可见性，**不动队列本体**；
	 * 徽标：已考显档位（重来红）、again 重现实例（同卡第二条）↻、未考 ○。
	 */
	private renderSessionList(panel: HTMLElement, s: ReviewSession): void {
		const head = panel.createDiv({ cls: "marinmind-review-list-head" });
		const sortSel = new DropdownComponent(head)
			.addOption("queue", "队列序")
			.addOption("document", "文档序")
			.addOption("text", "文本序");
		sortSel.setValue(this.listSort);
		sortSel.onChange((v) => {
			this.listSort = v === "document" || v === "text" ? v : "queue";
			this.render();
		});
		// 筛选下拉 value 空间："" 全部（→ undefined 不过滤）/ 哨兵（→ null 对应
		// SessionListFilter 的「自由卡片」「未设色」语义）/ 实际值
		const docSel = new DropdownComponent(head).addOption("", "全部书籍");
		for (const d of this.plugin.documents.list()) {
			docSel.addOption(d.id, d.title);
		}
		docSel.addOption(FREE_DOC_KEY, "自由卡片");
		docSel.setValue(
			this.listFilter.documentId === undefined
				? ""
				: this.listFilter.documentId === null
					? FREE_DOC_KEY
					: this.listFilter.documentId,
		);
		docSel.onChange((v) => {
			this.listFilter.documentId = v === "" ? undefined : v === FREE_DOC_KEY ? null : v;
			this.render();
		});
		// 颜色候选从会话队列实际卡片派生（四色 + 旧色相 + 未设色）
		const colorSel = new DropdownComponent(head).addOption("", "全部颜色");
		const colors = new Set<string>();
		let hasUnset = false;
		for (const c of s.cards) {
			if (c.color) colors.add(c.color);
			else hasUnset = true;
		}
		for (const c of [...colors].sort((a, b) => a.localeCompare(b))) {
			colorSel.addOption(c, colorOptionLabel(c));
		}
		if (hasUnset) {
			colorSel.addOption(NO_COLOR_KEY, "未设色");
		}
		colorSel.setValue(
			this.listFilter.color === undefined
				? ""
				: this.listFilter.color === null
					? NO_COLOR_KEY
					: this.listFilter.color,
		);
		colorSel.onChange((v) => {
			this.listFilter.color = v === "" ? undefined : v === NO_COLOR_KEY ? null : v;
			this.render();
		});

		const body = panel.createDiv({ cls: "marinmind-review-list-body" });
		const rows = buildSessionRows(s.cards, this.listSort, this.listFilter);
		if (rows.length === 0) {
			body.createDiv({ cls: "marinmind-review-list-empty", text: "当前筛选下没有卡片" });
			return;
		}
		for (const { index, card } of rows) {
			const row = body.createDiv({ cls: "marinmind-review-list-row" });
			if (index === s.positionNo) {
				row.addClass("is-current");
			}
			const grade = s.gradeOf(index);
			const badge = row.createDiv({ cls: "marinmind-review-list-badge" });
			if (grade) {
				badge.dataset.grade = grade;
				badge.textContent = GRADE_LABELS[grade];
			} else {
				// again 重现实例（同卡 id 已在更早下标出现；重现实例恒晚于原实例）
				const requeue = s.cards.some((c, i) => i < index && c.id === card.id);
				badge.textContent = requeue ? "↻" : "○";
				if (requeue) {
					badge.addClass("is-requeue");
				}
			}
			row.createDiv({
				cls: "marinmind-review-list-title",
				text: sessionRowTitle(card) || mediaLabel(card),
			});
			row.addEventListener("click", () => {
				s.goTo(index);
				this.contextTab = null; // 跳转换卡收起上下文（navigate 同语义）
				this.render();
			});
		}
	}

	/**
	 * 范围 chip（卡组批书名下沉）：书名/卡组名/范围名胶囊 + × 切回全部书籍。
	 * 复用 .marinmind-review-scope 三件类（胶囊 + name 省略 + × 不缩，CSS 零改动）；
	 * deck 范围显示卡组名（无书名号）、cards 范围显示调用方给的 label。
	 */
	private renderScopeChip(meta: HTMLElement): void {
		if (this.reviewScope === null) {
			return;
		}
		const name =
			this.reviewScope.kind === "book"
				? `《${this.plugin.documents.get(this.reviewScope.docId)?.title ?? "已删除文档"}》`
				: this.reviewScope.kind === "cards"
					? this.reviewScope.label
					: this.reviewScope.deck;
		const chip = meta.createEl("button", {
			cls: "marinmind-review-scope",
			attr: {
				type: "button",
				title:
					this.reviewScope.kind === "book"
						? "当前只复习本书 · 点击切换为全部书籍"
						: this.reviewScope.kind === "cards"
							? "当前只复习该范围 · 点击切换为全部书籍"
							: "当前只复习本组 · 点击切换为全部书籍",
			},
		});
		chip.createSpan({ cls: "marinmind-review-scope-name", text: name });
		chip.createSpan({ cls: "marinmind-review-scope-x", text: "×" });
		chip.addEventListener("click", () => {
			new Notice("已切换为全部书籍的到期卡片");
			void this.startSession(null);
		});
	}

	/**
	 * ⋯ 管理菜单（卡组批 + 65 批注）：查看卡片 / 编辑批注 / 打标签 / 设卡组 / 删除。
	 * 四类编辑动作与卡片预览弹窗经 card-actions 单源共享（行为不分叉）；
	 * 删除的会话剔除与重渲染由 cardBus removed 订阅完成，这里不手动 render。
	 */
	private openManageMenu(evt: MouseEvent, card: Card): void {
		const menu = new Menu();
		menu.addItem((item) =>
			item
				.setTitle("查看卡片")
				.setIcon("eye")
				.onClick(() => {
					new CardPreviewModal(
						this.app,
						this.plugin,
						this.plugin.cards?.get(card.id) ?? card,
					).open();
				}),
		);
		menu.addItem((item) =>
			item
				.setTitle("编辑批注…")
				.setIcon("pencil")
				.onClick(() => promptCardNote(this.app, this.plugin, card)),
		);
		menu.addItem((item) =>
			item
				.setTitle("打标签…")
				.setIcon("tags")
				.onClick(() => promptCardTags(this.app, this.plugin, card)),
		);
		menu.addItem((item) =>
			item
				.setTitle("设置卡组…")
				.setIcon("layers")
				.onClick(() => promptCardDeck(this.app, this.plugin, card)),
		);
		menu.addSeparator();
		menu.addItem((item) =>
			item
				.setTitle("删除卡片")
				.setIcon("trash-2")
				.onClick(() => {
					new ConfirmModal(
						this.app,
						"删除卡片",
						"将同时删除附件、双向链接与脑图中的对应节点，且无法恢复。",
						() => deleteCardCascade(this.plugin, card),
					).open();
				}),
		);
		menu.showAtMouseEvent(evt);
	}

	/** 浏览导航统一入口：移动成功才重渲染（换卡收起上下文，保住"先回忆"） */
	private navigate(move: () => boolean): void {
		if (move()) {
			this.contextTab = null;
			this.render();
		}
	}

	private grade(grade: ReviewGrade): void {
		if (this.session?.grade(grade)) {
			this.contextTab = null;
			this.render();
		}
	}

	/**
	 * 67 撤销上次评分：session 回退会话态（计数/graded/again 重现实例出队/落回被撤销
	 * 卡未翻面态），视图快照栈回退 DB 态（restoreReview 直写评分前快照 = 时间倒流 +
	 * 日志镜像递减）。双栈失配（理论不可达——压栈同一同步闭包）全清放弃宁拒不赌。
	 */
	private undoLastGrade(): void {
		const s = this.session;
		if (!s) {
			return;
		}
		const step = s.undoLast();
		if (!step) {
			return; // 空栈或重现实例防御失败（session 已自还原）
		}
		const snap = this.undoSnapshots.pop();
		if (!snap || snap.cardId !== step.cardId || snap.grade !== step.grade) {
			this.undoSnapshots.length = 0;
			new Notice("撤销状态异常，已重置撤销历史");
		} else if (snap.before) {
			this.plugin.reviews.restoreReview(snap.before, snap.ts, snap.grade);
		}
		this.contextTab = null;
		this.render();
	}

	/** 键盘：← → 浏览切换；Space/Enter 翻面，1-4 评分；Ctrl+Z 撤销上次评分（67） */
	private onKeydown(evt: KeyboardEvent): void {
		// 仅当前激活标签页响应（后台复习标签页不误触）
		if (this.app.workspace.activeLeaf !== this.leaf) {
			return;
		}
		const target = evt.target as HTMLElement | null;
		const inInput =
			!!target &&
			(target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable);
		// 67 撤销评分：Ctrl/Cmd+Z（不带 Shift；输入态让位原生文本撤销）。必须在
		// 组合键早退之前分支——z 会先被吞掉；session 判空挪到 undoLastGrade 内部
		if ((evt.ctrlKey || evt.metaKey) && !evt.shiftKey && !evt.altKey && evt.key.toLowerCase() === "z") {
			if (inInput) {
				return;
			}
			evt.preventDefault();
			this.undoLastGrade();
			return;
		}
		if (evt.ctrlKey || evt.metaKey || evt.altKey) {
			return;
		}
		if (inInput) {
			return; // 前台 Modal / 输入框聚焦态
		}
		const s = this.session;
		if (!s) {
			return;
		}
		if (evt.key === "ArrowLeft" || evt.key === "ArrowRight") {
			// 方向键浏览切换（完成屏也可 ◀ 回看）；阻断默认避免页面滚动
			evt.preventDefault();
			this.navigate(evt.key === "ArrowLeft" ? () => s.goPrev() : () => s.goNext());
			return;
		}
		if (!s.isCurrentPending) {
			return; // 浏览态/完成态：翻面与评分键不接管
		}
		if (evt.key === " " || evt.key === "Enter") {
			// keydown 级阻断默认行为：防 Space 触发聚焦按钮 click 与页面滚动
			evt.preventDefault();
			if (!s.isRevealed) {
				s.reveal();
				this.render();
			}
			return;
		}
		const grade = GRADE_KEYS[evt.key];
		if (s.isRevealed && grade) {
			evt.preventDefault();
			this.grade(grade);
		}
	}

	/** 附件 → blob URL（同 ref 复用；onClose 统一 revoke） */
	private mediaUrl(ref: string): Promise<string> {
		const cached = this.mediaUrls.get(ref);
		if (cached) {
			return Promise.resolve(cached);
		}
		return this.plugin.attachments.read(ref).then((bytes) => {
			let url = this.mediaUrls.get(ref);
			if (!url) {
				url = URL.createObjectURL(new Blob([bytes]));
				this.mediaUrls.set(ref, url);
			}
			return url;
		});
	}

	async onClose(): Promise<void> {
		// cardBus 退订（constructor 订阅的镜像清理——视图关闭后不再响应改卡/删卡）
		for (const off of this.cardBusOffs.splice(0)) {
			off();
		}
		// 会话内缓存的 blob URL 统一回收（翻页渲染不回收，靠这里兜底）
		for (const url of this.mediaUrls.values()) {
			URL.revokeObjectURL(url);
		}
		this.mediaUrls.clear();
		// 遮挡正面管线创建的 blob URL（㊷）
		for (const url of this.occlusionUrls) {
			URL.revokeObjectURL(url);
		}
		this.occlusionUrls.clear();
		// 上下文渲染器缓存的 PDF 文档释放（worker 侧通道）
		await this.context.destroy();
	}
}
