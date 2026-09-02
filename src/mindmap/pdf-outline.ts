/**
 * PDF 目录 → 脑图框架建卡计划（55，纯函数，零 obsidian 依赖，vitest 直接覆盖）。
 *
 * OutlineEntry 树（pdf-document.outline 解析产物）深度优先平铺为建卡序列；
 * 建树方（mindmap-view.buildOutlineFramework）按下标互挂：parentIndex 指向
 * 返回数组中父项的位置（先父后子，顺序建卡时父节点已存在）。
 */

import type { OutlineEntry } from "../reader/pdf-document";

/**
 * 目录框架建卡计划项
 */
export interface ChapterPlanItem {
	/** 章节标题（直接作卡片 title 与摘录文字） */
	title: string;
	/** 章节起始页（1 基）：新摘录归章判定与跳原文共用 */
	page: number;
	/**
	 * 章节起始锚点 y（62 md 框架：归一化 0-1，由隐藏渲染实测标题位置得出）；
	 * pdf/epub 恒 null——页粒度即归章粒度。建卡方据此合成 rects 供跳原文
	 * locateCard 精确定位与归章同页 y 比较
	 */
	anchorY: number | null;
	/** 层级深度（顶层 0）：随损坏条目重挂归一，可能与原目录深度不一致 */
	depth: number;
	/** 父项在返回数组中的下标；顶层为 null（建树方挂到《书名》组卡下） */
	parentIndex: number | null;
}

/**
 * 目录树 → 建卡计划：page==null 的损坏条目自身跳过（宁拒不赌——跳页卡没有
 * 归章意义），其子级就近重挂最近有效祖先（无则上浮顶层）；depth 随重挂归一。
 * 建树只看 parentIndex，depth 仅供确认弹窗与调试展示。
 * 入参条目可携带 anchorY（62 md 量测产物；pdf/epub OutlineEntry 无该字段，
 * 可选属性结构兼容原调用零改动）。
 */
export function planOutlineChapters(
	entries: Array<OutlineEntry & { anchorY?: number | null }>,
): ChapterPlanItem[] {
	const items: ChapterPlanItem[] = [];
	const walk = (
		list: Array<OutlineEntry & { anchorY?: number | null }>,
		parentIndex: number | null,
		depth: number,
	): void => {
		for (const entry of list) {
			if (entry.page == null) {
				// 损坏条目：自身跳过，子级挂到当前父（就近重挂，层级随之上浮）
				walk(entry.children, parentIndex, depth);
				continue;
			}
			const idx = items.length;
			items.push({
				title: entry.title,
				page: entry.page,
				anchorY: entry.anchorY ?? null,
				depth,
				parentIndex,
			});
			walk(entry.children, idx, depth + 1);
		}
	};
	walk(entries, null, 0);
	return items;
}
