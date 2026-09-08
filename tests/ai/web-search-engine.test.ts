import { describe, expect, it } from "vitest";
import {
	WEB_SEARCH_ENGINES,
	buildWebContextText,
	isWebSearchServiceId,
	parseBochaResponse,
	parseSearxngResponse,
	parseTavilyResponse,
	resolveSearchCall,
	searchServiceReady,
	toWebSources,
	type WebSearchResult,
} from "../../src/ai/web-search-engine";

/** 凭据全量形态（trim/去尾斜杠用例单独构造脏值） */
const FULL_CRED = {
	webSearchService: "tavily",
	webSearchTavilyKey: "tvly-xxx",
	webSearchBochaKey: "sk-yyy",
	webSearchSearxngUrl: "http://127.0.0.1:8080",
};

describe("注册表与守卫", () => {
	it("三引擎与 WebSearchServiceId 非 off 项一一对应，顺序 = 设置下拉顺序", () => {
		expect(WEB_SEARCH_ENGINES.map((e) => e.id)).toEqual(["tavily", "bocha", "searxng"]);
	});

	it("isWebSearchServiceId：四合法值收窄，其余拒绝", () => {
		for (const v of ["off", "tavily", "bocha", "searxng"]) {
			expect(isWebSearchServiceId(v)).toBe(true);
		}
		expect(isWebSearchServiceId("google")).toBe(false);
		expect(isWebSearchServiceId(1)).toBe(false);
		expect(isWebSearchServiceId(undefined)).toBe(false);
	});
});

describe("resolveSearchCall / searchServiceReady", () => {
	it("off 与脏值 → null；searchServiceReady 同步 false", () => {
		expect(resolveSearchCall({ ...FULL_CRED, webSearchService: "off" })).toBeNull();
		expect(resolveSearchCall({ ...FULL_CRED, webSearchService: "google" })).toBeNull();
		expect(resolveSearchCall({ webSearchService: "off" })).toBeNull();
		expect(searchServiceReady({ ...FULL_CRED, webSearchService: "off" })).toBe(false);
		expect(searchServiceReady({ webSearchService: 42 })).toBe(false);
	});

	it("tavily 就绪：Key 缺失抛中文出路 Error；searchServiceReady 不抛版 false", () => {
		const call = resolveSearchCall(FULL_CRED)!;
		expect(call.engine.id).toBe("tavily");
		expect(() => resolveSearchCall({ ...FULL_CRED, webSearchTavilyKey: " " })).toThrow(
			/Tavily 需要 API Key.*设置 → AI → 联网搜索服务/,
		);
		expect(searchServiceReady({ ...FULL_CRED, webSearchTavilyKey: "" })).toBe(false);
	});

	it("bocha / searxng 就绪：凭据缺失/地址缺失分别抛中文 Error", () => {
		expect(resolveSearchCall({ ...FULL_CRED, webSearchService: "bocha" })!.engine.id).toBe(
			"bocha",
		);
		expect(() =>
			resolveSearchCall({ ...FULL_CRED, webSearchService: "bocha", webSearchBochaKey: "" }),
		).toThrow("博查需要 API Key");
		const searx = resolveSearchCall({
			...FULL_CRED,
			webSearchService: "searxng",
			webSearchSearxngUrl: "http://192.168.1.5:8888/",
		})!;
		expect(searx.engine.id).toBe("searxng");
		expect(searx.cred.searxngUrl).toBe("http://192.168.1.5:8888"); // 去尾斜杠归一
		expect(() =>
			resolveSearchCall({
				...FULL_CRED,
				webSearchService: "searxng",
				webSearchSearxngUrl: "",
			}),
		).toThrow("SearXNG 需要实例地址");
	});

	it("凭据脏值归一：非字符串按空串（触发凭据缺失拦截而非运行时错）", () => {
		expect(() => resolveSearchCall({ ...FULL_CRED, webSearchTavilyKey: undefined })).toThrow(
			"Tavily 需要 API Key",
		);
	});
});

