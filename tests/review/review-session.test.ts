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
		deck: null,
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

describe("ReviewSession remove（会话中删卡：复习内 ⋯ 菜单 / cardBus 外部删除）", () => {
	it("删除待考卡：index 指向下一张，total/remaining 修正，后续卡可继续评分", () => {
		const onGrade = makeSpy();
		const s = new ReviewSession([makeCard("a"), makeCard("b"), makeCard("c")], onGrade);
		expect(s.remove("a")).toBe(true);
		expect(s.total).toBe(2);
		expect(s.remaining).toBe(2);
		expect(s.current?.id).toBe("b"); // index 迁移后恰指向被删卡的下一张
		expect(s.isCurrentPending).toBe(true);
		s.reveal();
		expect(s.grade("good")).toBe(true);
		expect(onGrade).toHaveBeenCalledWith("b", "good");
	});

	it("删除已评分卡：counts 事件计数保留，其他卡 gradedAt 下标整体迁移", () => {
		const onGrade = makeSpy();
		const s = new ReviewSession([makeCard("a"), makeCard("b"), makeCard("c")], onGrade);
		s.reveal();
		s.grade("good"); // a（下标 0）
		s.reveal();
		s.grade("hard"); // b（下标 1）
		expect(s.remove("a")).toBe(true);

		// counts 是已落库的事件计数，刻意保留不回退
		expect(s.stats).toEqual({ again: 0, hard: 1, good: 1, easy: 0, total: 2 });
		// graded 迁移：b 的 hard 从下标 1 前移到 0
		expect(s.goPrev()).toBe(true);
		expect(s.current?.id).toBe("b");
		expect(s.gradedAt).toBe("hard");
		// 待考卡 c 接续（index 从 2 迁移到 1）
		expect(s.goNext()).toBe(true);
		expect(s.current?.id).toBe("c");
		expect(s.isCurrentPending).toBe(true);
	});

	it("删除 index 指向的待考卡：迁移后指向下一张，不出现 index 落在已考位的错位", () => {
		const onGrade = makeSpy();
		const s = new ReviewSession([makeCard("a"), makeCard("b"), makeCard("c")], onGrade);
		s.reveal();
		s.grade("good"); // a 已考，index=1（b 待考）
		expect(s.remove("b")).toBe(true); // 删的正是待考卡
		expect(s.current?.id).toBe("c");
		expect(s.isCurrentPending).toBe(true); // c 可考，index 未落回已考的 a
	});

	it("删除 again 卡：原始实例与队尾重现实例一并消失", () => {
		const onGrade = makeSpy();
		const s = new ReviewSession([makeCard("a"), makeCard("b")], onGrade);
		s.reveal();
		s.grade("again"); // a 重现：队列 [a, b, a]，graded {0: "again"}
		expect(s.total).toBe(3);
		expect(s.remove("a")).toBe(true);
		expect(s.total).toBe(1);
		expect(s.includes("a")).toBe(false); // 重现实例也删净，不留幽灵卡
		expect(s.current?.id).toBe("b");
		expect(s.isCurrentPending).toBe(true);
	});

	it("删除当前浏览的待考卡：position 停原位显示下一张，翻面态复位", () => {
		const onGrade = makeSpy();
		const s = new ReviewSession([makeCard("a"), makeCard("b"), makeCard("c")], onGrade);
		s.reveal();
		expect(s.isRevealed).toBe(true);
		s.remove("a"); // 删的就是正在看（已翻面）的卡
		expect(s.current?.id).toBe("b"); // 下一张移入该槽
		expect(s.isRevealed).toBe(false);
	});

	it("删除别处的卡：不打断当前翻面态", () => {
		const onGrade = makeSpy();
		const s = new ReviewSession([makeCard("a"), makeCard("b")], onGrade);
		s.reveal();
		s.remove("b"); // 显示的 a 不受影响
		expect(s.current?.id).toBe("a");
		expect(s.isRevealed).toBe(true);
		expect(s.grade("good")).toBe(true);
	});

	it("完成屏删卡：position 钳到新 total 仍在完成屏，已考回看可用", () => {
		const onGrade = makeSpy();
		const s = new ReviewSession([makeCard("a"), makeCard("b")], onGrade);
		s.reveal();
		s.grade("good");
		s.reveal();
		s.grade("good");
		expect(s.isDone).toBe(true); // position = 2 = 完成屏
		expect(s.remove("a")).toBe(true);
		expect(s.current).toBeUndefined(); // 仍完成屏（position 钳到新 total 1）
		expect(s.canNext).toBe(false);
		expect(s.goPrev()).toBe(true); // ◀ 回看 b，graded 迁移后档位正确
		expect(s.current?.id).toBe("b");
		expect(s.gradedAt).toBe("good");
	});

	it("队列删空：total=0、isDone=true（视图走空态屏）", () => {
		const onGrade = makeSpy();
		const s = new ReviewSession([makeCard("a")], onGrade);
		expect(s.remove("a")).toBe(true);
		expect(s.total).toBe(0);
		expect(s.isDone).toBe(true);
		expect(s.remaining).toBe(0);
		expect(s.current).toBeUndefined();
	});

	it("不在会话的 id：返回 false 且状态零变化", () => {
		const onGrade = makeSpy();
		const s = new ReviewSession([makeCard("a")], onGrade);
		expect(s.remove("zzz")).toBe(false);
		expect(s.total).toBe(1);
		expect(s.remaining).toBe(1);
		expect(s.current?.id).toBe("a");
	});

	it("includes：含原始实例与 again 重现实例", () => {
		const onGrade = makeSpy();
		const s = new ReviewSession([makeCard("a"), makeCard("b")], onGrade);
		expect(s.includes("a")).toBe(true);
		s.reveal();
		s.grade("again"); // a 重现
		expect(s.includes("a")).toBe(true);
		expect(s.includes("zzz")).toBe(false);
	});
});

