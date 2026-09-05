import { describe, expect, it } from "vitest";
import {
	LINK_CANDIDATE_CAP,
	buildLinkMessages,
	parseLinkSuggestions,
	type LinkCandidate,
} from "../../src/ai/ai-link";

const candidates: LinkCandidate[] = [
	{ cardId: "card-a", text: "贝叶斯定理的条件概率形式" },
	{ cardId: "card-b", text: "频率学派与贝叶斯学派的分歧" },
	{ cardId: "card-c", text: "光合作用的两个阶段" },
];

describe("buildLinkMessages（99 相关卡推荐）", () => {
	it("候选以「序号. 摘要」呈现（LLM 只见下标不见 id）；输出约束 JSON 数组", () => {
		const messages = buildLinkMessages("贝叶斯推断", candidates);
		expect(messages).toHaveLength(2);
		expect(messages[0].role).toBe("system");
		expect(messages[0].content).toContain('"index"');
		expect(messages[0].content).toContain("宁缺毋滥");
		expect(messages[1].content).toContain("当前卡片：贝叶斯推断");
		expect(messages[1].content).toContain("0. 贝叶斯定理的条件概率形式");
		expect(messages[1].content).toContain("2. 光合作用的两个阶段");
		// 防幻觉 id：真实 cardId 不进 prompt
		expect(messages[1].content).not.toContain("card-a");
	});

	it("超长候选摘要截断（token 预算保护）", () => {
		const long: LinkCandidate[] = [{ cardId: "x", text: "长".repeat(300) }];
		const content = buildLinkMessages("源", long)[1].content;
		expect(content).not.toContain("长".repeat(121));
		expect(content).toContain("…");
	});
});

describe("parseLinkSuggestions", () => {
	it("下标回映射真实 cardId：in-bounds 全收，reason 透传", () => {
		const raw = JSON.stringify([
			{ index: 0, reason: "同属贝叶斯主题" },
			{ index: 1, reason: "学派对比互为佐证" },
		]);
		const out = parseLinkSuggestions(raw, candidates);
		expect(out.map((s) => s.cardId)).toEqual(["card-a", "card-b"]);
		expect(out[0].reason).toBe("同属贝叶斯主题");
		expect(out[0].text).toBe(candidates[0].text);
	});

	it("越界/非整数/非对象下标丢弃（幻觉防御），不整批失败", () => {
		const raw = JSON.stringify([
			{ index: 0, reason: "有效" },
			{ index: 3, reason: "越界" },
			{ index: -1, reason: "负值" },
			{ index: "1", reason: "字符串下标" },
			"杂项",
			{ reason: "缺 index" },
		]);
		const out = parseLinkSuggestions(raw, candidates);
		expect(out).toHaveLength(1);
		expect(out[0].cardId).toBe("card-a");
	});

	it("重复推荐同一候选去重", () => {
		const raw = JSON.stringify([
			{ index: 0, reason: "理由一" },
			{ index: 0, reason: "理由二" },
		]);
		const out = parseLinkSuggestions(raw, candidates);
		expect(out).toHaveLength(1);
		expect(out[0].reason).toBe("理由一");
	});

	it("reason 缺省兜底「语义相关」", () => {
		const out = parseLinkSuggestions('[{"index":2}]', candidates);
		expect(out).toEqual([{ cardId: "card-c", text: candidates[2].text, reason: "语义相关" }]);
	});

	it("空数组/全部无效返回空列表不抛（宁缺毋滥的「无推荐」路径）", () => {
		expect(parseLinkSuggestions("[]", candidates)).toEqual([]);
		expect(parseLinkSuggestions("想了想没有相关的", candidates)).toEqual([]);
	});

	it("超 8 条截断（prompt 约束的兜底）", () => {
		const many: LinkCandidate[] = Array.from({ length: LINK_CANDIDATE_CAP }, (_, i) => ({
			cardId: `c${i}`,
			text: `候选${i}`,
		}));
		const raw = JSON.stringify(
			Array.from({ length: 12 }, (_, i) => ({ index: i, reason: "r" })),
		);
		expect(parseLinkSuggestions(raw, many)).toHaveLength(8);
	});
});
