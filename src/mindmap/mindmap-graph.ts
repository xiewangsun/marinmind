/**
 * 思维导图纯逻辑（零 DOM 依赖，vitest 可测）：
 * 树结构查询、拖拽 reparent 环检测、新节点自动落位、连线贝塞尔路径。
 * 与 CSS 中 .marinmind-mm-node 的尺寸约定保持一致（自动落位只求"不重叠、方向对"，用户可再拖）。
 */

/** 与 MindmapNode 兼容的最小输入形态（视图传 MindmapNodeWithCard 也满足） */
export interface GraphNode {
	id: string;
	parentId: string | null;
	x: number;
	y: number;
}

/** 节点固定宽（styles.css 中 .marinmind-mm-node { width: 200px }） */
export const NODE_WIDTH = 200;
/** 节点高度估算（含 meta 行，用于兄弟顺延落位） */
export const NODE_HEIGHT_EST = 72;
/** 列间距：父节点右缘 → 子节点左缘 */
export const GAP_X = 80;
/** 同父兄弟的垂直间距 */
export const GAP_Y = 24;
/** 相邻根节点的垂直间距 */
export const ROOT_GAP_Y = 64;

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
