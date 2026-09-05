import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MarinMindStore } from "../../src/store/marinmind-store";
import { CardRepository } from "../../src/db/repositories/card-repo";
import { DocumentRepository } from "../../src/db/repositories/document-repo";
import { ReviewRepository } from "../../src/db/repositories/review-repo";
import {
	REVIEW_LOG_FILENAME,
	flashcardCount,
	heatmapCells,
	parseReviewLogMd,
	recordReview,
	reviewLogDayKey,
	serializeReviewLogMd,
	streakFromLog,
	futureDueBuckets,
	loggedReviewTotal,
	totalReviewsApprox,
	unrecordReview,
	type ReviewLogData,
} from "../../src/store/review-log";
import type { ReviewState } from "../../src/types";
import { MemoryAdapter, textOf, writeText } from "../helpers/memory-adapter";

// ---------------------------------------------------------------------------
// 纯函数（零 obsidian 依赖直测）
// ---------------------------------------------------------------------------

describe("reviewLogDayKey（66）", () => {
	it("本地时区日键：本地分量构造的午夜前后分属两日（任何时区跑出同键，禁 toISOString 的 UTC 错日）", () => {
		// 用本地时间分量构造而非绝对毫秒——东八区与 UTC 机器断言结果一致
		const lateNight = new Date(2026, 8, 1, 23, 30).getTime();
		const pastMidnight = new Date(2026, 8, 2, 0, 30).getTime();
		expect(reviewLogDayKey(lateNight)).toBe("2026-09-01");
		expect(reviewLogDayKey(pastMidnight)).toBe("2026-09-02");
		// 月日补零：单数字月份日期
		const jan = new Date(2027, 0, 5, 12, 0).getTime();
		expect(reviewLogDayKey(jan)).toBe("2027-01-05");
	});
});

describe("recordReview / unrecordReview（66）", () => {
	it("record 三态：reviews 恒 +1、新卡另计 newCards、重来另计 again", () => {
		const ts = new Date(2026, 8, 1, 10, 0).getTime();
		const log: ReviewLogData = {};
		recordReview(log, ts, false, "good"); // 旧卡 good
		recordReview(log, ts, true, "good"); // 新卡 good
		recordReview(log, ts, false, "again"); // 旧卡重来
		expect(log["2026-09-01"]).toEqual({ reviews: 3, newCards: 1, again: 1 });
	});

	it("unrecord 严格镜像回退；三计数归零删日键（热力图不留 0 行）", () => {
		const ts = new Date(2026, 8, 1, 10, 0).getTime();
		const log: ReviewLogData = {};
		recordReview(log, ts, true, "again");
		recordReview(log, ts, false, "good");
		unrecordReview(log, ts, true, "again"); // 新卡重来那次撤销
		expect(log["2026-09-01"]).toEqual({ reviews: 1, newCards: 0, again: 0 });
		unrecordReview(log, ts, false, "good"); // 最后一次归零 → 删键
		expect(log["2026-09-01"]).toBeUndefined();
	});

	it("unrecord 日键缺失无害 no-op（外部删过日志后撤销：宁拒不赌不造负数）", () => {
		const ts = new Date(2026, 8, 1, 10, 0).getTime();
		const log: ReviewLogData = {};
		expect(() => unrecordReview(log, ts, true, "good")).not.toThrow();
		expect(log).toEqual({});
	});
});

