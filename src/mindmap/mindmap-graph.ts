/**
 * 思维导图纯逻辑（零 DOM 依赖，vitest 可测）：
 * 树结构查询、拖拽 reparent 环检测、新节点自动落位、连线贝塞尔路径、
 * 子树折叠过滤、整树自动布局、视口适配（⑨-C）。
 * 与 CSS 中 .marinmind-mm-node 的尺寸约定保持一致（自动落位只求"不重叠、方向对"，用户可再拖）。
 */

/** 与 MindmapNode 兼容的最小输入形态（视图传 MindmapNodeWithCard 也满足） */
export interface GraphNode {
	id: string;
	parentId: string | null;
	x: number;
	y: number;
	/** 子树折叠态：折叠时自身仍显示（带计数徽标），隐藏的是后代 */
	collapsed?: boolean;
}

/** 节点固定宽（styles.css 中 .marinmind-mm-node { width: 200px }） */
export const NODE_WIDTH = 200;
/** 节点高度估算（含 meta 行，用于兄弟顺延落位与自动布局纵向堆叠） */
export const NODE_HEIGHT_EST = 72;
/** 列间距：父节点右缘 → 子节点左缘 */
export const GAP_X = 80;
/** 同父兄弟的垂直间距 */
export const GAP_Y = 24;
/** 相邻根节点的垂直间距 */
export const ROOT_GAP_Y = 64;
/** 缩放下限 / 上限（Ctrl+滚轮缩放与视口适配共用） */
export const MIN_SCALE = 0.25;
export const MAX_SCALE = 2.5;

/** parentId → 子节点列表（null 键即根集合） */
export function buildChildrenMap(nodes: GraphNode[]): Map<string | null, GraphNode[]> {
	const map = new Map<string | null, GraphNode[]>();
	for (const n of nodes) {
		const list = map.get(n.parentId) ?? [];
		list.push(n);
		map.set(n.parentId, list);
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
 * 新子节点落位：父节点右侧一列；无兄弟时对齐父 y，有兄弟时排在最低兄弟下方顺延。
 */
export function suggestChildPosition(
	parent: { x: number; y: number },
	siblings: { x: number; y: number }[],
): { x: number; y: number } {
	const x = parent.x + NODE_WIDTH + GAP_X;
	const y =
		siblings.length === 0
			? parent.y
			: Math.max(...siblings.map((s) => s.y)) + NODE_HEIGHT_EST + GAP_Y;
	return { x, y };
}

/** 新根落位：无根时 (0,0)，否则排在最低根下方顺延 */
export function suggestRootPosition(existingRoots: { x: number; y: number }[]): {
	x: number;
	y: number;
} {
	if (existingRoots.length === 0) {
		return { x: 0, y: 0 };
	}
	return { x: 0, y: Math.max(...existingRoots.map((r) => r.y)) + NODE_HEIGHT_EST + ROOT_GAP_Y };
}

/**
 * 拖拽入图落位决策（阅读器高亮拖到脑图画布）：
 * 命中节点 → 挂为其子并按兄弟顺延落位（不用指针位置，与画布内加卡一致）；
 * 未命中 / 脏 id → 根节点，位置取指针世界坐标（调用方取整入库）。
 */
export function dropPlacement(
	nodes: GraphNode[],
	hitNodeId: string | null,
	pointerWorld: { x: number; y: number },
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
	);
	return { parentId: hitNodeId, ...pos };
}

/**
 * 连线路径（三次贝塞尔，世界坐标系）：
 * 起点 = 父右缘中点，终点 = 子左缘中点；控制点水平外扩，间距近时收紧、远时放宽。
 * h 由视图传实测 offsetHeight（无 DOM 时缺省估算值）。
 */
export function edgePath(
	parent: { x: number; y: number; h?: number },
	child: { x: number; y: number; h?: number },
): string {
	const x1 = parent.x + NODE_WIDTH;
	const y1 = parent.y + (parent.h ?? NODE_HEIGHT_EST) / 2;
	const x2 = child.x;
	const y2 = child.y + (child.h ?? NODE_HEIGHT_EST) / 2;
	const dx = Math.min(Math.max(Math.abs(x2 - x1) / 2, 40), 160);
	return `M ${x1} ${y1} C ${x1 + dx} ${y1}, ${x2 - dx} ${y2}, ${x2} ${y2}`;
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

/**
 * 整树自动布局（经典"左根右叶"层级树）：
 * - x = 深度 × (NODE_WIDTH + GAP_X)，同深度严格对齐一列；
 * - 叶子按深度优先纵序依次堆叠（间隔 GAP_Y）；
 * - 父节点垂直居中于其全部后代构成的子块；
 * - 多根（含孤儿：parent 指向集合外的悬空引用）自上而下纵向堆叠（间隔 ROOT_GAP_Y）。
 * 返回**全量节点**（含折叠隐藏的后代——展开后位置也合理）的新坐标；
 * 父子成环等脏数据不会死循环（环上节点不入结果，applyLayout 跳过后保留旧坐标）。
 */
export function layoutTree(nodes: GraphNode[]): Map<string, { x: number; y: number }> {
	const result = new Map<string, { x: number; y: number }>();
	if (nodes.length === 0) {
		return result;
	}
	const byId = new Map(nodes.map((n) => [n.id, n]));
	const childrenMap = buildChildrenMap(nodes);
	// 根集合：parentId 为空，或悬空引用（父不在集合内 → 孤儿上浮为根）
	const roots = nodes.filter((n) => n.parentId == null || !byId.has(n.parentId));

	// 布局单棵子树，返回子树块的底缘（下一个可用 y）；visited 防环
	const layoutSubtree = (
		node: GraphNode,
		depth: number,
		top: number,
		visited: Set<string>,
	): number => {
		visited.add(node.id);
		const x = depth * (NODE_WIDTH + GAP_X);
		const children = (childrenMap.get(node.id) ?? []).filter((c) => !visited.has(c.id));
		if (children.length === 0) {
			result.set(node.id, { x, y: top });
			return top + NODE_HEIGHT_EST;
		}
		let bottom = top;
		for (const child of children) {
			bottom = layoutSubtree(child, depth + 1, bottom, visited) + GAP_Y;
		}
		bottom -= GAP_Y; // 间距只在子块之间，最后一块下方不留
		// 父节点垂直居中于子块 [top, bottom]
		result.set(node.id, { x, y: (top + bottom - NODE_HEIGHT_EST) / 2 });
		return bottom;
	};

	const visited = new Set<string>();
	let cursor = 0;
	for (const root of roots) {
		cursor = layoutSubtree(root, 0, cursor, visited) + ROOT_GAP_Y;
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
