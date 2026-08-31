/**
 * 思维导图纯逻辑（零 DOM 依赖，vitest 可测）：
 * 树结构查询、拖拽 reparent 环检测、新节点自动落位、连线贝塞尔路径、
 * 子树折叠过滤、整树自动布局、视口适配（⑨-C）、分支样式变体（⑱）、
 * XMind 式拖放分区/兄弟排序/子树整理（㉜）。
 * 与 CSS 中 .marinmind-mm-node 的尺寸约定保持一致（自动落位只求"不重叠、方向对"，用户可再拖）。
 */
import type { BranchStyle } from "../types";
import { isBranchStyle } from "../types";

/** 与 MindmapNode 兼容的最小输入形态（视图传 MindmapNodeWithCard 也满足） */
export interface GraphNode {
	id: string;
	parentId: string | null;
	x: number;
	y: number;
	/** 子树折叠态：折叠时自身仍显示（带计数徽标），隐藏的是后代 */
	collapsed?: boolean;
	/** 分支样式覆盖（⑱）：合法值生效，null/undefined = 继承（祖先覆盖 → 图默认） */
	branchStyle?: string | null;
	/** 节点实测高（㉜，视图传 offsetHeight）：媒体图节点远高于估值，布局按实测高排防重叠；
	 * 缺省回退 NODE_HEIGHT_EST（纯函数调用方与旧测试无感） */
	h?: number;
	/** 兄弟序（㉜，手动重排）：同父兄弟的显示/堆叠顺序；
	 * 缺省回退创建序（createdAt, id）——md 存储层解析时按下标赋值，旧数据天然有序 */
	order?: number;
	/** 创建时间戳（order 缺省时的次级排序键，MindmapNode 自带） */
	createdAt?: number;
}

/**
 * 节点生效分支样式：沿父链向上找最近的合法覆盖，都没有则用图默认。
 * 样式归属父节点——node 的生效样式决定其子节点如何挂出（连线形状 + 布局排列）。
 * visited 防御脏数据 parent 成环导致的死循环。
 */
export function effectiveBranchStyle(
	nodes: GraphNode[],
	nodeId: string,
	mapDefault: BranchStyle,
): BranchStyle {
	const byId = new Map(nodes.map((n) => [n.id, n]));
	const visited = new Set<string>();
	let cur = byId.get(nodeId);
	while (cur && !visited.has(cur.id)) {
		visited.add(cur.id);
		if (cur.branchStyle != null && isBranchStyle(cur.branchStyle)) {
			return cur.branchStyle;
		}
		cur = cur.parentId == null ? undefined : byId.get(cur.parentId);
	}
	return mapDefault;
}

/** 节点固定宽（styles.css 中 .marinmind-mm-node { width: 200px }） */
export const NODE_WIDTH = 200;
/** 节点高度估算（含 meta 行，用于兄弟顺延落位与自动布局纵向堆叠） */
export const NODE_HEIGHT_EST = 72;
/** 列间距：父节点右缘 → 子节点左缘（㉜ 参照 XMind 放宽，80 → 120） */
export const GAP_X = 120;
/** 同父兄弟的垂直间距（㉜ 参照 XMind 放宽，24 → 40） */
export const GAP_Y = 40;
/** 相邻根节点的垂直间距（㉜ 参照 XMind 放宽，64 → 110） */
export const ROOT_GAP_Y = 110;
/** 缩放下限 / 上限（Ctrl+滚轮缩放与视口适配共用） */
export const MIN_SCALE = 0.25;
export const MAX_SCALE = 2.5;

/**
 * 兄弟/根排序比较器（㉜ 单一排序源）：order 优先 → 创建序 → id；
 * buildChildrenMap / insertOrder / restackRoots / mindmap-format 序列化共用，
 * 保证"显示堆叠顺序 = 文件列表顺序 = 插入计算基准"三处一致。
 */
export function compareSiblings(
	a: { id: string; order?: number; createdAt?: number },
	b: { id: string; order?: number; createdAt?: number },
): number {
	if (a.order !== b.order) {
		return (a.order ?? Number.MAX_SAFE_INTEGER) - (b.order ?? Number.MAX_SAFE_INTEGER);
	}
	const ac = a.createdAt ?? 0;
	const bc = b.createdAt ?? 0;
	if (ac !== bc) {
		return ac - bc;
	}
	return a.id < b.id ? -1 : 1;
}