describe("parseReviewLogMd / serializeReviewLogMd（66）", () => {
	it("序列化·解析往返：多日数据整包往返逐值相等", () => {
		const log: ReviewLogData = {
			"2026-08-31": { reviews: 12, newCards: 3, again: 1 },
			"2026-09-01": { reviews: 5, newCards: 0, again: 2 },
		};
		const text = serializeReviewLogMd(log);
		expect(parseReviewLogMd(text)).toEqual(log);
	});

	it("空数据产出合法空文档且被认领为空日志（首次落盘/全删后重建的「暂无记录」态）", () => {
		const text = serializeReviewLogMd({});
		expect(parseReviewLogMd(text)).toEqual({});
	});

	it("序列化确定性：乱序灌入的日键按升序输出（两次序列化字节相同——零写入契约基础）", () => {
		const log: ReviewLogData = {
			"2026-09-03": { reviews: 1, newCards: 0, again: 0 },
			"2026-09-01": { reviews: 2, newCards: 2, again: 0 },
		};
		const text = serializeReviewLogMd(log);
		expect(text.indexOf("## 2026-09-01")).toBeLessThan(text.indexOf("## 2026-09-03"));
		expect(serializeReviewLogMd(log)).toBe(text);
	});

	it("不认领：无 frontmatter 的普通笔记 / 书文件 frontmatter（marinmind: book）均返回 null", () => {
		expect(parseReviewLogMd("# 随手笔记\n\n正文")).toBeNull();
		expect(parseReviewLogMd("---\nmarinmind: book\n---\n\n## 第 1 页\n")).toBeNull();
	});

	it("损坏防御：无机器注释 / JSON 非法 / 字段形状不对 / 日键乱造 → 整体 null 宁拒不赌", () => {
		const head = "---\nmarinmind: reviewlog\n---\n";
		expect(parseReviewLogMd(head)).toBeNull(); // 无注释
		expect(parseReviewLogMd(`${head}\n<!--mm-log {oops}-->\n`)).toBeNull(); // JSON 非法
		expect(
			parseReviewLogMd(
				`${head}\n<!--mm-log {"2026-09-01":{"reviews":"x","newCards":0,"again":0}}-->\n`,
			),
		).toBeNull(); // 字段非数
		expect(
			parseReviewLogMd(
				`${head}\n<!--mm-log {"昨天":{"reviews":1,"newCards":0,"again":0}}-->\n`,
			),
		).toBeNull(); // 日键乱造
	});
});

// ---------------------------------------------------------------------------
// store 集成（MemoryAdapter 直测）
// ---------------------------------------------------------------------------

let store: MarinMindStore;
beforeEach(async () => {
	store = await MarinMindStore.open(new MemoryAdapter());
});
afterEach(() => store.close());

