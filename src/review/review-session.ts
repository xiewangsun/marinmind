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
 *
 * 浏览语义（㉑，MN4 复习卡片组「切换闪卡」）：
 * - index = 评分推进位置（下一张待考），position = 浏览位置（当前显示的卡），
 *   两者分离：◀ ▶ 只移动 position 不影响 SRS 推进
 * - 只有 position === index 的卡（待考卡）可翻面/评分；浏览到已考卡
 *   视图层按 gradedAt 展示正反面与"已考"徽标（只读），浏览到后面的未考卡只显示正面
 * - 评分后 position 跟随 index（正常流程无感）；position 可走到 queue.length
 *   （末尾）= 完成统计屏，再 ◀ 可回去翻看已考的卡
 */
export class ReviewSession {
	private readonly queue: Card[];
	private index = 0;
	/** 浏览位置（显示的队列下标）；评分后跟随 index，◀ ▶ 独立移动 */
	private position = 0;
	private revealed = false;
	/** 已评分的队列下标 → 档位（again 重现的新下标单独记录，同一卡可有多条） */
	private readonly graded = new Map<number, ReviewGrade>();
	private readonly counts = { again: 0, hard: 0, good: 0, easy: 0 };

	constructor(
		cards: Card[],
		private readonly onGrade: GradeHandler,
	) {
		this.queue = [...cards];
	}

	/** 当前浏览的卡片（浏览到末尾/会话为空时 undefined，视图层渲染完成屏） */
	get current(): Card | undefined {
		return this.queue[this.position];
	}

	/** 是否已翻面（仅对待考卡有意义；浏览已考卡由 gradedAt 判定显示背面） */
	get isRevealed(): boolean {
		return this.revealed;
	}

	/** 评分是否推进完（浏览位置仍可回退翻看已考卡） */
	get isDone(): boolean {
		return this.index >= this.queue.length;
	}

	/** 剩余张数（含 again 重现的未到卡） */
	get remaining(): number {
		return this.queue.length - this.index;
	}

	/** 会话队列总张数（含 again 重现；浏览位置指示用） */
	get total(): number {
		return this.queue.length;
	}

	/** 当前浏览位置（0 起；=== total 表示在完成屏） */
	get positionNo(): number {
		return this.position;
	}

	/** 是否可 ◀（浏览位置不在最前且队列非空） */
	get canPrev(): boolean {
		return this.position > 0;
	}

	/** 是否可 ▶（浏览位置未越过末尾完成屏） */
	get canNext(): boolean {
		return this.position < this.queue.length;
	}

	/** 当前浏览的卡是否待考（可翻面可评分） */
	get isCurrentPending(): boolean {
		return this.position === this.index && !this.isDone;
	}

	/** 当前浏览卡的已评档位（未评/待考 undefined）——视图层据此显示背面与徽标 */
	get gradedAt(): ReviewGrade | undefined {
		return this.graded.get(this.position);
	}

	get stats(): SessionStats {
		return {
			...this.counts,
			total: this.counts.again + this.counts.hard + this.counts.good + this.counts.easy,
		};
	}

	reveal(): void {
		if (this.isCurrentPending) {
			this.revealed = true;
		}
	}

	/** ◀ 上一张（只移动浏览位置；不改变翻面态，由 gradedAt 决定显示） */
	goPrev(): boolean {
		if (!this.canPrev) {
			return false;
		}
		this.position--;
		this.revealed = false;
		return true;
	}

	/** ▶ 下一张（可走到末尾完成屏 position === queue.length） */
	goNext(): boolean {
		if (!this.canNext) {
			return false;
		}
		this.position++;
		this.revealed = false;
		return true;
	}

	/** 直接跳回待考卡（浏览到末尾却还没考完时的返回入口） */
	jumpToPending(): boolean {
		if (this.position === this.index) {
			return false;
		}
		this.position = this.index;
		this.revealed = false;
		return true;
	}

	/**
	 * 翻面后评分：计数、回调 DB、推进队列（浏览位置跟随）。
	 * 非待考卡（浏览态）或未翻面时静默返回 false（不推进不计数）。
	 */
	grade(grade: ReviewGrade): boolean {
		if (!this.isCurrentPending || !this.revealed) {
			return false;
		}
		const card = this.queue[this.index];
		this.counts[grade]++;
		this.onGrade(card.id, grade);
		this.graded.set(this.index, grade);
		if (grade === "again") {
			this.queue.push(card); // 本地队尾重现（同会话再考）
		}
		this.index++;
		this.position = this.index;
		this.revealed = false;
		return true;
	}
}
