import { ButtonComponent, Menu, Modal } from "obsidian";
import type { App } from "obsidian";
import type MarinMindPlugin from "../main";
import type { Card, DocRect } from "../types";
import { now } from "../utils";
import { pageWordOf } from "../storage/paths";
import { cardPreview, cardPreviewBlocks, EXCERPT_LABELS, formatRelativeTime } from "./home-data";
import { highlightFallbackColor } from "../reader/highlight-colors";
import { renderExcerptVisual } from "../reader/excerpt-visual";
import { snapshotImgSize } from "../reader/rect-utils";
import {
	deleteCardCascade,
	promptCardDeck,
	promptCardAiComment,
	promptCardGen,
	promptCardLinks,
	promptCardEdit,
	promptCardTags,
} from "./card-actions";
import { canCardAiComment } from "../ai/ai-prompts";
import { ConfirmModal } from "../mindmap/confirm-modal";

/**
 * 卡片摘录预览弹窗（㶈；91 批分区重排）：主页点卡片**先弹预览**——卡片式
 * 分区自上而下：标题（墨线随卡色）→ 徽标行（形态胶囊 + 出处）→ 摘录视觉
 * 主体 → 「摘录/批注」带标签分区 → 元信息（卡组/标签/时间）→ 操作区
 * （跳原文/编辑/复制链接三钮直放 + 低频动作收 ⋯ 菜单，MN3 式收敛）。
 *
 * 视觉三级回退（㊷ 起管线抽至 src/reader/excerpt-visual.ts，与复习遮挡正面共用）：
 * 1. 媒体附件（photo/audio/handwriting 的 excerptRef；111 起 area/lasso 页裁剪
 *    优先、快照降为兜底——与复习卡同形态，110 context 档窗口显示范围参照
 *    文字摘录）；
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

		// 卡片头（91 批重排）：标题 + 徽标行（形态胶囊在前、出处随后单行省略）
		const doc = this.card.documentId
			? this.plugin.documents.get(this.card.documentId)
			: undefined;
		contentEl.createDiv({ cls: "marinmind-card-preview-title", text: cardPreview(this.card) });
		const badges = contentEl.createDiv({ cls: "marinmind-card-preview-badges" });
		badges.createSpan({
			cls: "marinmind-card-preview-type",
			text: EXCERPT_LABELS[this.card.excerptType],
		});
		badges.createSpan({
			cls: "marinmind-card-preview-src",
			text: doc
				? `《${doc.title}》${this.card.page != null ? ` · 第 ${this.card.page} ${pageWordOf(doc.filePath)}` : ""}`
				: "手工卡片",
		});

		// 视觉主体（异步三级回退，㊷ 起与复习遮挡正面共用管线）；
		// 71 编辑态切换（photo 遮挡）整体重画此宿主
		this.bodyEl = contentEl.createDiv({ cls: "marinmind-card-preview-body" });
		void this.renderVisual(this.bodyEl);

		// 正文分区（85-D cardPreviewBlocks + 91 批带标签分区）：标题行已吸收
		// 最高优先级内容——摘录块（OCR 文字归宿）与批注块（问题语义）未吸收
		// 才另列；摘录在上、批注在下，与复习背面同语义。
		const blocks = cardPreviewBlocks(this.card);
		if (blocks.excerpt) {
			this.renderSection(contentEl, "摘录", "marinmind-card-preview-excerpt", blocks.excerpt);
		}
		if (blocks.note) {
			this.renderSection(contentEl, "批注", "marinmind-card-preview-note", blocks.note);
		}

		// 元信息行（91 批）：卡组徽标 + 标签 chips + 相对时间（时间恒有，行恒渲染）
		const info = contentEl.createDiv({ cls: "marinmind-card-preview-info" });
		if (this.card.deck) {
			info.createSpan({ cls: "marinmind-doc-badge", text: this.card.deck });
		}
		for (const tag of this.card.tags) {
			info.createSpan({ cls: "marinmind-card-preview-tag", text: `#${tag}` });
		}
		info.createSpan({
			cls: "marinmind-card-preview-time",
			text: formatRelativeTime(this.card.updatedAt, now()),
		});

		// 操作区（91 批 MN3 式收敛）：常用三钮直放（跳原文仅文档卡有）+
		// 低频动作收 ⋯ 菜单——与阅读器工具行/脑图 header 的溢出菜单同一范式
		const actions = contentEl.createDiv({ cls: "marinmind-card-preview-actions" });
		if (this.card.documentId) {
			new ButtonComponent(actions)
				.setIcon("arrow-up-right")
				.setButtonText("跳原文")
				.onClick(() => {
					this.close();
					void this.plugin.openCardSource(this.card);
				});
		}
		// 65 编辑批注起步，78 统一标题/批注双字段（与脑图节点编辑器同源）——
		// 复习/预览发现要改不必回脑图，同一单源共享
		new ButtonComponent(actions)
			.setIcon("pencil")
			.setButtonText("标题/批注")
			.onClick(() => {
				promptCardEdit(this.app, this.plugin, this.freshCard());
			});
		// ㊻-A 复制互链（任何卡可复制）
		new ButtonComponent(actions)
			.setIcon("link")
			.setButtonText("复制链接")
			.onClick(() => {
				void this.plugin.copyCardLink(this.card, "link");
			});
		new ButtonComponent(actions)
			.setIcon("more-horizontal")
			.setButtonText("⋯")
			.onClick((evt) => this.openMoreMenu(evt));
	}

	/** 带标签分区渲染（91 批）：小标签 + 内容块（note/excerpt 内容类沿用 pre-wrap/限高滚动配方） */
	private renderSection(host: HTMLElement, label: string, cls: string, text: string): void {
		const section = host.createDiv({ cls: "marinmind-card-preview-section" });
		section.createDiv({ cls: "marinmind-card-preview-section-label", text: label });
		section.createDiv({ cls, text });
	}

	/**
	 * ⋯ 更多菜单（91 批）：低频动作收纳（镜像阅读器工具行 openToolOverflowMenu
	 * 先例——即开即建、勾选/文案随状态现读）。点击时 fresh 取库（弹窗开着时
	 * 卡可能被外部改过，标签预填/附件删除用最新值）。
	 */
	private openMoreMenu(evt: MouseEvent): void {
		const menu = new Menu();
		// ㊻-A 复制嵌入互链
		menu.addItem((mi) =>
			mi
				.setTitle("复制嵌入")
				.setIcon("copy")
				.onClick(() => {
					void this.plugin.copyCardLink(this.card, "embed");
				}),
		);
		// 卡组批（73）：打标签 / 设卡组——与复习视图 ⋯ 菜单经 card-actions 单源共享
		menu.addItem((mi) =>
			mi
				.setTitle("打标签")
				.setIcon("tags")
				.onClick(() => {
					promptCardTags(this.app, this.plugin, this.freshCard());
				}),
		);
		menu.addItem((mi) =>
			mi
				.setTitle("设卡组")
				.setIcon("layers")
				.onClick(() => {
					promptCardDeck(this.app, this.plugin, this.freshCard());
				}),
		);
		// 翻译/AI 制卡：有摘录文字才可用；AI 补充解释 104-C 起扩全摘录类型
		// （canCardAiComment 单源——有文字 / 图片类摘录 vision / audio 有批注）
		if ((this.card.excerptText ?? "").trim().length > 0) {
			menu.addItem((mi) =>
				mi
					.setTitle("AI 制卡…")
					.setIcon("list-checks")
					.onClick(() => {
						promptCardGen(this.app, this.plugin, this.freshCard());
					}),
			);
		}
		if (canCardAiComment(this.card)) {
			menu.addItem((mi) =>
				mi
					.setTitle("AI 补充解释")
					.setIcon("sparkles")
					.onClick(() => {
						void promptCardAiComment(this.app, this.plugin, this.freshCard());
					}),
			);
		}
		// 99 相关卡片（AI 推荐）：候选按同文档收集，无文档归属的卡在弹窗内说明
		if (this.card.documentId != null) {
			menu.addItem((mi) =>
				mi
					.setTitle("相关卡片（AI）…")
					.setIcon("git-compare")
					.onClick(() => {
						promptCardLinks(this.app, this.plugin, this.freshCard());
					}),
			);
		}
		// 71 photo 快照遮挡：预览弹窗是 photo 卡唯一遮挡编辑面（阅读器无页矩形
		// 无入口）——菜单项文案随 occEdit 现读，点选翻转态并整体重画视觉主体
		if (this.card.excerptType === "photo") {
			menu.addItem((mi) =>
				mi
					.setTitle(this.occEdit ? "完成遮挡" : "编辑遮挡")
					.setIcon("eye-off")
					.onClick(() => {
						this.occEdit = !this.occEdit;
						this.rerenderBody();
					}),
			);
		}
		// 84-C 重录语音：删旧卡（含附件）+ 立即开始全局录音（锚定原卡归属，
		// 不在阅读器也能重录）。批注/标签/复习进度随旧卡丢弃（语音卡通常无此负担）。
		if (this.card.excerptType === "audio") {
			menu.addItem((mi) =>
				mi
					.setTitle("重录")
					.setIcon("mic")
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
					}),
			);
		}
		menu.addSeparator();
		menu.addItem((mi) =>
			mi
				.setTitle("删除")
				.setIcon("trash-2")
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
				}),
		);
		menu.showAtMouseEvent(evt);
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
		// 111 与复习统一：area/lasso 页裁剪优先（preferCrop，110 context 档窗口
		// ——显示范围参照文字摘录）；此前走附件快照（紧贴区域的窄图，用户反馈
		// 主页-卡片显示区域偏窄）。handwriting/photo 由 canPreferCrop 守卫不受影响。
		// 112 感知提速：出图前先占位——冷首开要读文件+解析+渲染（数百毫秒到秒级），
		// 暖窗命中时占位一闪而过，无突兀感
		const loading = host.createDiv({
			cls: "marinmind-card-preview-loading",
			text: "摘录图加载中…",
		});
		const result = await renderExcerptVisual(this.plugin, this.card, host, {
			preferCrop: true,
		});
		loading.remove();
		if (result.objectUrl) {
			this.objectUrl = result.objectUrl;
		}
		if (!result.rendered) {
			host.createDiv({
				cls: "marinmind-card-preview-fallback",
				text: "（摘录图不可用——附件缺失或原文文件无法读取）",
			});
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
			host.createDiv({
				cls: "marinmind-card-preview-fallback",
				text: "（照片附件缺失，无法编辑遮挡）",
			});
			return;
		}
		let bytes: ArrayBuffer;
		try {
			bytes = await this.plugin.attachments.read(ref);
		} catch {
			host.createDiv({
				cls: "marinmind-card-preview-fallback",
				text: "（照片附件读取失败，无法编辑遮挡）",
			});
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
			const clear = host.createEl("button", {
				cls: "marinmind-review-link",
				text: "清除全部遮挡",
			});
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
			const block = wrap.createDiv({
				cls: "marinmind-photo-occ-block",
				attr: { title: "点击删除此遮挡" },
			});
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
