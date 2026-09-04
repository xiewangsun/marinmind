import { ButtonComponent, Modal, Notice } from "obsidian";
import type { App } from "obsidian";
import type MarinMindPlugin from "../main";
import { ConfirmModal } from "../mindmap/confirm-modal";
import type { Card } from "../types";
import { CardEditModal } from "../home/card-edit-modal";
import { pageWordOf } from "../storage/paths";
import { snapshotImgSize } from "./rect-utils";
import { formatDurSec } from "./audio-recorder";

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

/** 预览弹窗对宿主视图的回调（同步快照 / 删除联动徽标与附件 / 重录） */
export interface MediaPreviewHooks {
	/** 卡片被修改（编辑标题批注 / 闪卡开关）后同步宿主缓存 */
	onUpdated?(card: Card): void;
	/** 删除卡片（由宿主处理附件级联与徽标更新） */
	onDelete(card: Card): void;
	/** 重录语音（84-B，audio 卡）：删旧建新由宿主处理；宿主未接线时不显示重录钮 */
	onRerecord?(card: Card): void;
	/** 照片定位到页面（84-D，photo 卡）：宿主进入重定位模式；未接线时不显示定位钮 */
	onRelocate?(card: Card): void;
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
		/** 78 起内部引用随编辑保存更新（update 产新对象，不跟随则批注显示停留旧值） */
		private card: Card,
		private readonly hooks: MediaPreviewHooks,
	) {
		super(app);
	}

	async onOpen(): Promise<void> {
		const { contentEl } = this;
		contentEl.addClass("marinmind-media-preview");
		// ㊼ 页码量词随所属文档格式（epub 章=页模型）；文档失联/手工卡兜底「页」
		const doc = this.card.documentId
			? this.plugin.documents.get(this.card.documentId)
			: undefined;
		// 84-B 时长进标题（dur 为权威——webm 容器无时长元数据时 <audio> 控件可能显示 NaN）
		const dur =
			this.card.excerptType === "audio" &&
			typeof this.card.durationSec === "number" &&
			this.card.durationSec > 0
				? ` · ${formatDurSec(this.card.durationSec)}`
				: "";
		contentEl.createDiv({
			cls: "marinmind-media-preview-title",
			text: `${mediaLabel(this.card)}${dur}${this.card.page != null ? ` · 第 ${this.card.page} ${doc ? pageWordOf(doc.filePath) : "页"}` : ""}`,
		});
		this.noteEl = contentEl.createDiv({ cls: "marinmind-media-preview-note" });
		this.renderNote();
		// 85-D 摘录只读块：手写卡的 OCR 识别文字存 excerptText（弹窗标题行是形态
		// 标签非 cardPreview，note/excerpt 均无被标题吸收问题）——非空即显示
		const excerptText = this.card.excerptText?.trim();
		if (excerptText) {
			const block = contentEl.createDiv({ cls: "marinmind-media-preview-excerpt" });
			block.createDiv({ cls: "marinmind-media-preview-excerpt-label", text: "摘录（只读）" });
			block.createDiv({ cls: "marinmind-media-preview-excerpt-body", text: excerptText });
		}

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
					// R3（W-02）：按 rects 包围盒预留宽高比（photo 兜底 4:3）——防加载后布局跳动
					const size = snapshotImgSize(this.card);
					img.width = size.width;
					img.height = size.height;
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
					this.hooks.onUpdated?.(updated);
				}
				new Notice(isFlashcard ? "已取消闪卡" : "已转为闪卡");
				this.close();
			});
		new ButtonComponent(actions).setButtonText("编辑标题/批注").onClick(() => {
			// 78 统一双字段入口：保存后跟随最新卡（渲染批注 + 同步宿主缓存）
			new CardEditModal(this.app, this.plugin, this.card, (updated) => {
				this.card = updated;
				this.hooks.onUpdated?.(updated);
				this.renderNote();
			}).open();
		});
		// 84-B 重录（仅 audio 卡且宿主接线了 onRerecord——reader 内删旧建新，
		// home/复习等外部位不接线则不显示）
		if (this.card.excerptType === "audio" && this.hooks.onRerecord) {
			new ButtonComponent(actions).setButtonText("重录").setWarning().onClick(() => {
				new ConfirmModal(
					this.app,
					"重录语音",
					"删除当前语音并立即开始新录音？（旧卡的标题/批注/复习进度不会保留）",
					() => {
						this.hooks.onRerecord?.(this.card);
					},
				).open();
			});
		}
		// 84-D 照片定位（仅 photo 卡且宿主接线了 onRelocate——reader 进重定位模式；
		// home/复习等外部位不接线则不显示）；已定位可取消（rects 清空回徽标锚定）
		if (this.card.excerptType === "photo" && this.hooks.onRelocate) {
			new ButtonComponent(actions)
				.setButtonText("定位到页面…")
				.onClick(() => {
					this.close();
					this.hooks.onRelocate?.(this.card);
				});
			if (this.card.rects.length > 0) {
				new ButtonComponent(actions).setButtonText("取消定位").onClick(() => {
					this.plugin.cards.update(this.card.id, { rects: [] });
					this.close();
				});
			}
		}
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
