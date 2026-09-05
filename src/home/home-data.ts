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

/**
 * 卡片预览弹窗的正文块拆分（85-D：批注与摘录的独立展示位）：
 * 标题行恒取 cardPreview（title > note > excerptText > 占位）——正文块只列
 * **未被标题行吸收**的内容，避免同一段文字上下重复：
 * - note 块：note 存在且**title 也存在**（title 空时 cardPreview 已用 note 当标题）；
 * - excerpt 块：excerptText 存在且 title/note 至少一个存在（全空时已当标题）。
 * OCR 文字（存 excerptText）在各编辑/预览界面"看不到"的问题由此补齐——
 * 批注=问题、摘录=答案，与复习正反面同语义。
 */
export function cardPreviewBlocks(card: Card): { note: string | null; excerpt: string | null } {
	const title = card.title?.trim() || null;
	const note = card.note?.trim() || null;
	const excerpt = card.excerptText?.trim() || null;
	return {
		note: note && title ? note : null,
		excerpt: excerpt && (title || note) ? excerpt : null,
	};
}

/**
 * 卡片行摘要第二行（91 批）：未被标题行吸收的内容（批注 > 摘录文字，与
 * cardPreview 优先链同序）——OCR 卡/带批注卡在列表里即可见正文；全被标题
 * 吸收返回 null（不渲染空占位）。复用 cardPreviewBlocks 单源拆分。
 */
