import type { App } from "obsidian";
import { Notice } from "obsidian";
import type MarinMindPlugin from "../main";
import type { Card } from "../types";
import { CATEGORY_MAX_LENGTH, normalizeCategory } from "./home-data";
import { DeckAssignModal } from "./deck-assign-modal";
import { TextPromptModal } from "../reader/note-edit-modal";

/**
 * 卡片管理动作（打标签 / 设卡组 / 编辑批注 / 删除）：复习视图 ⋯ 菜单与卡片预览弹窗
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
		{ title: options.title, initialText: options.initialText, placeholder: options.placeholder, multiline: false },
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
 * 编辑批注（65）：复习界面发现批注要改不必回阅读器——多行 textarea，
 * 预填当前批注；TextPromptModal 已 trim 空串转 null（null = 清空批注）。
 */
export function promptCardNote(app: App, plugin: MarinMindPlugin, card: Card): void {
	new TextPromptModal(
		app,
		{
			title: "编辑批注",
			placeholder: "输入批注（复习正面的问题）",
			initialText: card.note ?? "",
			multiline: true,
		},
		(text) => {
			plugin.cards.update(card.id, { note: text });
		},
	).open();
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
