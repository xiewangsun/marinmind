/**
 * 联网搜索引擎纯函数层（128 AI 联网后备）——插件侧搜索 API 的引擎注册表 /
 * 请求构造 / 响应解析 / RAG 拼接。零 obsidian 依赖（vitest 覆盖），网络调用在
 * web-search-service。
 *
 * 定位：105 批厂商自带搜索（智谱 web_search / OpenAI search-preview /
 * perplexity sonar）的**后备**——普通端点（DeepSeek 等）无法联网时，插件先经
 * 搜索 API 取回资料、以 RAG 形态拼进 prompt（【联网搜索资料】围栏），让任何
 * OpenAI 兼容模型都能「联网」回答。结构镜像 translate-engine 五件套：
 * id 类型 + 注册表 + 守卫 + resolve + 每引擎 buildRequest/parse。
 */

import type { WebSource } from "./ai-provider";

/** 搜索服务 id（设置 webSearchService 的合法值；off 首位 = 缺省关闭） */
export type WebSearchServiceId = "off" | "tavily" | "bocha" | "searxng";

/** 设置守卫：webSearchService 脏值归一回 off（镜像 isTranslateEngineId） */
export function isWebSearchServiceId(v: unknown): v is WebSearchServiceId {
	return v === "off" || v === "tavily" || v === "bocha" || v === "searxng";
}

/** 引擎凭据（Tavily/博查 API Key；SearXNG 为自建实例地址，免密钥） */
export interface WebSearchCredentials {
	tavilyKey: string;
	bochaKey: string;
	searxngUrl: string;
}

/** 引擎构造的网络请求描述（service 层原样交给 requestUrl；GET 无 body） */
export interface WebSearchRequestSpec {
	url: string;
	method: "GET" | "POST";
	headers: Record<string, string>;
	body?: string;
}

/** 归一后的单条搜索结果（title 可为空串——SearXNG 极简实例可能只回 url） */
export interface WebSearchResult {
	title: string;
	url: string;
	/** 内容片段（Tavily content / 博查 summary→snippet / SearXNG content） */
	snippet: string;
}

/** 引擎定义（镜像 TranslateEngineDef：一组纯函数对 + 失败提示） */
export interface WebSearchEngineDef {
	id: Exclude<WebSearchServiceId, "off">;
	label: string;
	buildRequest(query: string, cred: WebSearchCredentials): WebSearchRequestSpec;
	/** 解析响应为结果列表（防御式：脏项逐条跳过不抛；全部无效抛中文格式错） */
	parse(data: unknown): WebSearchResult[];
	networkHint: string;
}

/**
 * 解析 Tavily /search 响应：`results[]`（title/url/content，score 可缺省）。
 * 官方 JSON 结构，脏项逐条跳过；列表整体缺失/为空抛中文错。
 */
export function parseTavilyResponse(data: unknown): WebSearchResult[] {
	const list = (data as { results?: unknown } | null)?.results;
	if (!Array.isArray(list) || list.length === 0) {
		throw new Error("Tavily 响应格式异常（无 results）");
	}
	return collectResults(list, (rec) => ({
		title: rec.title,
		url: rec.url,
		snippet: rec.content,
	}));
}

const tavilyEngine: WebSearchEngineDef = {
	id: "tavily",
	label: "Tavily（需 API Key）",
	buildRequest: (query, cred) => ({
		url: "https://api.tavily.com/search",
		method: "POST",
		headers: {
			Authorization: `Bearer ${cred.tavilyKey}`,
			"Content-Type": "application/json",
		},
		body: JSON.stringify({ query, max_results: 5 }),
	}),
	parse: parseTavilyResponse,
	networkHint: "无法连接 Tavily：请检查网络与 API Key（api.tavily.com 国内通常需代理）",
};

/**
 * 解析博查 web-search 响应：`webPages.value[]`（name/url/snippet，summary
 * 开启时优先）。**双位置防御**——顶层 `webPages`（现行文档）与 `data.webPages`
 * （历史/中转包装形态）依次尝试，命中即返不混家；脏项逐条跳过。
 */
