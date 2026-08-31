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
		title: null,
		occlusions: [],
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

describe("ReviewSession 浏览切换（㉑：◀ ▶ 移动显示位置，评分只作用于待考卡）", () => {
	it("评分后浏览上一张：显示已考卡，翻面/评分被拒；再前进回待考卡恢复可考", () => {
		const onGrade = makeSpy();
		const s = new ReviewSession([makeCard("a"), makeCard("b")], onGrade);
		s.reveal();
		expect(s.grade("good")).toBe(true);

		// ◀ 回到第一张：已考（gradedAt 有值），不可翻面不可评分
		expect(s.goPrev()).toBe(true);
		expect(s.current?.id).toBe("a");
		expect(s.gradedAt).toBe("good");
		expect(s.isCurrentPending).toBe(false);
		s.reveal();
		expect(s.isRevealed).toBe(false);
		expect(s.grade("hard")).toBe(false);
		expect(onGrade).toHaveBeenCalledTimes(1);

		// ▶ 回到待考卡：可翻面可评分
		expect(s.goNext()).toBe(true);
		expect(s.current?.id).toBe("b");
		expect(s.isCurrentPending).toBe(true);
		s.reveal();
		expect(s.grade("easy")).toBe(true);
	});

	it("浏览边界：最前不可 ◀；可 ▶ 越过末尾到完成屏再回来", () => {
		const onGrade = makeSpy();
		const s = new ReviewSession([makeCard("a"), makeCard("b")], onGrade);
		expect(s.canPrev).toBe(false);
		expect(s.goPrev()).toBe(false);
		expect(s.canNext).toBe(true);

		// 一路 ▶ 到末尾之外 = 完成屏（current 为空）
		expect(s.goNext()).toBe(true);
		expect(s.goNext()).toBe(true);
		expect(s.current).toBeUndefined();
		expect(s.canNext).toBe(false);
		expect(s.goNext()).toBe(false);
		// 注意：浏览越过未考卡不等于评分——isDone 仍为 false，remaining 不变
		expect(s.isDone).toBe(false);
		expect(s.remaining).toBe(2);

		// ◀ 从完成屏回看
		expect(s.goPrev()).toBe(true);
		expect(s.current?.id).toBe("b");
	});

	it("完成后的会话仍可 ◀ 浏览已考卡（只读），不影响统计", () => {
		const onGrade = makeSpy();
		const s = new ReviewSession([makeCard("a")], onGrade);
		s.reveal();
		s.grade("good");
		expect(s.isDone).toBe(true);
		expect(s.current).toBeUndefined();

		expect(s.goPrev()).toBe(true);
		expect(s.current?.id).toBe("a");
		expect(s.gradedAt).toBe("good");
		expect(s.stats.total).toBe(1);
	});

	it("again 重现：原位置的卡记为已考，队尾重现实例是待考卡", () => {
		const onGrade = makeSpy();
		const s = new ReviewSession([makeCard("a"), makeCard("b")], onGrade);
		s.reveal();
		s.grade("again"); // a 到队尾
		expect(s.total).toBe(3);
		expect(s.positionNo).toBe(1);

		// ◀ 回到 a 的第一份：已考·重来
		s.goPrev();
		expect(s.current?.id).toBe("a");
		expect(s.gradedAt).toBe("again");

		// ▶▶ 到队尾重现实例：未考（gradedAt 空，但排在本该待考的 b 之后，非当前待考卡）
		s.goNext();
		s.goNext();
		expect(s.current?.id).toBe("a");
		expect(s.gradedAt).toBeUndefined();
		expect(s.isCurrentPending).toBe(false);

		// 回到待考的 b 正常评分后，a 的重现实例变为待考卡
		s.goPrev();
		expect(s.isCurrentPending).toBe(true);
		s.reveal();
		s.grade("good");
		expect(s.current?.id).toBe("a");
		expect(s.isCurrentPending).toBe(true);
	});

	it("浏览到后面的未考卡：只显示不可考（isCurrentPending=false，gradedAt 空）", () => {
		const onGrade = makeSpy();
		const s = new ReviewSession([makeCard("a"), makeCard("b")], onGrade);
		expect(s.goNext()).toBe(true);
		expect(s.current?.id).toBe("b");
		expect(s.isCurrentPending).toBe(false);
		expect(s.gradedAt).toBeUndefined();
		s.reveal();
		expect(s.isRevealed).toBe(false);
		expect(s.grade("good")).toBe(false);
		// 回到待考的 a 正常考
		s.goPrev();
		expect(s.isCurrentPending).toBe(true);
	});

	it("一路 ▶ 浏览到末尾未考完：jumpToPending 一键回到待考卡", () => {
		const onGrade = makeSpy();
		const s = new ReviewSession([makeCard("a"), makeCard("b")], onGrade);
		s.goNext();
		s.goNext();
		expect(s.current).toBeUndefined(); // 末尾屏
		expect(s.isDone).toBe(false);
		expect(s.remaining).toBe(2);
		expect(s.jumpToPending()).toBe(true);
		expect(s.current?.id).toBe("a");
		expect(s.isCurrentPending).toBe(true);
		// 已在待考位置时幂等返回 false
		expect(s.jumpToPending()).toBe(false);
	});
});