export function cardRowSummary(card: Card): string | null {
	const blocks = cardPreviewBlocks(card);
	return blocks.note ?? blocks.excerpt;
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
 * 按路径值列表聚合文件夹树核心（category/deck 共用，73-1 自 buildCategoryTree 上收）：
 * 文件夹 = 路径值的派生分组，不建实体。分组键由调用方先过段级归一（categoryPathOf /
 * deckPathOf）——手编产生的空白变体（如「学习  /英语」）与规范路径归并到同一节点，不再分裂。
 *
 * 76 explicitPaths：用户显式创建的空分组清单（数据根 分类.md/卡组.md）——仅长出
 * 节点**不计 count**（空分组徽标恒 0，all/uncategorized 不受影响）；与派生路径重复时
 * ensure 幂等命中同节点，不虚增。
 */
function buildPathTree(paths: (string | null)[], explicitPaths?: readonly string[]): CategoryTree {
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
	for (const path of paths) {
		if (!path) {
			uncategorized++;
			continue;
		}
		ensure(path).count++;
	}
	// 76 显式清单：只长节点不计数（空分组在树上可见、徽标 0）；空值防御跳过
	if (explicitPaths) {
		for (const path of explicitPaths) {
			if (!path) continue;
			ensure(path);
		}
	}
	// 自底向上累计 total（含子孙）
	const sumTotals = (node: CategoryNode): number => {
		node.total = node.count + node.children.reduce((sum, c) => sum + sumTotals(c), 0);
		return node.total;
	};
	sumTotals(root);
	sortCategoryNodes(root.children);
	return { all: paths.length, uncategorized, roots: root.children };
}

/**
 * 按文档记录聚合分类树（category 路径 → 虚拟文件夹）。
 * 76 explicitFolders：用户显式创建的空分类清单（store.getFolders）——union 进树
 * 持久可见，徽标 0 不影响文档计数。
 */
export function buildCategoryTree(
	docs: readonly BookDocument[],
	explicitFolders?: readonly string[],
): CategoryTree {
	return buildPathTree(docs.map(categoryPathOf), explicitFolders);
}

/** 文档 category 的段级归一完整路径（空/全空段/超长 → null = 未分类） */
function categoryPathOf(doc: BookDocument): string | null {
	return doc.category ? normalizeCategory(doc.category) : null;
}

/** 卡片 deck 的段级归一完整路径（空/全空段/超长 → null = 未分组；与 categoryPathOf 同构，73） */
function deckPathOf(card: Card): string | null {
	return card.deck ? normalizeCategory(card.deck) : null;
}

/**
 * 按卡片记录聚合卡组树（73 deck 路径化——与文档分类树同一核心，读侧归一防变体分裂）。
 * 76 explicitDecks：用户显式创建的空卡组清单（store.getDecks）——union 同分类。
 */
export function buildDeckTree(
	cards: readonly Card[],
	explicitDecks?: readonly string[],
): CategoryTree {
	return buildPathTree(cards.map(deckPathOf), explicitDecks);
}

/**
 * 全部已知卡组（76 设卡组选择器 items）：卡片实际卡组 ∪ 显式清单去重，拼音序。
 * 与 buildDeckTree 同源（卡片侧 distinct + 清单 union），保证选择器与左列树所见一致。
 */
export function allKnownDecks(cards: readonly Card[], explicitDecks?: readonly string[]): string[] {
	const set = new Set<string>();
	for (const card of cards) {
		const d = deckPathOf(card);
		if (d !== null) set.add(d);
	}
	for (const d of explicitDecks ?? []) {
		if (d) set.add(d);
	}
	return [...set].sort((a, b) => a.localeCompare(b, "zh-Hans-CN"));
}

/** 路径是否在目标子树内（自身或以「目标/」为前缀；斜杠边界——「学」不匹配「学习」） */
export function inPathSubtree(path: string, target: string): boolean {
	return path === target || path.startsWith(`${target}/`);
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

/** 卡片筛选条件（null = 不限；tag 含即命中——卡可多标签） */
export interface CardsFilter {
	documentId: string | null;
	excerptType: string | null;
	/**
	 * 卡组（卡组批；73 路径化树选中）：null=不限（树「全部」）/ UNSET_DECK 哨兵=未分组
	 * / 路径=含子树（选「学习」含「学习/英语」，归一后匹配）。
	 */
	deck: string | null;
	/** 标签（卡组批）：卡 tags 数组含该值即命中 */
	tag: string | null;
	/**
	 * 颜色（70）：精确匹配 card.color；UNSET_COLOR 哨兵 = 未设色（card.color 空）。
	 * 候选不取 settings.excerptColors——从实际卡片派生才含旧色相与未设色。
	 */
	color: string | null;
}

/** 卡片页视图状态：筛选 + 当前页码（页码从 1 起） */
export interface CardsPageState extends CardsFilter {
	page: number;
}

/** 颜色筛选「未设色」哨兵值（card.color 为 null 的卡；下拉 value 空间内专用，不与真实颜色撞） */
export const UNSET_COLOR = "__mm_unset__";

/** 卡组树「未分组」哨兵值（card.deck 为 null 的卡；树/筛选 value 空间内专用，不与真实路径撞，73） */
export const UNSET_DECK = "__mm_deck_unset__";

/**
 * 当前卡组筛选的有效路径（73）：null（不限）或 UNSET_DECK（未分组）→ null，真实路径原样返回。
 * 消费方三处——「复习本组」按钮（防哨兵字符串被当卡组名传给复习）、树注入
 * （injectCategoryPath 会为任意非空字符串长出真节点，哨兵必须先剥）、
 * 重命名/删除卡组后的选中态级联判定。
 */
export function activeDeckPath(deck: string | null): string | null {
	return deck === null || deck === UNSET_DECK ? null : deck;
}

/**
 * filterCards 的 deck 维谓词（73 路径化三态）：
 * UNSET_DECK=未分组（path 为 null）/ 其余值=归一后含子树匹配
 * （卡片侧先过 deckPathOf 归一，空白变体不漏配；归一失败的超长筛选值不命中任何卡）。
 */
function matchesDeckPath(path: string | null, filterDeck: string): boolean {
	if (filterDeck === UNSET_DECK) return path === null;
	const target = normalizeCategory(filterDeck);
	return target !== null && path !== null && inPathSubtree(path, target);
}

/** 按书籍/形态/卡组/标签/颜色五维 AND 筛选卡片（null 字段不限，保持传入序） */
export function filterCards(cards: readonly Card[], filter: CardsFilter): Card[] {
	return cards.filter(
		(c) =>
			(filter.documentId === null || c.documentId === filter.documentId) &&
			(filter.excerptType === null || c.excerptType === filter.excerptType) &&
			(filter.deck === null || matchesDeckPath(deckPathOf(c), filter.deck)) &&
			(filter.tag === null || c.tags.includes(filter.tag)) &&
			(filter.color === null ||
				c.color === filter.color ||
				(filter.color === UNSET_COLOR && c.color == null)),
	);
}

/**
 * 全库去重卡组名（拼音序，「按卡组复习」选卡器用；空输入返回空数组）。
 * 73 路径化：归一后去重——空白变体合并为单条，超长归一失败值不列出（落未分组桶）。
 */
export function distinctDecks(cards: readonly Card[]): string[] {
	const decks = new Set<string>();
	for (const c of cards) {
		const path = deckPathOf(c);
		if (path) decks.add(path);
	}
	return [...decks].sort((a, b) => a.localeCompare(b, "zh"));
}

/** 全库去重标签名（拼音序，主页筛选下拉共用；空输入返回空数组） */
export function distinctTags(cards: readonly Card[]): string[] {
	const tags = new Set<string>();
	for (const c of cards) {
		for (const t of c.tags) tags.add(t);
	}
	return [...tags].sort((a, b) => a.localeCompare(b, "zh"));
}

/**
 * 全库去重卡片颜色（70 主页颜色筛选下拉用）：含旧色相（teal/orange/… 存量卡
 * 继续渲染故可筛），「未设色」以 UNSET_COLOR 哨兵殿后（有未设色卡才出现该选项）。
 */
export function distinctColors(cards: readonly Card[]): string[] {
	const colors = new Set<string>();
	let hasUnset = false;
	for (const c of cards) {
		if (c.color) colors.add(c.color);
		else hasUnset = true;
	}
	const out = [...colors].sort((a, b) => a.localeCompare(b));
	if (hasUnset) out.push(UNSET_COLOR);
	return out;
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
		d.getFullYear() === n.getFullYear() &&
		d.getMonth() === n.getMonth() &&
		d.getDate() === n.getDate();
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
