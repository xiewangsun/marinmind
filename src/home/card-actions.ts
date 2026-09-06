import type { App } from "obsidian";
import { Notice } from "obsidian";
import type MarinMindPlugin from "../main";
import type { Card } from "../types";
import { CATEGORY_MAX_LENGTH, normalizeCategory } from "./home-data";
import { CardEditModal } from "./card-edit-modal";
import { DeckAssignModal } from "./deck-assign-modal";
import { TextPromptModal } from "../reader/note-edit-modal";
import { AiActionModal } from "../ai/ai-action-modal";
import { buildCardCommentMessages, canCardAiComment, cardVisionImageRef } from "../ai/ai-prompts";
import { imageToDataUrl } from "../attachments/vision-image";
import { AiCardgenModal } from "../ai/ai-cardgen-modal";
import { AiLinkModal } from "../ai/ai-link-modal";

/**
 * 卡片管理动作（打标签 / 设卡组 / 编辑标题批注 / 删除）：复习视图 ⋯ 菜单与卡片预览弹窗
 * **单源共享**——两个 UI 壳各自薄封装，行为不会分叉。
 * 写库走 cards.update / cards.delete，回显与联动清理由 cardBus 事件回环
 * （复习会话剔除、主页列表刷新、跨标签高亮同步）统一承接。
 */

/**
 * 归一输入并校验（73 更名自 promptCategoryName——分类/卡组路径输入共用；76 自
 * home-pages 迁入导出：deck-assign-modal 新建分支与主页新建/重命名同源）；取消或
 * 无效时静默/Notice 拦截，有效才回调归一值。
 */
export function promptPathName(
	app: App,
	options: { title: string; initialText?: string; placeholder?: string },
	onOk: (normalized: string) => void,
): void {
	new TextPromptModal(
		app,
		{
			title: options.title,
			initialText: options.initialText,
			placeholder: options.placeholder,
			multiline: false,
		},
		(name) => {
			const raw = name ?? "";
			const normalized = normalizeCategory(raw);
			if (!normalized) {
				if (raw.trim()) new Notice(`名称无效（为空或超过 ${CATEGORY_MAX_LENGTH} 字符）`);
				return;
			}
			onOk(normalized);
		},
	).open();
}

/** 打标签：空格/逗号（含全角逗号）分隔多个标签，留空清除全部 */
export function promptCardTags(app: App, plugin: MarinMindPlugin, card: Card): void {
	new TextPromptModal(
		app,
		{
			title: "打标签",
			placeholder: "多个标签用空格或逗号分隔，留空清除",
			initialText: card.tags.join(" "),
			multiline: false,
		},
		(text) => {
			// 空 → []（清空标签）；分隔符宽容（中英文逗号/任意空白）
			const tags = (text ?? "")
				.split(/[\s,，]+/)
				.map((t) => t.trim())
				.filter(Boolean);
			plugin.cards.update(card.id, { tags });
		},
	).open();
}

/**
 * 设置卡组（76 改选择器）：弹出卡组选择列表（可输入筛选、当前卡组带徽标、
 * 支持新建与移出），替代文本填入——与「按卡组复习」DeckPickerModal 同款交互。
 * 至多一组，改选即换组；新建项经 promptPathName 归一（段级空白折叠 + 上限校验）
 * 并写入显式清单（创建即持久，空组不消失）；回显走 cardBus changed 回环。
 */
export function promptCardDeck(app: App, plugin: MarinMindPlugin, card: Card): void {
	new DeckAssignModal(app, plugin, card, (item) => {
		if (item.kind === "deck") {
			if (item.deck !== card.deck) plugin.cards.update(card.id, { deck: item.deck });
			return;
		}
		if (item.kind === "remove") {
			plugin.cards.update(card.id, { deck: null });
			return;
		}
		// 新建：输入卡组名 → 入显式清单 + 归入该卡（创建即持久，76）
		promptPathName(
			app,
			{ title: "新建卡组", placeholder: "卡组名称（支持多层，如：学习/英语）" },
			(deck) => {
				plugin.store?.addDeck(deck);
				plugin.cards.update(card.id, { deck });
				new Notice(`已归入「${deck}」`);
			},
		);
	}).open();
}

/**
 * 编辑标题/批注（65 批注起步，78 统一为双字段）：复习/预览/阅读器发现要改不必回
 * 脑图——CardEditModal 与脑图节点编辑器同源语义（trim 空串→null、同值不写库），
 * 标题为 ㊺ MN3 一卡一对象一标题（各显示链最高优先）。
 */