/** parentId → 子节点列表（null 键即根集合）；列表已按 compareSiblings 排序（㉜） */
export function buildChildrenMap(nodes: GraphNode[]): Map<string | null, GraphNode[]> {
	const map = new Map<string | null, GraphNode[]>();
	for (const n of nodes) {
		const list = map.get(n.parentId) ?? [];
		list.push(n);
		map.set(n.parentId, list);
	}
	for (const list of map.values()) {
		list.sort(compareSiblings);
	}
	return map;
}

/**
 * ancestorId 是否为 targetId 的祖先（或自身）——拖拽 reparent 的环检测：
 * 把节点挂到自己的后代上会形成环，必须拒绝。
 * 沿 parent 链向上爬；visited 集合防御脏数据成环导致的死循环。
 */
export function isDescendantOrSelf(
	nodes: GraphNode[],
	ancestorId: string,
	targetId: string,
): boolean {
	const byId = new Map(nodes.map((n) => [n.id, n]));
	const visited = new Set<string>();
	let cur = byId.get(targetId);
	while (cur) {
		if (cur.id === ancestorId) {
			return true;
		}
		if (visited.has(cur.id)) {
			return false; // 脏数据成环：终止
		}
		visited.add(cur.id);
		cur = cur.parentId == null ? undefined : byId.get(cur.parentId);
	}
	return false;
}

/**
 * 新子节点落位（方向随父节点生效分支样式）：
 * tree/line/bidir/frame → 父右侧一列；tree-left → 父左侧一列；
 * tree-down → 父下方一行顺延（按兄弟数粗略推进，仅求方向对）。
 */
export function suggestChildPosition(
	parent: { x: number; y: number },
	siblings: { x: number; y: number }[],
	style: BranchStyle = "tree",
): { x: number; y: number } {
	const nextY =
		siblings.length === 0
			? parent.y
			: Math.max(...siblings.map((s) => s.y)) + NODE_HEIGHT_EST + GAP_Y;
	switch (style) {
		case "tree-left":
			return { x: parent.x - NODE_WIDTH - GAP_X, y: nextY };
		case "tree-down":
			return { x: parent.x + siblings.length * (NODE_WIDTH + GAP_X), y: parent.y + NODE_HEIGHT_EST + 2 * GAP_Y };
		default:
			return { x: parent.x + NODE_WIDTH + GAP_X, y: nextY };
	}
}

/**
 * 新根落位：无根时 (0,0)，否则排在最低根下方顺延。
 * ㊺ 起收可选 h（视图实测高度）——三栏节点实际高度普遍大于估值 72，
 * 只看根 y 顶点会把新根排进矮估的上一根身位里
 */
export function suggestRootPosition(
	existingRoots: { x: number; y: number; h?: number }[],
): {
	x: number;
	y: number;
} {
	if (existingRoots.length === 0) {
		return { x: 0, y: 0 };
	}
	return {
		x: 0,
		y: Math.max(...existingRoots.map((r) => r.y + (r.h ?? NODE_HEIGHT_EST))) + ROOT_GAP_Y,
	};
}

/**
 * 拖拽入图落位决策（阅读器高亮拖到脑图画布）：
 * 命中节点 → 挂为其子并按其生效分支样式落位（不用指针位置，与画布内加卡一致）；
 * 未命中 / 脏 id → 根节点，位置取指针世界坐标（调用方取整入库）。
 */
export function dropPlacement(
	nodes: GraphNode[],
	hitNodeId: string | null,
	pointerWorld: { x: number; y: number },
	mapDefault: BranchStyle = "tree",
): { parentId: string | null; x: number; y: number } {
	if (hitNodeId == null) {
		return { parentId: null, ...pointerWorld };
	}
	const parent = nodes.find((n) => n.id === hitNodeId);
	if (!parent) {
		return { parentId: null, ...pointerWorld };
	}
	const pos = suggestChildPosition(
		parent,
		nodes.filter((n) => n.parentId === hitNodeId),
		effectiveBranchStyle(nodes, parent.id, mapDefault),
	);
	return { parentId: hitNodeId, ...pos };
}

/**
 * 拖放分区（㉜，XMind 式）：目标节点盒沿兄弟堆叠轴三等分——
 * v 轴（tree/tree-left/bidir/line/frame 及根）：上 1/3 = before（插为同级前方）、
 * 中 1/3 = inside（挂为子）、下 1/3 = after（插为同级后方）；
 * h 轴（tree-down 的子节点行）：左/中/右对应 before/inside/after。
 */
