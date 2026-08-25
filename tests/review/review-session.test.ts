import { describe, expect, it, vi } from "vitest";
import { ReviewSession } from "../../src/review/review-session";
import type { Card } from "../../src/types";

/** Card 字段较多，用工厂补默认值（会话逻辑只关心 id） */
function makeCard(id: string): Card {
	return {
		id,
		documentId: null,
		page: null,
		rects: [],
		excerptType: "text",
		excerptText: `摘录-${id}`,
		excerptRef: null,
		note: null,
		color: null,
		tags: [],
		createdAt: 0,
		updatedAt: 0,
	};
}

/** 评分回调的 spy 记录（cardId, grade） 序列 */
function makeSpy() {
	return vi.fn((_cardId: string, _grade: string) => undefined);
}

describe("ReviewSession 复习会话", () => {
	it("空队列：构造即完成，current 为空，统计全 0", () => {
		const onGrade = makeSpy();
		const s = new ReviewSession([], onGrade);
		expect(s.isDone).toBe(true);
		expect(s.current).toBeUndefined();
		expect(s.remaining).toBe(0);
		expect(s.stats).toEqual({ again: 0, hard: 0, good: 0, easy: 0, total: 0 });
		expect(onGrade).not.toHaveBeenCalled();
	});

	it("good 评分推进到下一张，翻面态复位", () => {
		const onGrade = makeSpy();
		const s = new ReviewSession([makeCard("a"), makeCard("b")], onGrade);
		expect(s.current?.id).toBe("a");

		s.reveal();
		expect(s.isRevealed).toBe(true);
		expect(s.grade("good")).toBe(true);

		expect(s.current?.id).toBe("b");
		expect(s.isRevealed).toBe(false);
		expect(onGrade).toHaveBeenCalledWith("a", "good");
	});

	it("again 评分：本地队尾重现，同会话再次评分", () => {
		const onGrade = makeSpy();
		const s = new ReviewSession([makeCard("a")], onGrade);

		s.reveal();
		s.grade("again");
		// 未耗尽：again 卡回到队尾
		expect(s.isDone).toBe(false);
		expect(s.remaining).toBe(1);
		expect(s.current?.id).toBe("a");

		s.reveal();
		s.grade("good");
		expect(s.isDone).toBe(true);
		// 同一张卡两次评分，顺序 [again, good]
		expect(onGrade.mock.calls).toEqual([
			["a", "again"],
			["a", "good"],
		]);
	});

	it("统计：四档计数与总次数等于按键次数", () => {
		const onGrade = makeSpy();
		const s = new ReviewSession(
			[makeCard("a"), makeCard("b"), makeCard("c"), makeCard("d")],
			onGrade,
		);
		for (const g of ["again", "hard", "good", "easy"] as const) {
			s.reveal();
			s.grade(g);
		}
		// again 的卡已回到队尾，还需评分一次才会结束
		s.reveal();
		s.grade("good");
		expect(s.isDone).toBe(true);
		expect(s.stats).toEqual({ again: 1, hard: 1, good: 2, easy: 1, total: 5 });
	});

	it("未翻面评分无效：不推进、不计数", () => {
		const onGrade = makeSpy();
		const s = new ReviewSession([makeCard("a")], onGrade);
		expect(s.grade("good")).toBe(false);
		expect(s.current?.id).toBe("a");
		expect(s.isDone).toBe(false);
		expect(onGrade).not.toHaveBeenCalled();
		// 结束后同样无效
		s.reveal();
		s.grade("good");
		expect(s.isDone).toBe(true);
		expect(s.grade("good")).toBe(false);
		expect(s.stats.total).toBe(1);
	});
});
