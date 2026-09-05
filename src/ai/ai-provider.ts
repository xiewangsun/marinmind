/**
 * AI 服务纯函数层（96）——OpenAI 兼容 chat/completions 的请求构造 / 响应解析 /
 * SSE 流式增量解析 / token 估算 / 预设与设置的形状守卫。零 obsidian 依赖
 * （vitest 覆盖），网络调用在 ai-service。
 *
 * 96 AI 集成：全部 AI 功能经此层与 OpenAI 兼容端点对话（Base URL + API Key +
 * 模型名，支持 DeepSeek / 智谱 / OpenAI / oneapi 系中转站等）。分层完全镜像
 * translate-engine 的「构造/解析下沉纯函数、service 原样消费描述对象」结构。
 */

/** AI 模型预设（96）：一套 Base URL + Key + 模型名的组合，可配多个在设置页切换 */
export interface AiPreset {
	/** 机器 id（设置弹窗生成，newPresetId） */
	id: string;
	/** 显示名（如 "DeepSeek" / "公司中转"） */
	name: string;
	/** 服务地址，填到 /v1 层级（如 https://api.deepseek.com/v1） */
	baseUrl: string;
	apiKey: string;
	/** 模型名（如 deepseek-chat / glm-4.6 / gpt-4o-mini） */
	model: string;
}

/** 划选 AI 操作的自定义项（96）：label 进划选 AI 菜单、prompt 为对选中文字的指令 */
export interface AiCustomPrompt {
	id: string;
	label: string;
	prompt: string;
}

/** 累计用量（96，settings.aiUsage）：每次请求结束累加，防抖落盘；流式请求为估算值 */
export interface AiUsage {
	requests: number;
	promptTokens: number;
	completionTokens: number;
}

export const EMPTY_AI_USAGE: AiUsage = { requests: 0, promptTokens: 0, completionTokens: 0 };

/** 单条消息（OpenAI messages 格式） */
export interface ChatMessage {
	role: "system" | "user" | "assistant";
	content: string;
}

/** 采样参数（temperature 必填由 sendChat 按设置补默认；maxTokens 仅 ping 类调用用） */
export interface ChatSampleOptions {
	temperature: number;
	/** 输出 token 上限（不传则由服务端默认） */
	maxTokens?: number;
}

/** 请求描述对象（镜像 TranslateRequestSpec：service 原样消费，不感知预设细节） */
export interface ChatRequestSpec {
	url: string;
	method: "POST";
	headers: Record<string, string>;
	body: string;
	/** 是否流式（service 据此选 fetch+SSE 或 requestUrl 整包） */
	stream: boolean;
}

/**
 * Base URL 归一（96）：trim + 去尾部斜杠。**刻意不自动补 /v1**——中转站路径
 * 五花八门（有的挂 /api、有的裸根），自动补会拼错地址；设置页 desc 明确要求
 * 填到 /v1 层级，404 错误提示也引导到这里。
 */
export function normalizeBaseUrl(raw: string): string {
	return raw.trim().replace(/\/+$/, "");
}

/** 完整对话端点：{base}/chat/completions（OpenAI 兼容约定的路径部分） */
export function buildChatUrl(baseUrl: string): string {
	return `${normalizeBaseUrl(baseUrl)}/chat/completions`;
}

/** 构造一次对话请求描述（流式与否由调用方定；body 为 JSON 字符串） */
export function buildChatRequest(
	preset: AiPreset,
	messages: ChatMessage[],
	sample: ChatSampleOptions,
	stream: boolean,
): ChatRequestSpec {
	return {
		url: buildChatUrl(preset.baseUrl),
		method: "POST",
		headers: {
			Authorization: `Bearer ${preset.apiKey}`,
			"Content-Type": "application/json",
		},
		body: JSON.stringify({
			model: preset.model,
			messages,
			temperature: sample.temperature,
			...(stream ? { stream: true } : {}),
			...(sample.maxTokens != null ? { max_tokens: sample.maxTokens } : {}),
		}),
		stream,
	};
}

/** 非流式响应解析产物 */
export interface ChatCompletion {
	/** 回复文本（max_tokens=1 的 ping 可能空串——成功与否由 HTTP 状态判定） */
	text: string;
	/** 用量（部分中转站不回传，归 null） */
	usage: AiUsage | null;
	/** 实际使用的模型名（展示用；缺失归 null） */
	model: string | null;
}

