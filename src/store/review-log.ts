import type { ReviewGrade, ReviewState } from "../types";

/**
 * 轻量复习日志（66）：数据根 `复习日志.md`，按日聚合的复习计数——
 * 每日复习量 / 新卡数 / 重来数。三个消费方：统计面板热力图与连续天数（69）、
 * 每日新卡上限的当日已考计数（68 due 混排）、撤销评分的计数回退（67）。
 *
 * 设计取舍：
 * - 计数是**派生统计**而非权威账本（权威在每卡 ReviewState 的 SM-2 字段），
 *   外部手编采纳磁盘值、损坏保内存写回、删除清空不复活——损失面封顶 2s
 *   防抖窗口的当日计数，不追求事务一致（见 store.handleExternalChange 分支注释）。
 * - 日键 yyyy-mm-dd 一律**本地时区**手拼（new Date 的本地分量）——toISOString
 *   是 UTC，东八区晚间复习会记到"昨天"，热力图错日。
 * - 纯函数零 obsidian 依赖，vitest 直测（分层铁律，镜像 review-session）。
 */

/** 数据根内的日志文件名（与书/图文件平级；备份 collectMdFiles 自动收） */
export const REVIEW_LOG_FILENAME = "复习日志.md";

/** 复习日志的脏 scope 键（store 层 flush 分支用；与 docId/mapId/orphan 并列） */
export const REVIEW_LOG_SCOPE = "reviewlog";

/** 单日聚合计数 */
export interface ReviewDayLog {
	/** 当日总评分次数 */
	reviews: number;
	/** 其中新卡（首考 phase="new"）次数——每日新卡上限的计量口径 */
	newCards: number;
	/** 其中评"重来"的次数 */
	again: number;
}

/** 日键 → 计数（日键 yyyy-mm-dd 本地时区） */
export type ReviewLogData = Record<string, ReviewDayLog>;

/** 机器层注释标记（区别于书文件的 mm / 书签的 mm-bm） */
const LOG_MARK = "<!--mm-log ";

/**
 * 时间戳 → 本地时区日键（yyyy-mm-dd）。手拼本地分量，禁 toISOString（UTC 错日）。
 */
export function reviewLogDayKey(ts: number): string {
	const d = new Date(ts);
	const m = String(d.getMonth() + 1).padStart(2, "0");
	const day = String(d.getDate()).padStart(2, "0");
	return `${d.getFullYear()}-${m}-${day}`;
}

/** 记一次评分：reviews 恒 +1；新卡另计 newCards；重来另计 again */
export function recordReview(
	log: ReviewLogData,
	ts: number,
	isNew: boolean,
	grade: ReviewGrade,
): void {
	const key = reviewLogDayKey(ts);
	const day = log[key] ?? { reviews: 0, newCards: 0, again: 0 };
	log[key] = day;
	day.reviews += 1;
	if (isNew) day.newCards += 1;
	if (grade === "again") day.again += 1;
}

/**
 * 撤销评分的计数回退（67）：与 recordReview 严格镜像。日键缺失时无害 no-op
 * （宁拒不赌不造负数——外部删过日志/跨会话撤销时静默放弃该次回退）；
 * 三计数归零删日键（热力图不留 0 行）。
 */
export function unrecordReview(
	log: ReviewLogData,
	ts: number,
	isNew: boolean,
	grade: ReviewGrade,
): void {
	const day = log[reviewLogDayKey(ts)];
	if (!day) return;
	day.reviews = Math.max(0, day.reviews - 1);
	if (isNew) day.newCards = Math.max(0, day.newCards - 1);
	if (grade === "again") day.again = Math.max(0, day.again - 1);
	if (day.reviews === 0 && day.newCards === 0 && day.again === 0) {
		delete log[reviewLogDayKey(ts)];
	}
}

/** 日键合法性（yyyy-mm-dd）——解析侧拒乱造键 */
const DAY_KEY_RE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * 解析日志文件：frontmatter `marinmind: reviewlog` 认领 + 机器层 JSON 为权威。
 * 不认领（无 frontmatter）/损坏（无注释、JSON 非法、日键/字段形状不对）返回 null
 * ——调用方（loadAll 跳过不认领、外部修改保内存）按"宁拒不赌"处理。
 */