export type DropZoneKind = "before" | "inside" | "after";

export function dropZoneFor(
	target: { x: number; y: number; w: number; h: number },
	pointerWorld: { x: number; y: number },
	axis: "v" | "h" = "v",
): DropZoneKind {
	// 相对比例不截断：指针在盒外（极端拖拽角度）时自然落入 before/after 侧
	const rel =
		axis === "h"
			? (pointerWorld.x - target.x) / target.w
			: (pointerWorld.y - target.y) / target.h;
	return rel < 1 / 3 ? "before" : rel < 2 / 3 ? "inside" : "after";
}

/**
 * 兄弟插入序号（㉜）：把节点插到 targetId 的 before/after 侧时的新 order 值——
 * 取相邻两兄弟 order 的中点（端点 = 相邻 ±1，可为负/浮点，只需保持相对顺序）。
 * siblings 应**不含被拖节点自身**（它正被重新插入）；
 * targetId 不在列表（防御）返回 siblings.length（追加末位）。
 */
export function insertOrder(
	siblings: Array<{ id: string; order?: number; createdAt?: number }>,
	targetId: string,
	side: "before" | "after",
): number {
	const sorted = [...siblings].sort(compareSiblings);
	const idx = sorted.findIndex((s) => s.id === targetId);
	if (idx < 0) {
		return siblings.length;
	}
	const prev = side === "before" ? sorted[idx - 1]?.order : sorted[idx]?.order;
	const next = side === "before" ? sorted[idx]?.order : sorted[idx + 1]?.order;
	if (prev == null && next == null) {
		return 0;
	}
	if (prev == null) {
		return (next as number) - 1;
	}
	if (next == null) {
		return prev + 1;
	}
	return (prev + next) / 2;
}

/** 水平肘弯贝塞尔：从 (x1,y1) 指向 (x2,y2)，控制点向 x2 方向水平外扩（间距近收紧、远放宽） */
function hElbow(x1: number, y1: number, x2: number, y2: number): string {
	const dx = Math.min(Math.max(Math.abs(x2 - x1) / 2, 40), 160);
	const sign = x2 >= x1 ? 1 : -1;
	return `M ${x1} ${y1} C ${x1 + sign * dx} ${y1}, ${x2 - sign * dx} ${y2}, ${x2} ${y2}`;
}

/**
 * 连线路径（世界坐标系，随父节点生效分支样式分形，⑱）：
 * - tree：三次贝塞尔——默认父右缘中点 → 子左缘中点；**㉜ 锚点自适应**：
 *   子被拖到父左侧时自动镜像为父左缘 → 子右缘（修复手动移动子节点后连线绕回打结）；
 * - tree-left：镜像——默认父左 → 子右，子在父右侧时同样自动镜像（㉜）；
 * - bidir：双向——按子节点相对方位选边（子在右走右接、在左走左接），
 *   孙节点延续父辈所在侧（布局侧见 layoutTree 的 bidir 分支）；
 * - tree-down：组织架构图正交折线——父底缘中点 → 垂直短线 → 水平段 → 子顶缘中点
 *   （子在父上方时自动镜像为 顶→底）；
 * - line：直线——水平段为主（高度不齐时中段直角校正），MN 直线链同款；
 * - frame：无连线（返回 null，层级由收纳框表达，视图画 frameRectFor 矩形）。
 * h 由视图传实测 offsetHeight（无 DOM 时缺省估算值）。
 */