export function parseBochaResponse(data: unknown): WebSearchResult[] {
	const obj = data as {
		webPages?: { value?: unknown };
		data?: { webPages?: { value?: unknown } };
	} | null;
	const list = obj?.webPages?.value ?? obj?.data?.webPages?.value;
	if (!Array.isArray(list) || list.length === 0) {
		throw new Error("博查响应格式异常（无 webPages.value）");
	}
	return collectResults(list, (rec) => ({
		// 博查标题字段为 name；snippet 优先取 summary（请求开启时更完整的摘要）
		title: rec.name,
		url: rec.url,
		snippet: rec.summary ?? rec.snippet,
	}));
}

const bochaEngine: WebSearchEngineDef = {
	id: "bocha",
	label: "博查（需 API Key）",
	buildRequest: (query, cred) => ({
		url: "https://api.bochaai.com/v1/web-search",
		method: "POST",
		headers: {
			Authorization: `Bearer ${cred.bochaKey}`,
			"Content-Type": "application/json",
		},
		body: JSON.stringify({ query, summary: true, count: 5 }),
	}),
	parse: parseBochaResponse,
	networkHint: "无法连接博查：请检查网络与 API Key（api.bochaai.com 国内直连可用）",
};

/**
 * 解析 SearXNG json 响应：`results[]`（title/url/content）。
 * 注意实例需开启 json 输出格式（searxng 设置 search.formats 含 json），未开启
 * 时返回 HTML → JSON 解析失败走「响应格式异常」文案。
 */
export function parseSearxngResponse(data: unknown): WebSearchResult[] {
	const list = (data as { results?: unknown } | null)?.results;
	if (!Array.isArray(list) || list.length === 0) {
		throw new Error("SearXNG 响应格式异常（无 results；实例需开启 json 输出格式）");
	}
	return collectResults(list, (rec) => ({
		title: rec.title,
		url: rec.url,
		snippet: rec.content,
	}));
}

const searxngEngine: WebSearchEngineDef = {
	id: "searxng",
	label: "SearXNG（自建实例）",
	buildRequest: (query, cred) => ({
		// cred.searxngUrl 已归一去尾斜杠（resolveSearchCall）；format=json 为实例侧开关
		url: `${cred.searxngUrl}/search?q=${encodeURIComponent(query)}&format=json`,
		method: "GET",
		headers: { Accept: "application/json" },
	}),
	parse: parseSearxngResponse,
	networkHint:
		"无法连接 SearXNG：请检查实例地址可达且已开启 json 输出格式（searxng 设置 search.formats 含 json）",
};

/** 引擎注册表（与 WebSearchServiceId 非 off 项一一对应；顺序 = 设置下拉顺序） */
export const WEB_SEARCH_ENGINES: readonly WebSearchEngineDef[] = [
	tavilyEngine,
	bochaEngine,
	searxngEngine,
];

/** 一次搜索调用的引擎与凭据（resolveSearchCall 产物，service/UI 间传递） */
export interface SearchEngineCall {
	engine: WebSearchEngineDef;
	cred: WebSearchCredentials;
}

/**
 * 按设置解析引擎与凭据：服务脏值回 off（返回 null）；Tavily/博查 Key 缺失、
 * SearXNG 地址缺失抛带中文出路的 Error（镜像 resolveEngineCall——调用方
 * Notice 后返回，不进网络层）。
 */
