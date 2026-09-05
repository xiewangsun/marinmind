import type { MarinMindStore, MapState } from "../../store/marinmind-store";
import type { BranchStyle, Mindmap, MindmapNode, MindmapNodeWithCard } from "../../types";
import { subtreeIds } from "../../mindmap/mindmap-graph";
import { newId, now } from "../../utils";

/**
 * 思维导图仓储（㉚ md 存储版）：内存 Map 操作 + store 标脏。
 * 公开语义与 SQL 版一致；外键级联（删图→节点 / 删卡→节点+子节点上浮）
 * 由 store 的 *Cascade 方法承担，removeNode 的子上浮在本层显式实现。
 */
export class MindmapRepository {
	constructor(private store: MarinMindStore) {}

	/**
	 * 新建脑图（分支样式默认 tree）。
	 * documentId 非空即"书籍默认脑图"（㉗）：该书摘录的自动入图目标；
	 * 一书一图（对齐旧库 UNIQUE(document_id)，重复创建抛错——调用方应 get-or-create）。
	 */
	create(name: string, documentId: string | null = null): Mindmap {
		if (documentId != null && this.findByDocument(documentId)) {
			throw new Error(`该文档已有默认脑图：${documentId}`);
		}
		const ts = now();
		const map: Mindmap = {
			id: newId(),
			name,
			defaultBranchStyle: "tree",
			documentId,
			fixedRootNodeId: null,
			createdAt: ts,
			updatedAt: ts,
		};
		this.store.upsertMap(map);
		return map;
	}

	get(id: string): Mindmap | undefined {
		return this.store.maps.get(id)?.map;
	}

	/** 按文档查默认书籍脑图（㉗；一书一图约束由 create 保证至多一张） */
	findByDocument(documentId: string): Mindmap | undefined {
		for (const ms of this.store.maps.values()) {
			if (ms.map.documentId === documentId) return ms.map;
		}
		return undefined;
	}

	/**
	 * 设定/取消固定根节点（㉗）：全局唯一——设定前先清空其他图的固定根。
	 * nodeId 必须属于 mapId（跨图拒绝）；nodeId=null 取消本图固定。
	 * 节点删除的解钉由 removeNode / store 级联自动完成。
	 */
	setFixedRoot(mapId: string, nodeId: string | null): boolean {
		if (nodeId != null) {
			const node = this.getNode(nodeId);
			if (!node || node.mapId !== mapId) {
				return false;
			}
			for (const ms of this.store.maps.values()) {
				if (ms.map.id !== mapId && ms.map.fixedRootNodeId !== null) {
					ms.map = { ...ms.map, fixedRootNodeId: null };
					this.store.markDirty(ms.map.id);
				}
			}
			const target = this.store.maps.get(mapId)!;
			target.map = { ...target.map, fixedRootNodeId: nodeId };
			this.store.markDirty(mapId);
			return true;
		}
		const target = this.store.maps.get(mapId);
		if (!target) {
			return false;
		}
		if (target.map.fixedRootNodeId !== null) {
			target.map = { ...target.map, fixedRootNodeId: null };
		}
		this.store.markDirty(mapId);
		return true;
	}

	/**
	 * 当前全局固定根（至多一个；过滤节点已删的脏引用——正常路径由级联解钉，
	 * 此处只做防御；多行脏数据取最近更新的一张，对齐旧库 ORDER BY updated_at）。
	 */
	fixedRoot(): { mapId: string; nodeId: string } | null {
		let best: { mapId: string; nodeId: string; updatedAt: number } | null = null;
		for (const ms of this.store.maps.values()) {
			const pinned = ms.map.fixedRootNodeId;
			if (pinned === null || !ms.nodes.has(pinned)) continue;
			if (!best || ms.map.updatedAt > best.updatedAt) {
				best = { mapId: ms.map.id, nodeId: pinned, updatedAt: ms.map.updatedAt };
			}
		}
		return best ? { mapId: best.mapId, nodeId: best.nodeId } : null;
	}

	/** 全部脑图，按最近使用在前（addNode 等操作会前移 updated_at） */
	list(): Mindmap[] {
		return [...this.store.maps.values()]
			.map((ms) => ms.map)
			.sort((a, b) => b.updatedAt - a.updatedAt || (a.id < b.id ? -1 : 1));
	}