export function edgePath(
	parent: { x: number; y: number; h?: number },
	child: { x: number; y: number; h?: number },
	style: BranchStyle = "tree",
): string | null {
	const ph = parent.h ?? NODE_HEIGHT_EST;
	const ch = child.h ?? NODE_HEIGHT_EST;
	const py = parent.y + ph / 2;
	const cy = child.y + ch / 2;
	switch (style) {
		case "tree-left": {
			// 镜像树：默认父左 → 子右；子中心在父右侧时镜像（㉜ 锚点自适应）
			const left = child.x + NODE_WIDTH / 2 <= parent.x + NODE_WIDTH / 2;
			return left
				? hElbow(parent.x, py, child.x + NODE_WIDTH, cy)
				: hElbow(parent.x + NODE_WIDTH, py, child.x, cy);
		}
		case "bidir": {
			// 双向：子中心在父中心右侧走右接，左侧走左接
			const right = child.x + NODE_WIDTH / 2 >= parent.x + NODE_WIDTH / 2;
			return right
				? hElbow(parent.x + NODE_WIDTH, py, child.x, cy)
				: hElbow(parent.x, py, child.x + NODE_WIDTH, cy);
		}
		case "tree-down": {
			// 组织架构图正交折线；子在父上方时上下镜像
			const x1 = parent.x + NODE_WIDTH / 2;
			const x2 = child.x + NODE_WIDTH / 2;
			const below = cy >= py;
			const y1 = below ? parent.y + ph : parent.y;
			const y2 = below ? child.y : child.y + ch;
			const midY = (y1 + y2) / 2;
			return `M ${x1} ${y1} V ${midY} H ${x2} V ${y2}`;
		}
		case "line": {
			// 直线：水平段 + 高度不齐时的中段直角校正（同高时即纯水平直线）
			const right = child.x >= parent.x;
			const x1 = right ? parent.x + NODE_WIDTH : parent.x;
			const x2 = right ? child.x : child.x + NODE_WIDTH;
			const midX = (x1 + x2) / 2;
			return `M ${x1} ${py} H ${midX} V ${cy} H ${x2}`;
		}
		case "frame":
			return null; // 框架：不画连线（视图画收纳框）
		default: {
			// tree：经典右接贝塞尔；子中心在父左侧时镜像（㉜，与 bidir 同款技术）
			const right = child.x + NODE_WIDTH / 2 >= parent.x + NODE_WIDTH / 2;
			return right
				? hElbow(parent.x + NODE_WIDTH, py, child.x, cy)
				: hElbow(parent.x, py, child.x + NODE_WIDTH, cy);
		}
	}
}

/**
 * 摘录自动入图落点决策（⑲，MN4「自动添加到脑图 · 分组（按文档）」同款语义）：
 * 每个文档在图中对应一个"分组节点"——其卡片 documentId 匹配且 page 为 null
 * （手工卡 documentId 为 null、真实摘录卡 page 非空，两类都不会误判成分组）。
 * 已有分组 → 新摘录挂其子（随分组生效样式落位，与既有兄弟顺延）；
 * 尚无分组 → 返回 createGroup 计划：调用方先建《文档名》分组卡落根区，
 * 再把摘录卡挂其下（childPos 已按图默认样式算好）。
 * 手工卡（documentId 为 null）同样返回 createGroup 计划——是否入队由视图层
 * 在订阅入口过滤（自动收录只收文档摘录卡），纯函数不预设该策略。
 */
export interface AutoCollectPlan {
	/** true = 需先创建文档分组节点（groupPos 是其根区落位；parentId 置 null 占位） */
	createGroup: boolean;
	/** 分组节点的根区落位（仅 createGroup=true 时有意义） */
	groupPos: { x: number; y: number };
	/** 摘录卡挂接的父节点 id（createGroup=false 时为既有分组节点 id） */
	parentId: string | null;
	/** 摘录卡落位（世界坐标，调用方取整入库） */
	childPos: { x: number; y: number };
}

/** 摘录自动入图落点（按文档分组，⑲）：见 AutoCollectPlan 注释 */
export function autoCollectPlacement(
	nodes: Array<GraphNode & { card: { documentId: string | null; page: number | null } }>,
	card: { documentId: string | null; page: number | null },
	mapDefault: BranchStyle = "tree",
): AutoCollectPlan {
	const group =
		card.documentId == null
			? undefined
			: nodes.find(
					(n) =>
						n.card.documentId === card.documentId && n.card.page == null,
				);
	if (group) {
		// 已有分组：挂其下，与既有兄弟顺延（方向随分组生效样式）
		const siblings = nodes.filter((n) => n.parentId === group.id);
		return {
			createGroup: false,
			groupPos: { x: 0, y: 0 },
			parentId: group.id,
			childPos: suggestChildPosition(
				group,
				siblings,
				effectiveBranchStyle(nodes, group.id, mapDefault),
			),
		};
	}
	// 尚无分组：分组卡落根区最下方顺延，首张摘录卡按图默认样式挂其下
	const groupPos = suggestRootPosition(
		nodes.filter((n) => n.parentId === null).map((n) => ({ x: n.x, y: n.y })),
	);
	return {
		createGroup: true,
		groupPos,
		parentId: null,
		childPos: suggestChildPosition(groupPos, [], mapDefault),
	};
}

