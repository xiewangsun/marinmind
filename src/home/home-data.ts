import type { BookDocument, Card, ExcerptType } from "../types";

/**
 * 主页纯函数（㉟，㊲ 多层分类）：分类树/过滤/搜索/分页/归一化/相对时间。
 * 零 obsidian 依赖，vitest 直测。
 */

/** 摘录形态中文标签（无文字的媒体卡显示形态占位；主页列表/筛选与卡片预览弹窗㶈共用） */
export const EXCERPT_LABELS: Record<ExcerptType, string> = {
	text: "文字摘录",
	area: "区域摘录",
	lasso: "套索摘录",
	blank: "留白",
	handwriting: "手写摘录",
	audio: "语音摘录",
	photo: "照片摘录",
};

/** 卡片预览文本：标题（㊺）> 批注 > 摘录文字 > 形态占位（与脑图节点标题同序；主页列表与㶈 预览弹窗标题共用） */
export function cardPreview(card: Card): string {
	if (card.title?.trim()) return card.title.trim();
	if (card.note?.trim()) return card.note.trim();
	if (card.excerptText?.trim()) return card.excerptText.trim();
	return EXCERPT_LABELS[card.excerptType];
}

/** 分类选择的三态："all" 全部 / null 未分类 / 具体分类路径（多层以 / 分隔） */
export type CategorySelection = string | null | "all";

/** 文件夹树节点（category 路径按 / 拆段派生的虚拟文件夹） */
export interface CategoryNode {
	/** 段名（显示用，不含父路径） */
	name: string;
	/** 完整路径（选中键 = 文档 category 值） */
	fullName: string;
	/** 直接归入该分类的文档数 */
	count: number;
	/** 含子孙分类的文档总数（徽标显示） */
	total: number;
	/** 子文件夹（段名拼音序） */
	children: CategoryNode[];
}

/** 文档分类树（虚拟文件夹侧栏数据源） */
export interface CategoryTree {
	/** 全部文档数 */
	all: number;
	/** 未分类（category 为 null/空白/无效路径）文档数 */
	uncategorized: number;
	/** 具名分类根层 */
	roots: CategoryNode[];
}

/**
 * 按文档记录聚合分类树（文件夹 = category 值的派生分组，不建实体）。
 * 分组键统一走段级归一（与 normalizeCategory 一致）——手编产生的空白变体
 * （如「学习  /英语」）与规范路径归并到同一节点，不再分裂。
 */
export function buildCategoryTree(docs: readonly BookDocument[]): CategoryTree {
	// 根占位节点（fullName=""，仅聚合用不导出）
	const root: CategoryNode = { name: "", fullName: "", count: 0, total: 0, children: [] };
	const nodes = new Map<string, CategoryNode>([["", root]]);
	// 沿路径逐段补节点（保证树中路径唯一）
	const ensure = (fullName: string): CategoryNode => {
		const found = nodes.get(fullName);
		if (found) return found;
		const slash = fullName.lastIndexOf("/");
		const parent = ensure(slash === -1 ? "" : fullName.slice(0, slash));
		const node: CategoryNode = {
			name: fullName.slice(slash + 1),
			fullName,
			count: 0,
			total: 0,
			children: [],
		};
		parent.children.push(node);
		nodes.set(fullName, node);
		return node;
	};
	let uncategorized = 0;
	for (const doc of docs) {
		const path = categoryPathOf(doc);
		if (!path) {
			uncategorized++;
			continue;
		}
		ensure(path).count++;
	}
	// 自底向上累计 total（含子孙）
	const sumTotals = (node: CategoryNode): number => {
		node.total = node.count + node.children.reduce((sum, c) => sum + sumTotals(c), 0);
		return node.total;
	};
	sumTotals(root);
	sortCategoryNodes(root.children);
	return { all: docs.length, uncategorized, roots: root.children };
}

/** 递归按段名拼音序排序（zh-Hans-CN，与旧扁平分组排序一致） */
function sortCategoryNodes(nodes: CategoryNode[]): void {
	nodes.sort((a, b) => a.name.localeCompare(b.name, "zh-Hans-CN"));
	for (const n of nodes) sortCategoryNodes(n.children);
}

/**
 * 把本地新建的空分类路径注入树（返回根层数组；已存在时原样返回）。
 * 空分类仅本地选中不写文件（㉟ 语义不变），注入后树中可见、可点击、可作拖放目标。
 */
export function injectCategoryPath(roots: CategoryNode[], fullName: string | null): CategoryNode[] {
	const path = fullName === null ? null : normalizeCategory(fullName);
	if (!path) return roots;
	let siblings = roots;
	let created = false;
	let prefix = "";
	for (const seg of path.split("/")) {
		prefix = prefix ? `${prefix}/${seg}` : seg;
		let node = siblings.find((n) => n.fullName === prefix);
		if (!node) {
			node = { name: seg, fullName: prefix, count: 0, total: 0, children: [] };
			siblings.push(node);
			created = true;
		}
		siblings = node.children;
	}
	if (created) sortCategoryNodes(roots); // 注入节点并入整体拼音序
	return roots;
}

