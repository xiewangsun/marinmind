import { describe, expect, it } from "vitest";
import {
	SseParser,
	buildChatRequest,
	buildChatUrl,
	estimateTokens,
	normalizeBaseUrl,
	parseChatResponse,
	parseSseDelta,
	resolveAiPreset,
	sanitizeAiCustomPrompts,
	sanitizeAiPresets,
	sanitizeAiUsage,
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
