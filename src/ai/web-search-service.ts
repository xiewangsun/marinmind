/**
 * 联网搜索网络服务（128 AI 联网后备，obsidian 耦合层）：按 SearchEngineCall
 * 的引擎描述经 requestUrl 发请求（throw:false 绕 CORS 异常面 + 自行判状态码，
 * 镜像 translate-service），构造/解析全部在 web-search-engine 纯函数层
 * （vitest 覆盖）。引擎与凭据由调用方经 resolveSearchCall(settings) 解析后
 * 传入；AI 对话编排（ai-chat-view）负责失败降级（Notice 后继续不联网）。
 */
import { requestUrl } from "obsidian";
import type { SearchEngineCall, WebSearchResult } from "./web-search-engine";
import { resolveSearchCall } from "./web-search-engine";

/**
 * 经插件侧搜索服务执行一次搜索：网络/服务/解析失败抛带中文提示的 Error
 * （调用方决定降级策略——ai-chat-view 失败时 Notice 后继续不联网作答）。
 */
export async function runWebSearch(
	query: string,
	call: SearchEngineCall,
): Promise<WebSearchResult[]> {
	const { engine, cred } = call;
	const spec = engine.buildRequest(query, cred);
	let response: Awaited<ReturnType<typeof requestUrl>>;
	try {
		response = await requestUrl({ ...spec, throw: false });
	} catch (err) {
		console.error("[MarinMind] 联网搜索请求失败", err);
		throw new Error(engine.networkHint, { cause: err });
	}
	if (response.status !== 200) {
		throw new Error(`${engine.label}返回 HTTP ${response.status}，请稍后重试`);
	}
	try {
		return engine.parse(response.json);
	} catch (err) {
		console.error("[MarinMind] 联网搜索响应解析失败", err);
		throw new Error(err instanceof Error ? err.message : "搜索响应解析失败", { cause: err });
	}
}

/**
 * 设置页「测试连接」：固定词 ping 一次当前搜索服务（成功 Notice 结果条数，
 * 失败抛 Error 由设置页 Notice）；off 或凭据缺失时 resolveSearchCall 的
 * null/中文 Error 原样上抛/返回 null。
 */
export async function testSearchConnection(
	settings: Parameters<typeof resolveSearchCall>[0],
): Promise<WebSearchResult[] | null> {
	const call = resolveSearchCall(settings);
	if (!call) {
		return null;
	}
	return runWebSearch("Obsidian 插件开发", call);
}
