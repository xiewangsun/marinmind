import type { MarinMindDatabase } from "../database";
import type { CardLink } from "../../types";
import { newId, now } from "../../utils";

/**
 * 卡片双向链接仓储。
 * 链接语义为双向：(a→b) 与 (b→a) 视为同一条，neighbors 覆盖两个方向。
 */
export class LinkRepository {
	constructor(private db: MarinMindDatabase) {}

	/**
	 * 建立链接；自链或已存在（含反向）时返回 undefined。
	 */
	link(sourceId: string, targetId: string): CardLink | undefined {
		if (sourceId === targetId) {
			return undefined; // 自链无意义
		}
		const existing = this.db.get<{ id: string }>(
			`SELECT id FROM card_links
			 WHERE (source_id = ? AND target_id = ?) OR (source_id = ? AND target_id = ?)`,
			[sourceId, targetId, targetId, sourceId],
		);
		if (existing) {
			return undefined;
		}
		const link: CardLink = { id: newId(), sourceId, targetId, createdAt: now() };
		this.db.run(
			"INSERT INTO card_links (id, source_id, target_id, created_at) VALUES (?, ?, ?, ?)",
			[link.id, link.sourceId, link.targetId, link.createdAt],
		);
		return link;
	}

	/** 解除链接（两个方向等价）；不存在时返回 false */
	unlink(sourceId: string, targetId: string): boolean {
		const existed =
			this.db.get<{ id: string }>(
				`SELECT id FROM card_links
				 WHERE (source_id = ? AND target_id = ?) OR (source_id = ? AND target_id = ?)`,
				[sourceId, targetId, targetId, sourceId],
			) !== undefined;
		if (existed) {
			this.db.run(
				`DELETE FROM card_links
				 WHERE (source_id = ? AND target_id = ?) OR (source_id = ? AND target_id = ?)`,
				[sourceId, targetId, targetId, sourceId],
			);
		}
		return existed;
	}

	/** 与该卡片双向关联的所有卡片 id */
	neighbors(cardId: string): string[] {
		const rows = this.db.all<{ id: string }>(
			`SELECT target_id AS id FROM card_links WHERE source_id = ?
			 UNION
			 SELECT source_id AS id FROM card_links WHERE target_id = ?`,
			[cardId, cardId],
		);
		return rows.map((r) => r.id);
	}
}
