/**
 * AI 网络服务（96，obsidian 耦合层）：chat（requestUrl 非流式）与 chatStream
 * （fetch + SSE 流式，网络层异常自动降级非流式）。构造/解析全部在 ai-provider
 * 纯函数层（vitest 覆盖），镜像 translate-service 的「描述对象进、中文错误出」。
 *
 * 流式选型：obsidian.requestUrl 聚合完整响应体后才返回，结构上不可能流式——
 * 只能充当非流式通道（绕 CORS，桌面/移动端均可用）；桌面端默认 fetch + SSE
 * （OpenAI 兼容端点普遍带 Access-Control-Allow-Origin: *，官方为浏览器直连
 * 设计）。fetch 抛 TypeError（CORS 拒绝/断网特征）时自动降级 requestUrl
 * 非流式重发，模块级 flag 记住降级后本进程不再试流式（防反复试错）；
 * 设置 aiStream="off" 可从一开始就走非流式。
 */
import { requestUrl } from "obsidian";
import {
	buildChatRequest,
	estimatePromptTokens,
	estimateTokens,
	parseChatResponse,
	parseSseDelta,
	resolveAiPreset,
	SseParser,
	webSearchKind,
	type AiPreset,
	type AiUsage,
	type ChatMessage,
	type ChatSampleOptions,
	type WebSearchKind,
	type WebSource,
} from "./ai-provider";

/** sendChat 需要的设置字段子集（MarinMindSettings 结构性满足，免 service 依赖 settings 模块） */
export interface AiSettingsView {
	aiPresets?: unknown;
	aiActivePresetId?: unknown;
	aiTemperature?: unknown;
	aiStream?: unknown;
}

/** HTTP 状态 → 中文提示（AI 配置复杂度高于翻译，逐档明示排查出路） */
function httpError(status: number): Error {
	if (status === 400) {
		// 104-C / 105：无错误体的 400 兜底——最常见的失败是模型能力不匹配
		// （视觉：不支持图片输入；联网：不支持 web_search 工具/搜索参数）
		return new Error(
			"请求被服务端拒绝（HTTP 400）：若正在解释图片摘录，可能是当前模型不支持视觉输入，请在 设置 → AI 换用多模态模型（如 gpt-4o / glm-4v 系列）；若开启了联网搜索，请确认当前模型支持联网",
		);
	}
	if (status === 401) {
		return new Error("API Key 无效或已过期：请核对 设置 → AI 中的密钥");
	}
	if (status === 403) {
		return new Error("无访问权限：部分服务需实名认证或绑定支付方式后可用");
	}
	if (status === 404) {
		return new Error("接口地址或模型不存在：请检查 Base URL 是否填到 /v1 层级、模型名是否正确");
	}
	if (status === 429) {
		return new Error("请求过于频繁或额度不足：请稍后重试或检查账户余额");
	}
	return new Error(`AI 服务端异常（HTTP ${status}），请稍后重试`);
}

/** 非 2xx 时优先带出服务端 error.message（OpenAI 兼容错误体），否则按状态码映射 */
async function raiseHttpError(status: number, readJson: () => Promise<unknown>): Promise<never> {
	let serverMessage = "";
	try {
		const body = (await readJson()) as { error?: { message?: unknown } | string } | null;
		if (typeof body?.error === "string") {
			serverMessage = body.error;
		} else if (body?.error && typeof body.error.message === "string") {
			serverMessage = body.error.message;
		}
	} catch {
		// 错误体不可解析：走状态码映射
	}
	console.error(`[MarinMind] AI HTTP ${status}${serverMessage ? `：${serverMessage}` : ""}`);
	if (serverMessage) {
		throw new Error(`AI 服务错误（HTTP ${status}）：${serverMessage}`);
	}
	throw httpError(status);
}

/** chat/chatStream 的联网搜索透传项（105）：webSearch 为已识别的厂商方式，
 *  onSources 携带响应里提取到的联网来源（非流式一次、流式收尾一次） */
export interface ChatExtras {
	webSearch?: WebSearchKind;
	onSources?: (sources: WebSource[]) => void;
}

/**
 * 非流式对话（requestUrl 绕 CORS）：返回完整回复文本；onUsage 携带精确用量
 * （estimated=false；无 usage 回传的中转站不上报）。
 */