	rename(id: string, name: string): Mindmap | undefined {
		const current = this.store.maps.get(id)?.map;
		if (!current) {
			return undefined;
		}
		this.store.upsertMap({ ...current, name, updatedAt: now() });
		return this.store.maps.get(id)?.map;
	}

	/** 删除脑图（图内节点由 store 级联删除）+ portal 清扫（61）：其他图指向本图的
	 *  子脑图引用置 null（低频删图毫秒级全库扫描），防悬空引用永驻文件 */
	delete(id: string): boolean {
		const ok = this.store.deleteMap(id);
		if (ok) {
			for (const ms of this.store.maps.values()) {
				let touched = false;
				for (const node of ms.nodes.values()) {
					if (node.childMapId === id) {
						node.childMapId = null;
						touched = true;
					}
				}
				if (touched) this.store.markDirty(ms.map.id);
			}
		}
		return ok;
	}

	/** 节点数（省略 mapId = 全库节点数） */
	countNodes(mapId?: string): number {
		if (mapId === undefined) {
			let n = 0;
			for (const ms of this.store.maps.values()) n += ms.nodes.size;
			return n;
		}
		return this.store.maps.get(mapId)?.nodes.size ?? 0;
	}

	/** 卡片是否已在图中（一图一卡约束的显式判重） */
	hasCard(mapId: string, cardId: string): boolean {
		for (const node of this.store.maps.get(mapId)?.nodes.values() ?? []) {
			if (node.cardId === cardId) return true;
		}
		return false;
	}

	/**
	 * 加入节点（parentId 为空即根）。已在图中或卡片不存在返回 undefined。
	 * 坐标取整入库；成功后前移图的 updated_at（"最近使用"排序）。
	 * 注意：环检测（parentId 不能是自身的后代）由视图层用内存快照保证，此处只做
	 * 同图与自身校验（对齐旧库外键不校验 parent 与节点同图的取舍）。
	 */
	addNode(
		mapId: string,
		cardId: string,
		parentId: string | null,
		x: number,
		y: number,
	): MindmapNodeWithCard | undefined {
		const ms = this.store.maps.get(mapId);
		if (!ms) {
			return undefined;
		}
		if (this.hasCard(mapId, cardId)) {
			return undefined;
		}
		const card = this.store.bookOfCard(cardId)?.cards.get(cardId);
		if (!card) {
			return undefined; // 卡片必须存在（对齐旧库外键）
		}
		if (parentId != null) {
			const parent = this.getNode(parentId);
			// 父节点须存在且与目标同图
			if (!parent || parent.mapId !== mapId) {
				return undefined;
			}
		}
		const node: MindmapNode = {
			id: newId(),
			mapId,
			cardId,
			parentId,
			x: Math.round(x),
			y: Math.round(y),
			collapsed: false, // 新节点一律展开
			branchStyle: null, // 新节点继承图默认
			childMapId: null, // 61 新节点非 portal（坍缩时显式 setChildMap）
			// ㉜ 兄弟序追加末位（新节点按加入顺序堆叠；before/after 手动插入走 setParent 的 order 参数）
			order: this.countSiblings(mapId, parentId),
			createdAt: now(),
		};
		ms.nodes.set(node.id, node);
		ms.map = { ...ms.map, updatedAt: now() };
		this.store.markDirty(mapId);
		return { ...node, card };
	}

	/** 同父（或根集合，parentId=null）既有兄弟数——addNode 追加序号用 */
	private countSiblings(mapId: string, parentId: string | null): number {
		let n = 0;
		for (const node of this.store.maps.get(mapId)?.nodes.values() ?? []) {
			if (node.parentId === parentId) n++;
		}
		return n;
	}

	getNode(nodeId: string): MindmapNode | undefined {
		for (const ms of this.store.maps.values()) {
			const node = ms.nodes.get(nodeId);
			if (node) return node;
		}
		return undefined;
	}

	/** 纯坐标更新（拖放落点落库） */
	moveNode(nodeId: string, x: number, y: number): void {
		for (const ms of this.store.maps.values()) {
			const node = ms.nodes.get(nodeId);
			if (!node) continue;
			node.x = Math.round(x);
			node.y = Math.round(y);
			this.store.markDirty(ms.map.id);
			return;
		}
	}

