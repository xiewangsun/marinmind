import type { ReviewGrade, ReviewState } from "../types";

/**
 * FSRS-4.5 间隔重复调度（纯函数，镜像 sm2.ts 的接入形态）。
 *
 * 论文：Jianhao Ye et al. "A Modern Spaced Repetition Scheduler" (arXiv:2403.04800)。
 * 记忆模型二元组 (S 稳定性, D 难度) + 可提取性 R（遗忘曲线幂函数形式）；
 * 17 个默认参数取论文手选默认值（未用真实复习记录训练——接入即用，
 * 后续可换优化器产出的参数，公式不动）。
 *
 * 与 SM-2 的关系：ReviewState 复用同一形状，stability/difficulty 为可选扩展
 * 字段（SM-2 卡可无此二字段）；ease 字段 FSRS 不读不写（保留 SM-2 历史）。
 * intervalDays 允许小数（类型注释既有约定：小数表示分钟级学习步长）。
 */

/** 一天的毫秒数 */
const DAY_MS = 86_400_000;
/** "重来"后的重学间隔：10 分钟（与 SM-2 同值，due() 重现语义一致） */
const RELEARN_DELAY_MS = 10 * 60 * 1000;
/** 目标保留率（0.9 = 到期时还有 90% 概率记得）：间隔公式 I(r,S) 的 r */
const REQUEST_RETENTION = 0.9;
/** 遗忘曲线形状：R(t,S) = (1 + FACTOR·t/S)^DECAY，FACTOR = 19/81 使 S 恰为 R=0.9 的间隔 */
const DECAY = -0.5;
const FACTOR = 19 / 81;

/** FSRS-4.5 论文默认参数（17 个，0 基下标 = 论文 w1..w17） */
export const FSRS_DEFAULT_WEIGHTS = [
	0.4, 0.6, 2.4, 5.8, 4.93, 0.94, 0.86, 0.01, 1.49, 0.14, 0.94, 2.18, 0.05, 0.34, 1.26, 0.29,
	2.61,
];

/** 评分 → FSRS 评分档（1=重来 2=困难 3=良好 4=简单） */
const RATING: Record<ReviewGrade, number> = { again: 1, hard: 2, good: 3, easy: 4 };

/** 稳定性上下限（天）：下限防 0/负数进幂函数，上限 10 年防长间隔溢出语义 */
const S_MIN = 0.1;
const S_MAX = 3650;
/** 难度上下限（FSRS 约定 D ∈ [1, 10]） */
const D_MIN = 1;
const D_MAX = 10;

/** 首次评分后的初始稳定性 S₀(G) = w[G-1]（G∈1..4 → w0..w3） */
function initStability(w: number[], g: number): number {
	return clamp(w[g - 1], S_MIN, S_MAX);
}

/** 首次评分后的初始难度 D₀(G) = w4 - e^(w5·(G-1)) + 1（越大越难） */
function initDifficulty(w: number[], g: number): number {
	return clamp(w[4] - Math.exp(w[5] * (g - 1)) + 1, D_MIN, D_MAX);
}

/** 可提取性 R(t, S)：t 天后仍记得的概率（幂函数遗忘曲线） */
export function retrievability(elapsedDays: number, s: number): number {
	const t = Math.max(0, elapsedDays);
	return Math.pow(1 + FACTOR * (t / Math.max(S_MIN, s)), DECAY);
}

/**
 * 复习成功（hard/good/easy）后的稳定性：S′ = S·(1 + e^w8·(11-D)·S^(-w9)·(e^(w10·(1-R))−1)·惩罚/加成)。
 * w15 仅 hard 生效（<1 压低增长），w16 仅 easy 生效（>1 放大增长）。
 */
function stabilityAfterSuccess(w: number[], d: number, s: number, r: number, g: number): number {
	const hardPenalty = g === 2 ? w[15] : 1;
	const easyBonus = g === 4 ? w[16] : 1;
	const inc =
		Math.exp(w[8]) *
		(11 - d) *
		Math.pow(s, -w[9]) *
		(Math.exp(w[10] * (1 - r)) - 1) *
		hardPenalty *
		easyBonus;
	return clamp(s * (1 + inc), S_MIN, S_MAX);
}

/** 复习失败（again）后的稳定性：S′ = w11·D^(-w12)·((S+1)^w13 − 1)·e^(w14·(1-R))（新 S 远小于旧 S） */
function stabilityAfterForget(w: number[], d: number, s: number, r: number): number {
	const next =
		w[11] * Math.pow(d, -w[12]) * (Math.pow(s + 1, w[13]) - 1) * Math.exp(w[14] * (1 - r));
	return clamp(next, S_MIN, S_MAX);
}

/**
 * 复习后的难度更新（均值回归）：
 * D′ = w7·D₀(G) + (1−w7)·(D − w6·(G−3))——当前评分的线性冲击向初始难度回归。
 */
