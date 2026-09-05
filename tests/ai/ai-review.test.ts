import { describe, expect, it } from "vitest";
import {
	buildMistakeSummaryMessages,
	buildQuizMessages,
	buildReviewHintMessages,
	parseQuizDistractors,
	parseReviewHint,
	shuffleQuizOptions,
} from "../../src/ai/ai-review";

/** 造一条 system 消息纯文本（断言 prompt 约束用） */
function systemOf(messages: { role: string; content: string }[]): string {
	return messages.find((m) => m.role === "system")?.content ?? "";
}

describe("buildReviewHintMessages（101 卡壳提示）", () => {
	it("user 消息只携带问题（防泄题：答案不进请求）", () => {
		const messages = buildReviewHintMessages("什么是间隔重复？");
		expect(messages).toHaveLength(2);
		expect(messages[1].role).toBe("user");
		expect(messages[1].content).toContain("什么是间隔重复？");
		expect(messages[1].content).not.toContain("excerptText");
	});

	it("system 约束含防泄题禁令与 JSON 格式", () => {
		const sys = systemOf(buildReviewHintMessages("q"));
		expect(sys).toContain('{"hint"');
		expect(sys).toContain("严禁复述、概括、翻译或暗示答案本身");
		expect(sys).toContain("80 字");
	});
});

describe("parseReviewHint（101 提示解析三路）", () => {
	it('标准 JSON 对象 {"hint": ...} 取 hint', () => {
		expect(parseReviewHint('{"hint":"想想遗忘曲线"}')).toBe("想想遗忘曲线");
	});

	it("模型直接回纯文本提示（最常见不听话形态）整段采用", () => {
		expect(parseReviewHint("  提示：想想遗忘曲线。 ")).toBe("提示：想想遗忘曲线。");
	});

	it("JSON 数组等无 hint 结构回退裸字符串", () => {
		// parseJsonLoose 能解析出数组，但无 hint 字段 → 抛中文错（对象结构已判空）
		expect(() => parseReviewHint('["a","b"]')).toThrow("AI 未生成有效提示");
	});

	it("hint 为空白串抛中文错", () => {
		expect(() => parseReviewHint('{"hint":"  "}')).toThrow("AI 未生成有效提示");
	});

	it("剥 ```json 围栏后解析", () => {
		expect(parseReviewHint('```json\n{"hint":"方向：记忆算法"}\n```')).toBe("方向：记忆算法");
	});
});

describe("buildQuizMessages（101 干扰项请求）", () => {
	it("user 携带问题与正确答案（出题必须知道答案）", () => {
		const messages = buildQuizMessages("SM-2 的下一间隔由什么决定？", " ease 因子与评分");
		expect(messages[1].content).toContain("SM-2 的下一间隔由什么决定？");
		expect(messages[1].content).toContain("ease 因子与评分");
	});

	it("system 声明 3 个错误项 + 必须是错的", () => {
		const sys = systemOf(buildQuizMessages("q", "a"));
		expect(sys).toContain("3 个");
		expect(sys).toContain("必须是错的");
		expect(sys).toContain('{"distractors"');
	});
});

describe("parseQuizDistractors（101 干扰项解析）", () => {
	it("标准解析 + 与正确答案相同项剔除", () => {
		const raw = JSON.stringify({
			distractors: ["LSM-2 算法", "SM-2 算法", "随机数", "SM-2 算法"],
		});
		expect(parseQuizDistractors(raw, "SM-2 算法")).toEqual(["LSM-2 算法", "随机数"]);
	});

	it("非字符串项与空串剔除、去重", () => {
		const raw = JSON.stringify({ distractors: [null, "  ", "甲", "甲", "乙"] });
		expect(parseQuizDistractors(raw, "正确")).toEqual(["甲", "乙"]);
	});

	it("截断到 3 个", () => {
		const raw = JSON.stringify({ distractors: ["a", "b", "c", "d", "e"] });
		expect(parseQuizDistractors(raw, "z")).toEqual(["a", "b", "c"]);
	});

	it("全无效抛中文错", () => {
		expect(() => parseQuizDistractors('{"distractors":[]}', "正确")).toThrow(
			"AI 未生成有效的干扰项",
		);
		expect(() => parseQuizDistractors("不是 JSON", "正确")).toThrow("AI 未生成有效的干扰项");
	});

	it("裸数组（模型漏掉外层对象）也能取", () => {
		expect(parseQuizDistractors('["x","y"]', "正确")).toEqual(["x", "y"]);
	});
});

describe("shuffleQuizOptions（101 选项洗牌）", () => {
	it("注入确定性 rng 结果是原数组的排列", () => {
		const seq = [0.1, 0.5, 0.9, 0.3];
		let i = 0;
		const shuffled = shuffleQuizOptions(["甲", "乙", "丙", "丁"], () => seq[i++ % seq.length]);
		expect(shuffled.slice().sort()).toEqual(["丁", "丙", "乙", "甲"].sort());
		expect(shuffled).toHaveLength(4);
	});

	it("不修改原数组（纯函数）", () => {
		const origin = ["a", "b", "c", "d"];
		shuffleQuizOptions(origin, () => 0.42);
		expect(origin).toEqual(["a", "b", "c", "d"]);
	});

	it("同 rng 序列结果可复现", () => {
		const make = () => {
			const seq = [0.7, 0.2, 0.8];
			let i = 0;
			return () => seq[i++ % seq.length];
		};
		expect(shuffleQuizOptions([1, 2, 3, 4], make())).toEqual(
			shuffleQuizOptions([1, 2, 3, 4], make()),
		);
	});
});

describe("buildMistakeSummaryMessages（101 错题总结）", () => {
	it("条目按序编号、含答案标注", () => {
		const messages = buildMistakeSummaryMessages([
			{ question: "什么是间隔重复？", answer: "按遗忘曲线拉长的复习安排" },
			{ question: "SM-2 ease 初值？", answer: "2.5" },
		]);
		const user = messages[1].content;
		expect(user).toContain("1. 什么是间隔重复？｜答案：按遗忘曲线拉长的复习安排");
		expect(user).toContain("2. SM-2 ease 初值？｜答案：2.5");
	});

	it("长条目截断到 60 字（加省略号）且无答案条目省略答案段", () => {
		const long = "很".repeat(80);
		const messages = buildMistakeSummaryMessages([{ question: long, answer: "" }]);
		const user = messages[1].content;
		expect(user).toContain(`${"很".repeat(60)}…`);
		expect(user).not.toContain("｜答案：");
	});

	it("system 约束 300 字与简体中文", () => {
		const sys = systemOf(buildMistakeSummaryMessages([{ question: "q", answer: "a" }]));
		expect(sys).toContain("300 字");
		expect(sys).toContain("简体中文");
	});
});
