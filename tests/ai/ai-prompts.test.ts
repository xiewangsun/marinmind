import { describe, expect, it } from "vitest";
import {
	CHAT_HISTORY_LIMIT,
	aiActionTitle,
	buildAiActionMessages,
	buildCardCommentMessages,
	buildChatMessages,
	buildSummaryMapMessages,
	buildSummaryMessages,
	buildSummaryReduceMessages,
	type AiMenuAction,
	type ChatTurn,
} from "../../src/ai/ai-prompts";

describe("buildAiActionMessages", () => {
	it("内置三操作：system 含对应指令与输出约束，user 为选中文本", () => {
		const keywords = { explain: "解释", summarize: "要点", rewrite: "改写" } as const;
		for (const kind of Object.keys(keywords) as (keyof typeof keywords)[]) {
			const messages = buildAiActionMessages({ kind }, "被选中的内容");
			expect(messages).toHaveLength(2);
			expect(messages[0].role).toBe("system");
			expect(messages[0].content).toContain(keywords[kind]);
			expect(messages[0].content).toContain("直接输出结果本身");
			expect(messages[1]).toEqual({ role: "user", content: "被选中的内容" });
		}
	});

	it("三操作 system 互不相同（指令正文有区分度）", () => {
		const systems = (["explain", "summarize", "rewrite"] as const).map(
			(kind) => buildAiActionMessages({ kind }, "x")[0].content,
		);
		expect(new Set(systems).size).toBe(3);
	});

	it("自定义操作：system 携带指令原文并声明作用于文本", () => {
		const action: AiMenuAction = { kind: "custom", label: "出题", prompt: "出 3 道练习题" };
		const messages = buildAiActionMessages(action, "递归的定义");
		expect(messages[0].content).toContain("出 3 道练习题");
		expect(messages[0].content).toContain("以上指令作用于用户给出的文本");
		expect(messages[0].content).toContain("直接输出结果本身");
		expect(messages[1].content).toBe("递归的定义");
	});

	it("自定义指令 trim 后参与拼接（设置层已拦空白，此处兜底）", () => {
		const action: AiMenuAction = { kind: "custom", label: "润色", prompt: "  润色这段话  " };
		expect(buildAiActionMessages(action, "x")[0].content).toContain("润色这段话");
	});
});

describe("aiActionTitle", () => {
	it("内置操作 → 「AI 解释」等；自定义 → 「AI · 〈label〉」", () => {
		expect(aiActionTitle({ kind: "explain" })).toBe("AI 解释");
		expect(aiActionTitle({ kind: "summarize" })).toBe("AI 总结");
		expect(aiActionTitle({ kind: "rewrite" })).toBe("AI 改写");
		expect(aiActionTitle({ kind: "custom", label: "出题", prompt: "x" })).toBe("AI · 出题");
	});
});

describe("buildCardCommentMessages", () => {
	it("纯摘录：user 即摘录内容", () => {
		const messages = buildCardCommentMessages({ excerptText: "贝叶斯定理" });
		expect(messages[0].role).toBe("system");
		expect(messages[0].content).toContain("补充解释");
		expect(messages[1]).toEqual({ role: "user", content: "贝叶斯定理" });
	});

	it("带标题与批注：user 上下文先行、摘录殿后", () => {
		const messages = buildCardCommentMessages({
			title: "概率",
			note: "和频率学派的关系？",
			excerptText: "P(H|E) = P(E|H)P(H)/P(E)",
		});
		expect(messages[1].content).toContain("卡片标题：概率");
		expect(messages[1].content).toContain("我的批注：和频率学派的关系？");
		expect(messages[1].content).toContain("摘录内容：P(H|E) = P(E|H)P(H)/P(E)");
		// 顺序：上下文块在前，摘录在末（指令让解释聚焦摘录本身）
		expect(messages[1].content.indexOf("卡片标题")).toBeLessThan(
			messages[1].content.indexOf("摘录内容"),
		);
	});

	it("空白标题/批注不产生空上下文行", () => {
		const messages = buildCardCommentMessages({ title: "  ", note: null, excerptText: "内容" });
		expect(messages[1].content).toBe("内容");
	});
});

describe("buildChatMessages（98 文档对话）", () => {
	it("顺序：system → 历史 → 当前问题（上下文+问题在末条 user）", () => {
		const history: ChatTurn[] = [
			{ role: "user", content: "第一问" },
			{ role: "assistant", content: "第一答" },
		];
		const messages = buildChatMessages(history, "[第 1 页]\n内容", "第二问");
		expect(messages.map((m) => m.role)).toEqual(["system", "user", "assistant", "user"]);
		expect(messages[1]).toEqual({ role: "user", content: "第一问" });
		const last = messages[messages.length - 1];
		expect(last.content).toContain("【文档内容开始】");
		expect(last.content).toContain("[第 1 页]");
		expect(last.content).toContain("我的问题：第二问");
	});

	it("system 约束页码引用与拒答脑补", () => {
		const messages = buildChatMessages([], "内容", "问");
		expect(messages[0].content).toContain("（第 N 页）");
		expect(messages[0].content).toContain("禁止编造页码");
		expect(messages[0].content).toContain("文档中未提及");
	});

	it("历史超 CHAT_HISTORY_LIMIT 轮裁最旧（user/assistant 成对保留）", () => {
		const history: ChatTurn[] = [];
		for (let i = 0; i < 10; i++) {
			history.push(
				{ role: "user", content: `问${i}` },
				{ role: "assistant", content: `答${i}` },
			);
		}
		const messages = buildChatMessages(history, "内容", "新问");
		// 总消息 = system + 裁剪后历史 + 当前问题
		expect(messages).toHaveLength(1 + CHAT_HISTORY_LIMIT + 1);
		expect(messages[1].content).toBe(`问${10 - CHAT_HISTORY_LIMIT / 2}`);
	});
});

describe("buildSummary*（98 摘要）", () => {
	it("直出：一句话概括 + 要点结构要求", () => {
		const messages = buildSummaryMessages("文档内容");
		expect(messages[0].content).toContain("一句话概括");
		expect(messages[1]).toEqual({ role: "user", content: "文档内容" });
	});

	it("map：片段提炼至多 5 条且保留页标记", () => {
		const messages = buildSummaryMapMessages("片段内容");
		expect(messages[0].content).toContain("至多 5 条");
		expect(messages[0].content).toContain("[第 N 页]");
	});

	it("reduce：合并去重 + 各部分编号", () => {
		const messages = buildSummaryReduceMessages(["要点A", "要点B"]);
		expect(messages[0].content).toContain("去重");
		expect(messages[1].content).toContain("【第 1 部分】\n要点A");
		expect(messages[1].content).toContain("【第 2 部分】\n要点B");
	});
});
