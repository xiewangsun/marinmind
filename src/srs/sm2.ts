import type { ReviewGrade, ReviewState } from "../types";

/** 一天的毫秒数 */
const DAY_MS = 86_400_000;
/** "重来"后的重学间隔：10 分钟 */
const RELEARN_DELAY_MS = 10 * 60 * 1000;
/** 难度系数（EF）上下限 */
const EASE_MIN = 1.3;
const EASE_MAX = 2.8;

/** 评分 → SM-2 quality（0-5）：again 判为失败（< 3），其余递增 */
const QUALITY: Record<ReviewGrade, number> = { again: 2, hard: 3, good: 4, easy: 5 };

/**
 * SM-2 间隔重复调度（Anki 简化版，天粒度）：
 *
 * - 首次答对：1 天后复习；第二次：6 天；此后 interval × ease
 * - again：重置 repetitions、计入遗忘，10 分钟后重新出现（relearning）
 * - hard / easy 微调难度系数，ease 限制在 [1.3, 2.8]
 *
 * 输入输出均为纯数据（ReviewState），后续可无缝替换为 FSRS 等算法。
 */
export function nextReviewState(prev: ReviewState, grade: ReviewGrade, nowMs: number): ReviewState {
	const q = QUALITY[grade];
	let { ease, intervalDays, repetitions } = prev;
	const { lapses } = prev;

	if (q < 3) {
		// 复习失败：清空进度，进入重学
		return {
			...prev,
			phase: "relearning",
			repetitions: 0,
			intervalDays: 0,
			lapses: lapses + 1,
			ease: clampEase(ease - 0.2),
			dueAt: nowMs + RELEARN_DELAY_MS,
			lastReviewedAt: nowMs,
		};
	}

	// SM-2 标准公式：ease += 0.1 - (5-q) * (0.08 + (5-q) * 0.02)
	ease += 0.1 - (5 - q) * (0.08 + (5 - q) * 0.02);
	if (repetitions === 0) {
		intervalDays = 1;
	} else if (repetitions === 1) {
		intervalDays = 6;
	} else {
		intervalDays = Math.max(1, Math.round(intervalDays * clampEase(ease)));
	}
	repetitions += 1;

	return {
		...prev,
		phase: "review",
		ease: clampEase(ease),
		intervalDays,
		repetitions,
		dueAt: nowMs + Math.round(intervalDays * DAY_MS),
		lastReviewedAt: nowMs,
	};
}

function clampEase(ease: number): number {
	return Math.min(EASE_MAX, Math.max(EASE_MIN, ease));
}
