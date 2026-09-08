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
	canCardAiComment,
	cardVisionImageRef,
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

	it("104-C 图片路径：user 为分段数组（text + image_url），system 换图片解释文案", () => {
		const messages = buildCardCommentMessages({
			title: "正态分布",
			note: "这条曲线代表什么？",
			excerptText: null,
			excerptType: "area",
			imageDataUrl: "data:image/webp;base64,AAAA",
		});
		expect(messages[0].content).toContain("图片");
		expect(messages[0].content).not.toContain("摘录了下面这段内容");
		const user = messages[1];
		if (!Array.isArray(user.content)) {
			throw new Error("图片路径 user.content 应为分段数组");
		}
		expect(user.content).toHaveLength(2);
		expect(user.content[0]).toEqual({ type: "text", text: expect.any(String) });
		expect(user.content[1]).toEqual({
			type: "image_url",
			image_url: { url: "data:image/webp;base64,AAAA" },
		});
		// 文本段含标题/批注上下文与附图指引
		const textPart = user.content[0];
		if (textPart.type !== "text") {
			throw new Error("首段应为 text");
		}
		expect(textPart.text).toContain("卡片标题：正态分布");
		expect(textPart.text).toContain("我的批注：这条曲线代表什么？");
		expect(textPart.text).toContain("附图");
	});

	it("104-C 图片路径无上下文：文本段为默认引导句", () => {
		const messages = buildCardCommentMessages({
			excerptText: null,
			excerptType: "photo",
			imageDataUrl: "data:image/webp;base64,BBBB",
		});
		const user = messages[1];
		if (!Array.isArray(user.content) || user.content[0].type !== "text") {
			throw new Error("user.content 应为 text 起头的分段数组");
		}
		expect(user.content[0].text).toContain("摘录图片");
	});

	it("104-C audio 路径：批注作摘录材料且不重复进上下文行，system 含录音措辞", () => {
		const messages = buildCardCommentMessages({
			title: "口语课",
			note: "老师讲了连读规则",
			excerptText: null,
			excerptType: "audio",
		});
		expect(messages[0].content).toContain("录音");
		expect(messages[1].content).toContain("卡片标题：口语课");
		expect(messages[1].content).toContain("摘录内容：老师讲了连读规则");
		// 批注即材料本体：不再出现「我的批注：」行（防同一段文字两次）
		expect(messages[1].content).not.toContain("我的批注：");
	});

	it("104-C audio 有 excerptText 时走纯文本路径（防御：不误判 audio）", () => {
		const messages = buildCardCommentMessages({
			note: "批注",
			excerptText: "已转写的文字",
			excerptType: "audio",
		});
		expect(messages[0].content).not.toContain("录音");
		expect(messages[1].content).toContain("摘录内容：已转写的文字");
		expect(messages[1].content).toContain("我的批注：批注");
	});
});

