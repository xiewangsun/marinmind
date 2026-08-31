import type { MarinMindStore } from "../../store/marinmind-store";
import { linkId } from "../../store/book-format";
import type { CardLink } from "../../types";
import { now } from "../../utils";

/**
 * 卡片双向链接仓储（㉚ md 存储版）。
 * 链接语义为双向：(a→b) 与 (b→a) 视为同一条，neighbors 覆盖两个方向；
 * 落盘时只写在持有方（双侧 id 较小者）的机器注释里，由 store 重建。
 */
export class LinkRepository {
	constructor(private store: MarinMindStore) {}

	/**
	 * 建立链接；自链或已存在（含反向）时返回 undefined。
	 * 两端卡片必须存在（对齐旧库外键）。
	 */
	link(sourceId: string, targetId: string): CardLink | undefined {
		if (sourceId === targetId) {
			return undefined; // 自链无意义
		}
		if (this.store.links.has(linkId(sourceId, targetId))) {
			return undefined; // 已存在（含反向）
		}
		if (!this.store.bookOfCard(sourceId) || !this.store.bookOfCard(targetId)) {
			throw new Error("链接的两端卡片必须存在");
		}
		return this.store.addLink(sourceId, targetId, now());
	}

	/** 解除链接（两个方向等价）；不存在时返回 false */
	unlink(sourceId: string, targetId: string): boolean {
		return this.store.removeLink(linkId(sourceId, targetId));
	}

	/** 与该卡片双向关联的所有卡片 id */
	neighbors(cardId: string): string[] {
		const out: string[] = [];
		for (const link of this.store.links.values()) {
			if (link.sourceId === cardId) out.push(link.targetId);
			else if (link.targetId === cardId) out.push(link.sourceId);
		}
		return out;
	}
}
