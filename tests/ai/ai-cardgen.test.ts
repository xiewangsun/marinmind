import { describe, expect, it } from "vitest";
import {
	CARDGEN_MAX,
	buildCardgenMessages,
	cardgenTitle,
	parseCardgenItems,
} from "../../src/ai/ai-cardgen";

describe("buildCardgenMessages（99 制卡）", () => {
	it("system 含 JSON 数组约束、few-shot 示例与上限；user 为材料原文", () => {
		const messages = buildCardgenMessages("学习材料");
		expect(messages).toHaveLength(2);
		expect(messages[0].role).toBe("system");
		expect(messages[0].content).toContain("JSON 数组");
		expect(messages[0].content).toContain(`至多 ${CARDGEN_MAX} 张`);
		// few-shot：qa 与 cloze 两种形态都有示例
		expect(messages[0].content).toContain('"type":"qa"');
		expect(messages[0].content).toContain('"type":"cloze"');
		expect(messages[1]).toEqual({ role: "user", content: "学习材料" });
	});
});

describe("parseCardgenItems", () => {
	it("标准输出：qa/cloze 各取其位（front/back 归一）", () => {
		const raw = JSON.stringify([
			{ type: "qa", q: "什么是间隔重复？", a: "拉长复习间隔巩固长期记忆" },
			{ type: "cloze", sentence: "贝叶斯定理描述条件概率", blank: "____定理描述条件概率" },
		]);
		const items = parseCardgenItems(raw);
		expect(items).toEqual([
			{ kind: "qa", front: "什么是间隔重复？", back: "拉长复习间隔巩固长期记忆" },
			{ kind: "cloze", front: "____定理描述条件概率", back: "贝叶斯定理描述条件概率" },
		]);
	});

	it("剥 ``` 围栏与前后杂话（parseJsonLoose 承接）", () => {
		const raw = '好的，以下是卡片：\n```json\n[{"type":"qa","q":"Q","a":"A"}]\n```\n祝学习愉快';
		expect(parseCardgenItems(raw)).toEqual([{ kind: "qa", front: "Q", back: "A" }]);
	});

	it("字段别名宽容：question/answer 与 front/back 同样受理；type 大小写不敏感", () => {
		const raw = JSON.stringify([{ type: "QA", question: "问题", answer: "答案" }]);
		expect(parseCardgenItems(raw)).toEqual([{ kind: "qa", front: "问题", back: "答案" }]);
	});

	it("cloze 缺 ____ 自动补一格（模型漏挖空的兜底）", () => {
		const raw = JSON.stringify([
			{ type: "cloze", sentence: "完整原句", blank: "挖空句没有空" },
		]);
		const items = parseCardgenItems(raw);
		expect(items[0].front).toBe("挖空句没有空____");
	});

	it("坏项逐个丢弃不整批失败：缺字段/未知 type/非对象混入", () => {
		const raw = JSON.stringify([
			{ type: "qa", q: "只有问题" }, // 缺 a → 丢
			{ type: "qa", q: "Q", a: "A" }, // 有效
			"字符串项", // 非对象 → 丢
			{ type: "匹配", q: "Q", a: "A" }, // 未知 type → 丢
			{ type: "cloze", blank: "B", sentence: "S" }, // 有效
		]);
		const items = parseCardgenItems(raw);
		expect(items).toHaveLength(2);
		expect(items[0].kind).toBe("qa");
		expect(items[1].kind).toBe("cloze");
	});

	it("超 CARDGEN_MAX 截断（防模型刷出几十张）", () => {
		const list = Array.from({ length: CARDGEN_MAX + 5 }, (_, i) => ({
			type: "qa",
			q: `问题${i}`,
			a: `答案${i}`,
		}));
		const items = parseCardgenItems(JSON.stringify(list));
		expect(items).toHaveLength(CARDGEN_MAX);
		expect(items[items.length - 1].front).toBe(`问题${CARDGEN_MAX - 1}`);
	});

	it("全部无效抛中文错误（调用方 Notice 展示）", () => {
		expect(() => parseCardgenItems("[]")).toThrow(/未生成有效/);
		expect(() => parseCardgenItems("[null]")).toThrow(/未生成有效/);
	});
});

describe("cardgenTitle", () => {
	it("qa 取问题；cloze 归一 ____ 后截断；超 40 字省略", () => {
		expect(cardgenTitle({ kind: "qa", front: "问题", back: "答案" })).toBe("问题");
		expect(cardgenTitle({ kind: "cloze", front: "多________空", back: "原句" })).toBe(
			"多____空",
		);
		const long = "很".repeat(50);
		expect(cardgenTitle({ kind: "qa", front: long, back: "x" })).toBe(`${"很".repeat(40)}…`);
	});
});