describe("三引擎 buildRequest + parse（官方响应 fixture）", () => {
	it("tavily：POST api.tavily.com/search Bearer + {query, max_results:5}；parse results[]", () => {
		const { engine, cred } = resolveSearchCall(FULL_CRED)!;
		const spec = engine.buildRequest("量子计算", cred);
		expect(spec.url).toBe("https://api.tavily.com/search");
		expect(spec.method).toBe("POST");
		expect(spec.headers.Authorization).toBe("Bearer tvly-xxx");
		expect(JSON.parse(spec.body!)).toEqual({ query: "量子计算", max_results: 5 });
		expect(
			parseTavilyResponse({
				results: [
					{
						title: "量子百科",
						url: "https://a.com/q",
						content: "量子计算概述",
						score: 0.9,
					},
					{ title: "新闻", url: "https://b.com/n", content: "最新进展" },
				],
			}),
		).toEqual([
			{ title: "量子百科", url: "https://a.com/q", snippet: "量子计算概述" },
			{ title: "新闻", url: "https://b.com/n", snippet: "最新进展" },
		]);
	});

	it("bocha：POST api.bochaai.com/v1/web-search Bearer + {query, summary, count}；顶层与 data 包装双形态", () => {
		const { engine, cred } = resolveSearchCall({ ...FULL_CRED, webSearchService: "bocha" })!;
		const spec = engine.buildRequest("量子计算", cred);
		expect(spec.url).toBe("https://api.bochaai.com/v1/web-search");
		expect(spec.headers.Authorization).toBe("Bearer sk-yyy");
		expect(JSON.parse(spec.body!)).toEqual({ query: "量子计算", summary: true, count: 5 });
		// 现行文档形态：顶层 webPages.value[]，summary 优先于 snippet，标题字段为 name
		const item = { name: "百科", url: "https://a.com/q", snippet: "短摘要", summary: "长摘要" };
		expect(parseBochaResponse({ code: 200, webPages: { value: [item] } })).toEqual([
			{ title: "百科", url: "https://a.com/q", snippet: "长摘要" },
		]);
		// 历史/中转包装形态：data.webPages.value[]
		expect(parseBochaResponse({ data: { webPages: { value: [item] } } })).toHaveLength(1);
	});

	it("searxng：GET {url}/search?q=…&format=json（query URL 编码）；parse results[]", () => {
		const { engine, cred } = resolveSearchCall({
			...FULL_CRED,
			webSearchService: "searxng",
			webSearchSearxngUrl: "http://127.0.0.1:8080",
		})!;
		const spec = engine.buildRequest("量子 计算&搜索", cred);
		expect(spec.method).toBe("GET");
		expect(spec.body).toBeUndefined();
		expect(spec.url).toBe(
			`http://127.0.0.1:8080/search?q=${encodeURIComponent("量子 计算&搜索")}&format=json`,
		);
		expect(
			parseSearxngResponse({
				results: [{ title: "百科", url: "https://a.com/q", content: "概述" }],
			}),
		).toEqual([{ title: "百科", url: "https://a.com/q", snippet: "概述" }]);
	});

	it("脏项跳过与空结果：url 缺失的条目丢弃；全无效/列表缺失抛中文格式错", () => {
		const dirty = [
			{ title: "有链接", url: "https://a.com/1" },
			{ title: "无链接" },
			"junk",
			null,
		];
		expect(parseTavilyResponse({ results: dirty })).toEqual([
			{ title: "有链接", url: "https://a.com/1", snippet: "" },
		]);
		expect(() => parseTavilyResponse({ results: [{ title: "无链接" }] })).toThrow(
			"搜索结果为空",
		);
		expect(() => parseTavilyResponse({})).toThrow("Tavily 响应格式异常");
		expect(() => parseBochaResponse({ webPages: {} })).toThrow("博查响应格式异常");
		expect(() => parseSearxngResponse({ results: [] })).toThrow("SearXNG 响应格式异常");
	});
});

describe("buildWebContextText / toWebSources（128 RAG 拼接）", () => {
	const results: WebSearchResult[] = [
		{ title: "百科", url: "https://a.com/q", snippet: "概述一" },
		{ title: "", url: "https://b.com/n", snippet: "概述二" },
	];

	it("每条三行（无标题占位）条间空行；toWebSources 同构 WebSource", () => {
		expect(buildWebContextText(results)).toBe(
			"百科\nhttps://a.com/q\n概述一\n\n(无标题)\nhttps://b.com/n\n概述二",
		);
		expect(toWebSources(results)).toEqual([
			{ title: "百科", url: "https://a.com/q" },
			{ title: "", url: "https://b.com/n" },
		]);
	});

	it("snippet 截 200 字 + 总量软限（装不下整条即停，不截半条）", () => {
		const long: WebSearchResult[] = [
			{ title: "长片段", url: "https://a.com/1", snippet: "x".repeat(500) },
		];
		const out = buildWebContextText(long);
		const block = out.split("\n");
		expect(block[2]).toHaveLength(200); // 500 字片段截 200
		// 软限：显式收紧 maxChars=250（第一条块 218 字符装下、加第二条超限）→ 只保留第一条
		const pair: WebSearchResult[] = [
			{ title: "一", url: "https://a.com/1", snippet: "y".repeat(300) },
			{ title: "二", url: "https://b.com/2", snippet: "z".repeat(300) },
		];
		expect(buildWebContextText(pair, 250)).not.toContain("https://b.com/2");
		// 放宽到 500（两条 + 分隔共 438）→ 两条都收
		expect(buildWebContextText(pair, 500)).toContain("https://b.com/2");
	});

	it("空结果 → 空串（调用方跳过注入）", () => {
		expect(buildWebContextText([])).toBe("");
	});
});