/**
 * 固定根节点挂子落位（㉗）：新摘录直挂 fixedRootNodeId 之下，
 * 与既有兄弟顺延（方向随该节点生效样式）；节点不在图中返回 null（调用方走分组路径）。
 */
export function fixedRootPlacement(
	nodes: Array<GraphNode & { card: { documentId: string | null; page: number | null } }>,
	fixedRootNodeId: string,
	mapDefault: BranchStyle = "tree",
): { x: number; y: number } | null {
	const root = nodes.find((n) => n.id === fixedRootNodeId);
	if (!root) {
		return null;
	}
	const siblings = nodes.filter((n) => n.parentId === fixedRootNodeId);
	return suggestChildPosition(
		root,
		siblings,
		effectiveBranchStyle(nodes, fixedRootNodeId, mapDefault),
	);
}

/** 框架收纳框内边距（框矩形 = 子节点实际包围盒外扩该值） */
export const FRAME_PADDING = 20;
export const FRAME_COLS = 2;

/** 框架收纳框：全部可见子节点的实际包围盒外扩 FRAME_PADDING（无子返回 null） */
export function frameRectFor(
	children: { x: number; y: number; w: number; h: number }[],
): { x: number; y: number; w: number; h: number } | null {
	if (children.length === 0) {
		return null;
	}
	let minX = Infinity;
	let minY = Infinity;
	let maxX = -Infinity;
	let maxY = -Infinity;
	for (const c of children) {
		minX = Math.min(minX, c.x);
		minY = Math.min(minY, c.y);
		maxX = Math.max(maxX, c.x + c.w);
		maxY = Math.max(maxY, c.y + c.h);
	}
	return {
		x: minX - FRAME_PADDING,
		y: minY - FRAME_PADDING,
		w: maxX - minX + FRAME_PADDING * 2,
		h: maxY - minY + FRAME_PADDING * 2,
	};
}

/**
 * 可见节点 id 集合（折叠过滤）：祖先链上任一节点折叠即隐藏。
 * 自身折叠时自身仍可见——藏的是后代；孤儿（父不在集合内）视为根，不受影响。
 * visited 防御脏数据 parent 成环导致的死循环。
 */
export function visibleNodes(nodes: GraphNode[]): Set<string> {
	const byId = new Map(nodes.map((n) => [n.id, n]));
	const visible = new Set<string>();
	for (const n of nodes) {
		const visited = new Set<string>([n.id]);
		let cur = n.parentId == null ? undefined : byId.get(n.parentId);
		let show = true;
		while (cur && !visited.has(cur.id)) {
			if (cur.collapsed) {
				show = false;
				break;
			}
			visited.add(cur.id);
			cur = cur.parentId == null ? undefined : byId.get(cur.parentId);
		}
		if (show) {
			visible.add(n.id);
		}
	}
	return visible;
}

/** 子树包围盒（世界坐标；兄弟堆叠与多根堆叠由调用方用包围盒推进游标） */
interface BBox {
	minX: number;
	minY: number;
	maxX: number;
	maxY: number;
}

/** 布局引擎（㉜ 从 layoutTree 拆出）：layoutTree 与 layoutSubtree 共用的递归核心 */
interface LayoutEngine {
	result: Map<string, { x: number; y: number }>;
	childrenMap: Map<string | null, GraphNode[]>;
	visited: Set<string>;
	layoutNode(
		node: GraphNode,
		x: number,
		top: number,
		inherit: BranchStyle | undefined,
		visited: Set<string>,
	): BBox;
}

/**
 * 创建布局引擎：递归 layoutNode 把 node 左上角落点 (x, top)，返回子树包围盒。
 * inherit 为父层下传的样式（bidir 子节点按所在侧改为单侧延续）；
 * visited 防环——已在当前布局路径上的子节点跳过（环上节点不入结果）。
 * 节点高度用 node.h（视图实测）?? NODE_HEIGHT_EST（㉜：媒体图节点更高，按估值排会重叠）。
 */
