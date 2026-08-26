import type { MarinMindDatabase, SqlParam } from "../database";
import type { Mindmap, MindmapNode, MindmapNodeWithCard } from "../../types";
import { newId, now } from "../../utils";
import { mapRowToCard, type CardRow } from "./card-repo";

/** mindmaps 表行 */
export interface MindmapRow {
	id: string;
	name: string;
	created_at: number;
	updated_at: number;
}

function mapRowToMindmap(row: MindmapRow): Mindmap {
	return {
		id: row.id,
		name: row.name,
		createdAt: row.created_at,
		updatedAt: row.updated_at,
	};
}

/** listNodes 的 JOIN 行：节点字段加 node_ 前缀，卡片列保持原生列名（直接喂 mapRowToCard） */
interface NodeJoinRow extends CardRow {
	node_id: string;
	node_map_id: string;
	node_card_id: string;
	node_parent_id: string | null;
	node_x: number;
	node_y: number;
	node_collapsed: number;
	node_created_at: number;
}

/** 思维导图仓储 */
export class MindmapRepository {
	constructor(private db: MarinMindDatabase) {}

	/** 新建脑图 */
	create(name: string): Mindmap {
		const ts = now();
		const map: Mindmap = { id: newId(), name, createdAt: ts, updatedAt: ts };
		this.db.run(
			"INSERT INTO mindmaps (id, name, created_at, updated_at) VALUES (?, ?, ?, ?)",
			[map.id, map.name, map.createdAt, map.updatedAt],
		);
		return map;
	}

	get(id: string): Mindmap | undefined {
		const row = this.db.get<MindmapRow>("SELECT * FROM mindmaps WHERE id = ?", [id]);
		return row ? mapRowToMindmap(row) : undefined;
	}

	/** 全部脑图，按最近使用在前（addNode 等操作会前移 updated_at） */
	list(): Mindmap[] {
		return this.db
			.all<MindmapRow>("SELECT * FROM mindmaps ORDER BY updated_at DESC, id")
			.map(mapRowToMindmap);
	}

	rename(id: string, name: string): Mindmap | undefined {
		if (!this.get(id)) {
			return undefined;
		}
		this.db.run("UPDATE mindmaps SET name = ?, updated_at = ? WHERE id = ?", [
			name,
			now(),
			id,
		]);
		return this.get(id);
	}

	/** 删除脑图（图内节点由外键级联删除） */
	delete(id: string): boolean {
		const existed = this.get(id) !== undefined;
		if (existed) {
			this.db.run("DELETE FROM mindmaps WHERE id = ?", [id]);
		}
		return existed;
	}

	/** 节点数（省略 mapId = 全库节点数） */
	countNodes(mapId?: string): number {
		const row =
			mapId === undefined
				? this.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM mindmap_nodes")
				: this.db.get<{ n: number }>(
						"SELECT COUNT(*) AS n FROM mindmap_nodes WHERE map_id = ?",
						[mapId],
					);
		return row?.n ?? 0;
	}

	/** 卡片是否已在图中（UNIQUE(map_id, card_id) 的显式判重） */
	hasCard(mapId: string, cardId: string): boolean {
		const row = this.db.get<{ n: number }>(
			"SELECT COUNT(*) AS n FROM mindmap_nodes WHERE map_id = ? AND card_id = ?",
			[mapId, cardId],
		);
		return (row?.n ?? 0) > 0;
	}

	/**
	 * 加入节点（ parentId 为空即根）。已在图中返回 undefined（不抛 UNIQUE 冲突）。
	 * 坐标取整入库；成功后前移图的 updated_at（"最近使用"排序）。
	 * 注意：环检测（parentId 不能是自身的后代）由视图层用内存快照保证，此处只做
	 * 同图与自身校验——SQLite 外键不校验 parent 与节点同图。
	 */
	addNode(
		mapId: string,
		cardId: string,
		parentId: string | null,
		x: number,
		y: number,
	): MindmapNodeWithCard | undefined {
		if (this.hasCard(mapId, cardId)) {
			return undefined;
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
			collapsed: false, // DB 侧 DEFAULT 0，新节点一律展开
			createdAt: now(),
		};
		this.db.tx(() => {
			this.db.run(
				"INSERT INTO mindmap_nodes (id, map_id, card_id, parent_id, x, y, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
				[node.id, node.mapId, node.cardId, node.parentId, node.x, node.y, node.createdAt],
			);
			this.db.run("UPDATE mindmaps SET updated_at = ? WHERE id = ?", [
				now(),
				mapId,
			]);
		});
		return this.getNodeWithCard(node.id);
	}

