import { ItemView, Notice, TFile } from "obsidian";
import type { WorkspaceLeaf } from "obsidian";
import type MarinMindPlugin from "../main";
import type { Card, ReviewGrade } from "../types";
import { ReviewSession } from "./review-session";

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

/** 媒体形态的正面标签 */
function mediaLabel(card: Card): string {
	if (card.excerptType === "audio") {
		return "语音摘录";
	}
	if (card.excerptType === "handwriting") {
		return "手写摘录";
	}
	return "照片摘录";
}

/**
 * MarinMind 复习视图：到期闪卡的翻面 + 四档评分 + 跳转原文。
 *
 * 状态机：Empty（无到期/DB 未就绪）→ Front（正面）→ Back（翻面，可评分）→ Done（统计），
 * 每次评分后整体重渲染（视图简单，不做局部更新）。
 * 会话为 due 快照：again 卡由 ReviewSession 本地队尾重现，DB 侧 SM-2 照常调度。
 */
export class MarinMindReviewView extends ItemView {
	private readonly plugin: MarinMindPlugin;
	private session: ReviewSession | null = null;
	/** excerptRef → blob URL（同 ref 复用；onClose 统一 revoke，翻页渲染不回收） */
	private readonly mediaUrls = new Map<string, string>();

	constructor(leaf: WorkspaceLeaf, plugin: MarinMindPlugin) {
		super(leaf);
		this.plugin = plugin;
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

	/** 拉取到期快照并重建会话（onOpen 首次 + 命令复用标签页重启都走这里） */
	async startSession(): Promise<void> {
		this.contentEl.empty();
		this.contentEl.classList.add("marinmind-review");
		await this.plugin.whenReady();
		if (!this.plugin.db) {
			this.session = null;
			this.renderMessage("数据库未就绪，无法复习。");
			return;
		}
		this.session = new ReviewSession(
			this.plugin.reviews.due(),
			(cardId, grade) => {
				// 卡片可能在会话中被删除：review 返回 undefined 被忽略，会话照常推进
				this.plugin.reviews.review(cardId, grade);
			},
		);
		this.render();
	}

	// ---------- 内部实现 ----------

	private render(): void {
		const s = this.session;
		if (!s) {
			return;
		}
		const stage = this.contentEl.createDiv({ cls: "marinmind-review-stage" });
		if (s.isDone) {
			if (s.stats.total === 0) {
				this.renderMessage("当前没有到期卡片 🎉", stage);
			} else {
				this.renderDone(stage, s);
			}
			return;
		}
		this.renderCard(stage, s);
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
	}

	private renderCard(stage: HTMLElement, s: ReviewSession): void {
		const card = s.current;
		if (!card) {
			return;
		}
		const doc = card.documentId ? this.plugin.documents.get(card.documentId) : undefined;

		const meta = stage.createDiv({ cls: "marinmind-review-meta" });
		meta.textContent =
			`${doc ? `《${doc.title}》` : "自由卡片"}` +
			`${card.page != null ? ` · 第 ${card.page} 页` : ""} · 剩余 ${s.remaining} 张`;

		const cardBox = stage.createDiv({ cls: "marinmind-review-card" });
		// 正面：text 卡显示摘录文字；媒体卡显示 img / audio；其余形态显示占位提示
		if (card.excerptText) {
			const excerpt = cardBox.createDiv({ cls: "marinmind-review-excerpt" });
			excerpt.textContent = card.excerptText;
		} else if (card.excerptRef) {
			// fire-and-forget 加载附件：渲染后视图可能立刻被翻页重绘，isConnected 守卫丢弃
			if (card.excerptType === "audio") {
				const audio = cardBox.createEl("audio", { cls: "marinmind-review-media" });
				audio.controls = true;
				audio.preload = "metadata";
				void this.mediaUrl(card.excerptRef).then((url) => {
					if (audio.isConnected) {
						audio.src = url;
					}
				});
			} else {
				const img = cardBox.createEl("img", { cls: "marinmind-review-media" });
				img.alt = mediaLabel(card);
				void this.mediaUrl(card.excerptRef).then((url) => {
					if (img.isConnected) {
						img.src = url;
					}
				});
			}
			const ph = cardBox.createDiv({ cls: "marinmind-review-placeholder" });
			ph.textContent =
				card.page != null
					? `${mediaLabel(card)} · 第 ${card.page} 页`
					: mediaLabel(card);
		} else {
			const ph = cardBox.createDiv({ cls: "marinmind-review-placeholder" });
			ph.textContent = card.page != null ? `区域摘录 · 第 ${card.page} 页` : "区域摘录";
		}

		// 背面：批注 + 出处 + 跳转原文
		if (s.isRevealed) {
			const back = cardBox.createDiv({ cls: "marinmind-review-back" });
			const note = back.createDiv({ cls: "marinmind-review-note" });
			if (card.note) {
				note.textContent = card.note;
			} else {
				note.textContent = "（暂无批注）";
				note.classList.add("marinmind-review-placeholder");
			}
			const source = back.createDiv({ cls: "marinmind-review-source" });
			source.textContent = doc
				? `《${doc.title}》${card.page != null ? ` · 第 ${card.page} 页` : ""}`
				: "无出处信息";
			if (doc && card.documentId && card.page != null) {
				const jump = source.createEl("button", {
					cls: "marinmind-review-link",
					text: "↗ 跳转原文",
				});
				jump.addEventListener("click", () => void this.jumpToSource(card));
			}
		}

		// 操作区：未翻面 = 翻面按钮；已翻面 = 四档评分
		const actions = stage.createDiv({ cls: "marinmind-review-actions" });
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

		const hint = stage.createDiv({ cls: "marinmind-review-hint" });
		hint.textContent = s.isRevealed ? "按 1-4 评分" : "空格 / 回车 翻面";
	}

	private renderDone(stage: HTMLElement, s: ReviewSession): void {
		const done = stage.createDiv({ cls: "marinmind-review-done" });
		done.createDiv({ cls: "marinmind-review-done-title", text: "本组复习完成 🎉" });
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
	}

	private grade(grade: ReviewGrade): void {
		if (this.session?.grade(grade)) {
			this.render();
		}
	}

	/** 键盘：Space/Enter 翻面，1-4 评分（仅翻面后）；组合键与输入态不接管 */
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
		if (!s || s.isDone) {
			return;
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

	async onClose(): Promise<void> {
		// 会话内缓存的 blob URL 统一回收（翻页渲染不回收，靠这里兜底）
		for (const url of this.mediaUrls.values()) {
			URL.revokeObjectURL(url);
		}
		this.mediaUrls.clear();
	}
}
