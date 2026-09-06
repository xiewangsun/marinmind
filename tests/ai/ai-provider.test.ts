import { describe, expect, it } from "vitest";
import {
	SseParser,
	buildChatRequest,
	buildChatUrl,
	estimateImageTokens,
	estimatePromptTokens,
	estimateTokens,
	extractWebSources,
	normalizeBaseUrl,
	parseChatResponse,
	parseSseDelta,
	resolveAiPreset,
	sanitizeAiCustomPrompts,
	sanitizeAiPresets,
	sanitizeAiUsage,
	webSearchKind,
	type AiPreset,
	type ChatMessage,
} from "../../src/ai/ai-provider";

const PRESET: AiPreset = {
	id: "p1",
	name: "DeepSeek",
	baseUrl: "https://api.deepseek.com/v1",
	apiKey: "sk-test",
	model: "deepseek-chat",
};

const MESSAGES: ChatMessage[] = [
	{ role: "system", content: "你是助手" },
	{ role: "user", content: "你好" },
];

describe("normalizeBaseUrl", () => {
	it("trim 空白并去尾部斜杠（单个与多个）", () => {
		expect(normalizeBaseUrl("  https://api.deepseek.com/v1  ")).toBe(
			"https://api.deepseek.com/v1",
		);
		expect(normalizeBaseUrl("https://api.deepseek.com/v1/")).toBe(
			"https://api.deepseek.com/v1",
		);
		expect(normalizeBaseUrl("https://api.deepseek.com/v1///")).toBe(
			"https://api.deepseek.com/v1",
		);
	});

	it("刻意不自动补 /v1（中转站路径五花八门，自动补会拼错）", () => {
		expect(normalizeBaseUrl("https://gate.example.com/api")).toBe(
			"https://gate.example.com/api",
		);
	});
});

describe("buildChatUrl", () => {
	it("拼 {base}/chat/completions（OpenAI 兼容约定路径）", () => {
		expect(buildChatUrl("https://api.deepseek.com/v1/")).toBe(
			"https://api.deepseek.com/v1/chat/completions",
		);
	});
});

describe("buildChatRequest", () => {
	it("Bearer 头 + JSON 体携带 model/messages/temperature", () => {
		const spec = buildChatRequest(PRESET, MESSAGES, { temperature: 0.3 }, false);
		expect(spec.url).toBe("https://api.deepseek.com/v1/chat/completions");
		expect(spec.method).toBe("POST");
		expect(spec.headers.Authorization).toBe("Bearer sk-test");
		expect(spec.headers["Content-Type"]).toBe("application/json");
		expect(spec.stream).toBe(false);
		const body = JSON.parse(spec.body) as Record<string, unknown>;
		expect(body.model).toBe("deepseek-chat");
		expect(body.messages).toEqual(MESSAGES);
		expect(body.temperature).toBe(0.3);
		expect(body.stream).toBeUndefined();
		expect(body.max_tokens).toBeUndefined();
	});

	it("流式开关加 stream:true；maxTokens 透传 max_tokens", () => {
		const spec = buildChatRequest(PRESET, MESSAGES, { temperature: 0, maxTokens: 1 }, true);
		expect(spec.stream).toBe(true);
		const body = JSON.parse(spec.body) as Record<string, unknown>;
		expect(body.stream).toBe(true);
		expect(body.max_tokens).toBe(1);
	});

	it("104-C 视觉分段：content 为分段数组时 JSON body 原样透传（image_url 不被改写）", () => {
		const visionMessages: ChatMessage[] = [
			{ role: "system", content: "你是助手" },
			{
				role: "user",
				content: [
					{ type: "text", text: "请解释这张摘录图片" },
					{ type: "image_url", image_url: { url: "data:image/webp;base64,AAAA" } },
				],
			},
		];
		const spec = buildChatRequest(PRESET, visionMessages, { temperature: 0.3 }, true);
		const body = JSON.parse(spec.body) as { messages: ChatMessage[] };
		expect(body.messages).toEqual(visionMessages);
		// 数组形态必须逐段保真（不出现字符串化/字段重排）
		const user = body.messages[1];
		if (!Array.isArray(user.content)) {
			throw new Error("user.content 应为分段数组");
		}
		expect(user.content[1]).toEqual({
			type: "image_url",
			image_url: { url: "data:image/webp;base64,AAAA" },
		});
	});
});