	getNode(nodeId: string): MindmapNode | undefined {
		const row = this.db.get<{
			id: string;
			map_id: string;
			card_id: string;
			parent_id: string | null;
			x: number;
			y: number;
			collapsed: number;
			created_at: number;
		}>("SELECT * FROM mindmap_nodes WHERE id = ?", [nodeId]);
		if (!row) {
			return undefined;
		}
		return {
			id: row.id,
			mapId: row.map_id,
			cardId: row.card_id,
			parentId: row.parent_id,
			x: row.x,
			y: row.y,
			collapsed: row.collapsed === 1,
			createdAt: row.created_at,
		};
	}

	private getNodeWithCard(nodeId: string): MindmapNodeWithCard | undefined {
		return this.listNodesByFilter("WHERE n.id = ?", [nodeId])[0];
	}

	/** 纯坐标更新（拖放落点落库） */
	moveNode(nodeId: string, x: number, y: number): void {
		this.db.run("UPDATE mindmap_nodes SET x = ?, y = ? WHERE id = ?", [
			Math.round(x),
			Math.round(y),
			nodeId,
		]);
	}

	/**
	 * 改父子（拖到另一节点上）。校验：两节点存在、同图、非自身；
	 * 环检测由视图层内存快照保证（契约见 addNode 注释）。
	 */
	setParent(nodeId: string, parentId: string | null): MindmapNode | undefined {
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
		this.db.run("UPDATE mindmap_nodes SET parent_id = ? WHERE id = ?", [parentId, nodeId]);
		return this.getNode(nodeId);
	}

	/** 移出脑图（仅删节点行；子节点由 SET NULL 上浮为根，布局保留） */
	removeNode(nodeId: string): boolean {
		const existed = this.getNode(nodeId) !== undefined;
		if (existed) {
			this.db.run("DELETE FROM mindmap_nodes WHERE id = ?", [nodeId]);
		}
		return existed;
	}

	/** 图内全部节点（附带卡片本体），按加入先后排序 */
	listNodes(mapId: string): MindmapNodeWithCard[] {
		return this.listNodesByFilter("WHERE n.map_id = ?", [mapId]);
	}

	private listNodesByFilter(where: string, params: SqlParam[]): MindmapNodeWithCard[] {
		const rows = this.db.all<NodeJoinRow>(
			`SELECT n.id AS node_id, n.map_id AS node_map_id, n.card_id AS node_card_id,
			        n.parent_id AS node_parent_id, n.x AS node_x, n.y AS node_y,
			        n.collapsed AS node_collapsed, n.created_at AS node_created_at,
			        c.id, c.document_id, c.page, c.rects, c.excerpt_type, c.excerpt_text,
			        c.excerpt_ref, c.note, c.color, c.tags, c.created_at, c.updated_at
			 FROM mindmap_nodes n JOIN cards c ON c.id = n.card_id
			 ${where}
			 ORDER BY n.created_at, n.id`,
			params,
		);
		return rows.map((row) => ({
			id: row.node_id,
			mapId: row.node_map_id,
			cardId: row.node_card_id,
			parentId: row.node_parent_id,
			x: row.node_x,
			y: row.node_y,
			collapsed: row.node_collapsed === 1,
			createdAt: row.node_created_at,
			card: mapRowToCard(row),
		}));
	}

	/** 切换子树折叠态（折叠时后代不渲染；视图层重拉） */
	setCollapsed(nodeId: string, collapsed: boolean): void {
		this.db.run("UPDATE mindmap_nodes SET collapsed = ? WHERE id = ?", [
			collapsed ? 1 : 0,
			nodeId,
		]);
	}

	/**
	 * 自动布局批量写回：单事务逐条 UPDATE（中途失败整体回滚，不留半布局）。
	 * 只更新给定 id 的坐标，图内其余节点不动。
	 */
	applyLayout(mapId: string, positions: Map<string, { x: number; y: number }>): void {
		this.db.tx(() => {
			for (const [nodeId, pos] of positions) {
				this.db.run(
					"UPDATE mindmap_nodes SET x = ?, y = ? WHERE id = ? AND map_id = ?",
					[Math.round(pos.x), Math.round(pos.y), nodeId, mapId],
				);
			}
		});
	}
}
