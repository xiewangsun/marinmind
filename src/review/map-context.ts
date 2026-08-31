import type { Card, MindmapNodeWithCard } from "../types";

/** 脑图上下文条目：卡片在一张图中的位置摘要（MN4 脑图栏的文本落地） */
export interface MapContextEntry {
	/** 图名 */
	mapTitle: string;
	/** 祖先标题（远 → 近，最多 2 级；根节点为空数组） */
	ancestors: string[];
	/** 本卡标题（㊺ 标题优先，无则批注/摘录文字/形态占位） */
	selfTitle: string;
	/** 子节点标题（最多展示 3 个，其余以计数收尾） */
	childTitles: string[];
	/** 子节点总数 */
	childCount: number;
	/** 同级节点数（不含自身；根节点之间互为同级） */
	siblingCount: number;
}

/** 祖先链最多回溯几级（再远对回忆定位帮助有限，展示也更长） */
const MAX_ANCESTORS = 2;

/** 子节点标题最多展示几个（其余以计数收尾） */
const MAX_CHILD_TITLES = 3;

/** 媒体形态的标题占位（对齐 mindmap-view 画布的占位语义） */
const MEDIA_TITLES: Record<Card["excerptType"], string> = {
	text: "（无标题）",
	area: "（区域摘录）",
	lasso: "（套索摘录）",
	blank: "（留白摘录）",
	handwriting: "（手写摘录）",
	audio: "（语音摘录）",
	photo: "（照片摘录）",
};

/** 节点标题：标题（㊺）→ 批注 → 摘录文字 → 形态占位（与脑图画布一致） */
export function cardTitle(card: Card): string {
	return card.title ?? card.note ?? card.excerptText ?? MEDIA_TITLES[card.excerptType];
}

/**
 * 构建卡片在单张脑图中的位置摘要（纯函数，vitest 覆盖）。
 *
 * - 卡不在该图节点集中返回 undefined（视图层跳过）
 * - 祖先链带 visited 防环（防御手工改库产生的 parentId 环——宁可截断不悬挂）
 * - 同级 = 同 parentId 的其他节点（parentId 为 null 的根节点之间互为同级）
 */
export function buildMapContext(
	nodes: MindmapNodeWithCard[],
	mapTitle: string,
	cardId: string,
): MapContextEntry | undefined {
	const self = nodes.find((n) => n.cardId === cardId);
	if (!self) {
		return undefined;
	}
	// 祖先链：parentId 逐级上溯（远 → 近），防环 + 截断到上限
	const ancestors: string[] = [];
	const seen = new Set<string>([self.id]);
	let cursor = self.parentId ? nodes.find((n) => n.id === self.parentId) : undefined;
	while (cursor && ancestors.length < MAX_ANCESTORS) {
		if (seen.has(cursor.id)) {
			break; // 异常数据成环：到此为止
		}
		ancestors.push(cardTitle(cursor.card));
		seen.add(cursor.id);
		cursor = cursor.parentId ? nodes.find((n) => n.id === cursor!.parentId) : undefined;
	}
	const children = nodes.filter((n) => n.parentId === self.id);
	const siblings = nodes.filter((n) => n.parentId === self.parentId && n.id !== self.id);
	return {
		mapTitle,
		// 收集序是近 → 远（先父后祖），展示路径要 远 → 近，翻转一次
		ancestors: ancestors.reverse(),
		selfTitle: cardTitle(self.card),
		childTitles: children.slice(0, MAX_CHILD_TITLES).map((n) => cardTitle(n.card)),
		childCount: children.length,
		siblingCount: siblings.length,
	};
}