export function parseReviewLogMd(text: string): ReviewLogData | null {
	const lines = text.split(/\r?\n/);
	// frontmatter 认领：首行 --- 到闭合 ---，其中须有 marinmind: reviewlog
	if (lines[0]?.trim() !== "---") return null;
	const end = lines.findIndex((l, idx) => idx > 0 && l.trim() === "---");
	if (end < 0) return null;
	let claimed = false;
	for (let i = 1; i < end; i++) {
		if (/^marinmind:\s*reviewlog\s*$/.test(lines[i])) claimed = true;
	}
	if (!claimed) return null;
	// 机器层：最后一个 mm-log 注释行（全文唯一，取尾容错用户复制粘贴）
	let raw: string | null = null;
	for (const line of lines) {
		const trimmed = line.trim();
		if (trimmed.startsWith(LOG_MARK) && trimmed.endsWith("-->")) {
			raw = trimmed.slice(LOG_MARK.length, -3);
		}
	}
	if (raw === null) return null;
	let data: unknown;
	try {
		data = JSON.parse(raw);
	} catch {
		return null;
	}
	if (data === null || typeof data !== "object" || Array.isArray(data)) return null;
	const log: ReviewLogData = {};
	for (const [key, value] of Object.entries(data as Record<string, unknown>)) {
		if (!DAY_KEY_RE.test(key)) return null;
		if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
		const v = value as Record<string, unknown>;
		const reviews = v.reviews;
		const newCards = v.newCards;
		const again = v.again;
		if (
			typeof reviews !== "number" ||
			!Number.isFinite(reviews) ||
			typeof newCards !== "number" ||
			!Number.isFinite(newCards) ||
			typeof again !== "number" ||
			!Number.isFinite(again)
		) {
			return null;
		}
		log[key] = { reviews, newCards, again };
	}
	return log;
}

/**
 * 序列化日志文件：frontmatter + 可读按日行（供用户直接阅读）+ 机器层 JSON
 * （解析权威）。日键升序——同数据两次序列化字节相同（确定性，零写入契约基础）。
 * 空数据也产出合法空文档（认领标记在，机器层空对象）。
 */
export function serializeReviewLogMd(log: ReviewLogData): string {
	const keys = Object.keys(log).sort();
	const out: string[] = [
		"---",
		"marinmind: reviewlog",
		"---",
		"",
		"# 复习日志",
		"",
		"按日聚合的复习计数（MarinMind 自动维护；可手改数字，保存后生效）。",
		"",
	];
	if (keys.length === 0) {
		out.push("（暂无记录——完成第一次评分后开始累计）", "");
	}
	for (const key of keys) {
		const d = log[key];
		out.push(`## ${key}`, "");
		out.push(`复习 ${d.reviews} 张 · 新卡 ${d.newCards} 张 · 重来 ${d.again} 张`);
		out.push("");
	}
	const machine: Record<string, ReviewDayLog> = {};
	for (const key of keys) {
		// 键序固定（reviews/newCards/again），保证确定性序列化
		machine[key] = {
			reviews: log[key].reviews,
			newCards: log[key].newCards,
			again: log[key].again,
		};
	}
	out.push(`${LOG_MARK}${JSON.stringify(machine)}-->`);
	out.push("");
	return out.join("\n");
}

// ---------------------------------------------------------------------------
// 统计派生（69 复习统计面板；纯函数零 obsidian 直测）
// ---------------------------------------------------------------------------

/** 日键 → 本地 Date（月转 0 起）；非法键交由调用方保证（本模块产物键恒合法） */
function dayKeyToDate(key: string): Date {
	const [y, m, d] = key.split("-").map(Number);
	return new Date(y, m - 1, d);
}

/** 本地 Date → 日键（与 reviewLogDayKey 同构） */
function dateToDayKey(d: Date): string {
	const m = String(d.getMonth() + 1).padStart(2, "0");
	const day = String(d.getDate()).padStart(2, "0");
	return `${d.getFullYear()}-${m}-${day}`;
}

/**
 * 连续复习天数：自今日（今日尚无记录则自最近有记录日——当天还没考不算断）向前
 * 数连续有复习（reviews>0）的天数。todayKey 由调用方传入保持纯函数可测。
 */