/**
 * 解析非流式 chat/completions 响应：choices[0].message.content + usage。
 * OpenAI 兼容错误体（error.message，HTTP 200 也可能携带——部分中转站不守
 * 状态码）抛出服务端原文，由 service 前缀化；choices 缺失抛中文格式错。
 */
export function parseChatResponse(data: unknown): ChatCompletion {
	const obj = data as {
		choices?: unknown;
		usage?: { prompt_tokens?: unknown; completion_tokens?: unknown };
		model?: unknown;
		error?: { message?: unknown } | string | null;
	} | null;
	if (obj?.error) {
		const message =
			typeof obj.error === "string" ? obj.error : String(obj.error?.message ?? "");
		throw new Error(message || "AI 服务返回错误");
	}
	const choices = obj?.choices;
	const first = Array.isArray(choices)
		? (choices[0] as { message?: { content?: unknown } } | undefined)
		: undefined;
	if (!first) {
		throw new Error("AI 响应格式异常（无 choices）");
	}
	const text = typeof first.message?.content === "string" ? first.message.content : "";
	const u = obj?.usage;
	const usage: AiUsage | null =
		typeof u?.prompt_tokens === "number" || typeof u?.completion_tokens === "number"
			? {
					requests: 1,
					promptTokens: typeof u.prompt_tokens === "number" ? u.prompt_tokens : 0,
					completionTokens:
						typeof u.completion_tokens === "number" ? u.completion_tokens : 0,
				}
			: null;
	return { text, usage, model: typeof obj?.model === "string" ? obj.model : null };
}

/** SSE 单事件解析产物：content 为本轮增量（null = 无内容增量），finishReason 流结束原因 */
export interface SseDelta {
	content: string | null;
	finishReason: string | null;
}

/**
 * 单个 SSE data 载荷 → 增量内容（96）。JSON 损坏不抛（流中可能混心跳/非 JSON
 * 载荷），返回空增量由调用方跳过——单事件损坏不应中断整条流。
 */
export function parseSseDelta(data: string): SseDelta {
	try {
		const obj = JSON.parse(data) as {
			choices?: { delta?: { content?: unknown }; finish_reason?: unknown }[];
		};
		const first = Array.isArray(obj.choices) ? obj.choices[0] : undefined;
		const content = first?.delta?.content;
		return {
			content: typeof content === "string" ? content : null,
			finishReason: typeof first?.finish_reason === "string" ? first.finish_reason : null,
		};
	} catch {
		return { content: null, finishReason: null };
	}
}

/**
 * SSE 增量解析状态机（96）：feed 任意切割的网络 chunk，产出已完整结束的事件
 * data 载荷（[DONE] 哨兵原样产出，由调用方判定后停止）。
 * 按 SSE 规范处理：跨 chunk 断行（残行留 buffer）、CRLF 容差、注释行（: 开头）
 * 与 event:/id:/retry: 字段忽略、同事件多条 data: 行以 \n 拼接、空行派发。
 */
export class SseParser {
	private buffer = "";
	private dataLines: string[] = [];

	/** 喂入一个网络 chunk：返回其中已完整结束事件的 data 载荷（0 个或多个） */
	feed(chunk: string): string[] {
		this.buffer += chunk;
		const out: string[] = [];
		const lines = this.buffer.split("\n");
		// 末段可能是不完整行（chunk 边界不在行尾）——留在 buffer 等下一 chunk
		this.buffer = lines.pop() ?? "";
		for (const raw of lines) {
			this.consumeLine(raw.endsWith("\r") ? raw.slice(0, -1) : raw, out);
		}
		return out;
	}

	/** 流终止兜底：残留 buffer 当完整行消费 + 未派发 data 行合并产出（正常流以空行收尾，多为空操作） */
	flush(): string[] {
		const out: string[] = [];
		if (this.buffer !== "") {
			const line = this.buffer.endsWith("\r") ? this.buffer.slice(0, -1) : this.buffer;
			this.buffer = "";
			this.consumeLine(line, out);
		}
		if (this.dataLines.length > 0) {
			out.push(this.dataLines.join("\n"));
			this.dataLines = [];
		}
		return out;
	}

