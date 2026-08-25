import { ButtonComponent, Modal, Notice } from "obsidian";
import type { App } from "obsidian";
import type MarinMindPlugin from "../main";
import type { Card } from "../types";
import { TextPromptModal } from "./note-edit-modal";

/** 照片/语音摘录的形态标签 */
function mediaLabel(card: Card): string {
	if (card.excerptType === "audio") {
		return "语音摘录";
	}
	if (card.excerptType === "handwriting") {
		return "手写摘录";
	}
	return "照片摘录";
}

/** 预览弹窗对宿主视图的回调（同步快照 / 删除联动徽标与附件） */
export interface MediaPreviewHooks {
	/** 卡片被修改（编辑批注 / 闪卡开关）后同步宿主缓存 */
	onUpdated(card: Card): void;
	/** 删除卡片（由宿主处理附件级联与徽标更新） */
	onDelete(card: Card): void;
}

/**
 * 媒体卡片查看弹窗：img / audio 控件 + 批注 + 管理按钮。
 * blob URL 在 onClose 统一 revoke（Modal 可反复开关，每次新建一次性 URL）。
 */
export class MediaPreviewModal extends Modal {
	private objectUrl: string | null = null;
	private noteEl: HTMLElement | null = null;

	constructor(
		app: App,
		private readonly plugin: MarinMindPlugin,
		private readonly card: Card,
		private readonly hooks: MediaPreviewHooks,
	) {
		super(app);
	}

	async onOpen(): Promise<void> {
		const { contentEl } = this;
		contentEl.addClass("marinmind-media-preview");
		contentEl.createDiv({
			cls: "marinmind-media-preview-title",
			text: `${mediaLabel(this.card)}${this.card.page != null ? ` · 第 ${this.card.page} 页` : ""}`,
		});
		this.noteEl = contentEl.createDiv({ cls: "marinmind-media-preview-note" });
		this.renderNote();

		const ref = this.card.excerptRef;
		if (!ref) {
			contentEl.createDiv({ cls: "marinmind-media-preview-missing", text: "（附件缺失）" });
		} else {
			try {
				const bytes = await this.plugin.attachments.read(ref);
				if (!contentEl.isConnected) {
					return; // 关闭竞态：视图已拆
				}
				const url = URL.createObjectURL(new Blob([bytes]));
				this.objectUrl = url;
				if (this.card.excerptType === "audio") {
					const audio = contentEl.createEl("audio", { cls: "marinmind-review-media" });
					audio.controls = true;
					audio.src = url;
				} else {
					const img = contentEl.createEl("img", { cls: "marinmind-review-media" });
					img.alt = mediaLabel(this.card);
					img.src = url;
				}
			} catch (err) {
				console.warn("[MarinMind] 附件读取失败", err);
				contentEl.createDiv({ text: "附件读取失败（文件可能已被移动或删除）" });
			}
		}

		// 管理操作
		const actions = contentEl.createDiv({ cls: "marinmind-note-actions" });
		const isFlashcard = this.plugin.reviews.get(this.card.id)?.isFlashcard ?? false;
		new ButtonComponent(actions)
			.setButtonText(isFlashcard ? "取消闪卡" : "转为闪卡")
			.onClick(() => {
				if (isFlashcard) {
					this.plugin.reviews.disable(this.card.id);
				} else {
					this.plugin.reviews.enable(this.card.id);
				}
				const updated = this.plugin.cards.get(this.card.id);
				if (updated) {
					this.hooks.onUpdated(updated);
				}
				new Notice(isFlashcard ? "已取消闪卡" : "已转为闪卡");
				this.close();
			});
		new ButtonComponent(actions).setButtonText("编辑批注").onClick(() => {
			new TextPromptModal(
				this.app,
				{ title: "编辑批注", initialText: this.card.note ?? "" },
				(note) => {
					const updated = this.plugin.cards.update(this.card.id, { note });
					if (updated) {
						this.hooks.onUpdated(updated);
						this.renderNote();
					}
				},
			).open();
		});
		new ButtonComponent(actions).setButtonText("删除卡片").setWarning().onClick(() => {
			this.hooks.onDelete(this.card);
			this.close();
		});
	}

	private renderNote(): void {
		if (this.noteEl) {
			this.noteEl.textContent = this.card.note ?? "";
			this.noteEl.classList.toggle("is-empty", !this.card.note);
		}
	}

	onClose(): Promise<void> {
		if (this.objectUrl) {
			URL.revokeObjectURL(this.objectUrl);
			this.objectUrl = null;
		}
		this.contentEl.empty();
		return Promise.resolve();
	}
}