describe("复习日志 store 集成（66）", () => {
	it("loadAll 认领：数据根预置 复习日志.md 灌入内存；损坏文件保空态不炸", async () => {
		const adapter = new MemoryAdapter();
		const log: ReviewLogData = { "2026-09-01": { reviews: 7, newCards: 2, again: 1 } };
		writeText(adapter, REVIEW_LOG_FILENAME, serializeReviewLogMd(log));

		const s1 = await MarinMindStore.open(adapter);
		expect(s1.getReviewLog()).toEqual(log);
		s1.close();

		// 损坏文件：空态 + lastWritten 记磁盘原文（下次评分 flush 覆盖回规范格式）
		const adapter2 = new MemoryAdapter();
		writeText(adapter2, REVIEW_LOG_FILENAME, "---\nmarinmind: reviewlog\n---\n（损坏）");
		const s2 = await MarinMindStore.open(adapter2);
		expect(s2.getReviewLog()).toEqual({});
		s2.close();
	});

	it("flush 零写契约：无评分时 flush 不写日志文件（writeCounts 无记录）", async () => {
		const adapter = new MemoryAdapter();
		const s1 = await MarinMindStore.open(adapter);
		await s1.flush();
		expect(adapter.writeCounts.get(REVIEW_LOG_FILENAME)).toBeUndefined();
		s1.close();
	});

	it("review() 记日志：评分→flush 落盘→重开恢复（跨会话往返）", async () => {
		const adapter = new MemoryAdapter();
		const s1 = await MarinMindStore.open(adapter);
		const c1 = new CardRepository(s1);
		const r1 = new ReviewRepository(s1);
		const card = c1.create({
			documentId: null,
			page: null,
			rects: [],
			excerptType: "text",
			excerptText: "Q",
		});
		r1.enable(card.id, 1000);
		const ts = new Date(2026, 8, 1, 10, 0).getTime();
		r1.review(card.id, "good", ts); // 首考 = 新卡
		r1.review(card.id, "again", ts + 60_000); // 需先到期——直接再评走 prev（phase=review）非新卡
		expect(s1.getReviewLog()["2026-09-01"]).toEqual({ reviews: 2, newCards: 1, again: 1 });
		await s1.flush();
		expect(parseReviewLogMd(textOf(adapter, REVIEW_LOG_FILENAME))).toEqual({
			"2026-09-01": { reviews: 2, newCards: 1, again: 1 },
		});
		s1.close();

		const s2 = await MarinMindStore.open(adapter);
		expect(s2.getReviewLog()["2026-09-01"]).toEqual({ reviews: 2, newCards: 1, again: 1 });
		s2.close();
	});

	it("外部修改采纳：手编数字即权威（整文件覆盖内存，lastWritten 跟随不回声）", async () => {
		const adapter = new MemoryAdapter();
		writeText(
			adapter,
			REVIEW_LOG_FILENAME,
			serializeReviewLogMd({
				"2026-09-01": { reviews: 99, newCards: 50, again: 0 },
			}),
		);
		const s1 = await MarinMindStore.open(adapter);
		await s1.handleExternalChange(REVIEW_LOG_FILENAME, textOf(adapter, REVIEW_LOG_FILENAME));
		expect(s1.getReviewLog()["2026-09-01"]?.reviews).toBe(99);
		// 同内容再来一次 = 插件自写回声（lastWritten 已跟随）→ 无警告无变化
		const result = await s1.handleExternalChange(
			REVIEW_LOG_FILENAME,
			textOf(adapter, REVIEW_LOG_FILENAME),
		);
		expect(result.warnings).toEqual([]);
		s1.close();
	});

	it("外部修改损坏：内存不动（下次 flush 用内存覆盖回）", async () => {
		const adapter = new MemoryAdapter();
		const log: ReviewLogData = { "2026-09-01": { reviews: 8, newCards: 0, again: 0 } };
		writeText(adapter, REVIEW_LOG_FILENAME, serializeReviewLogMd(log));
		const s1 = await MarinMindStore.open(adapter);
		// 半截写入：frontmatter 认领但机器注释 JSON 被截断
		await s1.handleExternalChange(
			REVIEW_LOG_FILENAME,
			"---\nmarinmind: reviewlog\n---\n<!--mm-log {trunc",
		);
		expect(s1.getReviewLog()).toEqual(log);
		s1.close();
	});

	it("外部删除：内存清空不复活——后续 flush 不重写文件；新评分自然重建", async () => {
		const adapter = new MemoryAdapter();
		writeText(
			adapter,
			REVIEW_LOG_FILENAME,
			serializeReviewLogMd({
				"2026-09-01": { reviews: 3, newCards: 0, again: 0 },
			}),
		);
		const s1 = await MarinMindStore.open(adapter);
		// vault delete 事件到达时磁盘文件已消失（store 只清内存，不负责删盘）
		adapter.files.delete(REVIEW_LOG_FILENAME);
		await s1.handleExternalChange(REVIEW_LOG_FILENAME, null);
		expect(s1.getReviewLog()).toEqual({});
		await s1.flush(); // 撤脏生效：不得把空内存重新写回复活
		expect(adapter.files.has(REVIEW_LOG_FILENAME)).toBe(false);
		s1.close();

		// 重建：删后新评分标脏 → flush 产出只含新记录的日志
		const s2 = await MarinMindStore.open(adapter);
		const c2 = new CardRepository(s2);
		const r2 = new ReviewRepository(s2);
		const card = c2.create({
			documentId: null,
			page: null,
			rects: [],
			excerptType: "text",
			excerptText: "Q",
		});
		r2.enable(card.id, 1000);
		r2.review(card.id, "good", new Date(2026, 8, 2, 9, 0).getTime());
		await s2.flush();
		expect(parseReviewLogMd(textOf(adapter, REVIEW_LOG_FILENAME))).toEqual({
			"2026-09-02": { reviews: 1, newCards: 1, again: 0 },
		});
		s2.close();
	});

	it("书名占用守卫：书名恰为「复习日志」时文件名加 id 后缀让路", () => {
		const documents = new DocumentRepository(store);
		const d = documents.upsertByPath("books/x.pdf", "复习日志");
		expect(d.title).toBe("复习日志");
		const written = [...store.books.values()].find((b) => b.doc.id === d.id);
		expect(written?.relPath).not.toBe(REVIEW_LOG_FILENAME);
		expect(written?.relPath).toContain("复习日志 (");
	});
});