function nextDifficulty(w: number[], d: number, g: number): number {
	const delta = -w[6] * (g - 3);
	return clamp(w[7] * initDifficulty(w, g) + (1 - w[7]) * (d + delta), D_MIN, D_MAX);
}

/**
 * 目标保留率下的间隔（天）：I(r,S) = S·(81/19)·(r^(1/DECAY) − 1)。
 * r=0.9 时系数恒等于 1（I ≡ S），即"稳定性 = 90% 保留率的间隔"。
 */
function intervalAtRetention(s: number, r = REQUEST_RETENTION): number {
	return (s / FACTOR) * (Math.pow(r, 1 / DECAY) - 1);
}

function clamp(v: number, min: number, max: number): number {
	return Math.min(max, Math.max(min, v));
}

/**
 * SM-2 历史卡 → FSRS 记忆状态迁移（近似映射，只补 stability/difficulty 二字段）：
 * - S ≈ 当前间隔（SM-2 间隔在 0.85-0.95 保留率带内，与 0.9 目标的 S 同量级；
 *   重学中/未学卡 intervalDays=0 → 取下限 0.1 天）
 * - D ≈ ease 线性反演：ease 1.3（最难）→ D 10，ease 2.8（最易）→ D 1
 *
 * 何时触发：scheduler 切到 fsrs 后，首张缺 FSRS 字段的复习卡评分时惰性迁移
 * （不做全库批迁移——切回 sm2 零成本，双向可退）。
 */
export function sm2StateToFsrsMemory(prev: ReviewState): { s: number; d: number } {
	const s = clamp(prev.intervalDays > 0 ? prev.intervalDays : S_MIN, S_MIN, S_MAX);
	const ease = clamp(prev.ease, 1.3, 2.8);
	const d = clamp(10 - (ease - 1.3) * 6, D_MIN, D_MAX);
	return { s, d };
}

/**
 * FSRS-4.5 调度主入口（形态对齐 sm2.nextReviewState：纯函数，输入输出 ReviewState）。
 *
 * - 新卡（phase=new）：S₀/D₀ 即首次评分后的记忆状态（不叠加更新公式）
 * - 存量 SM-2 卡（缺 stability/difficulty）：先惰性迁移再走更新公式
 * - again：S_f′ 压低稳定性进重学（10 分钟后重现，dueAt 与 SM-2 同值），
 *   repetitions 清零、lapses+1——与 SM-2 的重学语义逐字段对齐（会话/日志零改动）
 * - hard/good/easy：S_r′ 与 D′ 更新，间隔 = 目标保留率下的 I(r,S)（保留 3 位小数）
 */
export function nextReviewStateFsrs(
	prev: ReviewState,
	grade: ReviewGrade,
	nowMs: number,
): ReviewState {
	const w = FSRS_DEFAULT_WEIGHTS;
	const g = RATING[grade];

	// 新卡：首次评分直接初始化（S₀/D₀ 本就是"评分后"的值）
	if (prev.phase === "new") {
		return finishReview(prev, initStability(w, g), initDifficulty(w, g), g, nowMs);
	}

	// 记忆状态二分支：既有 FSRS 状态直用 / SM-2 存量卡惰性迁移
	const mem =
		prev.stability != null && prev.difficulty != null
			? { s: prev.stability, d: prev.difficulty }
			: sm2StateToFsrsMemory(prev);
	const { s, d } = mem;

	// 距上次复习的天数（无记录按 0：R 取满值，增长项趋近下界）
	const elapsedDays =
		prev.lastReviewedAt != null ? Math.max(0, (nowMs - prev.lastReviewedAt) / DAY_MS) : 0;
	const r = retrievability(elapsedDays, s);

	if (g === 1) {
		return finishReview(
			prev,
			stabilityAfterForget(w, d, s, r),
			nextDifficulty(w, d, g),
			g,
			nowMs,
		);
	}
	return finishReview(
		prev,
		stabilityAfterSuccess(w, d, s, r, g),
		nextDifficulty(w, d, g),
		g,
		nowMs,
	);
}

/** 按评分档收尾公共字段（phase/计数/dueAt；新卡与存量卡共用） */
function finishReview(
	prev: ReviewState,
	stability: number,
	difficulty: number,
	g: number,
	nowMs: number,
): ReviewState {
	if (g === 1) {
		// 复习失败：压低稳定性进重学（字段语义与 SM-2 的 again 分支逐一对齐）
		return {
			...prev,
			phase: "relearning",
			stability,
			difficulty,
			repetitions: 0,
			intervalDays: 0,
			lapses: prev.lapses + 1,
			dueAt: nowMs + RELEARN_DELAY_MS,
			lastReviewedAt: nowMs,
		};
	}
	const interval = Math.round(intervalAtRetention(stability) * 1000) / 1000;
	return {
		...prev,
		phase: "review",
		stability,
		difficulty,
		repetitions: prev.repetitions + 1,
		intervalDays: interval,
		dueAt: nowMs + Math.round(interval * DAY_MS),
		lastReviewedAt: nowMs,
	};
}
