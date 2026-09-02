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
 * 一次已落库评分的会话内记录（67 浏览态撤销）。
 * index = 评分发生时的队列下标（撤销的落回目标）；requeued = 该次评分是
 * again（队尾重现了一条该卡的实例，撤销时要一并出队）。
 */
export interface GradedStep {
	cardId: string;
	grade: ReviewGrade;
	index: number;
	requeued: boolean;
}

/** 撤销栈深度（浅栈防误按连环回退掏空整场会话；改评 = 撤销后重评自然组合） */
const UNDO_STACK_MAX = 20;

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
	/** 67 已落库评分的撤销栈（栈顶 = 最近一次；grade 单调递增的 index 保栈序有效） */
	private readonly undoStack: GradedStep[] = [];

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
		const requeued = grade === "again";
		if (requeued) {
			this.queue.push(card); // 本地队尾重现（同会话再考）
		}
		// 67 撤销栈：评分只发生在 index 且 index 单调递增 → 栈顶 index 恒为
		// graded 的最大键（again 重现实例下标恒大于当时的 index），撤销无需 remove 的重键算法
		this.undoStack.push({ cardId: card.id, grade, index: this.index, requeued });
		if (this.undoStack.length > UNDO_STACK_MAX) {
			this.undoStack.shift();
		}
		this.index++;
		this.position = this.index;
		this.revealed = false;
		return true;
	}

	/** 撤销栈深度（视图层按钮禁用态判定） */
	get undoDepth(): number {
		return this.undoStack.length;
	}

	/**
	 * 撤销最近一次评分（67）：弹出栈顶并回退会话状态——计数递减、graded 清键、
	 * again 重现实例出队、index/position 落回被撤销卡（未翻面态重新作答）。
	 * 返回弹出的步骤（视图层据此回退 DB 与日志），空栈/防御失败返回 null。
	 *
	 * 不变量：grade() 只在 index 处发生且 index 单调递增 → 栈顶 index 恒为 graded
	 * 最大键 → 弹栈即剥最近一层。防御一：requeued 步骤要求队尾恰为该卡——不符
	 * （理论不可达，remove 清栈保住了这一点）则原样推回放弃撤销。
	 */
	undoLast(): GradedStep | null {
		const step = this.undoStack.pop();
		if (!step) {
			return null;
		}
		if (step.requeued) {
			const tail = this.queue[this.queue.length - 1];
			if (!tail || tail.id !== step.cardId) {
				this.undoStack.push(step); // 状态已不是我认识的样子——原样还栈宁拒不赌
				return null;
			}
			this.queue.pop();
		}
		this.counts[step.grade] = Math.max(0, this.counts[step.grade] - 1);
		this.graded.delete(step.index);
		this.index = step.index;
		this.position = step.index; // 落回被撤销卡，从头作答
		this.revealed = false;
		return step;
	}

	/** 浏览跳转到指定下标（70 卡片列表点击用）：越界钳制到 [0, total]，翻面态复位 */
	goTo(target: number): void {
		this.position = Math.min(Math.max(target, 0), this.queue.length);
		this.revealed = false;
	}

	/** 队列中是否含有该卡（含 again 重现实例）——cardBus changed 订阅方的过滤条件 */
	includes(cardId: string): boolean {
		return this.queue.some((c) => c.id === cardId);
	}

	/**
	 * 会话队列只读快照（70 卡片列表用）：列表行携带队列下标 goTo 跳转；
	 * again 重现实例（同卡两条）在列表里同 id 双行——下标区分，点击各到各位。
	 */
	get cards(): readonly Card[] {
		return this.queue;
	}

	/** 指定下标的已评档位（未评 undefined）——列表行状态徽标用（gradedAt 的任意下标版） */
	gradeOf(i: number): ReviewGrade | undefined {
		return this.graded.get(i);
	}

	/** 评分推进位置（列表行区分已考 < pendingIndex ≤ 待考）——isDone 的数值形态 */
	get pendingIndex(): number {
		return this.index;
	}

	/**
	 * 从会话中删除一张卡（复习内 ⋯ 菜单 / cardBus 外部删除共用）：按 id 全量匹配——
	 * 原始实例与 again 重现实例一并移除（留下任一即幽灵卡）。不在队列返回 false 且零变化。
	 *
	 * counts 刻意保留不回退：评分计数是已落库的事件计数（SM-2 已写库、onGrade 已回调，
	 * Anki 事件语义），Done 屏"共评分 N 次"统计的是按键次数而非卡片数。
	 *
	 * 下标迁移：删除后存活条目整体前移——graded（按队列下标键）重键、index/position
	 * 各减去"严格小于自身的被删下标数"（index 恰指被删卡时迁移后落在下一张待考卡；
	 * position 恰指被删卡时停原位显示移入该槽的下一张；position 在完成屏时恰迁到新 total）。
	 * revealed 仅在显示的卡变了时复位（删别处的卡不打断当前翻面态）。
	 */
	remove(cardId: string): boolean {
		// 0. 67 清撤销栈：删除的 graded 重键破坏栈内 index 有效性——撤销栈浅
		// （≤20）而删除是罕见中断，放弃栈保正确性（取舍见类注释）
		this.undoStack.length = 0;
		// 1. 捕获被删下标（升序）；doomed 只在此处读队列，之后才变异
		const doomed: number[] = [];
		this.queue.forEach((c, i) => {
			if (c.id === cardId) doomed.push(i);
		});
		if (doomed.length === 0) {
			return false;
		}
		// 2. 偏移函数：原下标 i 迁移到 i - before(i)（doomed 升序可提前 break）
		const before = (i: number): number => {
			let n = 0;
			for (const d of doomed) {
				if (d < i) n++;
				else break;
			}
			return n;
		};
		// 3. splice 前记录当前显示的卡（判定翻面态是否需要复位）
		const prevShownId = this.queue[this.position]?.id;
		// 4. graded 整体重键（被删实例的条目丢弃，存活条目下标前移；一次性重建防边读边写）
		const migrated = new Map<number, ReviewGrade>();
		for (const [i, g] of this.graded) {
			if (!doomed.includes(i)) {
				migrated.set(i - before(i), g);
			}
		}
		this.graded.clear();
		for (const [i, g] of migrated) {
			this.graded.set(i, g);
		}
		// 5. 队列按 doomed 降序 splice（先删高下标，低下标不受影响）
		for (let k = doomed.length - 1; k >= 0; k--) {
			this.queue.splice(doomed[k], 1);
		}
		// 6. index/position 迁移（before 只依赖 doomed，splice 后计算仍正确）+ position 钳制
		this.index -= before(this.index);
		this.position = Math.min(this.position - before(this.position), this.queue.length);
		// 7. 显示的卡变了才复位翻面态
		if (this.queue[this.position]?.id !== prevShownId) {
			this.revealed = false;
		}
		return true;
	}
}
