import type { MarinMindStore } from "../../store/marinmind-store";
import { defaultReviewState } from "../../store/book-format";
import type { Card, ReviewGrade, ReviewState } from "../../types";
import { now } from "../../utils";
import { nextReviewState } from "../../srs/sm2";

/**
 * 闪卡复习仓储（㉚ md 存储版）：复习状态存卡片机器注释（store.reviews），
 * 调度算法仍走 src/srs/sm2.ts 纯函数。公开语义与 SQL 版一致。
 */
export class ReviewRepository {
	constructor(private store: MarinMindStore) {}

	/** 将卡片转为闪卡（幂等），可指定初始到期时间 */
	enable(cardId: string, dueAt: number = now()): void {
		if (!this.store.bookOfCard(cardId)) {
			throw new Error(`卡片不存在，无法转为闪卡：${cardId}`);
		}
		const prev =
			this.store.reviews.get(cardId) ?? defaultReviewState(cardId, now());
		this.store.putReview({ ...prev, isFlashcard: true, dueAt });
	}

	/** 取消闪卡（保留调度历史，仅移出复习队列） */
	disable(cardId: string): boolean {
		const prev = this.store.reviews.get(cardId);
		if (!prev) {
			return false;
		}
		this.store.putReview({ ...prev, isFlashcard: false });
		return true;
	}

	get(cardId: string): ReviewState | undefined {
		return this.store.reviews.get(cardId);
	}

	/** 当前到期待复习的闪卡数量 */
	dueCount(nowMs: number = now()): number {
		let n = 0;
		for (const r of this.store.reviews.values()) {
			if (r.isFlashcard && r.dueAt <= nowMs) n++;
		}
		return n;
	}

	/**
	 * 到期闪卡列表（附带卡片本体，复习时可回看摘录与上下文），按到期先后排序。
	 * documentId（㊷ 复习按书过滤）：非 null 时只返回该书卡片（先过滤后计数，limit 语义不受影响）
	 */
	due(nowMs: number = now(), limit = 20, documentId?: string): Card[] {
		const states = [...this.store.reviews.values()]
			.filter((r) => r.isFlashcard && r.dueAt <= nowMs)
			.sort((a, b) => a.dueAt - b.dueAt || (a.cardId < b.cardId ? -1 : 1));
		const out: Card[] = [];
		for (const r of states) {
			const card = this.store.bookOfCard(r.cardId)?.cards.get(r.cardId);
			if (!card) continue; // 卡片本体必须存在（对齐旧库 INNER JOIN）
			if (documentId != null && card.documentId !== documentId) continue;
			out.push(card);
			if (out.length >= limit) break;
		}
		return out;
	}

	/** 完成一次复习（SM-2 调度）；卡片不存在或未启用闪卡时返回 undefined */
	review(cardId: string, grade: ReviewGrade, nowMs: number = now()): ReviewState | undefined {
		const prev = this.store.reviews.get(cardId);
		if (!prev || !prev.isFlashcard) {
			return undefined;
		}
		const next = nextReviewState(prev, grade, nowMs);
		this.store.putReview(next);
		return next;
	}
}
