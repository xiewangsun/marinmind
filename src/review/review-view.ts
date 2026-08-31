import { ItemView, Notice, setIcon } from "obsidian";
import type { WorkspaceLeaf } from "obsidian";
import type MarinMindPlugin from "../main";
import type { BookDocument, Card, DocRect, MindmapNodeWithCard, ReviewGrade } from "../types";
import { ReviewSession } from "./review-session";
import { ContextPreviewRenderer } from "./context-preview";
import { buildMapContext } from "./map-context";
import { occlusionBounds, occlusionPercent } from "../reader/rect-utils";
import { renderExcerptVisual } from "../reader/excerpt-visual";
import { highlightFallbackColor, highlightLineColor } from "../reader/highlight-colors";
import { pageWordOf } from "../storage/paths";

/** 复习视图的 viewType */
export const REVIEW_VIEW_TYPE = "marinmind-review";

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
 * - 按书范围：scopeDocId 限定到期快照（阅读器入口传当前书），顶部徽标可切全部书籍
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
	/** 复习范围文档 id（㊷）：null = 全部书籍；阅读器「复习」入口按书传入 */
	private scopeDocId: string | null = null;
	/** 遮挡正面经 excerpt-visual 管线创建的 blob URL（onClose 统一 revoke；换卡重渲染不逐个回收，会话量小） */
	private readonly occlusionUrls = new Set<string>();

	constructor(leaf: WorkspaceLeaf, plugin: MarinMindPlugin) {
		super(leaf);
		this.plugin = plugin;
		this.context = new ContextPreviewRenderer(plugin);
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
	 * scope（㊷）：undefined = 保持当前范围（视图内"再查一批"沿用）；null = 清为全部
	 * 书籍；string = 限定该书（阅读器入口按书传入）。
	 */
	async startSession(scope?: string | null): Promise<void> {
		if (scope !== undefined) {
			this.scopeDocId = scope;
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
		this.session = new ReviewSession(
			// ㊷ 按书过滤：scoped 时只拉该书到期卡（书被删后 due 自然回空，徽标显示"已删除文档"）
			this.plugin.reviews.due(undefined, undefined, this.scopeDocId ?? undefined),
			(cardId, grade) => {
				// 卡片可能在会话中被删除：review 返回 undefined 被忽略，会话照常推进
				this.plugin.reviews.review(cardId, grade);
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
		const stage = this.contentEl.createDiv({ cls: "marinmind-review-stage" });
		const card = s.current;
		if (!card) {
			if (s.total === 0) {
				this.renderMessage(
					this.scopeDocId ? "本书当前没有到期闪卡 🎉" : "当前没有到期卡片 🎉",
					stage,
				);
			} else {
				this.renderDone(stage, s);
			}
			return;
		}
		this.renderCard(stage, s, card);
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
		// ㊷ 按书范围下加"考全部书籍"入口（Empty 屏 / 数据层未就绪共用）
		if (this.scopeDocId) {
			const all = box.createEl("button", {
				cls: "marinmind-review-link",
				text: "考全部书籍",
			});
			all.addEventListener("click", () => void this.startSession(null));
		}
	}

	private renderCard(stage: HTMLElement, s: ReviewSession, card: Card): void {
		const doc = card.documentId ? this.plugin.documents.get(card.documentId) : undefined;
		// 浏览到已考过的卡：直接显示正反面（只读）；待考卡按翻面态；未考预览只显示正面
		const showBack = s.isRevealed || s.gradedAt != null;

		// 顶部导航条：◀ 第 i/N 张 ▶ …… ↗ 原文（正面即可跳转，MN4 文档栏入口）
		const topbar = stage.createDiv({ cls: "marinmind-review-topbar" });
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
		// ㊷ 按书范围徽标：显示当前限定书籍，点击 × 切全部书籍
		if (this.scopeDocId) {
			const scopeDoc = this.plugin.documents.get(this.scopeDocId);
			const badge = topbar.createEl("button", {
				cls: "marinmind-review-scope",
				attr: {
					type: "button",
					title: "当前只复习本书 · 点击切换为全部书籍",
				},
			});
			badge.createSpan({ cls: "marinmind-review-scope-name", text: `《${scopeDoc?.title ?? "已删除文档"}》` });
			badge.createSpan({ cls: "marinmind-review-scope-x", text: "×" });
			badge.addEventListener("click", () => {
				new Notice("已切换为全部书籍的到期卡片");
				void this.startSession(null);
			});
		}
		topbar.createEl("div", { cls: "marinmind-review-topbar-spacer" });
		if (doc && card.documentId && card.page != null) {
			const jump = topbar.createEl("button", { cls: "marinmind-review-link" });
			// P2-1 图标语言统一：字符 ↗ → lucide arrow-up-right（与脑图节点编辑器/主页预览弹窗同款）
			setIcon(jump.createSpan({ cls: "marinmind-review-link-icon" }), "arrow-up-right");
			jump.createSpan({ text: "原文" });
			jump.addEventListener("click", () => void this.plugin.openCardSource(card));
		}

		const meta = stage.createDiv({ cls: "marinmind-review-meta" });
		meta.textContent =
			`${doc ? `《${doc.title}》` : "自由卡片"}` +
			`${card.page != null ? ` · 第 ${card.page} ${doc ? pageWordOf(doc.filePath) : "页"}` : ""} · 剩余 ${s.remaining} 张`;

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
				this.render();
			});
		}
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
		// ㊷ 按书范围下的切换入口（与 Empty 屏一致）
		if (this.scopeDocId) {
			const all = done.createEl("button", {
				cls: "marinmind-review-link",
				text: "考全部书籍",
			});
			all.addEventListener("click", () => void this.startSession(null));
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

	/** 键盘：← → 浏览切换；Space/Enter 翻面，1-4 评分（仅待考卡；组合键与输入态不接管） */
	private onKeydown(evt: KeyboardEvent): void {
		// 仅当前激活标签页响应（后台复习标签页不误触）
		if (this.app.workspace.activeLeaf !== this.leaf) {
			return;
		}
		if (evt.ctrlKey || evt.metaKey || evt.altKey) {
			return;
		}
		const target = evt.target as HTMLElement | null;
		if (
			target &&
			(target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable)
		) {
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
