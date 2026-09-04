import { ButtonComponent, Modal } from "obsidian";
import type { App } from "obsidian";
import type MarinMindPlugin from "../main";
import type { Card, DocRect } from "../types";
import { pageWordOf } from "../storage/paths";
import { cardPreview, cardPreviewBlocks, EXCERPT_LABELS } from "./home-data";
import { highlightFallbackColor } from "../reader/highlight-colors";
import { renderExcerptVisual } from "../reader/excerpt-visual";
import { snapshotImgSize } from "../reader/rect-utils";
import { deleteCardCascade, promptCardDeck, promptCardEdit, promptCardTags } from "./card-actions";
import { ConfirmModal } from "../mindmap/confirm-modal";

/**
 * 卡片摘录预览弹窗（㶈）：主页点卡片**先弹预览**——只显示摘录区域本身
 * （媒体附件图 / 原文页裁剪窗口 + 高亮标示），需要时再点「跳原文」进阅读器。
 *
 * 视觉三级回退（㊷ 起管线抽至 src/reader/excerpt-visual.ts，与复习遮挡正面共用）：
 * 1. 媒体附件（photo/audio/handwriting/area/lasso 的 excerptRef）；
 * 2. 原文页裁剪（text/blank 卡走此路，带少量上下文）；
 * 3. 文本兜底（附件缺失且无 rects 的 photo/audio）。
 *
 * 标题与主页列表同源（cardPreview：标题 > 批注 > 摘录文字 > 形态占位）；
 * 正文块经 cardPreviewBlocks（85-D）拆分——批注与摘录文字各有独立展示位
 * （批注=问题、摘录=答案，与复习正反面同语义；未被标题吸收的内容才另列）。
 * blob URL 在 onClose 统一 revoke（镜像 MediaPreviewModal）。
 */

export class CardPreviewModal extends Modal {
	private objectUrl: string | null = null;
	/** 视觉主体宿主（71 遮挡编辑态切换时整体重画；onOpen 赋值） */
	private bodyEl: HTMLElement | null = null;
	/**
	 * 71 photo 快照遮挡编辑态（会话级不持久化）：photo 卡在阅读器无页矩形
	 * 拿不到「遮挡区域…」入口——预览弹窗即其唯一编辑面（拖框入 occlusions，
	 * 图内 0-1 坐标；复习端 bounds 恒整图的数学天然对位，渲染侧零改动）。
	 */
	private occEdit = false;

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

		// 视觉主体（异步三级回退，㊷ 起与复习遮挡正面共用管线）；
		// 71 编辑态切换（photo 遮挡）整体重画此宿主
		this.bodyEl = contentEl.createDiv({ cls: "marinmind-card-preview-body" });
		void this.renderVisual(this.bodyEl);