describe("ReviewSession 撤销评分（67：undoLast 回退会话态，DB 回退由视图快照栈负责）", () => {
	it("good 全回退：计数/graded/index/position/翻面态一并复原，落回被撤销卡重新作答", () => {
		const onGrade = makeSpy();
		const s = new ReviewSession([makeCard("a"), makeCard("b")], onGrade);
		s.reveal();
		expect(s.grade("good")).toBe(true); // a：index 0→1
		expect(s.undoDepth).toBe(1);

		const step = s.undoLast();
		expect(step).toEqual({ cardId: "a", grade: "good", index: 0, requeued: false });
		expect(s.current?.id).toBe("a"); // 落回被撤销卡
		expect(s.isCurrentPending).toBe(true); // 待考态重新作答
		expect(s.isRevealed).toBe(false);
		expect(s.gradedAt).toBeUndefined();
		expect(s.stats).toEqual({ again: 0, hard: 0, good: 0, easy: 0, total: 0 });
		expect(s.undoDepth).toBe(0);
		// 重评不同档位覆盖：改评 = 撤销后重评的自然组合
		s.reveal();
		expect(s.grade("easy")).toBe(true);
		expect(s.stats.total).toBe(1);
		expect(s.stats.easy).toBe(1);
	});

	it("again 撤销：队尾重现实例一并出队，total 复原", () => {
		const onGrade = makeSpy();
		const s = new ReviewSession([makeCard("a")], onGrade);
		s.reveal();
		s.grade("again");
		expect(s.total).toBe(2); // 队列 [a, a]

		expect(s.undoLast()).toEqual({ cardId: "a", grade: "again", index: 0, requeued: true });
		expect(s.total).toBe(1); // 重现实例出队
		expect(s.remaining).toBe(1);
		expect(s.stats.again).toBe(0);
	});

	it("连续撤销 again 链：评 a(again) → 评 b(good) → 评 a重现(easy) 后三步逐层回退", () => {
		const onGrade = makeSpy();
		const s = new ReviewSession([makeCard("a"), makeCard("b")], onGrade);
		s.reveal();
		s.grade("again"); // 队列 [a,b,a]，index 1
		s.reveal();
		s.grade("good"); // b，index 2
		s.reveal();
		s.grade("easy"); // a 重现实例（easy 不再重现），index 3 = 完成
		expect(s.isDone).toBe(true);

		// 撤销 3（a 重现实例的 easy）：不 requeued，队列不变，落回 index 2
		expect(s.undoLast()).toEqual({ cardId: "a", grade: "easy", index: 2, requeued: false });
		expect(s.isDone).toBe(false);
		expect(s.current?.id).toBe("a");
		// 撤销 2（b 的 good）
		expect(s.undoLast()).toEqual({ cardId: "b", grade: "good", index: 1, requeued: false });
		expect(s.current?.id).toBe("b");
		// 撤销 1（a 的 again）：重现实例出队
		expect(s.undoLast()).toEqual({ cardId: "a", grade: "again", index: 0, requeued: true });
		expect(s.total).toBe(2);
		expect(s.current?.id).toBe("a");
		expect(s.isCurrentPending).toBe(true);
		expect(s.stats).toEqual({ again: 0, hard: 0, good: 0, easy: 0, total: 0 });
		expect(s.undoDepth).toBe(0);
		expect(s.undoLast()).toBeNull(); // 空栈
	});

	it("浏览他处后撤销：position 落回被撤销卡（不看当前浏览位置）", () => {
		const onGrade = makeSpy();
		const s = new ReviewSession([makeCard("a"), makeCard("b")], onGrade);
		s.reveal();
		s.grade("good"); // index 1
		s.goPrev(); // 浏览回 a（position 0，已考只读态）

		s.undoLast();
		expect(s.positionNo).toBe(0); // 落回 step.index
		expect(s.current?.id).toBe("a");
		expect(s.isCurrentPending).toBe(true);
		expect(s.isRevealed).toBe(false);
	});

	it("requeued 防御：队尾 id 与步骤不符时还栈放弃撤销（理论不可达，钉住行为）", () => {
		const s = new ReviewSession([makeCard("a")], makeSpy());
		s.reveal();
		s.grade("again"); // 队列 [a, a]，栈 [{a, again, 0, requeued}]
		// 手工破坏不变量（模拟外部状态异常）：把队尾换成别的卡
		(s as unknown as { queue: Card[] }).queue[1] = makeCard("b");
		expect(s.undoLast()).toBeNull(); // 宁拒不赌
		expect(s.undoDepth).toBe(1); // 步骤原样还栈
		expect(s.stats.again).toBe(1); // 状态零回退
	});

	it("remove 清栈：删卡后撤销不可用（删除的 graded 重键破坏栈内 index 有效性）", () => {
		const s = new ReviewSession([makeCard("a"), makeCard("b")], makeSpy());
		s.reveal();
		s.grade("good");
		expect(s.undoDepth).toBe(1);
		expect(s.remove("a")).toBe(true);
		expect(s.undoDepth).toBe(0);
		expect(s.undoLast()).toBeNull();
	});

	it("栈深截断 20：第 21 次评分丢弃最旧步骤，仍可连续撤销 20 次", () => {
		const cards = Array.from({ length: 21 }, (_, i) => makeCard(`c${i}`));
		const s = new ReviewSession(cards, makeSpy());
		for (let i = 0; i < 21; i++) {
			s.reveal();
			s.grade("good");
		}
		expect(s.isDone).toBe(true);
		expect(s.undoDepth).toBe(20); // 深度上限
		for (let i = 0; i < 20; i++) {
			const step = s.undoLast();
			expect(step).not.toBeNull();
		}
		// 最旧一次（c0）已出栈不可撤销：落回的是第 2 次评分
		expect(s.positionNo).toBe(1);
		expect(s.current?.id).toBe("c1");
		expect(s.undoLast()).toBeNull();
	});

	it("goTo 浏览跳转（70 卡片列表点击用）：双向钳制 + 翻面态复位", () => {
		const s = new ReviewSession([makeCard("a"), makeCard("b"), makeCard("c")], makeSpy());
		s.goTo(2);
		expect(s.positionNo).toBe(2);
		expect(s.current?.id).toBe("c");
		s.goTo(99); // 越界钳到完成屏（total）
		expect(s.positionNo).toBe(3);
		expect(s.current).toBeUndefined();
		s.goTo(-1); // 负值钳 0
		expect(s.positionNo).toBe(0);
		// 翻面态复位：跳走再跳回不再保持翻面
		s.reveal();
		expect(s.isRevealed).toBe(true);
		s.goTo(1);
		s.goTo(0);
		expect(s.isRevealed).toBe(false);
	});
});
