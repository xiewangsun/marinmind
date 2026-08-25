import type { Card, ReviewGrade } from "../types";

/** 评分回调：视图层接 DB（reviews.review），纯逻辑层不依赖仓储实现 */
export type GradeHandler = (cardId: string, grade: ReviewGrade) => void;

/** 会话统计（四档按键计数；again 重现后再次评分计两次，Anki 语义） */
export interface SessionStats {
	again: number;
	hard: number;
	good: number;
	easy: number;
	total: number;
}

/**
 * 复习会话（纯逻辑，零 obsidian 依赖，vitest 可测）。
 *
 * 队列语义：
 * - 构造时收 `reviews.due()` 的快照，会话内不重查 DB
 * - again 评分的卡 push 到本地队尾（同会话重现，Anki 风格）；
 *   DB 侧 SM-2 照常调度（dueAt=+10min）——两者解耦：
 *   会话中断后该卡约 10 分钟重新到期，符合直觉
 * - 卡片在评分前被删除的场景由 DB 侧 review 返回 undefined 自然吞掉（回调忽略返回值）
 */
export class ReviewSession {
	private readonly queue: Card[];
	private index = 0;
	private revealed = false;
	private readonly counts = { again: 0, hard: 0, good: 0, easy: 0 };

	constructor(
		cards: Card[],
		private readonly onGrade: GradeHandler,
	) {
		this.queue = [...cards];
	}

	/** 当前卡片（会话结束时 undefined） */
	get current(): Card | undefined {
		return this.queue[this.index];
	}

	/** 是否已翻面（翻面后才允许评分） */
	get isRevealed(): boolean {
		return this.revealed;
	}

	/** 队列是否耗尽 */
	get isDone(): boolean {
		return this.index >= this.queue.length;
	}

	/** 剩余张数（含 again 重现的未到卡） */
	get remaining(): number {
		return this.queue.length - this.index;
	}

	get stats(): SessionStats {
		return {
			...this.counts,
			total: this.counts.again + this.counts.hard + this.counts.good + this.counts.easy,
		};
	}

	reveal(): void {
		if (!this.isDone) {
			this.revealed = true;
		}
	}

	/**
	 * 翻面后评分：计数、回调 DB、推进队列。
	 * 未翻面或已结束时静默返回 false（不推进不计数）。
	 */
	grade(grade: ReviewGrade): boolean {
		if (this.isDone || !this.revealed) {
			return false;
		}
		const card = this.queue[this.index];
		this.counts[grade]++;
		this.onGrade(card.id, grade);
		if (grade === "again") {
			this.queue.push(card); // 本地队尾重现（同会话再考）
		}
		this.index++;
		this.revealed = false;
		return true;
	}
}