		// 正文块（85-D cardPreviewBlocks）：标题行已吸收最高优先级内容——
		// 批注块仅在有标题时另列（title 空时 cardPreview 已用批注当标题）；
		// 摘录块（OCR 文字归宿）在 title/note 任一存在时另列（全空时已当标题）。
		// 批注=问题、摘录=答案，与复习背面同语义；修复"OCR 卡看不到文字 /
		// 有批注的卡看不到批注"两类不可见问题。
		const blocks = cardPreviewBlocks(this.card);
		if (blocks.note) {
			contentEl.createDiv({
				cls: "marinmind-card-preview-note",
				text: blocks.note,
			});
		}
		if (blocks.excerpt) {
			contentEl.createDiv({
				cls: "marinmind-card-preview-excerpt",
				text: blocks.excerpt,
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
		// 卡组批：打标签 / 设卡组 / 删除——与复习视图 ⋯ 菜单经 card-actions 单源共享。
		// 点击时 fresh 取库（弹窗开着时卡可能被外部改过，标签预填/附件删除用最新值）
		new ButtonComponent(actions).setIcon("tags").setButtonText("打标签").onClick(() => {
			promptCardTags(this.app, this.plugin, this.freshCard());
		});
		new ButtonComponent(actions).setIcon("layers").setButtonText("卡组").onClick(() => {
			promptCardDeck(this.app, this.plugin, this.freshCard());
		});
		// 65 编辑批注起步，78 统一标题/批注双字段（与脑图节点编辑器同源）——
		// 复习/预览发现要改不必回脑图，同一单源共享
		new ButtonComponent(actions).setIcon("pencil").setButtonText("标题/批注").onClick(() => {
			promptCardEdit(this.app, this.plugin, this.freshCard());
		});
		// 71 photo 快照遮挡：预览弹窗是 photo 卡唯一遮挡编辑面（阅读器无页矩形无入口）
		if (this.card.excerptType === "photo") {
			const occBtn = new ButtonComponent(actions).setIcon("eye-off").setButtonText("遮挡");
			occBtn.onClick(() => {
				this.occEdit = !this.occEdit;
				occBtn.setButtonText(this.occEdit ? "完成遮挡" : "遮挡");
				occBtn.buttonEl.toggleClass("is-active", this.occEdit);
				this.rerenderBody();
			});
		}
		// 84-C 重录语音：删旧卡（含附件）+ 立即开始全局录音（锚定原卡归属，
		// 不在阅读器也能重录）。批注/标签/复习进度随旧卡丢弃（语音卡通常无此负担）。
		if (this.card.excerptType === "audio") {
			new ButtonComponent(actions)
				.setIcon("mic")
				.setButtonText("重录")
				.setWarning()
				.onClick(() => {
					const fresh = this.freshCard();
					new ConfirmModal(
						this.app,
						"重录语音",
						"将删除当前语音卡片（含批注、标签与复习进度），并立即开始新录音。继续？",
						() => {
							deleteCardCascade(this.plugin, fresh);
							this.close();
							void this.plugin.startGlobalRecording({
								documentId: fresh.documentId,
								page: fresh.page,
							});
						},
					).open();
				});
		}
		new ButtonComponent(actions)
			.setIcon("trash-2")
			.setButtonText("删除")
			.setWarning()
			.onClick(() => {
				new ConfirmModal(
					this.app,
					"删除卡片",
					"将同时删除附件、双向链接与脑图中的对应节点，且无法恢复。",
					() => {
						deleteCardCascade(this.plugin, this.freshCard());
						this.close(); // 卡已删，弹窗随之关闭；主页列表刷新由 cardBus 防抖订阅完成
					},
				).open();
			});
	}

	/** 库中最新快照（弹窗期间外部改卡时动作仍作用于当前值）；已删回退构造时快照 */
	private freshCard(): Card {
		return this.plugin.cards?.get(this.card.id) ?? this.card;
	}

	onClose(): Promise<void> {
		this.revokeUrl();
		this.contentEl.empty();
		return Promise.resolve();
	}

	/** 视觉三级回退：附件媒体 → 原文页裁剪 → 文本兜底（管线在 excerpt-visual.ts） */
	private async renderVisual(host: HTMLElement): Promise<void> {
		// 重画前回收上一枚 blob URL 并清空宿主（编辑态切换/遮挡更新都整体重画）
		this.revokeUrl();
		host.empty();
		// 71 photo 遮挡编辑态：拖框编辑器替代普通视觉
		if (this.occEdit && this.card.excerptType === "photo") {
			await this.renderOccEditor(host);
			return;
		}
		const result = await renderExcerptVisual(this.plugin, this.card, host);
		if (result.objectUrl) {
			this.objectUrl = result.objectUrl;
		}
		if (!result.rendered) {
			host.createDiv({ cls: "marinmind-card-preview-fallback", text: "（摘录图不可用——附件缺失或原文文件无法读取）" });
		}
	}

	/** 重画视觉主体（71 遮挡编辑入口用；宿主断开时安全 no-op） */
	private rerenderBody(): void {
		if (this.bodyEl) {
			void this.renderVisual(this.bodyEl);
		}
	}

	private revokeUrl(): void {
		if (this.objectUrl) {
			URL.revokeObjectURL(this.objectUrl);
			this.objectUrl = null;
		}
	}

	// ---------- 71 photo 快照遮挡编辑器（obsidian/DOM 耦合不单测） ----------

	/** photo 遮挡编辑器：快照图 + 拖框添加 + 点块删除 + 清除全部 */
	private async renderOccEditor(host: HTMLElement): Promise<void> {
		const card = this.freshCard();
		const ref = card.excerptRef;
		if (!ref) {
			host.createDiv({ cls: "marinmind-card-preview-fallback", text: "（照片附件缺失，无法编辑遮挡）" });
			return;
		}
		let bytes: ArrayBuffer;
		try {
			bytes = await this.plugin.attachments.read(ref);
		} catch {
			host.createDiv({ cls: "marinmind-card-preview-fallback", text: "（照片附件读取失败，无法编辑遮挡）" });
			return;
		}
		if (!host.isConnected) {
			return; // 弹窗已关：丢弃
		}
		const url = URL.createObjectURL(new Blob([bytes]));
		this.objectUrl = url;
		// inline-block 收紧到图片边缘——百分比定位即图内 0-1 坐标（photo bounds 恒整图同基）
		const wrap = host.createDiv({ cls: "marinmind-photo-occ-editor" });
		const img = wrap.createEl("img", { cls: "marinmind-card-preview-media" });
		img.alt = EXCERPT_LABELS.photo;
		// R3（W-02）：photo 图像恒整图、比例未知，4:3 兜底预留（加载后按真实比例落位）
		const size = snapshotImgSize(card);
		img.width = size.width;
		img.height = size.height;
		img.src = url;
		img.draggable = false; // 防原生拖图劫持拖框手势
		this.syncOccBlocks(wrap, card);
		this.bindOccDrag(wrap);
		host.createDiv({
			cls: "marinmind-photo-occ-hint",
			text: "在图上拖框添加遮挡；点击遮挡块删除该块。",
		});
		if (card.occlusions.length > 0) {
			const clear = host.createEl("button", { cls: "marinmind-review-link", text: "清除全部遮挡" });
			clear.addEventListener("click", () => {
				this.plugin.cards.update(card.id, { occlusions: [] });
				this.rerenderBody();
			});
		}
	}

	/** 遮挡块回显：occlusions → 百分比定位块（click 删单块） */
	private syncOccBlocks(wrap: HTMLElement, card: Card): void {
		wrap.findAll(".marinmind-photo-occ-block").forEach((el) => el.remove());
		card.occlusions.forEach((occ, i) => {
			const block = wrap.createDiv({ cls: "marinmind-photo-occ-block", attr: { title: "点击删除此遮挡" } });
			block.style.left = `${occ.x * 100}%`;
			block.style.top = `${occ.y * 100}%`;
			block.style.width = `${occ.w * 100}%`;
			block.style.height = `${occ.h * 100}%`;
			block.addEventListener("pointerdown", (e) => e.stopPropagation()); // 块上起笔不进拖框
			block.addEventListener("click", (e) => {
				e.stopPropagation();
				this.plugin.cards.update(card.id, {
					occlusions: card.occlusions.filter((_, idx) => idx !== i),
				});
				this.rerenderBody();
			});
		});
	}

	/** 拖框添加遮挡：pointerdown 起笔 → 框选预览 → pointerup gBCR 归一入 occlusions */
	private bindOccDrag(wrap: HTMLElement): void {
		let drag: { startX: number; startY: number; preview: HTMLElement } | null = null;
		wrap.addEventListener("pointerdown", (e) => {
			if (e.button !== 0) {
				return;
			}
			const preview = wrap.createDiv({ cls: "marinmind-photo-occ-drag" });
			drag = { startX: e.clientX, startY: e.clientY, preview };
			wrap.setPointerCapture(e.pointerId);
			e.preventDefault(); // 防选中文本/图片
		});
		wrap.addEventListener("pointermove", (e) => {
			if (!drag) {
				return;
			}
			const box = wrap.getBoundingClientRect();
			const x1 = Math.min(drag.startX, e.clientX) - box.left;
			const x2 = Math.max(drag.startX, e.clientX) - box.left;
			const y1 = Math.min(drag.startY, e.clientY) - box.top;
			const y2 = Math.max(drag.startY, e.clientY) - box.top;
			Object.assign(drag.preview.style, {
				left: `${x1}px`,
				top: `${y1}px`,
				width: `${x2 - x1}px`,
				height: `${y2 - y1}px`,
			});
		});
		const finish = (e: PointerEvent) => {
			if (!drag) {
				return;
			}
			const { startX, startY, preview } = drag;
			drag = null;
			preview.remove();
			const card = this.freshCard();
			const box = wrap.getBoundingClientRect();
			// gBCR 比例归一（与 excerpt-layer 拖框同式），页内钳制 0-1
			const clamp01 = (v: number) => Math.min(1, Math.max(0, v));
			const x1 = clamp01((Math.min(startX, e.clientX) - box.left) / box.width);
			const x2 = clamp01((Math.max(startX, e.clientX) - box.left) / box.width);
			const y1 = clamp01((Math.min(startY, e.clientY) - box.top) / box.height);
			const y2 = clamp01((Math.max(startY, e.clientY) - box.top) / box.height);
			const rect: DocRect = { x: x1, y: y1, w: x2 - x1, h: y2 - y1 };
			if (rect.w < 0.01 || rect.h < 0.01) {
				return; // 误触微拖不建块
			}
			this.plugin.cards.update(card.id, { occlusions: [...card.occlusions, rect] });
			this.rerenderBody();
		};
		wrap.addEventListener("pointerup", finish);
		wrap.addEventListener("pointercancel", () => {
			if (drag) {
				drag.preview.remove();
				drag = null;
			}
		});
	}
}