// ---------------------------------------------------------------------------
// 统计派生纯函数（69 复习统计面板）
// ---------------------------------------------------------------------------

/** 本地分量构造时间戳（任何时区断言一致） */
function at(y: number, m: number, d: number): number {
	return new Date(y, m - 1, d, 12, 0).getTime();
}

/** 造最小 ReviewState（统计函数只读 isFlashcard/dueAt/repetitions/lapses） */
function reviewState(partial: Partial<ReviewState>): ReviewState {
	return {
		cardId: partial.cardId ?? "c",
		isFlashcard: true,
		phase: "review",
		ease: 2.5,
		intervalDays: 1,
		repetitions: 0,
		dueAt: 0,
		lastReviewedAt: null,
		lapses: 0,
		...partial,
	};
}

describe("streakFromLog（69 连续复习天数）", () => {
	it("今日有记录：从今日向前数连续日（中断即停）", () => {
		const log: ReviewLogData = {
			"2026-08-30": { reviews: 3, newCards: 0, again: 0 },
			"2026-08-31": { reviews: 5, newCards: 0, again: 0 },
			"2026-09-01": { reviews: 2, newCards: 0, again: 0 },
		};
		expect(streakFromLog(log, "2026-09-01")).toBe(3);
	});

	it("今日尚无记录：从最近有记录日起算（当天还没考不算断，昨日成果保留）", () => {
		const log: ReviewLogData = {
			"2026-08-30": { reviews: 3, newCards: 0, again: 0 },
			"2026-08-31": { reviews: 5, newCards: 0, again: 0 },
		};
		expect(streakFromLog(log, "2026-09-01")).toBe(2);
	});

	it("中断停 + 空日志 + 未来日期起点不计", () => {
		// 8-30 缺席 → 从 8-31 起只连 2 天（8-31、9-01）
		const log: ReviewLogData = {
			"2026-08-29": { reviews: 3, newCards: 0, again: 0 },
			"2026-08-31": { reviews: 5, newCards: 0, again: 0 },
			"2026-09-01": { reviews: 2, newCards: 0, again: 0 },
		};
		expect(streakFromLog(log, "2026-09-01")).toBe(2);
		// reviews=0 的日不算（手编清零 = 没复习）
		expect(
			streakFromLog({ "2026-09-01": { reviews: 0, newCards: 0, again: 0 } }, "2026-09-01"),
		).toBe(0);
		// 日志全部晚于 todayKey（未来）→ 0
		expect(
			streakFromLog({ "2026-09-05": { reviews: 1, newCards: 0, again: 0 } }, "2026-09-01"),
		).toBe(0);
	});
});