	/**
	 * 改父子（拖到另一节点上/插为同级前后）。校验：两节点存在、同图、非自身；
	 * 环检测由视图层内存快照保证（契约见 addNode 注释）。
	 * order（㉜）：插入到新父下的兄弟序——inside 挂子传末位、before/after 插同级传
	 * insertOrder 计算的中点；缺省保留原序号（普通改父不重排）。
	 */
	setParent(nodeId: string, parentId: string | null, order?: number): MindmapNode | undefined {
		const node = this.getNode(nodeId);
		if (!node) {
			return undefined;
		}
		if (parentId != null) {
			if (parentId === nodeId) {
				return undefined;
			}
			const parent = this.getNode(parentId);
			if (!parent || parent.mapId !== node.mapId) {
				return undefined;
			}
		}
		node.parentId = parentId;
		if (order != null) {
			node.order = order;
		}
		this.store.markDirty(node.mapId);
		return node;
	}

	/** 移出脑图：删节点行 + 子节点上浮为根（SET NULL）+ 固定根解钉，布局保留 */
	removeNode(nodeId: string): boolean {
		for (const ms of this.store.maps.values()) {
			const node = ms.nodes.get(nodeId);
			if (!node) continue;
			ms.nodes.delete(nodeId);
			for (const child of ms.nodes.values()) {
				if (child.parentId === nodeId) child.parentId = null;
			}
			if (ms.map.fixedRootNodeId === nodeId) {
				ms.map = { ...ms.map, fixedRootNodeId: null };
			}
			this.store.markDirty(ms.map.id);
			return true;
		}
		return false;
	}

	/** 图内全部节点（附带卡片本体），按加入先后排序 */
	listNodes(mapId: string): MindmapNodeWithCard[] {
		return this.nodesByFilter((node) => node.mapId === mapId);
	}

	/**
	 * 节点改挂另一张卡（60 卡片合并的节点迁移）：一图一卡预检——目标卡在同图
	 * 已有节点则拒绝返回 undefined（调用方应走"子挂目标 + 删源节点"路径）；
	 * 目标卡必须存在（对齐 addNode 外键语义）。
	 */
	repointNode(nodeId: string, cardId: string): MindmapNode | undefined {
		for (const ms of this.store.maps.values()) {
			const node = ms.nodes.get(nodeId);
			if (!node) continue;
			if (!this.store.bookOfCard(cardId)?.cards.has(cardId)) {
				return undefined;
			}
			if (this.hasCard(node.mapId, cardId)) {
				return undefined; // 一图一卡：同图已有目标卡节点
			}
			node.cardId = cardId;
			this.store.markDirty(node.mapId);
			return node;
		}
		return undefined;
	}

	/** 按卡片反查节点引用（复习「脑图上下文」入口；一卡可在多图各挂一个节点） */
	nodesByCard(cardId: string): MindmapNodeWithCard[] {
		return this.nodesByFilter((node) => node.cardId === cardId);
	}

	/**
	 * 设置/清除节点的子脑图引用（61 portal 身份的唯一写入口）。
	 * 图存在性由调用方守卫（坍缩方刚 create 必存在；解除方先判 get）。
	 */
	setChildMap(nodeId: string, childMapId: string | null): void {
		for (const ms of this.store.maps.values()) {
			const node = ms.nodes.get(nodeId);
			if (!node) continue;
			node.childMapId = childMapId;
			this.store.markDirty(ms.map.id);
			return;
		}
	}