describe("estimatePromptTokens / estimateImageTokens（104-C）", () => {
	it("纯文本 messages 结果 = 逐条 estimateTokens 之和（回归锚点）", () => {
		const total = estimatePromptTokens(MESSAGES);
		const sum = MESSAGES.reduce((acc, m) => acc + estimateTokens(String(m.content)), 0);
		expect(total).toBe(sum);
	});

	it("含图片分段：总量 > 纯文本部分；图片随 base64 长度单调增", () => {
		const textOnly = estimatePromptTokens([{ role: "user", content: "请解释这张摘录图片" }]);
		const withImage = estimatePromptTokens([
			{
				role: "user",
				content: [
					{ type: "text", text: "请解释这张摘录图片" },
					{
						type: "image_url",
						image_url: { url: "data:image/webp;base64," + "A".repeat(800) },
					},
				],
			},
		]);
		expect(withImage).toBeGreaterThan(textOnly);
		// 纯图消息间对比：base64 长度翻倍 → 折算字节翻倍 → 估算 token 增大
		const imageOf = (n: number): ChatMessage[] => [
			{
				role: "user",
				content: [
					{
						type: "image_url",
						image_url: { url: "data:image/webp;base64," + "A".repeat(n) },
					},
				],
			},
		];
		expect(estimatePromptTokens(imageOf(1600))).toBeGreaterThan(
			estimatePromptTokens(imageOf(800)),
		);
	});

	it("estimateImageTokens 边界：0 字节 → 0；非零向上取整", () => {
		expect(estimateImageTokens(0)).toBe(0);
		expect(estimateImageTokens(1)).toBe(1);
		expect(estimateImageTokens(800)).toBe(1);
		expect(estimateImageTokens(801)).toBe(2);
	});
});

describe("webSearchKind（105 联网能力识别）", () => {
	const presetOf = (model: string, baseUrl = "https://gate.example.com/v1"): AiPreset => ({
		...PRESET,
		model,
		baseUrl,
	});

	it("模型名优先（中转站场景唯一可靠信号）：glm/chatglm → zhipu，sonar* → perplexity，*search-preview → openai", () => {
		expect(webSearchKind(presetOf("glm-4.6"))).toBe("zhipu");
		expect(webSearchKind(presetOf("GLM-5.3"))).toBe("zhipu");
		expect(webSearchKind(presetOf("chatglm-3"))).toBe("zhipu");
		expect(webSearchKind(presetOf("sonar"))).toBe("perplexity");
		expect(webSearchKind(presetOf("sonar-pro"))).toBe("perplexity");
		expect(webSearchKind(presetOf("sonar-reasoning-pro"))).toBe("perplexity");
		expect(webSearchKind(presetOf("sonar-deep-research"))).toBe("perplexity");
		expect(webSearchKind(presetOf("gpt-4o-search-preview"))).toBe("openai");
		expect(webSearchKind(presetOf("gpt-4o-mini-search-preview"))).toBe("openai");
	});

	it("host 兜底：官方端点（bigmodel / z.ai / perplexity.ai）+ 中性模型名", () => {
		expect(webSearchKind(presetOf("my-model", "https://open.bigmodel.cn/paas/v4"))).toBe(
			"zhipu",
		);
		expect(webSearchKind(presetOf("my-model", "https://api.z.ai/v1/"))).toBe("zhipu");
		expect(webSearchKind(presetOf("my-model", "https://api.perplexity.ai"))).toBe("perplexity");
	});

	it("不支持：deepseek / gpt-4o / gpt-4.1 / o 系与无名中转站 → null", () => {
		expect(webSearchKind(presetOf("deepseek-chat", "https://api.deepseek.com/v1"))).toBeNull();
		expect(webSearchKind(presetOf("gpt-4o", "https://api.openai.com/v1"))).toBeNull();
		expect(webSearchKind(presetOf("gpt-4.1"))).toBeNull();
		expect(webSearchKind(presetOf("o3"))).toBeNull();
		expect(webSearchKind(presetOf("my-model"))).toBeNull();
	});
});