function createLayoutEngine(nodes: GraphNode[], mapDefault: BranchStyle): LayoutEngine {
	const childrenMap = buildChildrenMap(nodes);
	const result = new Map<string, { x: number; y: number }>();
	const visited = new Set<string>();
	const W = NODE_WIDTH;
	const H = NODE_HEIGHT_EST;

	const layoutNode = (
		node: GraphNode,
		x: number,
		top: number,
		inherit: BranchStyle | undefined,
		visit: Set<string>,
	): BBox => {
		visit.add(node.id);
		const nh = node.h ?? H;
		const kids = (childrenMap.get(node.id) ?? []).filter((c) => !visit.has(c.id));
		const own =
			node.branchStyle != null && isBranchStyle(node.branchStyle)
				? node.branchStyle
				: undefined;
		const style: BranchStyle = own ?? inherit ?? mapDefault;
		if (kids.length === 0) {
			result.set(node.id, { x, y: top });
			return { minX: x, minY: top, maxX: x + W, maxY: top + nh };
		}
		switch (style) {
			case "tree-left": {
				// 镜像树：子节点左侧一列纵向堆叠
				let cursor = top;
				let minX = x;
				let maxX = x + W;
				for (const c of kids) {
					const b = layoutNode(c, x - W - GAP_X, cursor, style, visit);
					cursor = b.maxY + GAP_Y;
					minX = Math.min(minX, b.minX);
					maxX = Math.max(maxX, b.maxX);
				}
				// 父高于子块时以父高兜底（blockBottom 不小于 top+nh，居中不越界）
				const bottom = Math.max(cursor - GAP_Y, top + nh);
				result.set(node.id, { x, y: (top + bottom - nh) / 2 });
				return { minX, minY: top, maxX, maxY: bottom };
			}
			case "tree-down": {
				// 组织架构图：子节点横排在父下方一行，父水平居中于子行
				const rowY = top + nh + GAP_Y;
				let cx = x;
				let maxY = rowY;
				for (const c of kids) {
					const b = layoutNode(c, cx, rowY, style, visit);
					cx = b.maxX + GAP_X;
					maxY = Math.max(maxY, b.maxY);
				}
				const rowRight = cx - GAP_X;
				result.set(node.id, { x: (x + rowRight - W) / 2, y: top });
				return { minX: x, minY: top, maxX: rowRight, maxY };
			}
			case "line": {
				// 直线链：子节点与父同高横向排链，各子子树按包围盒占位
				let cx = x + W + GAP_X;
				let maxY = top + nh;
				for (const c of kids) {
					const b = layoutNode(c, cx, top, style, visit);
					cx = b.maxX + GAP_X;
					maxY = Math.max(maxY, b.maxY);
				}
				result.set(node.id, { x, y: top });
				return { minX: x, minY: top, maxX: cx - GAP_X, maxY };
			}
			case "bidir": {
				// 双向：前半子挂右侧（向右延续 tree），后半挂左侧（向左延续 tree-left）
				const rightKids = kids.slice(0, Math.ceil(kids.length / 2));
				const leftKids = kids.slice(Math.ceil(kids.length / 2));
				let rCursor = top;
				let minX = x;
				let maxX = x + W;
				for (const c of rightKids) {
					const b = layoutNode(c, x + W + GAP_X, rCursor, "tree", visit);
					rCursor = b.maxY + GAP_Y;
					maxX = Math.max(maxX, b.maxX);
				}
				let lCursor = top;
				for (const c of leftKids) {
					const b = layoutNode(c, x - W - GAP_X, lCursor, "tree-left", visit);
					lCursor = b.maxY + GAP_Y;
					minX = Math.min(minX, b.minX);
				}
				const bottom = Math.max(
					rightKids.length > 0 ? rCursor - GAP_Y : top + nh,
					leftKids.length > 0 ? lCursor - GAP_Y : top + nh,
					top + nh,
				);
				result.set(node.id, { x, y: (top + bottom - nh) / 2 });
				return { minX, minY: top, maxX, maxY: bottom };
			}
			case "frame": {
				// 框架：子节点在父右侧按 FRAME_COLS 列网格收纳（行满换行，行高取本行最高子块）
				const fx = x + W + GAP_X;
				let cx = fx;
				let cy = top;
				let rowBottom = top;
				let gridMaxX = fx;
				kids.forEach((c, i) => {
					if (i > 0 && i % FRAME_COLS === 0) {
						cx = fx;
						cy = rowBottom + GAP_Y;
					}
					const b = layoutNode(c, cx, cy, style, visit);
					cx = b.maxX + GAP_X;
					rowBottom = Math.max(rowBottom, b.maxY);
					gridMaxX = Math.max(gridMaxX, b.maxX);
				});
				result.set(node.id, { x, y: top });
				// 收纳框渲染时按实际节点位置重算（frameRectFor），此处包围盒只负责
				// 兄弟/多根间距——外扩 FRAME_PADDING 防视觉框压到相邻子树
				return {
					minX: Math.min(x, fx - FRAME_PADDING),
					minY: top,
					maxX: gridMaxX + FRAME_PADDING,
					maxY: Math.max(rowBottom + FRAME_PADDING, top + nh),
				};
			}
			default: {
				// tree：经典左根右叶（子块下方不留尾距，父垂直居中于子块）
				let cursor = top;
				let maxX = x + W;
				for (const c of kids) {
					const b = layoutNode(c, x + W + GAP_X, cursor, style, visit);
					cursor = b.maxY + GAP_Y;
					maxX = Math.max(maxX, b.maxX);
				}
				const bottom = Math.max(cursor - GAP_Y, top + nh);
				result.set(node.id, { x, y: (top + bottom - nh) / 2 });
				return { minX: x, minY: top, maxX, maxY: bottom };
			}
		}
	};

	return { result, childrenMap, visited, layoutNode };
}

