import type { MarinMindDatabase } from "../database";
import type { Card, ReviewGrade, ReviewState, SrsPhase } from "../../types";
import { now } from "../../utils";
import { nextReviewState } from "../../srs/sm2";
import { mapRowToCard, type CardRow } from "./card-repo";

interface ReviewRow {
	card_id: string;
	is_flashcard: number;
	phase: SrsPhase;
	ease: number;
	interval_days: number;
	repetitions: number;
	due_at: number;
	last_reviewed_at: number | null;
	lapses: number;
}

function mapRowToReview(row: ReviewRow): ReviewState {
	return {
		cardId: row.card_id,
		isFlashcard: row.is_flashcard === 1,
		phase: row.phase,
		ease: row.ease,
		intervalDays: row.interval_days,
		repetitions: row.repetitions,
		dueAt: row.due_at,
		lastReviewedAt: row.last_reviewed_at,
		lapses: row.lapses,
	};
}

/** 闪卡复习仓储 */
export class ReviewRepository {
	constructor(private db: MarinMindDatabase) {}

	/** 将卡片转为闪卡（幂等），可指定初始到期时间 */
	enable(cardId: string, dueAt: number = now()): void {
		this.db.run(
			`INSERT INTO review_states (card_id, is_flashcard, due_at) VALUES (?, 1, ?)
			 ON CONFLICT (card_id) DO UPDATE SET is_flashcard = 1, due_at = excluded.due_at`,
			[cardId, dueAt],
		);
	}

	/** 取消闪卡（保留调度历史，仅移出复习队列） */
	disable(cardId: string): boolean {
		if (!this.get(cardId)) {
			return false;
		}
		this.db.run("UPDATE review_states SET is_flashcard = 0 WHERE card_id = ?", [cardId]);
		return true;
	}

	get(cardId: string): ReviewState | undefined {
		const row = this.db.get<ReviewRow>(
			"SELECT * FROM review_states WHERE card_id = ?",
			[cardId],
		);
		return row ? mapRowToReview(row) : undefined;
	}

	/** 当前到期待复习的闪卡数量 */
	dueCount(nowMs: number = now()): number {
		const row = this.db.get<{ n: number }>(
			"SELECT COUNT(*) AS n FROM review_states WHERE is_flashcard = 1 AND due_at <= ?",
			[nowMs],
		);
		return row?.n ?? 0;
	}

	/** 到期闪卡列表（附带卡片本体，复习时可回看摘录与上下文），按到期先后排序 */
	due(nowMs: number = now(), limit = 20): Card[] {
		const rows = this.db.all<CardRow>(
			`SELECT c.* FROM cards c JOIN review_states r ON r.card_id = c.id
			 WHERE r.is_flashcard = 1 AND r.due_at <= ?
			 ORDER BY r.due_at ASC LIMIT ?`,
			[nowMs, limit],
		);
		return rows.map(mapRowToCard);
	}

	/** 完成一次复习（SM-2 调度）；卡片不存在或未启用闪卡时返回 undefined */
	review(cardId: string, grade: ReviewGrade, nowMs: number = now()): ReviewState | undefined {
		const prev = this.get(cardId);
		if (!prev || !prev.isFlashcard) {
			return undefined;
		}
		const next = nextReviewState(prev, grade, nowMs);
		this.db.run(
			`UPDATE review_states SET phase = ?, ease = ?, interval_days = ?, repetitions = ?,
			 due_at = ?, last_reviewed_at = ?, lapses = ? WHERE card_id = ?`,
			[
				next.phase,
				next.ease,
				next.intervalDays,
				next.repetitions,
				next.dueAt,
				next.lastReviewedAt,
				next.lapses,
				next.cardId,
			],
		);
		return next;
	}
}
