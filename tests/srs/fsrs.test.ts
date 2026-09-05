import { describe, expect, it } from "vitest";
import { nextReviewStateFsrs, retrievability, sm2StateToFsrsMemory } from "../../src/srs/fsrs";
import type { ReviewState } from "../../src/types";

/**
 * FSRS-4.5 调度测试：期望值全部按论文公式手算（默认参数 0.4/0.6/2.4/5.8/
 * 4.93/0.94/0.86/0.01/1.49/0.14/0.94/2.18/0.05/0.34/1.26/0.29/2.61）——
 * 防公式下标漂移的黄金基准。toBeCloseTo 精度 1（±0.05）容纳手算舍入。
 */

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

/** 已确立的 FSRS 卡（S=10、D=5，上次复习恰在 10 天前 → R=0.9） */
function matureState(): ReviewState {
	return {
		...baseState(),
		phase: "review",
		repetitions: 5,
		stability: 10,
		difficulty: 5,
		lastReviewedAt: T0 - 10 * DAY_MS,
	};
}

describe("FSRS-4.5：可提取性", () => {
	it("t = S 时 R 恰为 0.9（稳定性 ≡ 90% 保留率间隔）", () => {
		expect(retrievability(10, 10)).toBeCloseTo(0.9, 10);
	});

	it("t 越长 R 越低，且恒在 (0,1] 内", () => {
		const r1 = retrievability(1, 10);
		const r5 = retrievability(5, 10);
		const r50 = retrievability(50, 10);
		expect(r1).toBeGreaterThan(r5);
		expect(r5).toBeGreaterThan(r50);
		expect(r1).toBeLessThanOrEqual(1);
		expect(r50).toBeGreaterThan(0);
	});
});

describe("FSRS-4.5：SM-2 存量卡迁移", () => {
	it("ease 线性反演到难度：1.3→10、2.8→1、2.5→2.8", () => {
		expect(sm2StateToFsrsMemory({ ...baseState(), ease: 1.3, intervalDays: 30 }).d).toBe(10);
		expect(sm2StateToFsrsMemory({ ...baseState(), ease: 2.8, intervalDays: 30 }).d).toBeCloseTo(
			1,
			10,
		);
		expect(sm2StateToFsrsMemory({ ...baseState(), ease: 2.5, intervalDays: 30 }).d).toBeCloseTo(
			2.8,
			10,
		);
	});

	it("间隔即稳定性（重学中/间隔 0 的卡取下限 0.1 天）", () => {
		expect(sm2StateToFsrsMemory({ ...baseState(), intervalDays: 30 }).s).toBe(30);
		expect(sm2StateToFsrsMemory({ ...baseState(), intervalDays: 0 }).s).toBe(0.1);
	});
});

describe("FSRS-4.5：新卡首评", () => {
	it("good：S₀=w3=2.4、D₀ 钳到下限 1，间隔 = S（r=0.9 时系数恒为 1）", () => {
		const s = nextReviewStateFsrs(baseState(), "good", T0);
		expect(s.phase).toBe("review");
		expect(s.stability).toBe(2.4);
		expect(s.difficulty).toBe(1);
		expect(s.repetitions).toBe(1);
		expect(s.lapses).toBe(0);
		expect(s.intervalDays).toBe(2.4);
		expect(s.dueAt).toBe(T0 + 2.4 * DAY_MS);
		expect(s.lastReviewedAt).toBe(T0);
	});

	it("again：S₀=w1=0.4、D₀=w5=4.93，进重学 10 分钟后重现", () => {
		const s = nextReviewStateFsrs(baseState(), "again", T0);
		expect(s.phase).toBe("relearning");
		expect(s.stability).toBe(0.4);
		expect(s.difficulty).toBeCloseTo(4.93, 10);
		expect(s.repetitions).toBe(0);
		expect(s.lapses).toBe(1);
		expect(s.intervalDays).toBe(0);
		expect(s.dueAt).toBe(T0 + 10 * 60 * 1000);
	});

	it("easy：S₀=w4=5.8（比 good 长，间隔单调）", () => {
		const s = nextReviewStateFsrs(baseState(), "easy", T0);
		expect(s.stability).toBe(5.8);
		expect(s.intervalDays).toBe(5.8);
	});
});