	/** 单行消费：空行派发事件、注释/非 data 字段忽略、data 值累积 */
	private consumeLine(line: string, out: string[]): void {
		if (line === "") {
			if (this.dataLines.length > 0) {
				out.push(this.dataLines.join("\n"));
				this.dataLines = [];
			}
			return;
		}
		if (line.startsWith(":")) {
			return; // 注释行（SSE 规范 : 开头，部分服务用作 keep-alive）
		}
		const colon = line.indexOf(":");
		const field = colon === -1 ? line : line.slice(0, colon);
		if (field !== "data") {
			return; // event:/id:/retry: 字段——OpenAI 兼容流不使用
		}
		let value = colon === -1 ? "" : line.slice(colon + 1);
		if (value.startsWith(" ")) {
			value = value.slice(1); // 规范允许冒号后一个可选空格
		}
		this.dataLines.push(value);
	}
}

/** token 估算的 CJK 判定区间（假名/谚文/汉字/全角符号区段合并近似） */
const CJK_RE = /[⺀-鿿豈-﫿＀-￯]/;

/**
 * token 估算（96，纯启发式）：CJK 字符按 1 token/字、其余按 4 字符/token——
 * 流式响应无 usage 回传时的用量估算（非流式精确取响应 usage）。
 */
export function estimateTokens(text: string): number {
	let cjk = 0;
	let rest = 0;
	for (const ch of text) {
		if (CJK_RE.test(ch)) {
			cjk++;
		} else {
			rest++;
		}
	}
	return cjk + Math.ceil(rest / 4);
}

/** 预设列表形状守卫（96，镜像 sanitizeWorkspaceHidden）：四字段均需非空字符串，坏项整体丢弃 */
export function sanitizeAiPresets(value: unknown): AiPreset[] {
	if (!Array.isArray(value)) {
		return [];
	}
	const out: AiPreset[] = [];
	for (const item of value) {
		const p = item as Record<string, unknown> | null;
		const id = typeof p?.id === "string" ? p.id : "";
		const name = typeof p?.name === "string" ? p.name.trim() : "";
		const baseUrl = typeof p?.baseUrl === "string" ? p.baseUrl.trim() : "";
		const apiKey = typeof p?.apiKey === "string" ? p.apiKey.trim() : "";
		const model = typeof p?.model === "string" ? p.model.trim() : "";
		if (id && name && baseUrl && apiKey && model) {
			out.push({ id, name, baseUrl, apiKey, model });
		}
	}
	return out;
}

/** 自定义 prompt 形状守卫（96）：id/label/prompt 均需非空字符串，坏项丢弃 */
export function sanitizeAiCustomPrompts(value: unknown): AiCustomPrompt[] {
	if (!Array.isArray(value)) {
		return [];
	}
	const out: AiCustomPrompt[] = [];
	for (const item of value) {
		const p = item as Record<string, unknown> | null;
		const id = typeof p?.id === "string" ? p.id : "";
		const label = typeof p?.label === "string" ? p.label.trim() : "";
		const prompt = typeof p?.prompt === "string" ? p.prompt.trim() : "";
		if (id && label && prompt) {
			out.push({ id, label, prompt });
		}
	}
	return out;
}

/** 用量形状守卫（96）：非有限数/负数归零（手编 data.json 脏值防御） */
export function sanitizeAiUsage(value: unknown): AiUsage {
	const u = value as Record<string, unknown> | null;
	const num = (v: unknown): number =>
		typeof v === "number" && Number.isFinite(v) && v > 0 ? Math.round(v) : 0;
	return {
		requests: num(u?.requests),
		promptTokens: num(u?.promptTokens),
		completionTokens: num(u?.completionTokens),
	};
}

/**
 * AI 功能调用前统一守卫（96，镜像 resolveEngineCall）：预设列表为空 / 启用项
 * 缺失时抛带中文出路的 Error（调用方 Notice 后返回，不进网络层）。
 */
export function resolveAiPreset(settings: {
	aiPresets?: unknown;
	aiActivePresetId?: unknown;
}): AiPreset {
	const presets = sanitizeAiPresets(settings.aiPresets);
	const activeId = typeof settings.aiActivePresetId === "string" ? settings.aiActivePresetId : "";
	const preset = presets.find((p) => p.id === activeId);
	if (!preset) {
		throw new Error("AI 需先配置：请到 设置 → AI 添加并启用一个模型预设");
	}
	return preset;
}

/** 新预设/自定义 prompt 的机器 id（设置弹窗用）：时间戳 36 进制 + 随机段 */
export function newAiId(prefix: string): string {
	return `${prefix}-${Date.now().toString(36)}-${Math.floor(Math.random() * 1e6).toString(36)}`;
}