export function resolveSearchCall(settings: {
	webSearchService?: unknown;
	webSearchTavilyKey?: unknown;
	webSearchBochaKey?: unknown;
	webSearchSearxngUrl?: unknown;
}): SearchEngineCall | null {
	const id = isWebSearchServiceId(settings.webSearchService) ? settings.webSearchService : "off";
	if (id === "off") {
		return null;
	}
	const str = (v: unknown): string => (typeof v === "string" ? v.trim() : "");
	const cred: WebSearchCredentials = {
		tavilyKey: str(settings.webSearchTavilyKey),
		bochaKey: str(settings.webSearchBochaKey),
		searxngUrl: str(settings.webSearchSearxngUrl).replace(/\/+$/, ""),
	};
	if (id === "tavily" && !cred.tavilyKey) {
		throw new Error("Tavily 需要 API Key：请先在 设置 → AI → 联网搜索服务 中填写");
	}
	if (id === "bocha" && !cred.bochaKey) {
		throw new Error("博查需要 API Key：请先在 设置 → AI → 联网搜索服务 中填写");
	}
	if (id === "searxng" && !cred.searxngUrl) {
		throw new Error("SearXNG 需要实例地址：请先在 设置 → AI → 联网搜索服务 中填写");
	}
	const engine = WEB_SEARCH_ENGINES.find((e) => e.id === id)!;
	return { engine, cred };
}

/**
 * 搜索服务就绪判定（**不抛版**，🌐 chip 点亮条件用）：off/凭据缺失/脏值
 * 一律 false——UI 只关心「RAG 后备可用吗」，出路由设置页与拦截文案引导。
 */
export function searchServiceReady(settings: {
	webSearchService?: unknown;
	webSearchTavilyKey?: unknown;
	webSearchBochaKey?: unknown;
	webSearchSearxngUrl?: unknown;
}): boolean {
	try {
		return resolveSearchCall(settings) !== null;
	} catch {
		return false;
	}
}

/** 单条 snippet 截断长度（buildWebContextText 用；中文 200 字足够定位语境） */
const SNIPPET_MAX_CHARS = 200;

/** RAG 拼接默认总量软限（~2000 字：独立于 aiMaxContextTokens，不挤占文档预算） */
export const DEFAULT_WEB_CONTEXT_CHARS = 2000;

/**
 * 搜索结果 → RAG 上下文文本（128-2 拼进【联网搜索资料】围栏的内容）：
 * 每条三行（标题 / URL / 片段截 200 字），条间空行；**总量软限**——超限即停
 * （已收条目保留，宁少勿截半条；空结果返回空串由调用方跳过注入）。
 */
export function buildWebContextText(
	results: WebSearchResult[],
	maxChars = DEFAULT_WEB_CONTEXT_CHARS,
): string {
	const blocks: string[] = [];
	let total = 0;
	for (const r of results) {
		const snippet =
			r.snippet.length > SNIPPET_MAX_CHARS
				? r.snippet.slice(0, SNIPPET_MAX_CHARS)
				: r.snippet;
		const block = `${r.title || "(无标题)"}\n${r.url}\n${snippet}`;
		if (total > 0 && total + block.length > maxChars) {
			break; // 软限：装不下整条就停（前缀保留的条目已够语境）
		}
		total += block.length;
		blocks.push(block);
	}
	return blocks.join("\n\n");
}

/** 搜索结果 → 来源 chip 形态（复用 ai-provider WebSource，与 105 厂商来源同构） */
export function toWebSources(results: WebSearchResult[]): WebSource[] {
	return results.map((r) => ({ title: r.title, url: r.url }));
}

/**
 * 响应数组 → 归一结果列表（三引擎 parse 共用兜底）：pick 指定字段、url 非空
 * 字符串才收（title/snippet 非字符串归空）；全部无效时抛中文错（与空列表
 * 同等对待——搜索「成功」但零有效结果对用户没有信息量）。
 */
function collectResults(
	list: unknown[],
	pick: (rec: Record<string, unknown>) => { title: unknown; url: unknown; snippet: unknown },
): WebSearchResult[] {
	const out: WebSearchResult[] = [];
	for (const item of list) {
		if (!item || typeof item !== "object") {
			continue; // 脏项逐条跳过（镜像 extractWebSources）
		}
		const { title, url, snippet } = pick(item as Record<string, unknown>);
		if (typeof url !== "string" || !url) {
			continue;
		}
		out.push({
			title: typeof title === "string" ? title : "",
			url,
			snippet: typeof snippet === "string" ? snippet : "",
		});
	}
	if (out.length === 0) {
		throw new Error("搜索结果为空（响应中无有效条目）");
	}
	return out;
}