describe("FSRS-4.5：存量卡更新（S=10、D=5、t=10 天 → R=0.9）", () => {
	it("good：S′≈29.01、D′=4.96（手算基准）", () => {
		const s = nextReviewStateFsrs(matureState(), "good", T0);
		expect(s.phase).toBe("review");
		expect(s.stability).toBeCloseTo(29.01, 1);
		expect(s.difficulty).toBeCloseTo(4.96, 2);
		expect(s.repetitions).toBe(6);
		expect(s.intervalDays).toBeCloseTo(29.01, 1);
	});

	it("hard：惩罚系数 w15=0.29 压低增长，S′≈15.51、D′ 上行 ≈5.84", () => {
		const s = nextReviewStateFsrs(matureState(), "hard", T0);
		expect(s.stability).toBeCloseTo(15.51, 1);
		expect(s.difficulty).toBeCloseTo(5.84, 1);
	});

	it("easy：加成系数 w16=2.61 放大增长，S′≈59.61、D′ 下行 ≈4.11", () => {
		const s = nextReviewStateFsrs(matureState(), "easy", T0);
		expect(s.stability).toBeCloseTo(59.61, 1);
		expect(s.difficulty).toBeCloseTo(4.11, 1);
	});

	it("again：遗忘公式 S_f′≈2.87、D′≈6.70，重学语义与 SM-2 逐字段对齐", () => {
		const s = nextReviewStateFsrs(matureState(), "again", T0);
		expect(s.phase).toBe("relearning");
		expect(s.stability).toBeCloseTo(2.87, 1);
		expect(s.difficulty).toBeCloseTo(6.7, 1);
		expect(s.repetitions).toBe(0);
		expect(s.lapses).toBe(1);
		expect(s.dueAt).toBe(T0 + 10 * 60 * 1000);
	});
});

describe("FSRS-4.5：SM-2 存量卡惰性迁移后更新", () => {
	it("review 卡（间隔 30 天、ease 2.5）+ good：S 从迁移值 30 起算 ≈96.83、D 从 2.8 起算 ≈2.78", () => {
		const prev: ReviewState = {
			...baseState(),
			phase: "review",
			ease: 2.5,
			intervalDays: 30,
			repetitions: 30,
			lapses: 2,
			lastReviewedAt: T0 - 30 * DAY_MS,
		};
		const s = nextReviewStateFsrs(prev, "good", T0);
		expect(s.phase).toBe("review");
		expect(s.stability).toBeCloseTo(96.83, 1);
		expect(s.difficulty).toBeCloseTo(2.78, 1);
		expect(s.repetitions).toBe(31);
		expect(s.lapses).toBe(2); // good 不计遗忘
	});

	it("重学中卡（间隔 0）+ good：迁移 S 取下限 0.1，刚复习 R=1 增长项为 0", () => {
		const prev: ReviewState = {
			...baseState(),
			phase: "relearning",
			ease: 2.5,
			intervalDays: 0,
			repetitions: 0,
			lapses: 1,
			lastReviewedAt: T0,
		};
		const s = nextReviewStateFsrs(prev, "good", T0);
		expect(s.stability).toBeCloseTo(0.1, 2);
		expect(s.phase).toBe("review");
		expect(s.intervalDays).toBeCloseTo(0.1, 2);
	});
});

describe("FSRS-4.5：调度器切换语义", () => {
	it("同一状态在 SM-2 与 FSRS 下互不污染：FSRS 不读写 ease", () => {
		const s = nextReviewStateFsrs(matureState(), "good", T0);
		expect(s.ease).toBe(2.5); // 原样透传
		expect(s.cardId).toBe("c1");
		expect(s.isFlashcard).toBe(true);
	});
});