export function promptCardEdit(app: App, plugin: MarinMindPlugin, card: Card): void {
	new CardEditModal(app, plugin, card).open();
}

/**
 * AI 补充解释（97，MN4 AI 评论对齐；104-C 扩视觉/语音）：摘录内容流式解释弹窗，
 * 「填入批注」把结果预填 CardEditModal——经人手确认/修改后落库（AI 不直接写库）。
 * 阅读器高亮菜单 / 卡片预览 ⋯ 菜单 / 复习翻面按钮单源共享；入口判定
 * canCardAiComment（有文字 / 图片类摘录带附件 / audio 有批注）。
 * 图片类摘录（104-C）：读附件 → imageToDataUrl 栅格化压缩 → vision 多模态直发
 * （需模型支持视觉）；附件读取/栅格化失败且有文字降级纯文本，无文字 Notice 拦下。
 */
export async function promptCardAiComment(
	app: App,
	plugin: MarinMindPlugin,
	card: Card,
): Promise<void> {
	if (!canCardAiComment(card)) {
		return; // 菜单已按同函数放行，此处兜底防绕过（与旧版 source 守卫同位）
	}
	const source = card.excerptText?.trim() ?? "";
	// 图片类摘录：附件 → dataURL（失败降级纯文本路径）
	let imageDataUrl: string | null = null;
	const imageRef = cardVisionImageRef(card);
	if (imageRef) {
		try {
			const bytes = await plugin.attachments.read(imageRef);
			imageDataUrl = await imageToDataUrl(bytes, imageRef.split(".").pop() ?? "");
		} catch (err) {
			// 附件失联/读取异常：imageToDataUrl 永不 reject，这里只兜 read 抛错
			console.error("[MarinMind] AI 视觉图片读取失败", err);
		}
		if (!imageDataUrl && !source) {
			new Notice("图片附件读取失败，无法发送给 AI");
			return;
		}
	}
	const isAudioMaterial = !source && card.excerptType === "audio";
	new AiActionModal(app, {
		title: "AI 补充解释",
		sourceText: source || (isAudioMaterial ? (card.note ?? "").trim() : ""),
		sourceImage: imageDataUrl,
		sourceLabel: isAudioMaterial ? "批注" : undefined,
		messages: buildCardCommentMessages({
			...card,
			imageDataUrl,
			excerptType: card.excerptType,
		}),
		settings: plugin.settings,
		onUsage: (usage) => plugin.addAiUsage(usage),
		apply: {
			label: "填入批注",
			onApply: (text) => {
				// fresh 取库：弹窗开着时卡可能被外部改过（镜像 CardEditModal 保存语义）
				const fresh = plugin.cards.get(card.id);
				if (fresh) {
					new CardEditModal(app, plugin, fresh, undefined, text).open();
				}
			},
		},
	}).open();
}

/**
 * AI 制卡（99，MN4 对齐）：以卡片摘录文字为材料生成 QA/填空卡，预览勾选批量
 * 落库。有原文锚点（documentId+page）的卡生成的卡继承回链——自动入图归章；
 * 无源卡（区域/照片等无文字）由调用方守卫不给入口。
 */
export function promptCardGen(app: App, plugin: MarinMindPlugin, card: Card): void {
	const source = card.excerptText?.trim();
	if (!source) {
		return;
	}
	const { documentId, page } = card;
	new AiCardgenModal(app, plugin, {
		sourceText: source,
		anchor: documentId != null && page != null ? { documentId, page, rects: card.rects } : null,
	}).open();
}

/**
 * 相关卡片（AI 推荐）（99，MN4 AI 链接建议对齐）：同文档候选经 LLM 推荐语义
 * 相关卡，勾选确认后写入 links 双向链接、受影响脑图重画虚线边。
 * 卡片预览 ⋯ 菜单与脑图节点右键菜单单源共享；无文档归属由弹窗内说明拦截。
 */
export function promptCardLinks(app: App, plugin: MarinMindPlugin, card: Card): void {
	new AiLinkModal(app, plugin, card).open();
}

/**
 * 删除卡片（含附件级联）：发起方职责清附件（uid 一卡一附件，镜像
 * reader-view deleteCard 先例）；复习/链接/脑图节点由 store.deleteCardCascade
 * 级联。视图侧清理（复习会话剔除、DOM 移除）由 cardBus removed 订阅方完成。
 */
export function deleteCardCascade(plugin: MarinMindPlugin, card: Card): void {
	plugin.cards.delete(card.id);
	if (card.excerptRef) {
		void plugin.attachments.remove(card.excerptRef).catch(() => undefined);
	}
}