describe("buildChatRequest 联网注入（105）", () => {
	const msgs: ChatMessage[] = [{ role: "user", content: "问" }];

	it("zhipu：tools 携带 web_search 工具（search_engine 必填 + search_result 开来源）", () => {
		const spec = buildChatRequest(
			{ ...PRESET, model: "glm-4.6" },
			msgs,
			{ temperature: 0.3 },
			false,
			"zhipu",
		);
		const body = JSON.parse(spec.body) as Record<string, unknown>;
		expect(body.tools).toEqual([
			{
				type: "web_search",
				web_search: { enable: true, search_engine: "search_std", search_result: true },
			},
		]);
	});

	it("openai：注入 web_search_options；perplexity：零注入（自带搜索）", () => {
		const oai = buildChatRequest(
			{ ...PRESET, model: "gpt-4o-search-preview" },
			msgs,
			{ temperature: 0.3 },
			true,
			"openai",
		);
		expect(JSON.parse(oai.body).web_search_options).toEqual({ search_context_size: "medium" });
		const pplx = buildChatRequest(
			{ ...PRESET, model: "sonar" },
			msgs,
			{ temperature: 0.3 },
			true,
			"perplexity",
		);
		const body = JSON.parse(pplx.body) as Record<string, unknown>;
		expect(body.tools).toBeUndefined();
		expect(body.web_search_options).toBeUndefined();
	});

	it("不传 webSearch：body 无新增键（回归锚点，既有用例同款断言）", () => {
		const spec = buildChatRequest(PRESET, MESSAGES, { temperature: 0.3 }, false);
		const body = JSON.parse(spec.body) as Record<string, unknown>;
		expect(body.tools).toBeUndefined();
		expect(body.web_search_options).toBeUndefined();
	});
});

describe("extractWebSources（105 联网来源提取，经 parseChatResponse 断言）", () => {
	it("智谱顶层 web_search[]（现行 schema）：title/link 归一", () => {
		const out = parseChatResponse({
			choices: [{ message: { content: "答" } }],
			web_search: [
				{ title: "百科", link: "https://a.com/1" },
				{ title: "新闻", link: "https://b.com/2" },
			],
		});
		expect(out.sources).toEqual([
			{ title: "百科", url: "https://a.com/1" },
			{ title: "新闻", url: "https://b.com/2" },
		]);
	});

	it("智谱旧形态 message.web_search[] 同样可取；url 去重、脏数据逐项跳过", () => {
		const out = parseChatResponse({
			choices: [
				{
					message: {
						content: "答",
						web_search: [
							{ title: "同条", link: "https://a.com/1" },
							{ title: "重复", link: "https://a.com/1" },
							{ title: 123, link: "https://b.com/2" },
							"脏项",
							null,
						],
					},
				},
			],
		});
		expect(out.sources).toEqual([
			{ title: "同条", url: "https://a.com/1" },
			{ title: "", url: "https://b.com/2" }, // 非字符串 title 归空，url 有效仍收
		]);
	});

	it("perplexity：search_results 优先；仅 citations 纯 URL 数组时 title 空串", () => {
		expect(
			parseChatResponse({
				choices: [{ message: { content: "答" } }],
				search_results: [{ title: "页", url: "https://x.com" }],
			}).sources,
		).toEqual([{ title: "页", url: "https://x.com" }]);
		expect(
			parseChatResponse({
				choices: [{ message: { content: "答" } }],
				citations: ["https://y.com", 42],
			}).sources,
		).toEqual([{ title: "", url: "https://y.com" }]);
	});

	it("OpenAI message.annotations 的 url_citation；普通响应 → 空数组", () => {
		const out = parseChatResponse({
			choices: [
				{
					message: {
						content: "答",
						annotations: [
							{
								type: "url_citation",
								url_citation: {
									title: "引用",
									url: "https://z.com",
									start_index: 0,
									end_index: 5,
								},
							},
							{
								type: "别的类型",
								url_citation: { title: "异型", url: "https://w.com" },
							},
						],
					},
				},
			],
		});
		expect(out.sources).toEqual([{ title: "引用", url: "https://z.com" }]);
		expect(parseChatResponse({ choices: [{ message: { content: "答" } }] }).sources).toEqual(
			[],
		);
	});

	it("直接调用：null / 非对象入参不抛，返回空数组", () => {
		expect(extractWebSources(null)).toEqual([]);
		expect(extractWebSources("字符串")).toEqual([]);
	});
});

