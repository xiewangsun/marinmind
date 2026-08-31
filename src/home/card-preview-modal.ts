import { ButtonComponent, Modal } from "obsidian";
import type { App } from "obsidian";
import type MarinMindPlugin from "../main";
import type { Card } from "../types";
import { pageWordOf } from "../storage/paths";
import { cardPreview, EXCERPT_LABELS } from "./home-data";
import { highlightFallbackColor } from "../reader/highlight-colors";
import { renderExcerptVisual } from "../reader/excerpt-visual";

/**
 * 卡片摘录预览弹窗（㶈）：主页点卡片**先弹预览**——只显示摘录区域本身
 * （媒体附件图 / 原文页裁剪窗口 + 高亮标示），需要时再点「跳原文」进阅读器。
 *
 * 视觉三级回退（㊷ 起管线抽至 src/reader/excerpt-visual.ts，与复习遮挡正面共用）：
 * 1. 媒体附件（photo/audio/handwriting/area/lasso 的 excerptRef）；
 * 2. 原文页裁剪（text/blank 卡走此路，带少量上下文）；
 * 3. 文本兜底（附件缺失且无 rects 的 photo/audio）。
 *
 * 标题与主页列表同源（cardPreview：批注 > 摘录文字 > 形态占位）；批注存在时
 * 摘录文字另列原文块（批注=问题、摘录=答案，与复习正反面同语义）。
 * blob URL 在 onClose 统一 revoke（镜像 MediaPreviewModal）。
 */

export class CardPreviewModal extends Modal {
	private objectUrl: string | null = null;

	constructor(
		app: App,
		private readonly plugin: MarinMindPlugin,
		private readonly card: Card,
	) {
		super(app);
	}

	async onOpen(): Promise<void> {
		const { contentEl } = this;
		contentEl.addClass("marinmind-card-preview");
		// P1-b 墨色随卡走：弹窗身份色（标题左缘墨线由 CSS 按 data-color 消费令牌）
		contentEl.dataset.color = highlightFallbackColor(this.card);

		// 标题 + 出处（形态标签让 text/blank 与媒体卡语义一致）
		const doc = this.card.documentId ? this.plugin.documents.get(this.card.documentId) : undefined;
		contentEl.createDiv({ cls: "marinmind-card-preview-title", text: cardPreview(this.card) });
		contentEl.createDiv({
			cls: "marinmind-card-preview-meta",
			text: doc
				? `《${doc.title}》${this.card.page != null ? ` · 第 ${this.card.page} ${pageWordOf(doc.filePath)}` : ""} · ${EXCERPT_LABELS[this.card.excerptType]}`
				: `手工卡片 · ${EXCERPT_LABELS[this.card.excerptType]}`,
		});

		// 视觉主体（异步三级回退，㊷ 起与复习遮挡正面共用管线）
		const body = contentEl.createDiv({ cls: "marinmind-card-preview-body" });
		void this.renderVisual(body);

		// 有批注且摘录文字非空时另列原文块（标题=批注不重复展示；与复习背面同语义）
		if (this.card.note?.trim() && this.card.excerptText?.trim()) {
			contentEl.createDiv({
				cls: "marinmind-card-preview-excerpt",
				text: this.card.excerptText.trim(),
			});
		}

		// 操作行：复制互链（㊻-A，任何卡可复制）+ 跳原文（无文档归属的手工卡不显示）
		const actions = contentEl.createDiv({ cls: "marinmind-note-actions" });
		// P2-1 图标语言统一：emoji/字符 → lucide setIcon
		new ButtonComponent(actions).setIcon("link").setButtonText("复制链接").onClick(() => {
			void this.plugin.copyCardLink(this.card, "link");
		});
		new ButtonComponent(actions).setIcon("copy").setButtonText("复制嵌入").onClick(() => {
			void this.plugin.copyCardLink(this.card, "embed");
		});
		if (this.card.documentId) {
			new ButtonComponent(actions).setIcon("arrow-up-right").setButtonText("跳原文").onClick(() => {
				this.close();
				void this.plugin.openCardSource(this.card);
			});
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

	/** 视觉三级回退：附件媒体 → 原文页裁剪 → 文本兜底（管线在 excerpt-visual.ts） */
	private async renderVisual(host: HTMLElement): Promise<void> {
		const result = await renderExcerptVisual(this.plugin, this.card, host);
		if (result.objectUrl) {
			this.objectUrl = result.objectUrl;
		}
		if (!result.rendered) {
			host.createDiv({ cls: "marinmind-card-preview-fallback", text: "（摘录图不可用——附件缺失或原文文件无法读取）" });
		}
	}
}