/** 文档 category 的段级归一完整路径（空/全空段/超长 → null = 未分类） */
function categoryPathOf(doc: BookDocument): string | null {
	return doc.category ? normalizeCategory(doc.category) : null;
}

/**
 * 按分类选择过滤文档（保持传入序）：
 * "all" 全部 / null 未分类 / 路径选中含子树（选「学习」含「学习/英语」）。
 */
export function filterDocsByCategory(
	docs: readonly BookDocument[],
	sel: CategorySelection,
): BookDocument[] {
	if (sel === "all") return [...docs];
	const target = sel === null ? null : normalizeCategory(sel);
	return docs.filter((doc) => {
		const c = categoryPathOf(doc);
		if (target === null) return c === null;
		return c === target || (c !== null && c.startsWith(`${target}/`));
	});
}

/** 分类路径上限（frontmatter 单行标量；多层路径从 50 放宽到 120） */
export const CATEGORY_MAX_LENGTH = 120;

/**
 * 分类路径归一（㊲ 多层）：按 / 拆段 → 段内去首尾/折叠空白 → 丢弃空段 → 重拼。
 * 空/全空段 → null（= 未分类）；总长超上限 → null 拒绝（截断会切在段中间产生怪路径，
 * UI 层对非空输入给 Notice 提示）。入库前统一走这里，防止手编/输入的变体分裂同名分类。
 */
export function normalizeCategory(input: string): string | null {
	const segs = input
		.split("/")
		.map((seg) => seg.replace(/\s+/g, " ").trim())
		.filter((seg) => seg !== "");
	if (segs.length === 0) return null;
	const folded = segs.join("/");
	return folded.length > CATEGORY_MAX_LENGTH ? null : folded;
}

/** 按关键词过滤文档（标题/路径小写包含，保持传入序；query 空白 → 原样拷贝） */
export function filterDocsByQuery(docs: readonly BookDocument[], query: string): BookDocument[] {
	const q = query.trim().toLowerCase();
	if (!q) return [...docs];
	return docs.filter(
		(d) => d.title.toLowerCase().includes(q) || d.filePath.toLowerCase().includes(q),
	);
}

/** 卡片筛选条件（null = 不限） */
export interface CardsFilter {
	documentId: string | null;
	excerptType: string | null;
}

/** 卡片页视图状态：筛选 + 当前页码（页码从 1 起） */
export interface CardsPageState extends CardsFilter {
	page: number;
}

/** 按文档/形态筛选卡片（null 字段不限，保持传入序） */
export function filterCards(cards: readonly Card[], filter: CardsFilter): Card[] {
	return cards.filter(
		(c) =>
			(filter.documentId === null || c.documentId === filter.documentId) &&
			(filter.excerptType === null || c.excerptType === filter.excerptType),
	);
}

/** 总页数（空集也至少 1 页，避免「第 0/0 页」） */
export function pageCount(itemCount: number, size: number): number {
	if (size <= 0) return 1;
	return Math.max(1, Math.ceil(itemCount / size));
}

/** 分页切片（页码从 1 起，越界钳到最后一页） */
export function paginate<T>(items: readonly T[], page: number, size: number): T[] {
	if (size <= 0 || items.length === 0) return [];
	const p = Math.min(Math.max(1, page), pageCount(items.length, size));
	const start = (p - 1) * size;
	return items.slice(start, start + size);
}

/**
 * 相对时间（中文，主页列表用）：
 * 刚刚（<1 分钟）/ N 分钟前 / N 小时前（同一日历日内）/ 昨天（昨日历日，无论差几小时）/
 * M月D日（今年）/ YYYY年M月D日（往年）。nowMs 注入便于测试。
 */
export function formatRelativeTime(ts: number, nowMs: number): string {
	const diff = nowMs - ts;
	if (diff < 60_000) return "刚刚";
	if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} 分钟前`;
	const d = new Date(ts);
	const n = new Date(nowMs);
	const sameDay =
		d.getFullYear() === n.getFullYear() && d.getMonth() === n.getMonth() && d.getDate() === n.getDate();
	if (sameDay) return `${Math.floor(diff / 3_600_000)} 小时前`;
	const yesterday = new Date(n);
	yesterday.setDate(n.getDate() - 1);
	if (
		d.getFullYear() === yesterday.getFullYear() &&
		d.getMonth() === yesterday.getMonth() &&
		d.getDate() === yesterday.getDate()
	) {
		return "昨天";
	}
	if (d.getFullYear() === n.getFullYear()) return `${d.getMonth() + 1}月${d.getDate()}日`;
	return `${d.getFullYear()}年${d.getMonth() + 1}月${d.getDate()}日`;
}