describe("heatmapCells（69 热力图）", () => {
	it("网格周对齐：weeks×7 格，首格为 today 所在周的 weeks-1 周前的周一，末列含今日", () => {
		// 2026-09-01 是周二：当周周一 = 2026-08-31；13 周首格 = 08-31 − 12 周 = 2026-06-08（周一）
		const cells = heatmapCells({}, at(2026, 9, 1), 13);
		expect(cells).toHaveLength(13 * 7);
		expect(cells[0]?.dateKey).toBe("2026-06-08");
		expect(cells[0]?.future).toBe(false);
		// 末格 = 当周日 2026-09-06 > 今日 → future 占位
		expect(cells[cells.length - 1]?.dateKey).toBe("2026-09-06");
		expect(cells[cells.length - 1]?.future).toBe(true);
		// 今日格：周二 = 第 13 列第 2 行（列 12、行 1）
		const todayCell = cells[12 * 7 + 1];
		expect(todayCell?.dateKey).toBe("2026-09-01");
		expect(todayCell?.future).toBe(false);
	});

	it("level 五档：0 / 1-4 / 5-9 / 10-19 / 20+，计数取当日 reviews", () => {
		const log: ReviewLogData = {
			"2026-08-31": { reviews: 1, newCards: 0, again: 0 },
			"2026-09-01": { reviews: 5, newCards: 0, again: 0 },
		};
		const cells = heatmapCells(log, at(2026, 9, 1), 2);
		const byKey = new Map(cells.map((c) => [c.dateKey, c]));
		expect(byKey.get("2026-08-31")?.level).toBe(1);
		expect(byKey.get("2026-09-01")?.level).toBe(2);
		expect(byKey.get("2026-08-25")?.level).toBe(0); // 窗口内无记录日
		expect(byKey.get("2026-09-02")?.future).toBe(true); // 未来格不算档
	});

	it("weeks 截断：窗口外的历史日不进网格", () => {
		const log: ReviewLogData = { "2026-01-01": { reviews: 30, newCards: 0, again: 0 } };
		const cells = heatmapCells(log, at(2026, 9, 1), 13);
		expect(cells.some((c) => c.dateKey === "2026-01-01")).toBe(false);
	});
});

describe("futureDueBuckets（69 到期分布）", () => {
	it("逾期归今日桶，其余按本地日历日分桶；窗口外不计", () => {
		const now = at(2026, 9, 1);
		const states = [
			reviewState({ cardId: "overdue", dueAt: now - 86_400_000 * 3 }), // 逾期 → 桶 0
			reviewState({ cardId: "today", dueAt: now + 3600_000 }), // 今天 → 桶 0
			reviewState({ cardId: "tomorrow", dueAt: at(2026, 9, 2) }), // 明天 → 桶 1
			reviewState({ cardId: "d3", dueAt: at(2026, 9, 3) }), // 桶 2
			reviewState({ cardId: "beyond", dueAt: at(2026, 9, 12) }), // 7 天窗口外不计
			reviewState({ cardId: "off", isFlashcard: false, dueAt: now }), // 未启用不计
		];
		expect(futureDueBuckets(states, now, 7)).toEqual([2, 1, 1, 0, 0, 0, 0]);
	});

	it("totalReviewsApprox / flashcardCount：SM-2 字段近似口径 + 启用计数", () => {
		const states = [
			reviewState({ repetitions: 3, lapses: 1 }),
			reviewState({ repetitions: 2, lapses: 0 }),
			reviewState({ isFlashcard: false, repetitions: 5, lapses: 5 }), // 禁用卡：闪卡数不计
		];
		expect(totalReviewsApprox(states)).toBe(16); // 近似口径含禁用卡历史（调度字段保留）
		expect(flashcardCount(states)).toBe(2);
	});

	it("loggedReviewTotal：Σ 各日 reviews（103-C 累计复习的日志侧口径）", () => {
		expect(loggedReviewTotal({})).toBe(0);
		expect(
			loggedReviewTotal({
				"2026-09-01": { reviews: 12, newCards: 3, again: 1 },
				"2026-09-02": { reviews: 7, newCards: 0, again: 2 },
			}),
		).toBe(19);
	});
});
