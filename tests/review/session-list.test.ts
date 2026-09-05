import { describe, expect, it } from "vitest";
import { buildSessionRows, sessionRowTitle } from "../../src/review/session-list";
import type { Card } from "../../src/types";

function card(partial: Partial<Card> = {}): Card {
	return {
		id: partial.id ?? `c${Math.random().toString(36).slice(2, 8)}`,
		documentId: null,
		page: null,
		rects: [],
		excerptType: "text",
		polygon: null,
		excerptText: "文本",
		excerptRef: null,
		note: null,
		color: null,
		title: null,
		deck: null,
		occlusions: [],
		tags: [],
		createdAt: 1700000000000,
		updatedAt: 1700000000000,
		...partial,
	};
}

describe("buildSessionRows（70 复习卡片组列表）", () => {
	it("queue 序透传：行序 = 队列序，index 恒为队列下标（与 ◀ ▶ 浏览一致）", () => {
		const a = card({ id: "a", excerptText: "甲" });
		const b = card({ id: "b", excerptText: "乙" });
		const rows = buildSessionRows([a, b], "queue");
		expect(rows.map((r) => r.index)).toEqual([0, 1]);
		expect(rows.map((r) => r.card.id)).toEqual(["a", "b"]);
	});

	it("document 序：同书按 page 升序，无页码殿后，自由卡片（null 文档）最后；同页按首矩形 y", () => {
		const queue = [
			card({ id: "free1" }), // 自由卡片
			card({ id: "p3", documentId: "d1", page: 3 }),
			card({ id: "nopage", documentId: "d1", page: null }),
			card({
				id: "p1-low",
				documentId: "d1",
				page: 1,
				rects: [{ x: 0, y: 0.8, w: 0.2, h: 0.02 }],
			}),
			card({
				id: "p1-high",
				documentId: "d1",
				page: 1,
				rects: [{ x: 0, y: 0.2, w: 0.2, h: 0.02 }],
			}),
			card({ id: "d2p1", documentId: "d2", page: 1 }),
		];
		const rows = buildSessionRows(queue, "document");
		expect(rows.map((r) => r.card.id)).toEqual([
			"p1-high", // d1 页 1 上方
			"p1-low", // d1 页 1 下方
			"p3", // d1 页 3
			"nopage", // d1 无页码（同书殿后）
			"d2p1", // d2 页 1（按文档 id 分组聚拢）
			"free1", // 自由卡片最后
		]);
	});

	it("document 序书籍分组：documentId 字典序聚拢（自由卡片恒最后）", () => {
		const queue = [
			card({ id: "b", documentId: "dz", page: 1 }),
			card({ id: "a", documentId: "da", page: 2 }),
		];
		expect(buildSessionRows(queue, "document").map((r) => r.card.id)).toEqual(["a", "b"]);
	});

	it("text 序：标题 → 批注 → 摘录取文本 localeCompare 拼音序，空文本排前，次键队列下标保稳定", () => {
		const queue = [
			card({ id: "zhi", title: "知识" }),
			card({ id: "bei", note: "北京" }),
			card({ id: "empty", excerptText: "" }), // 无标题无批注摘录空
			card({ id: "anh", excerptText: "安徽" }),
			card({ id: "dup1", title: "同" }),
			card({ id: "dup2", title: "同" }),
		];
		const rows = buildSessionRows(queue, "text");
		expect(rows.map((r) => r.card.id)).toEqual([
			"empty", // "" 最小排前
			"anh",
			"bei",
			"dup1", // 同键下标稳定
			"dup2",
			"zhi",
		]);
	});

	it("sessionRowTitle：标题 > 批注 > 摘录 > 空串（视图层用形态占位兜底）", () => {
		expect(sessionRowTitle(card({ title: "T", note: "N", excerptText: "E" }))).toBe("T");
		expect(sessionRowTitle(card({ note: "N", excerptText: "E" }))).toBe("N");
		expect(sessionRowTitle(card({ excerptText: "E" }))).toBe("E");
		expect(sessionRowTitle(card({ excerptType: "photo", excerptText: null }))).toBe("");
	});

	it("筛选：文档（含 null=自由卡片）与颜色（含 null=未设色）各自独立收窄，index 保留队列本体位置", () => {
		const queue = [
			card({ id: "a", documentId: "d1", color: "yellow" }),
			card({ id: "b", documentId: "d1", color: null }),
			card({ id: "c", documentId: null, color: "yellow" }),
		];
		expect(
			buildSessionRows(queue, "queue", { documentId: "d1" }).map((r) => r.card.id),
		).toEqual(["a", "b"]);
		expect(
			buildSessionRows(queue, "queue", { documentId: null }).map((r) => r.card.id),
		).toEqual(["c"]);
		expect(buildSessionRows(queue, "queue", { color: "yellow" }).map((r) => r.index)).toEqual([
			0, 2,
		]);
		expect(buildSessionRows(queue, "queue", { color: null }).map((r) => r.card.id)).toEqual([
			"b",
		]);
	});

	it("组合：筛选 + 排序叠加（先筛后序，全空结果合法返回空数组）", () => {
		const queue = [
			card({ id: "b", documentId: "d1", page: 2, color: "red" }),
			card({ id: "a", documentId: "d1", page: 1, color: "red" }),
			card({ id: "x", documentId: "d2", page: 1, color: "red" }),
		];
		expect(
			buildSessionRows(queue, "document", { documentId: "d1", color: "red" }).map(
				(r) => r.card.id,
			),
		).toEqual(["a", "b"]);
		expect(buildSessionRows(queue, "text", { documentId: "d1", color: "yellow" })).toEqual([]);
	});
});

// ---------------------------------------------------------------------------
// session 访问器（70 列表消费）：cards/gradeOf/pendingIndex
// ---------------------------------------------------------------------------

import { ReviewSession } from "../../src/review/review-session";

describe("ReviewSession 列表访问器（70）", () => {
	it("cards 只读快照 + gradeOf 逐下标档位 + pendingIndex 推进位置", () => {
		const a = card({ id: "a" });
		const b = card({ id: "b" });
		const s = new ReviewSession([a, b], () => {});
		expect(s.cards.map((c) => c.id)).toEqual(["a", "b"]);
		expect(s.pendingIndex).toBe(0);
		expect(s.gradeOf(0)).toBeUndefined();
		s.reveal();
		expect(s.grade("good")).toBe(true);
		expect(s.pendingIndex).toBe(1);
		expect(s.gradeOf(0)).toBe("good");
		expect(s.gradeOf(1)).toBeUndefined();
	});
});
