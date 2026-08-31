/**
 * 翻译网络服务（obsidian 耦合层）：经 requestUrl 调 Google 免费翻译接口
 * （client=gtx 免密钥、sl=auto 自动检测源语言；requestUrl 绕过 CORS，
 * 桌面/移动端均可用——国内网络需代理可达 translate.googleapis.com）。
 * URL/请求体构造与响应解析在 translate-engine 纯函数层（vitest 覆盖）。
 */
import { requestUrl } from "obsidian";
import {
	buildGoogleBody,
	buildGoogleUrl,
	parseGoogleResponse,
	type TranslateOutcome,
} from "./translate-engine";

/** 翻译一段文本到目标语言；网络/服务/解析失败抛带中文提示的 Error */
export async function translateText(text: string, target: string): Promise<TranslateOutcome> {
	let response: Awaited<ReturnType<typeof requestUrl>>;
	try {
		// q 放 POST body：URL 不受长度限制，长卡片文本也一次成译
		response = await requestUrl({
			url: buildGoogleUrl(target),
			method: "POST",
			headers: { "Content-Type": "application/x-www-form-urlencoded" },
			body: buildGoogleBody(text),
			throw: false,
		});
	} catch (err) {
		console.error("[MarinMind] 翻译请求失败", err);
		throw new Error("无法连接翻译服务：请检查网络（translate.googleapis.com 国内通常需代理）");
	}
	if (response.status !== 200) {
		throw new Error(`翻译服务返回 HTTP ${response.status}，请稍后重试`);
	}
	try {
		return parseGoogleResponse(response.json);
	} catch (err) {
		console.error("[MarinMind] 翻译响应解析失败", err);
		throw new Error(err instanceof Error ? err.message : "翻译响应解析失败");
	}
}