export async function chat(
	preset: AiPreset,
	messages: ChatMessage[],
	sample: ChatSampleOptions,
	onUsage?: (usage: AiUsage, estimated: boolean) => void,
	extras?: ChatExtras,
): Promise<string> {
	const spec = buildChatRequest(preset, messages, sample, false, extras?.webSearch);
	let response: Awaited<ReturnType<typeof requestUrl>>;
	try {
		response = await requestUrl({
			url: spec.url,
			method: spec.method,
			headers: spec.headers,
			body: spec.body,
			throw: false,
		});
	} catch (err) {
		console.error("[MarinMind] AI 请求失败", err);
		throw new Error("无法连接 AI 服务：请检查网络与代理设置", { cause: err });
	}
	if (response.status !== 200) {
		await raiseHttpError(response.status, async () => response.json);
	}
	try {
		const parsed = parseChatResponse(response.json);
		if (parsed.usage) {
			onUsage?.(parsed.usage, false);
		}
		if (parsed.sources.length > 0) {
			extras?.onSources?.(parsed.sources);
		}
		return parsed.text;
	} catch (err) {
		console.error("[MarinMind] AI 响应解析失败", err);
		throw err instanceof Error ? err : new Error("AI 响应解析失败");
	}
}

/** 本进程是否已判定流式不可用（CORS 拒绝等）——降级一次后不再反复试错 */
let streamDegraded = false;

/** 流式回调集合（onUsage 的 estimated=true 表示流式无 usage 回传、为估算值） */
export interface StreamCallbacks {
	onDelta?: (text: string) => void;
	onUsage?: (usage: AiUsage, estimated: boolean) => void;
	/** 流式不可用自动降级非流式时触发（调用方 Notice 一次） */
	onDegraded?: () => void;
	/** 联网来源回调（105）：流式收尾单次回调（累积去重后），与页 chip 同节奏 */
	onSources?: (sources: WebSource[]) => void;
}

/**
 * 流式对话（fetch + SSE）：onDelta 逐段喂增量，返回完整文本。fetch 网络层
 * 异常（TypeError = CORS/断网特征）自动降级 chat 非流式重发——降级路径把
 * 完整文本作为单个增量喂给 onDelta，调用方 UI 无感切换。
 * 联网来源（105）：各 chunk 的 sources 增量按 url 去重累积，流末单次回调。
 */
export async function chatStream(
	preset: AiPreset,
	messages: ChatMessage[],
	sample: ChatSampleOptions,
	cbs: StreamCallbacks,
	signal?: AbortSignal,
	extras?: ChatExtras,
): Promise<string> {
	const degrade = async (): Promise<string> => {
		// 降级非流式重发：整包一个增量；来源经 chat 的 parseChatResponse 路径回传
		const text = await chat(preset, messages, sample, cbs.onUsage, {
			webSearch: extras?.webSearch,
			onSources: cbs.onSources,
		});
		cbs.onDelta?.(text);
		return text;
	};
	if (streamDegraded) {
		// 已知不可流式：直接非流式，整包作为一个增量喂出（UI 无感）
		return degrade();
	}
	const spec = buildChatRequest(preset, messages, sample, true, extras?.webSearch);
	let response: Response;
	try {
		response = await fetch(spec.url, {
			method: spec.method,
			headers: spec.headers,
			body: spec.body,
			signal,
		});
	} catch (err) {
		if (err instanceof DOMException && err.name === "AbortError") {
			throw err; // 用户主动取消：原样上抛，调用方静默处理
		}
		// TypeError = CORS 拒绝/断网特征：降级非流式重发（整包一个增量）
		console.error("[MarinMind] AI 流式请求失败，降级非流式", err);
		streamDegraded = true;
		cbs.onDegraded?.();
		return degrade();
	}
	if (!response.ok) {
		await raiseHttpError(response.status, () => response.json());
	}
	if (!response.body) {
		// 无流式体（个别网关整包返回 200 + 非 SSE）：按整包文本兜底解析
		const raw = await response.text();
		const parsed = parseChatResponse(JSON.parse(raw));
		if (parsed.sources.length > 0) {
			cbs.onSources?.(parsed.sources);
		}
		cbs.onDelta?.(parsed.text);
		return parsed.text;
	}
	const reader = response.body.getReader();
	const decoder = new TextDecoder();
	const parser = new SseParser();
	let full = "";
	const seenUrls = new Set<string>();
	const sources: WebSource[] = [];
	const emit = (payload: string): void => {
		if (payload.trim() === "[DONE]") {
			return; // 终止哨兵：OpenAI 兼容流的收尾标记
		}
		const delta = parseSseDelta(payload);
		if (delta.content) {
			full += delta.content;
			cbs.onDelta?.(delta.content);
		}
		if (delta.sources) {
			// 来源可能分多个 chunk 到达（智谱搜索先行、perplexity 首 chunk）——累积去重
			for (const s of delta.sources) {
				if (!seenUrls.has(s.url)) {
					seenUrls.add(s.url);
					sources.push(s);
				}
			}
		}
	};
	try {
		for (;;) {
			const { done, value } = await reader.read();
			if (done) {
				break;
			}
			for (const payload of parser.feed(decoder.decode(value, { stream: true }))) {
				emit(payload);
			}
		}
		for (const payload of [...parser.feed(decoder.decode()), ...parser.flush()]) {
			emit(payload);
		}
	} catch (err) {
		if (err instanceof DOMException && err.name === "AbortError") {
			throw err; // 用户主动取消
		}
		console.error("[MarinMind] AI 流中断", err);
		throw new Error("AI 响应流中断，请重试", { cause: err });
	}
	// 联网来源流末单次回调（105）：UI 与页 chip 同节奏只渲染一次
	if (sources.length > 0) {
		cbs.onSources?.(sources);
	}
	// 流式无 usage 回传（stream_options 中转兼容性差不传）：估算上报
	cbs.onUsage?.(
		{
			requests: 1,
			promptTokens: estimatePromptTokens(messages),
			completionTokens: estimateTokens(full),
		},
		true,
	);
	return full;
}

