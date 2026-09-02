import type { Card } from "../types";

/**
 * 复习卡片组列表（70，纯函数零 obsidian 依赖，vitest 直测）。
 *
 * 会话队列的旁路视图：排序与筛选不动队列本体（SRS 语义零干扰），行携带
 * 队列下标 index——点击 goTo(index) 跳转浏览位置（已评分下标自动只读态）。
 */

/** 列表排序键：queue = 队列序（到期/混排构建序，默认）；document = 文档位置；text = 文本 */
export type SessionSortKey = "queue" | "document" | "text";

/**
 * 列表筛选（undefined = 该维不过滤；null = 「自由卡片」/「未设色」——
 * 与 undefined 的区别让"无文档/未设色"也能被筛出来，下拉全量选项可用）。
 */
export interface SessionListFilter {
	documentId?: string | null;
	color?: string | null;
}

/** 列表行：index 为队列下标（排序只重排行序，不动队列） */
export interface SessionListRow {
	index: number;
	card: Card;
}

/** 列表行标题（与 map-context cardTitle 同源优先级：标题 → 批注 → 摘录 → 占位） */
export function sessionRowTitle(card: Card): string {
	return card.title ?? card.note ?? card.excerptText ?? "";
}

/** null 段殿后的升序比较器（page/documentId 等"可无"字段共用） */
function ascNullLast(a: number | null, b: number | null): number {
	if (a === b) return 0;
	if (a === null) return 1;
	if (b === null) return -1;
	return a - b;
}

/**
 * 构建列表行：queue 序透传（O(1) 心智——与 ◀ ▶ 浏览顺序一致）；document 序 =
 * documentId（自由卡片最后）→ page 升序（无页码最后）→ 首矩形 y（同页内自上而下）；
 * text 序 = 标题 localeCompare("zh")。次键恒为队列下标保稳定（同键不乱序）。
 * 筛选只收窄可见行，不影响下标（index 仍是队列本体位置）。
 */
export function buildSessionRows(
	queue: readonly Card[],
	sort: SessionSortKey,
	filter: SessionListFilter = {},
): SessionListRow[] {
	const rows: SessionListRow[] = queue.map((card, index) => ({ index, card }));
	const filtered = rows.filter(({ card }) => {
		if (filter.documentId !== undefined && card.documentId !== filter.documentId) {
			return false;
		}
		if (filter.color !== undefined && card.color !== filter.color) {
			return false;
		}
		return true;
	});
	if (sort === "queue") {
		return filtered;
	}
	if (sort === "document") {
		return filtered.sort((a, b) => {
			const da = a.card.documentId;
			const db = b.card.documentId;
			if (da !== db) {
				// 自由卡片（null documentId）殿后，其余按 id 分组同书聚拢
				if (da === null) return 1;
				if (db === null) return -1;
				return da < db ? -1 : 1;
			}
			const pageDiff = ascNullLast(a.card.page, b.card.page);
			if (pageDiff !== 0) return pageDiff;
			const ya = a.card.rects[0]?.y ?? null;
			const yb = b.card.rects[0]?.y ?? null;
			const yDiff = ascNullLast(ya, yb);
			if (yDiff !== 0) return yDiff;
			return a.index - b.index;
		});
	}
	// text 序
	return filtered.sort((a, b) => {
		const diff = sessionRowTitle(a.card).localeCompare(sessionRowTitle(b.card), "zh");
		return diff !== 0 ? diff : a.index - b.index;
	});
}