describe("canCardAiComment / cardVisionImageRef（104-C 入口判定）", () => {
	it("有摘录文字恒可（text/blank/已 OCR 的区域）", () => {
		expect(canCardAiComment({ excerptType: "text", excerptText: "内容" })).toBe(true);
		expect(canCardAiComment({ excerptType: "blank", excerptText: "留白" })).toBe(true);
		expect(
			canCardAiComment({ excerptType: "area", excerptText: "OCR 文字", excerptRef: null }),
		).toBe(true);
	});

	it("图片类摘录：带附件引用即可（无文字也行），缺引用不可", () => {
		expect(
			canCardAiComment({
				excerptType: "area",
				excerptText: null,
				excerptRef: "assets/a.webp",
			}),
		).toBe(true);
		expect(
			canCardAiComment({
				excerptType: "lasso",
				excerptText: null,
				excerptRef: "assets/b.png",
			}),
		).toBe(true);
		expect(
			canCardAiComment({
				excerptType: "handwriting",
				excerptText: null,
				excerptRef: "assets/c.png",
			}),
		).toBe(true);
		expect(
			canCardAiComment({
				excerptType: "photo",
				excerptText: null,
				excerptRef: "assets/d.webp",
			}),
		).toBe(true);
		expect(canCardAiComment({ excerptType: "area", excerptText: null, excerptRef: null })).toBe(
			false,
		);
		expect(
			canCardAiComment({ excerptType: "photo", excerptText: null, excerptRef: "  " }),
		).toBe(false);
	});

	it("audio：有批注即可、无批注不可；其他无文字无附件类型不可", () => {
		expect(canCardAiComment({ excerptType: "audio", excerptText: null, note: "批注" })).toBe(
			true,
		);
		expect(canCardAiComment({ excerptType: "audio", excerptText: null, note: null })).toBe(
			false,
		);
		expect(canCardAiComment({ excerptType: "blank", excerptText: null })).toBe(false);
	});

	it("cardVisionImageRef：图片类返回归一 ref，其余 null", () => {
		expect(cardVisionImageRef({ excerptType: "lasso", excerptRef: "assets/b.png " })).toBe(
			"assets/b.png",
		);
		expect(cardVisionImageRef({ excerptType: "text", excerptRef: "assets/a.png" })).toBeNull();
		expect(
			cardVisionImageRef({ excerptType: "audio", excerptRef: "assets/x.webm" }),
		).toBeNull();
		expect(cardVisionImageRef({ excerptType: "photo", excerptRef: null })).toBeNull();
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

	it("105 联网分支：webSearch=true 换「文档 + 联网资料」文案，页码幻觉防线保留", () => {
		const messages = buildChatMessages([], "内容", "问", true);
		expect(messages[0].content).toContain("联网搜索资料");
		expect(messages[0].content).toContain("（第 N 页）");
		expect(messages[0].content).toContain("禁止编造页码");
		expect(messages[0].content).toContain("注明来源");
		// 旧文案的硬禁令措辞不出现（放宽为区分文档依据与联网资料）
		expect(messages[0].content).not.toContain("「文档中未提及」");
	});

	it("105 不传第 4 参：system 逐字等于现行文案（回归锚点）；user 消息两分支一致", () => {
		const plain = buildChatMessages([], "内容", "问")[0].content;
		expect(plain).toBe(
			"你是严谨的学习助手，依据用户提供的文档内容回答问题。要求：1) 用简体中文回答；2) 引用出处时使用「（第 N 页）」格式，且 N 只能取文档内容中已出现的页标记，禁止编造页码；3) 文档内容中没有依据的部分要明确说明「文档中未提及」，不要自行脑补；4) 直接回答，不加客套。",
		);
		expect(buildChatMessages([], "内容", "问", true).at(-1)?.content).toBe(
			buildChatMessages([], "内容", "问").at(-1)?.content,
		);
	});

	it("128 RAG 分支：webContextText 非空时资料围栏在文档围栏之前，system 复用联网版文案", () => {
		const messages = buildChatMessages([], "文档内容", "问题", false, "搜索资料文本");
		const user = messages.at(-1)?.content as string;
		expect(user).toContain("【联网搜索资料开始】\n搜索资料文本\n【联网搜索资料结束】");
		// 顺序：搜索资料围栏在文档围栏之前
		expect(user.indexOf("【联网搜索资料开始】")).toBeLessThan(user.indexOf("【文档内容开始】"));
		expect(user).toContain("我的问题：问题");
		expect(messages[0].content).toContain("联网搜索资料"); // 联网版 system
		expect(messages[0].content).not.toContain("「文档中未提及」");
	});

	it("128 RAG 分支：webSearch 与 webContextText 同时为真不冲突（同款联网版文案）；空串等价不传", () => {
		const both = buildChatMessages([], "内容", "问", true, "资料")[0].content;
		const ragOnly = buildChatMessages([], "内容", "问", false, "资料")[0].content;
		expect(both).toBe(ragOnly);
		const emptyRag = buildChatMessages([], "内容", "问", false, "");
		expect(emptyRag[0].content).toBe(buildChatMessages([], "内容", "问")[0].content);
		expect((emptyRag.at(-1)?.content as string).startsWith("【文档内容开始】")).toBe(true);
	});

	it("128 不传第 5 参：输出与旧签名逐字一致（既有断言零破坏的硬约束）", () => {
		expect(buildChatMessages([], "内容", "问", true)).toEqual(
			buildChatMessages([], "内容", "问", true, undefined),
		);
		expect(buildChatMessages([], "内容", "问")).toEqual(
			buildChatMessages([], "内容", "问", undefined, undefined),
		);
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
