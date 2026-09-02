import type { MarinMindStore } from "../../store/marinmind-store";
import { defaultReviewState } from "../../store/book-format";
import { recordReview, reviewLogDayKey, unrecordReview } from "../../store/review-log";
import { inPathSubtree, normalizeCategory } from "../../home/home-data";
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
	 * 到期闪卡列表（附带卡片本体，复习时可回看摘录与上下文）。
	 * documentId（㊷ 复习按书过滤）/ deck（按卡组过滤）：非 null 时只返回匹配卡片
	 * （先过滤后计数），双参同时给定时取交集。
	 *
	 * deck 73 路径化改**子树匹配**（选「学习」含「学习/英语」；双侧过 normalizeCategory
	 * 合并空白变体）：存量扁平名不含 `/` 时子树匹配 ≡ 精确匹配，严格向后兼容；含 `/`
	 * 的旧值只扩不缩（多匹配到更深的子路径卡，即新语义本意）。唯一调用链
	 * openReviewDeck ← 命令/主页「复习本组」，limit/batching/「再查一批」语义不变。
	 *
	 * 68 分批与新卡混排：**复习卡（phase≠new）占 limit 名额按 dueAt 升序在前，
	 * 新卡（phase=new，dueAt=enable 时间）殿后独立计量**——limit 只封顶复习段
	 * （Anki 语义：新卡不占复习名额）。newPerDay > 0 时新卡配额 =
	 * max(0, newPerDay − 当日日志已考新卡数)（批 67 撤销已同步维护该计数）；
	 * 0/缺省 = 新卡不限量。行为变化提示：新卡囤积的老库首批会变大，教程引导
	 * 设置「每日新卡上限」。
	 */
	due(
		nowMs: number = now(),
		limit = 20,
		documentId?: string,
		deck?: string,
		newPerDay?: number,
	): Card[] {
		const states = [...this.store.reviews.values()]
			.filter((r) => r.isFlashcard && r.dueAt <= nowMs)
			.sort((a, b) => a.dueAt - b.dueAt || (a.cardId < b.cardId ? -1 : 1));
		// deck 目标归一一次（73 子树匹配）；卡片侧同步归一防空白变体漏配；
		// 归一失败（全空白/超长）= 无效子树 → 不命中任何卡（宁拒不赌，不静默放行）
		const deckTarget = deck != null ? normalizeCategory(deck) : null;
		return this.assembleMixed(states, nowMs, newPerDay, (card) => {
			if (documentId != null && card.documentId !== documentId) return false;
			if (deck != null) {
				if (deckTarget == null) return false;
				const path = card.deck ? normalizeCategory(card.deck) : null;
				if (!(path != null && inPathSubtree(path, deckTarget))) return false;
			}
			return true;
		}, limit);
	}

	/**
	 * 按卡片 id 集合取到期卡（70 cards 范围：主页颜色筛选结果/脑图分支复习共用）。
	 * 语义与 due() 同源——到期过滤 + 68 混排（复习卡在前新卡殿后 + newPerDay 配额）；
	 * **无 limit**（集合本身就是调用方框定的范围，20 截断反而漏卡）。忽略不存在/
	 * 未启用/未到期的 id（宁拒不赌），cardIds 先转 Set 防 N×M 线性扫描。
	 */
	dueByIds(cardIds: string[], opts?: { nowMs?: number; newPerDay?: number }): Card[] {
		const ids = new Set(cardIds);
		const nowMs = opts?.nowMs ?? now();
		const states = [...this.store.reviews.values()]
			.filter((r) => r.isFlashcard && r.dueAt <= nowMs && ids.has(r.cardId))
			.sort((a, b) => a.dueAt - b.dueAt || (a.cardId < b.cardId ? -1 : 1));
		return this.assembleMixed(states, nowMs, opts?.newPerDay, () => true, Number.POSITIVE_INFINITY);
	}

	/**
	 * 混排装配（due/dueByIds 共用，68）：states 已按 dueAt 升序过滤排序，
	 * cardFilter 做卡片级过滤（书/卡组/无），limit 只封顶复习段。
	 */
	private assembleMixed(
		states: ReviewState[],
		nowMs: number,
		newPerDay: number | undefined,
		cardFilter: (card: Card) => boolean,
		limit: number,
	): Card[] {
		// 过滤后按 new/复习二分（保持 dueAt 排序），两段独立计量拼接
		const reviewCards: Card[] = [];
		const newCards: Card[] = [];
		for (const r of states) {
			const card = this.store.bookOfCard(r.cardId)?.cards.get(r.cardId);
			if (!card) continue; // 卡片本体必须存在（对齐旧库 INNER JOIN）
			if (!cardFilter(card)) continue;
			(r.phase === "new" ? newCards : reviewCards).push(card);
		}
		const out = reviewCards.slice(0, limit);
		let newQuota = newPerDay && newPerDay > 0
			? Math.max(0, newPerDay - (this.store.getReviewLog()[reviewLogDayKey(nowMs)]?.newCards ?? 0))
			: Number.POSITIVE_INFINITY;
		for (const card of newCards) {
			if (newQuota <= 0) break;
			out.push(card);
			newQuota--;
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
		// 66 复习日志：与 putReview 共用同一 nowMs（撤销跨午夜回退 ts 对齐依赖此单一时间源）；
		// isNew 判定用评分前 prev.phase——评分后 next.phase 已离开 new
		this.store.mutateReviewLog((log) =>
			recordReview(log, nowMs, prev.phase === "new", grade));
		return next;
	}

	/**
	 * 撤销一次评分（67 浏览态撤销）：直写评分前快照，**不走 nextReviewState——
	 * 语义是时间倒流**而非新调度事件；复习日志同 ts 镜像回退（before 即评分前
	 * prev，isNew 判定与 recordReview 记录时同源）。ts/grade 由视图撤销快照携带。
	 */
	restoreReview(before: ReviewState, ts: number, grade: ReviewGrade): void {
		this.store.putReview(before);
		this.store.mutateReviewLog((log) =>
			unrecordReview(log, ts, before.phase === "new", grade));
	}
}
