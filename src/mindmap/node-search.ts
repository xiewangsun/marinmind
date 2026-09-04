import type { MindmapNodeWithCard } from "../types";

/**
 * 脑图节点搜索纯逻辑（89-C）：子串大小写不敏感；每节点按 标题 > 批注 > 摘录
 * 取首个命中字段（一节点一行，避免同节点多字段刷屏）。空/空白查询早退空结果。
 * 零 obsidian 依赖，vitest 直测（同 epub-document / md-outline 先例）。
 */

/** 节点搜索命中字段（优先级序：标题 > 批注 > 摘录） */
export type NodeSearchField = "title" | "note" | "excerptText";

/** 单条搜索结果：节点引用 + 命中字段与该字段全文（Modal 渲染主行/徽标用） */
export interface NodeSearchRow {
	node: MindmapNodeWithCard;
	field: NodeSearchField;
	/** 命中字段的完整文本（长文本由 Modal 截断显示） */
	main: string;
}

export interface NodeSearchResult {
	rows: NodeSearchRow[];
	/** 超 limit 截断（列表尾提示"前 N 个"） */
	truncated: boolean;
}

/** 字段取值链（null/空串统一跳过；顺序即命中优先级） */
const FIELD_GETTERS: ReadonlyArray<{
	field: NodeSearchField;
	get: (n: MindmapNodeWithCard) => string | null;
}> = [
	{ field: "title", get: (n) => n.card.title },
	{ field: "note", get: (n) => n.card.note },
	{ field: "excerptText", get: (n) => n.card.excerptText },
];

/** 命中字段徽标文案 */
export const NODE_SEARCH_FIELD_LABELS: Record<NodeSearchField, string> = {
	title: "标题",
	note: "批注",
	excerptText: "摘录",
};

/** 搜索结果上限（超大图防刷屏；截断标记由 UI 提示） */
export const NODE_SEARCH_LIMIT = 100;

/** 节点搜索：见文件头注释。折叠隐藏的节点照常命中（定位由 locateCard 展开祖先） */
export function searchMapNodes(
	nodes: readonly MindmapNodeWithCard[],
	query: string,
	limit: number = NODE_SEARCH_LIMIT,
): NodeSearchResult {
	const q = query.trim().toLowerCase();
	if (!q) {
		return { rows: [], truncated: false };
	}
	const rows: NodeSearchRow[] = [];
	for (const node of nodes) {
		for (const { field, get } of FIELD_GETTERS) {
			const text = get(node);
			if (text && text.toLowerCase().includes(q)) {
				if (rows.length >= limit) {
					return { rows, truncated: true };
				}
				rows.push({ node, field, main: text });
				break; // 每节点只取首个命中字段
			}
		}
	}
	return { rows, truncated: false };
}