/** sendChat 可选项（全部可选；onDelta 提供且设置为 auto 时才走流式） */
export interface SendChatOptions {
	/** 输出 token 上限（测试连接等 ping 类调用用；常规功能不传） */
	maxTokens?: number;
	/** 取消信号（仅流式路径生效；requestUrl 不支持中断） */
	signal?: AbortSignal;
	/** 流式增量回调 */
	onDelta?: (text: string) => void;
	/** 流式降级通知（调用方 Notice 一次） */
	onDegraded?: () => void;
	/** 用量上报（main 聚合入 settings.aiUsage） */
	onUsage?: (usage: AiUsage, estimated: boolean) => void;
	/** 开启联网搜索（105，仅 AI 助手用）：不支持的预设在此抛中文引导 */
	webSearch?: boolean;
	/** 联网来源回调（105）：非流式一次 / 流式收尾一次 */
	onSources?: (sources: WebSource[]) => void;
}

/**
 * 功能层统一入口（96）：resolveAiPreset 守卫（未配置抛中文错）+ 按设置路由
 * 流式/非流式。所有 AI 功能都从这里进——单一入口保证守卫与温度一致。
 * 105：webSearch 开启时识别厂商搜索方式，不支持联网的模型抛中文引导
 * （视图层发送前已前置拦截，此路径为未来调用方的防御）。
 */
export async function sendChat(
	settings: AiSettingsView,
	messages: ChatMessage[],
	opts: SendChatOptions = {},
): Promise<string> {
	const preset = resolveAiPreset(settings);
	let webSearch: WebSearchKind | undefined;
	if (opts.webSearch) {
		const kind = webSearchKind(preset);
		if (!kind) {
			throw new Error(
				"当前模型不支持联网搜索：请到 设置 → AI 换用 GLM（glm-*）、gpt-4o-search-preview 或 sonar 系列模型",
			);
		}
		webSearch = kind;
	}
	const extras: ChatExtras | undefined = opts.webSearch
		? { webSearch, onSources: opts.onSources }
		: undefined;
	const temperature =
		typeof settings.aiTemperature === "number" && Number.isFinite(settings.aiTemperature)
			? Math.min(2, Math.max(0, settings.aiTemperature))
			: 0.3;
	const sample: ChatSampleOptions = {
		temperature,
		...(opts.maxTokens != null ? { maxTokens: opts.maxTokens } : {}),
	};
	const streamMode = settings.aiStream === "off" ? "off" : "auto";
	if (streamMode === "off" || !opts.onDelta) {
		return chat(preset, messages, sample, opts.onUsage, extras);
	}
	return chatStream(
		preset,
		messages,
		sample,
		{ onDelta: opts.onDelta, onUsage: opts.onUsage, onDegraded: opts.onDegraded },
		opts.signal,
		extras,
	);
}

/**
 * 测试连接（96，设置页按钮）：max_tokens=1 的 ping 走非流式最稳路径，
 * 成功返回实际使用的模型名（成功 Notice 展示）。未配置预设由 resolveAiPreset
 * 抛中文错，调用方 Notice。
 */
export async function testAiConnection(settings: AiSettingsView): Promise<string> {
	const preset = resolveAiPreset(settings);
	await chat(preset, [{ role: "user", content: "ping" }], { temperature: 0, maxTokens: 1 });
	return preset.model;
}