	/**
	 * 整子树迁移到另一张图（61 子脑图坍缩/解除的原子操作）：
	 * BFS 收集源图 parentId 链整子树（含折叠隐藏后代），前置校验任一失败返回
	 * false 且零改动——节点存在 / 目标图存在 / 源≠目标 / targetParentId 属目标图 /
	 * **一图一卡整批预检**（子树任一卡已在目标图 → 整批拒绝，不留半迁移）。
	 * targetParentId 缺省 null：被迁根成目标图根，order 保留（坍缩后目标图内
	 * 根序 = 原兄弟序）；非 null：追加末位（解除时排在坍缩期间新加子之后）。
	 * 迁移逐节点换新对象 {...node, mapId}（防双图共享引用互染）；源图 fixedRoot
	 * 在子树内则解钉（对齐 removeNode）；markDirty 双图。
	 * 环防护：当前入口集（坍缩永远 create 新图）环不可能形成；「绑定已存在图
	 * 为子图」入口不暴露，写侧可达性校验挂账（手编 md 恶意环仅双击来回切图无递归）。
	 */
	moveSubtreeToMap(
		nodeId: string,
		targetMapId: string,
		targetParentId: string | null = null,
	): boolean {
		const root = this.getNode(nodeId);
		if (!root) return false;
		const sourceMapId = root.mapId;
		if (sourceMapId === targetMapId) return false;
		const source = this.store.maps.get(sourceMapId);
		const target = this.store.maps.get(targetMapId);
		if (!source || !target) return false;
		if (targetParentId != null && !target.nodes.has(targetParentId)) return false;
		const ids = subtreeIds([...source.nodes.values()], nodeId);
		for (const id of ids) {
			const n = source.nodes.get(id);
			if (n && this.hasCard(targetMapId, n.cardId)) return false;
		}
		for (const id of ids) {
			const n = source.nodes.get(id);
			if (!n) continue;
			source.nodes.delete(id);
			target.nodes.set(id, { ...n, mapId: targetMapId });
		}
		const moved = target.nodes.get(nodeId);
		if (moved) {
			// 追加序号须在改 parentId 前计算（否则把被迁节点自身也计入）
			if (targetParentId != null) {
				moved.order = this.countSiblings(targetMapId, targetParentId);
			}
			moved.parentId = targetParentId;
		}
		if (source.map.fixedRootNodeId != null && ids.includes(source.map.fixedRootNodeId)) {
			source.map = { ...source.map, fixedRootNodeId: null };
		}
		const ts = now();
		source.map = { ...source.map, updatedAt: ts };
		target.map = { ...target.map, updatedAt: ts };
		this.store.markDirty(sourceMapId);
		this.store.markDirty(targetMapId);
		return true;
	}

	/** 过滤 + JOIN 卡片本体 + 排序（节点挂的卡片已不存在时跳过，对齐 INNER JOIN） */
	private nodesByFilter(pred: (node: MindmapNode) => boolean): MindmapNodeWithCard[] {
		const out: MindmapNodeWithCard[] = [];
		for (const ms of this.store.maps.values()) {
			for (const node of ms.nodes.values()) {
				if (!pred(node)) continue;
				const card = this.store.bookOfCard(node.cardId)?.cards.get(node.cardId);
				if (!card) continue;
				out.push({ ...node, card });
			}
		}
		return out.sort((a, b) => a.createdAt - b.createdAt || (a.id < b.id ? -1 : 1));
	}

	/** 设置节点分支样式覆盖（null = 回到继承：祖先覆盖 → 图默认），视图层重拉生效 */
	setBranchStyle(nodeId: string, style: BranchStyle | null): void {
		for (const ms of this.store.maps.values()) {
			const node = ms.nodes.get(nodeId);
			if (!node) continue;
			node.branchStyle = style;
			this.store.markDirty(ms.map.id);
			return;
		}
	}

	/** 设置图的默认分支样式（未覆盖的节点生效），视图层重拉生效 */
	setDefaultBranchStyle(mapId: string, style: BranchStyle): void {
		const ms: MapState | undefined = this.store.maps.get(mapId);
		if (!ms) return;
		ms.map = { ...ms.map, defaultBranchStyle: style };
		this.store.markDirty(mapId);
	}

	/** 切换子树折叠态（折叠时后代不渲染；视图层重拉） */
	setCollapsed(nodeId: string, collapsed: boolean): void {
		for (const ms of this.store.maps.values()) {
			const node = ms.nodes.get(nodeId);
			if (!node) continue;
			node.collapsed = collapsed;
			this.store.markDirty(ms.map.id);
			return;
		}
	}

	/**
	 * 自动布局批量写回：内存原子更新（中途异常不留半布局——同步执行无并发）。
	 * 只更新给定 id 且属于该图的节点，其余不动。
	 */
	applyLayout(mapId: string, positions: Map<string, { x: number; y: number }>): void {
		const ms = this.store.maps.get(mapId);
		if (!ms) return;
		let touched = false;
		for (const [nodeId, pos] of positions) {
			const node = ms.nodes.get(nodeId);
			if (!node) continue; // 悬空 id 静默跳过（对齐旧库 map_id 守卫）
			node.x = Math.round(pos.x);
			node.y = Math.round(pos.y);
			touched = true;
		}
		if (touched) this.store.markDirty(mapId);
	}
}
