import { describe, expect, it } from "vitest";
import { nextReviewState } from "../../src/srs/sm2";
import type { ReviewState } from "../../src/types";

/** 固定时间基准，保证断言确定性 */
const T0 = 1_700_000_000_000;
const DAY_MS = 86_400_000;

/** 全新卡片的基础复习状态 */
function baseState(): ReviewState {
	return {
		cardId: "c1",
		isFlashcard: true,
		phase: "new",
		ease: 2.5,
		intervalDays: 0,
		repetitions: 0,
		dueAt: T0,
		lastReviewedAt: null,
		lapses: 0,
	};
}

describe("SM-2 调度", () => {
	it("新卡首次 good：1 天后复习，进入 review 阶段", () => {
		const s = nextReviewState(baseState(), "good", T0);
		expect(s.intervalDays).toBe(1);
		expect(s.dueAt).toBe(T0 + DAY_MS);
		expect(s.phase).toBe("review");
		expect(s.repetitions).toBe(1);
		expect(s.lastReviewedAt).toBe(T0);
	});

	it("连续 good 的间隔序列：1 → 6 → 6×ease", () => {
		let s = nextReviewState(baseState(), "good", T0);
		expect(s.intervalDays).toBe(1);
		s = nextReviewState(s, "good", s.dueAt);
		expect(s.intervalDays).toBe(6);
		s = nextReviewState(s, "good", s.dueAt);
		// good 不改变 ease（q=4 时增量恰为 0），6 × 2.5 = 15
		expect(s.intervalDays).toBe(15);
		expect(s.repetitions).toBe(3);
	});

	it("again：重置进度、计入遗忘，10 分钟后重学", () => {
		let s = nextReviewState(baseState(), "good", T0);
		s = nextReviewState(s, "again", s.dueAt);
		expect(s.phase).toBe("relearning");
		expect(s.repetitions).toBe(0);
		expect(s.intervalDays).toBe(0);
		expect(s.lapses).toBe(1);
		expect(s.ease).toBeCloseTo(2.3); // 2.5 - 0.2
		expect(s.dueAt).toBe(T0 + DAY_MS + 10 * 60 * 1000);
	});

	it("easy 提升难度系数；连续 hard 压到下限后不再下降", () => {
		const easy = nextReviewState(baseState(), "easy", T0);
		expect(easy.ease).toBeCloseTo(2.6);
		let s = baseState();
		for (let i = 0; i < 10; i++) {
			s = nextReviewState(s, "hard", T0);
		}
		expect(s.ease).toBe(1.3);
	});
});