describe("parseSseDelta 联网来源（105）", () => {
	it("智谱 delta.web_search chunk：sources 吐出且 content 不误判", () => {
		const payload = JSON.stringify({
			choices: [{ delta: { web_search: [{ title: "来源", link: "https://s.com" }] } }],
		});
		expect(parseSseDelta(payload)).toEqual({
			content: null,
			finishReason: null,
			sources: [{ title: "来源", url: "https://s.com" }],
		});
	});

	it("OpenAI delta.annotations 与 perplexity 顶层 citations 均可提取（流式双位置防御）", () => {
		const oai = parseSseDelta(
			JSON.stringify({
				choices: [
					{
						delta: {
							annotations: [
								{
									type: "url_citation",
									url_citation: { title: "T", url: "https://o.com" },
								},
							],
						},
					},
				],
			}),
		);
		expect(oai.sources).toEqual([{ title: "T", url: "https://o.com" }]);
		const pplx = parseSseDelta(
			JSON.stringify({
				choices: [{ delta: { content: "答" } }],
				citations: ["https://p.com"],
			}),
		);
		expect(pplx.sources).toEqual([{ title: "", url: "https://p.com" }]);
		expect(pplx.content).toBe("答");
	});

	it("普通内容 chunk 不携带 sources 键（既有 toEqual 断言即回归锚点）", () => {
		const delta = parseSseDelta(JSON.stringify({ choices: [{ delta: { content: "你" } }] }));
		expect("sources" in delta).toBe(false);
	});
});

describe("parseChatResponse", () => {
	it("取 choices[0].message.content 与 usage、model", () => {
		const out = parseChatResponse({
			choices: [{ message: { content: "你好！" } }],
			usage: { prompt_tokens: 10, completion_tokens: 5 },
			model: "deepseek-chat",
		});
		expect(out.text).toBe("你好！");
		expect(out.usage).toEqual({ requests: 1, promptTokens: 10, completionTokens: 5 });
		expect(out.model).toBe("deepseek-chat");
	});

	it("缺 usage 归 null（部分中转站不回传）；ping 空内容不抛", () => {
		const out = parseChatResponse({ choices: [{ message: { content: "" } }] });
		expect(out.text).toBe("");
		expect(out.usage).toBeNull();
	});

	it("错误体（对象形态）抛服务端 message（HTTP 200 也可能携带）", () => {
		expect(() => parseChatResponse({ error: { message: "insufficient balance" } })).toThrow(
			"insufficient balance",
		);
	});

	it("错误体字符串形态与空 message 兜底", () => {
		expect(() => parseChatResponse({ error: "bad key" })).toThrow("bad key");
		expect(() => parseChatResponse({ error: {} })).toThrow("AI 服务返回错误");
	});

	it("无 choices 抛中文格式错", () => {
		expect(() => parseChatResponse({})).toThrow("AI 响应格式异常");
	});
});

describe("parseSseDelta", () => {
	it("取增量内容与结束原因", () => {
		const d = parseSseDelta(
			JSON.stringify({ choices: [{ delta: { content: "你" }, finish_reason: null }] }),
		);
		expect(d.content).toBe("你");
		expect(d.finishReason).toBeNull();
		const end = parseSseDelta(
			JSON.stringify({ choices: [{ delta: {}, finish_reason: "stop" }] }),
		);
		expect(end.content).toBeNull();
		expect(end.finishReason).toBe("stop");
	});

	it("非 JSON 载荷不抛（心跳等），返回空增量", () => {
		expect(parseSseDelta(":keep-alive")).toEqual({ content: null, finishReason: null });
		expect(parseSseDelta("not json")).toEqual({ content: null, finishReason: null });
	});
});