/**
 * 收集子树全部节点 id（含自身与折叠隐藏的后代；环上安全——visited 防死循环）。
 * 拖拽子树跟随 / 自由落位批量写库 / 根重堆叠共用。
 */
export function subtreeIds(nodes: GraphNode[], rootId: string): string[] {
	return subtreeIdsFromMap(buildChildrenMap(nodes), rootId);
}

/** subtreeIds 的内部形态（调用方已持有 childrenMap 时免重复构建） */
function subtreeIdsFromMap(
	childrenMap: Map<string | null, GraphNode[]>,
	rootId: string,
): string[] {
	const out: string[] = [];
	const visited = new Set<string>([rootId]);
	const walk = (id: string): void => {
		out.push(id);
		for (const c of childrenMap.get(id) ?? []) {
			if (!visited.has(c.id)) {
				visited.add(c.id);
				walk(c.id);
			}
		}
	};
	walk(rootId);
	return out;
}

/**
 * 整树自动布局（样式感知，⑱；㉜ 间距放宽 + 实测高 + 根按 order 排序）：
 * 每个节点按自身生效分支样式排列其子树——
 * - tree：经典"左根右叶"——子节点右侧一列纵向堆叠，父垂直居中于子块（与 ⑨ 版逐值一致）；
 * - tree-left：镜像"右根左叶"——子节点左侧一列（世界坐标可为负）；
 * - tree-down：组织架构图——子节点横排在父下方一行，父水平居中于子行；
 * - line：直线链——子节点与父同高横向排链，各子子树按包围盒占位互不重叠；
 * - bidir：双向——前半子节点挂父右侧、后半挂左侧（父居中），子节点继承所在侧的
 *   单侧样式（孙节点不再二次分叉，与 MN 语义一致）；
 * - frame：框架——子节点在父右侧以 FRAME_COLS 列网格收纳，格大小 = 子树包围盒
 *   （子树可向右展开不压相邻格），返回包围盒含 FRAME_PADDING 间距。
 * 节点生效样式 = 自身覆盖 ?? 父层下传继承（bidir 侧别）?? 图默认。
 * 返回**全量节点**（含折叠隐藏的后代——展开后位置也合理）的新坐标；
 * 多根（含孤儿）按 order 自上而下纵向堆叠（间隔 ROOT_GAP_Y）；
 * 父子成环等脏数据不会死循环（环上节点不入结果，applyLayout 跳过后保留旧坐标）。
 */
export function layoutTree(
	nodes: GraphNode[],
	mapDefault: BranchStyle = "tree",
): Map<string, { x: number; y: number }> {
	if (nodes.length === 0) {
		return new Map();
	}
	const engine = createLayoutEngine(nodes, mapDefault);
	// 根集合（buildChildrenMap 已排序）：parentId 为空 + 悬空引用（父不在集合内 → 孤儿上浮为根）
	const byId = new Map(nodes.map((n) => [n.id, n]));
	const roots = [
		...(engine.childrenMap.get(null) ?? []),
		...nodes.filter((n) => n.parentId != null && !byId.has(n.parentId)),
	];
	let cursorY = 0;
	for (const root of roots) {
		const b = engine.layoutNode(root, 0, cursorY, undefined, engine.visited);
		cursorY = b.maxY + ROOT_GAP_Y;
	}
	return engine.result;
}

