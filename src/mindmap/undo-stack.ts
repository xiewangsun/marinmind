import type { MindmapRepository } from "../db/repositories/mindmap-repo";
import type { BranchStyle } from "../types";

/**
 * 全局撤销/重做（59）：纯数据 entry + 独立栈。
 * 依赖链 undo-stack → mindmap-repo → store → format 全零 DOM，vitest 直测。
 *
 * 语义：每条 entry 记录一次用户命令前后**可回退字段**的差异（坐标/父子/序/折叠/分支
 * 样式/宽度 + 图默认样式）。redo = 同一执行器换 before/after 侧重放。
 *
 * 交叉约定（见 process.md 59 条目）：
 * - 栈只由 拖拽 / 折叠（单个+批量）/ 分支样式（节点+图默认）/ 自动布局 / 调宽 五类入口写入；
 *   建卡/删卡/移出/固定根/子脑图坍缩解除/合并不进栈（级联风险取舍）。
 * - UndoNodePatch 不含 childMapId / fixedRoot——portal 身份与固定根在撤销重放中免疫。
 * - 捕获必须从 repo.listNodes 读（视图 this.nodes 在拖拽 pointermove 已被就地改写，
 *   pointerup 时刻 repo 才是真正的操作前状态）。
 * - 条目中被删节点重放时 repo 静默跳过（applyLayout 悬空 id 跳过 / setParent 拒绝返
 *   undefined）——「删节点后 undo 老条目可能少还原一层父子」与建删卡不进栈取舍一致。
 */

/** 节点可回退字段全集（不含 childMapId / cardId / mapId——身份与归属不可回退） */
export interface UndoNodePatch {
	x: number;
	y: number;
	parentId: string | null;
	/** 镜像 MindmapNode.order 可选语义（repo 实际总赋数值；undefined = 回退创建序） */
	order?: number;
	collapsed: boolean;
	branchStyle: BranchStyle | null;
	/** 镜像 MindmapNode.w 可选语义：undefined = 默认宽（重放 setNodeWidth(id, null)） */
	w?: number;
}

/** 一条撤销记录：mapId + 差分节点集 + 可选的图默认样式补丁 */
export interface UndoEntry {
	mapId: string;
	label: string;
	/** id → {操作前, 操作后}；只存变化节点（无差不进栈） */
	nodes: Map<string, { before: UndoNodePatch; after: UndoNodePatch }>;
	/** 图默认分支样式补丁（仅 setDefaultStyle 类命令非空） */
	mapDefault: { before: BranchStyle; after: BranchStyle } | null;
}

/** 撤销栈深度上限（超出丢最旧） */
export const UNDO_STACK_LIMIT = 50;

/** 图状态快照（captureMapState 产物）：id → 可回退字段 */
export type MapSnapshot = Map<string, UndoNodePatch>;

/** 双栈：undo 弹出压入 redo、redo 弹出压回 undo；push 清空 redo（新命令作废重做分支） */
export class MindmapUndoStack {
	private undoStack: UndoEntry[] = [];
	private redoStack: UndoEntry[] = [];

	/** 压入新命令（无 diff 的空 entry 由 buildUndoEntry 拦截，调用方直接判 null 不 push） */
	push(entry: UndoEntry): void {
		this.redoStack = [];
		this.undoStack.push(entry);
		if (this.undoStack.length > UNDO_STACK_LIMIT) {
			this.undoStack.shift();
		}
	}

	/** 弹出最近一条撤销（同时进入重做栈）；空栈返回 null */
	undo(): UndoEntry | null {
		const entry = this.undoStack.pop() ?? null;
		if (entry) {
			this.redoStack.push(entry);
		}
		return entry;
	}

	/** 弹出最近一条重做（同时回到撤销栈）；空栈返回 null */
	redo(): UndoEntry | null {
		const entry = this.redoStack.pop() ?? null;
		if (entry) {
			this.undoStack.push(entry);
		}
		return entry;
	}

	canUndo(): boolean {
		return this.undoStack.length > 0;
	}

	canRedo(): boolean {
		return this.redoStack.length > 0;
	}

	/** 换图/清图/关视图：整体作废（栈随视图生命周期，不跨视图） */
	clear(): void {
		this.undoStack = [];
		this.redoStack = [];
	}
}

/** 从 repo 读取图状态快照（绝不从视图内存读——拖拽中视图坐标已被就地改写） */
export function captureMapState(repo: MindmapRepository, mapId: string): MapSnapshot {
	const snap: MapSnapshot = new Map();
	for (const n of repo.listNodes(mapId)) {
		snap.set(n.id, {
			x: n.x,
			y: n.y,
			parentId: n.parentId,
			order: n.order,
			collapsed: n.collapsed,
			branchStyle: n.branchStyle,
			w: n.w,
		});
	}
	return snap;
}

/** 字段级相等判定 */
function samePatch(a: UndoNodePatch, b: UndoNodePatch): boolean {
	return (
		a.x === b.x &&
		a.y === b.y &&
		a.parentId === b.parentId &&
		a.order === b.order &&
		a.collapsed === b.collapsed &&
		a.branchStyle === b.branchStyle &&
		a.w === b.w
	);
}

/**
 * 前后快照差分构建 entry：只保留字段有变的节点；无任何差异（含 mapDefault）返回 null
 * （等价操作不占栈）。只在单侧存在的节点跳过——只在 after 的是新建（建卡不进栈的
 * 契约由入口保证，此处防御）、只在 before 的已被删（无法还原，降级语义）。
 */
export function buildUndoEntry(
	mapId: string,
	label: string,
	before: MapSnapshot,
	after: MapSnapshot,
	mapDefault: { before: BranchStyle; after: BranchStyle } | null,
): UndoEntry | null {
	const nodes = new Map<string, { before: UndoNodePatch; after: UndoNodePatch }>();
	for (const [id, b] of before) {
		const a = after.get(id);
		if (a && !samePatch(b, a)) {
			nodes.set(id, { before: b, after: a });
		}
	}
	if (nodes.size === 0 && mapDefault == null) {
		return null;
	}
	return { mapId, label, nodes, mapDefault };
}

/**
 * 重放 entry 到指定侧（"before" = 撤销 / "after" = 重做）。
 * 坐标批量 applyLayout；父子/序/折叠/样式逐节点写回；图默认样式整图写回。
 * 悬空节点（entry 之后被删）repo 各写方法静默跳过/拒绝，不抛错。
 */
export function applyUndoEntry(
	repo: MindmapRepository,
	entry: UndoEntry,
	side: "before" | "after",
): void {
	const positions = new Map<string, { x: number; y: number }>();
	for (const [id, pair] of entry.nodes) {
		const patch = pair[side];
		positions.set(id, { x: patch.x, y: patch.y });
	}
	if (positions.size > 0) {
		repo.applyLayout(entry.mapId, positions);
	}
	for (const [id, pair] of entry.nodes) {
		const patch = pair[side];
		repo.setParent(id, patch.parentId, patch.order);
		repo.setCollapsed(id, patch.collapsed);
		repo.setBranchStyle(id, patch.branchStyle);
		repo.setNodeWidth(id, patch.w ?? null); // undefined = 恢复默认宽（幂等重写无害）
	}
	if (entry.mapDefault) {
		repo.setDefaultBranchStyle(entry.mapId, entry.mapDefault[side]);
	}
}