describe("SseParser", () => {
	it("单 chunk 多事件全部产出（OpenAI 标准形态 data:…\\n\\n）", () => {
		const parser = new SseParser();
		const out = parser.feed('data: {"a":1}\n\ndata: {"a":2}\n\ndata: [DONE]\n\n');
		expect(out).toEqual(['{"a":1}', '{"a":2}', "[DONE]"]);
	});

	it("跨 chunk 断行：一行 JSON 被切成任意两半仍正确拼接", () => {
		const parser = new SseParser();
		expect(parser.feed('data: {"choices":[{"delta":{"content":"你')).toEqual([]);
		expect(parser.feed('好"}}]}\n\n')).toEqual(['{"choices":[{"delta":{"content":"你好"}}]}']);
	});

	it("CRLF 容差（\\r\\n 行界）", () => {
		const parser = new SseParser();
		const out = parser.feed('data: {"a":1}\r\n\r\ndata: [DONE]\r\n\r\n');
		expect(out).toEqual(['{"a":1}', "[DONE]"]);
	});

	it("注释行、event:/id:/retry: 字段忽略；data 冒号后空格剥一个", () => {
		const parser = new SseParser();
		const out = parser.feed(": comment\nevent: message\nid: 1\nretry: 100\ndata: x\n\n");
		expect(out).toEqual(["x"]);
	});

	it("同事件多条 data: 行按 SSE 规范以 \\n 拼接", () => {
		const parser = new SseParser();
		const out = parser.feed("data: line1\ndata: line2\n\n");
		expect(out).toEqual(["line1\nline2"]);
	});

	it("data 值本身含冒号不被截断（首冒号定界）", () => {
		const parser = new SseParser();
		const out = parser.feed('data: {"k":"a:b"}\n\n');
		expect(out).toEqual(['{"k":"a:b"}']);
	});

	it("flush 派发残留事件（流不以空行收尾的兜底）", () => {
		const parser = new SseParser();
		expect(parser.feed('data: {"a":1}')).toEqual([]);
		expect(parser.flush()).toEqual(['{"a":1}']);
		expect(parser.flush()).toEqual([]);
	});

	it("流终止前尾行带 \\r 的 flush 处理", () => {
		const parser = new SseParser();
		expect(parser.feed("data: x\r")).toEqual([]);
		expect(parser.flush()).toEqual(["x"]);
	});
});

describe("estimateTokens", () => {
	it("空串为 0；CJK 按一字一 token", () => {
		expect(estimateTokens("")).toBe(0);
		expect(estimateTokens("你好世界")).toBe(4);
	});

	it("非 CJK 按 4 字符一 token 上取整；中英混合相加", () => {
		expect(estimateTokens("abcd")).toBe(1);
		expect(estimateTokens("abc")).toBe(1);
		expect(estimateTokens("abcde")).toBe(2);
		expect(estimateTokens("你好ab")).toBe(3);
	});
});

describe("sanitizeAiPresets", () => {
	it("非数组归空；坏项（缺字段/空串/非字符串）整体丢弃", () => {
		expect(sanitizeAiPresets(undefined)).toEqual([]);
		expect(sanitizeAiPresets("x")).toEqual([]);
		expect(
			sanitizeAiPresets([
				PRESET,
				{ id: "p2", name: "缺密钥", baseUrl: "https://x/v1", apiKey: "", model: "m" },
				{ id: "p3", name: 123, baseUrl: "https://x/v1", apiKey: "k", model: "m" },
			]),
		).toEqual([PRESET]);
	});

	it("字段 trim 后参与校验（纯空白的 name 视为缺失）", () => {
		expect(
			sanitizeAiPresets([{ id: "p", name: "  ", baseUrl: "u", apiKey: "k", model: "m" }]),
		).toEqual([]);
	});
});

describe("sanitizeAiCustomPrompts / sanitizeAiUsage", () => {
	it("自定义 prompt：三字段非空才保留", () => {
		expect(
			sanitizeAiCustomPrompts([{ id: "1", label: "润色", prompt: "改写得更通顺" }]),
		).toEqual([{ id: "1", label: "润色", prompt: "改写得更通顺" }]);
		expect(sanitizeAiCustomPrompts([{ id: "1", label: "", prompt: "x" }])).toEqual([]);
	});

	it("用量：正数取整保留、负数/非数归零", () => {
		expect(sanitizeAiUsage({ requests: 2.4, promptTokens: 100, completionTokens: -5 })).toEqual(
			{
				requests: 2,
				promptTokens: 100,
				completionTokens: 0,
			},
		);
		expect(sanitizeAiUsage(null)).toEqual({
			requests: 0,
			promptTokens: 0,
			completionTokens: 0,
		});
	});
});

describe("resolveAiPreset", () => {
	it("未配置（空列表/空 id/id 指向丢弃项）抛中文引导", () => {
		expect(() => resolveAiPreset({})).toThrow("AI 需先配置");
		expect(() => resolveAiPreset({ aiPresets: [PRESET], aiActivePresetId: "" })).toThrow(
			"AI 需先配置",
		);
		expect(() => resolveAiPreset({ aiPresets: [PRESET], aiActivePresetId: "别的" })).toThrow(
			"AI 需先配置",
		);
	});

	it("启用项命中返回该预设", () => {
		// sanitizeAiPresets 会重建对象：内容相等而非同引用
		expect(resolveAiPreset({ aiPresets: [PRESET], aiActivePresetId: "p1" })).toEqual(PRESET);
	});
});