/**
 * 单棵子树布局（㉜）：对 rootId 子树跑与 layoutTree 相同的递归，
 * 但**根节点钉在原位**（anchor 缺省 = 该根当前 x/y——整理受影响分支时不动分支头，
 * 只让后代相对归位）；布局引擎的 (x, top) 是子树块左上角而非根节点最终位置，
 * 布局后整体平移把根钉回 anchor。
 * 返回该子树全部节点（含折叠隐藏的后代）的新坐标；rootId 不存在返回空 Map。
 */
export function layoutSubtree(
	nodes: GraphNode[],
	rootId: string,
	mapDefault: BranchStyle = "tree",
	anchor?: { x: number; y: number },
): Map<string, { x: number; y: number }> {
	const root = nodes.find((n) => n.id === rootId);
	if (!root) {
		return new Map();
	}
	const engine = createLayoutEngine(nodes, mapDefault);
	engine.layoutNode(root, anchor?.x ?? root.x, anchor?.y ?? root.y, undefined, engine.visited);
	const placed = engine.result.get(rootId);
	if (placed) {
		const dx = (anchor?.x ?? root.x) - placed.x;
		const dy = (anchor?.y ?? root.y) - placed.y;
		if (dx !== 0 || dy !== 0) {
			for (const p of engine.result.values()) {
				p.x += dx;
				p.y += dy;
			}
		}
	}
	return engine.result;
}

/**
 * 根重堆叠（㉜）：各根子树按**当前坐标**的包围盒自上而下重排（间隔 ROOT_GAP_Y），
 * 保留每根的 x 与子树内部相对位置（整棵子树只平移 dy）；首根保持原位、其后依次紧凑。
 * 已是标准间距时零变动（返回空 Map）——applyLayout 只写返回的 id，无写放大。
 * 根序与 buildChildrenMap 一致（order → 创建序 → id）。
 */
export function restackRoots(nodes: GraphNode[]): Map<string, { x: number; y: number }> {
	const result = new Map<string, { x: number; y: number }>();
	if (nodes.length === 0) {
		return result;
	}
	const byId = new Map(nodes.map((n) => [n.id, n]));
	const childrenMap = buildChildrenMap(nodes);
	const roots = [
		...(childrenMap.get(null) ?? []),
		...nodes.filter((n) => n.parentId != null && !byId.has(n.parentId)),
	];
	let nextTop: number | null = null;
	for (const root of roots) {
		const ids = subtreeIdsFromMap(childrenMap, root.id);
		let minY = Infinity;
		let maxY = -Infinity;
		for (const id of ids) {
			const n = byId.get(id);
			if (!n) {
				continue;
			}
			minY = Math.min(minY, n.y);
			maxY = Math.max(maxY, n.y + (n.h ?? NODE_HEIGHT_EST));
		}
		if (minY === Infinity) {
			continue;
		}
		// dy = 平移量：首根不动（dy=0），后续根被推向上使紧凑排列
		const dy: number = nextTop == null ? 0 : nextTop - minY;
		if (dy !== 0) {
			for (const id of ids) {
				const n = byId.get(id);
				if (n) {
					result.set(id, { x: n.x, y: n.y + dy });
				}
			}
		}
		nextTop = maxY + dy + ROOT_GAP_Y;
	}
	return result;
}

/**
 * 视口适配：让世界坐标包围盒在留 padding 边距后完整可见并居中。
 * scale 只缩小不放大（min 1），并夹在与手势缩放一致的 [MIN_SCALE, MAX_SCALE]；
 * 屏幕坐标 = 世界坐标 × scale + t，据此反解居中的 tx/ty。
 */
export function fitViewportTransform(
	bbox: { minX: number; minY: number; maxX: number; maxY: number },
	viewport: { width: number; height: number },
	padding: number,
): { tx: number; ty: number; scale: number } {
	const w = Math.max(bbox.maxX - bbox.minX, 1);
	const h = Math.max(bbox.maxY - bbox.minY, 1);
	// 可用区域（留边后），下限 1 防除零
	const availW = Math.max(viewport.width - padding * 2, 1);
	const availH = Math.max(viewport.height - padding * 2, 1);
	const scale = Math.min(
		MAX_SCALE,
		Math.max(MIN_SCALE, Math.min(1, availW / w, availH / h)),
	);
	const tx = (viewport.width - w * scale) / 2 - bbox.minX * scale;
	const ty = (viewport.height - h * scale) / 2 - bbox.minY * scale;
	return { tx, ty, scale };
}
