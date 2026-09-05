/**
 * 翻译网络服务（obsidian 耦合层，83 多引擎）：按 EngineCall 的引擎描述经
 * requestUrl 发请求（绕过 CORS，桌面/移动端均可用），构造/解析全部在
 * translate-engine 纯函数层（vitest 覆盖）。引擎与凭据由调用方经
 * resolveEngineCall(settings) 解析后传入；未传时缺省 Google 免密钥。
 */
import { requestUrl } from "obsidian";
import {
	defaultEngineCall,
	translateLangLabel,
	type EngineCall,
	type TranslateOutcome,
} from "./translate-engine";

/**
 * 翻译一段文本到目标语言（google 风格语言代码）；网络/服务/解析失败、
 * 引擎不支持该目标语言时抛带中文提示的 Error。
 */
export async function translateText(
	text: string,
	target: string,
	call?: EngineCall,
): Promise<TranslateOutcome> {
	const { engine, cred } = call ?? defaultEngineCall();
	const engineTarget = engine.mapTarget(target);
	if (engineTarget == null) {
		// DeepL 粤语/文言文等：目标语言在弹窗/侧栏可切换——指明出路而非笼统报错
		throw new Error(
			`${engine.label}不支持目标语言「${translateLangLabel(target)}」，请切换目标语言或引擎`,
		);
	}
	const spec = engine.buildRequest(text, engineTarget, cred);
	let response: Awaited<ReturnType<typeof requestUrl>>;
	try {
		response = await requestUrl({ ...spec, throw: false });
	} catch (err) {
		console.error("[MarinMind] 翻译请求失败", err);
		throw new Error(engine.networkHint, { cause: err });
	}
	if (response.status !== 200) {
		throw new Error(`${engine.label}返回 HTTP ${response.status}，请稍后重试`);
	}
	try {
		return engine.parse(response.json);
	} catch (err) {
		console.error("[MarinMind] 翻译响应解析失败", err);
		throw new Error(err instanceof Error ? err.message : "翻译响应解析失败", { cause: err });
	}
}