export function streakFromLog(log: ReviewLogData, todayKey: string): number {
	const active = new Set(
		Object.entries(log)
			.filter(([, d]) => d.reviews > 0)
			.map(([k]) => k),
	);
	if (active.size === 0) return 0;
	// 起点：今日有记录从今日数；否则从 < 今日的最大键数（保留昨日成果）
	let cursor: Date;
	if (active.has(todayKey)) {
		cursor = dayKeyToDate(todayKey);
	} else {
		let latest: string | null = null;
		for (const key of active) {
			if (key < todayKey && (latest === null || key > latest)) latest = key;
		}
		if (latest === null) return 0;
		cursor = dayKeyToDate(latest);
	}
	let streak = 0;
	while (active.has(dateToDayKey(cursor))) {
		streak++;
		cursor.setDate(cursor.getDate() - 1);
	}
	return streak;
}

/** 热力图单元格（周一起始的周列 × 7 行，含 future 占位） */
export interface HeatmapCell {
	dateKey: string;
	count: number;
	/** 0-4 五档：0 / 1-4 / 5-9 / 10-19 / 20+ */
	level: number;
	/** 今日之后的占位格（渲染为空白，不参与档位） */
	future: boolean;
}

/**
 * 热力图数据（GitHub 风格）：weeks 列（旧→新），最后一列含今日；周一为每周第一
 * 天（中文习惯）；今日之后格 future=true 占位（网格矩形整齐）。计数取当日 reviews。
 */
export function heatmapCells(log: ReviewLogData, todayTs: number, weeks = 13): HeatmapCell[] {
	const today = new Date(todayTs);
	// 周一起始的当周周一；再回退 weeks-1 周作为网格左上角
	const dow = (today.getDay() + 6) % 7;
	const monday = new Date(today.getFullYear(), today.getMonth(), today.getDate() - dow);
	const start = new Date(
		monday.getFullYear(),
		monday.getMonth(),
		monday.getDate() - (weeks - 1) * 7,
	);
	const todayKey = dateToDayKey(today);
	const cells: HeatmapCell[] = [];
	for (let w = 0; w < weeks; w++) {
		for (let d = 0; d < 7; d++) {
			const date = new Date(
				start.getFullYear(),
				start.getMonth(),
				start.getDate() + w * 7 + d,
			);
			const key = dateToDayKey(date);
			if (key > todayKey) {
				cells.push({ dateKey: key, count: 0, level: 0, future: true });
				continue;
			}
			const count = log[key]?.reviews ?? 0;
			const level = count === 0 ? 0 : count < 5 ? 1 : count < 10 ? 2 : count < 20 ? 3 : 4;
			cells.push({ dateKey: key, count, level, future: false });
		}
	}
	return cells;
}

/** 两个时间戳的本地日历日差（b − a，按本地午夜换算；复习到期分桶用） */
function calendarDaysBetween(a: number, b: number): number {
	const da = new Date(a);
	const db = new Date(b);
	const midnightA = new Date(da.getFullYear(), da.getMonth(), da.getDate()).getTime();
	const midnightB = new Date(db.getFullYear(), db.getMonth(), db.getDate()).getTime();
	return Math.round((midnightB - midnightA) / 86_400_000);
}

/**
 * 未来 days 天的到期分布（今天为第 0 桶）：**逾期归今日桶**（欠账先还的自然
 * 语义）；只统计已启用闪卡；超出窗口的到期不进桶。days 默认 7。
 */
export function futureDueBuckets(
	reviews: Iterable<ReviewState>,
	nowMs: number,
	days = 7,
): number[] {
	const buckets = new Array<number>(days).fill(0);
	for (const r of reviews) {
		if (!r.isFlashcard) continue;
		const diff = calendarDaysBetween(nowMs, r.dueAt);
		if (diff < 0) {
			buckets[0]++; // 逾期归今
		} else if (diff < days) {
			buckets[diff]++;
		}
	}
	return buckets;
}

/** 累计复习次数近似：Σ(repetitions + lapses)——仅作 103-C 基线迁移的输入
 *  （迁移前历史总量回推；迁移后「累计」= 基线 + loggedReviewTotal，不再直接展示） */
export function totalReviewsApprox(reviews: Iterable<ReviewState>): number {
	let n = 0;
	for (const r of reviews) n += r.repetitions + r.lapses;
	return n;
}

/** 日志记录的复习总次数（Σ 各日 reviews）——「累计复习」的日志侧口径（103-C） */
export function loggedReviewTotal(log: ReviewLogData): number {
	let n = 0;
	for (const day of Object.values(log)) n += day.reviews;
	return n;
}

/** 已启用闪卡数 */
export function flashcardCount(reviews: Iterable<ReviewState>): number {
	let n = 0;
	for (const r of reviews) if (r.isFlashcard) n++;
	return n;
}
