/**
 * 翻译引擎纯函数层（㉔）——目标语言表 / 各引擎请求构造与响应解析 /
 * 译文留白锚点计算。零 obsidian 依赖（vitest 覆盖），网络调用在 translate-service。
 *
 * 83 多引擎：引擎注册表 TRANSLATE_ENGINES（google / baidu / youdao / deepl），
 * 每个引擎一组纯函数（mapTarget + buildRequest + parse）；Google 原独立导出
 * 函数保留（存量测试与既有语义零改动），收编为 google 引擎 def。85-B 增有道
 * （国内直连可用，经典 MD5 签名）。
 *
 * 对齐 MN4「翻译及保存译文」手册：13 种目标语言、自动检测源语言、
 * 译文存为留白（与原文并排对照）/ 复制到剪贴板。
 */
import type { DocRect } from "../types";
import { md5Hex } from "./md5";

/** 目标语言条目（MN4 内置翻译同款 13 种；code 为 Google 翻译语言代码） */
export interface TranslateLanguage {
	code: string;
	label: string;
}

export const TRANSLATE_LANGUAGES: readonly TranslateLanguage[] = [
	{ code: "zh-CN", label: "简体中文" },
	{ code: "zh-TW", label: "繁体中文" },
	{ code: "en", label: "英语" },
	{ code: "ja", label: "日语" },
	{ code: "ko", label: "韩语" },
	{ code: "fr", label: "法语" },
	{ code: "de", label: "德语" },
	{ code: "es", label: "西班牙语" },
	{ code: "it", label: "意大利语" },
	{ code: "pt", label: "葡萄牙语" },
	{ code: "ru", label: "俄语" },
	{ code: "yue", label: "粤语" },
	{ code: "lzh", label: "文言文" },
];

/** 默认目标语言（设置项 translateTarget 的兜底值） */
export const DEFAULT_TRANSLATE_TARGET = "zh-CN";

/** 单次翻译文本上限（Google 接口 q 参数约 5K 字符） */
export const MAX_TRANSLATE_CHARS = 5000;

/** 校验值是否为受支持的目标语言代码（设置读取归一用） */
export function isTranslateLangCode(v: unknown): v is string {
	return typeof v === "string" && TRANSLATE_LANGUAGES.some((l) => l.code === v);
}

/** 语言代码 → 显示名（源语言检测结果的展示用；未知代码原样返回） */
export function translateLangLabel(code: string): string {
	return TRANSLATE_LANGUAGES.find((l) => l.code === code)?.label ?? code;
}

/** Google 免费翻译接口地址（client=gtx 免密钥；sl=auto 自动检测源语言） */
export function buildGoogleUrl(target: string): string {
	return `https://translate.googleapis.com/translate_a/single?client=gtx&sl=auto&tl=${encodeURIComponent(
		target,
	)}&dt=t`;
}

/** POST 请求体：q=URL 编码的待译文本（放 body 避免长文本超出 URL 长度限制） */
export function buildGoogleBody(text: string): string {
	return `q=${encodeURIComponent(text)}`;
}

export interface TranslateOutcome {
	/** 译文（句段按序拼接） */
	text: string;
	/** 检测到的源语言代码（检测失败为 "auto"） */
	from: string;
}

/**
 * 解析 Google translate_a/single 响应：
 * 形如 [[["译文","原文",null,null,10],…],null,"en",…]——
 * 首元素为句段对数组（每段 [0]=译文），第 3 个元素为检测到的源语言。
 */
export function parseGoogleResponse(data: unknown): TranslateOutcome {
	if (!Array.isArray(data) || !Array.isArray(data[0])) {
		throw new Error("翻译响应格式异常");
	}
	const parts: string[] = [];
	for (const seg of data[0]) {
		if (Array.isArray(seg) && typeof seg[0] === "string" && seg[0]) {
			parts.push(seg[0]);
		}
	}
	const text = parts.join("");
	if (!text) {
		throw new Error("翻译结果为空");
	}
	const from = typeof data[2] === "string" ? data[2] : "auto";
	return { text, from };
}

/** 译文留白锚点尺寸（归一化，约 6px 级别——胶囊按文字自动撑开，锚点仅作定位） */
const ANCHOR_SIZE = 0.006;
/** 锚点与原文下沿的间距（页面高度的归一化比例） */
const ANCHOR_GAP = 0.012;

/**
 * 译文留白锚点：取原文矩形中最下沿者，译文胶囊锚到其正下方——
 * 与原文并排对照（MN4「添加译文到留白」同款语义）。
 * 无矩形时回退页首默认锚点（可翻译的卡必有文本，理论上矩形总在；
 * 兜底防 OCR 前置数据异常）。
 */
export function translationAnchor(sourceRects: DocRect[]): DocRect {
	if (sourceRects.length === 0) {
		return { x: 0.02, y: 0.02, w: ANCHOR_SIZE, h: ANCHOR_SIZE };
	}
	let bottom = sourceRects[0];
	for (const r of sourceRects) {
		if (r.y + r.h > bottom.y + bottom.h) {
			bottom = r;
		}
	}
	return {
		x: bottom.x,
		y: Math.min(1 - ANCHOR_SIZE, bottom.y + bottom.h + ANCHOR_GAP),
		w: ANCHOR_SIZE,
		h: ANCHOR_SIZE,
	};
}

// ---------- 多引擎注册表（83） ----------

/** 引擎 id（设置 translateEngine 的合法值；google 首位兼缺省） */
export type TranslateEngineId = "google" | "baidu" | "youdao" | "deepl";

export const TRANSLATE_ENGINE_IDS: readonly TranslateEngineId[] = [
	"google",
	"baidu",
	"youdao",
	"deepl",
];

/** 设置守卫：translateEngine 脏值归一回 google（镜像 isTranslateLangCode） */
export function isTranslateEngineId(v: unknown): v is TranslateEngineId {
	return v === "google" || v === "baidu" || v === "youdao" || v === "deepl";
}

/** 引擎凭据（百度 appid+密钥 / 有道应用ID+密钥 / DeepL Auth-Key；Google 免密钥恒空串） */
export interface TranslateCredentials {
	baiduAppid: string;
	baiduSecret: string;
	youdaoAppKey: string;
	youdaoAppSecret: string;
	deeplKey: string;
}

/** 引擎构造的网络请求描述（service 层原样交给 requestUrl） */
export interface TranslateRequestSpec {
	url: string;
	method: "POST";
	headers: Record<string, string>;
	body: string;
}

/**
 * 引擎定义：一组纯函数对——目标语言映射（不支持返回 null）、请求构造、
 * 响应解析；networkHint 用于连接失败时的分引擎提示。
 */
export interface TranslateEngineDef {
	id: TranslateEngineId;
	label: string;
	mapTarget(googleCode: string): string | null;
	buildRequest(
		text: string,
		engineTarget: string,
		cred: TranslateCredentials,
	): TranslateRequestSpec;
	parse(data: unknown): TranslateOutcome;
	networkHint: string;
}

/** Google 免费接口（㉔ 既有实现收编）：免密钥、sl=auto 自动检测 */
const googleEngine: TranslateEngineDef = {
	id: "google",
	label: "Google 翻译（免费）",
	mapTarget: (code) => code,
	buildRequest: (text, target) => ({
		url: buildGoogleUrl(target),
		method: "POST",
		headers: { "Content-Type": "application/x-www-form-urlencoded" },
		body: buildGoogleBody(text),
	}),
	parse: parseGoogleResponse,
	networkHint:
		"无法连接翻译服务：请检查网络（translate.googleapis.com 国内通常需代理，或切换百度/DeepL 引擎）",
};

/** 百度目标语言代码映射（全部 13 种目标语言均有对应；zh-TW=cht / lzh=wyw 为百度惯用缩写） */
const BAIDU_TARGETS: Record<string, string> = {
	"zh-CN": "zh",
	"zh-TW": "cht",
	en: "en",
	ja: "jp",
	ko: "kor",
	fr: "fra",
	de: "de",
	es: "spa",
	it: "it",
	pt: "pt",
	ru: "ru",
	yue: "yue",
	lzh: "wyw",
};

/** 百度源语言代码 → Google 风格代码（from 检测结果的展示统一） */
const BAIDU_FROM_LABELS: Record<string, string> = {
	zh: "zh-CN",
	cht: "zh-TW",
	en: "en",
	jp: "ja",
	kor: "ko",
	fra: "fr",
	de: "de",
	spa: "es",
	it: "it",
	pt: "pt",
	ru: "ru",
	yue: "yue",
	wyw: "lzh",
};

/**
 * 百度签名（官方规范，83）：MD5(appid + q原文 + salt + 密钥)——q 用**未编码**
 * 原文参与拼接。独立导出供 vitest 用注入 salt 直测（buildRequest 内 salt 随机）。
 */
export function buildBaiduSign(appid: string, q: string, salt: string, secret: string): string {
	return md5Hex(`${appid}${q}${salt}${secret}`);
}

/** 解析百度 translate 响应：trans_result[].dst 按序 join；error_code 非空抛中文错 */
export function parseBaiduResponse(data: unknown): TranslateOutcome {
	const obj = data as {
		trans_result?: unknown;
		from?: unknown;
		error_code?: unknown;
		error_msg?: unknown;
	} | null;
	if (
		typeof obj === "object" &&
		obj !== null &&
		(typeof obj.error_code === "string" || typeof obj.error_code === "number") &&
		obj.error_code !== ""
	) {
		// 54001 签名错误 / 58001 未开通服务等——明示 code 便于对照官方文档排查
		throw new Error(
			`百度翻译错误 ${obj.error_code}：${String(obj.error_msg ?? "请检查 appid/密钥或稍后重试")}`,
		);
	}
	const list = obj?.trans_result;
	if (!Array.isArray(list) || list.length === 0) {
		throw new Error("翻译响应格式异常");
	}
	const parts: string[] = [];
	for (const seg of list) {
		const dst = (seg as { dst?: unknown } | null)?.dst;
		if (typeof dst === "string" && dst) {
			parts.push(dst);
		}
	}
	const text = parts.join("\n");
	if (!text) {
		throw new Error("翻译结果为空");
	}
	const from = typeof obj?.from === "string" ? (BAIDU_FROM_LABELS[obj.from] ?? obj.from) : "auto";
	return { text, from };
}

const baiduEngine: TranslateEngineDef = {
	id: "baidu",
	label: "百度翻译（需凭据）",
	mapTarget: (code) => BAIDU_TARGETS[code] ?? null,
	buildRequest: (text, engineTarget, cred) => {
		// salt 随机串 + 签名（sign 用未编码 q 原文）；appid/salt 无特殊字符但统一编码防呆
		const salt = `${Date.now()}${Math.floor(Math.random() * 1000)}`;
		return {
			url: "https://fanyi.baidu.com/api/trans/vip/translate",
			method: "POST",
			headers: { "Content-Type": "application/x-www-form-urlencoded" },
			body:
				`q=${encodeURIComponent(text)}&from=auto&to=${engineTarget}` +
				`&appid=${encodeURIComponent(cred.baiduAppid)}&salt=${salt}` +
				`&sign=${buildBaiduSign(cred.baiduAppid, text, salt, cred.baiduSecret)}`,
		};
	},
	parse: parseBaiduResponse,
	networkHint: "无法连接百度翻译：请检查网络（fanyi.baidu.com 国内直连可用）",
};

// ---------- 有道智云（85-B：Google 端点国内不可达的国产替代） ----------

/** 有道目标语言代码映射（zh-CHS 简体 / zh-CHT 繁体为有道惯用；粤语/文言文不支持 → null） */
const YOUDAO_TARGETS: Record<string, string> = {
	"zh-CN": "zh-CHS",
	"zh-TW": "zh-CHT",
	en: "en",
	ja: "ja",
	ko: "ko",
	fr: "fr",
	de: "de",
	es: "es",
	it: "it",
	pt: "pt",
	ru: "ru",
};

/** 有道源语言代码 → Google 风格代码（l 字段如 "zh-CHS->en" 源段的展示统一） */
const YOUDAO_FROM_LABELS: Record<string, string> = {
	"zh-CHS": "zh-CN",
	"zh-CHT": "zh-TW",
	en: "en",
	ja: "ja",
	ko: "ko",
	fr: "fr",
	de: "de",
	es: "es",
	it: "it",
	pt: "pt",
	ru: "ru",
};

/**
 * 有道经典 MD5 签名（官方文档）：MD5(appKey + q原文全文 + salt + 应用密钥)——
 * 与百度签名同构。注意「input 截断（前10+长度+后10）+ curtime + sha256」仅属于
 * signType=v3 增强签名；经典 MD5 不传 signType/curtime/input，q **不截断**。
 * 独立导出供 vitest 注入 salt 直测（buildRequest 内 salt 随机）。
 */
export function buildYoudaoSign(appKey: string, q: string, salt: string, secret: string): string {
	return md5Hex(`${appKey}${q}${salt}${secret}`);
}

/** 有道 errorCode → 中文提示（对照官方文档常见码；兜底给通用文案） */
const YOUDAO_ERRORS: Record<string, string> = {
	"101": "缺少必填参数",
	"102": "不支持的语言类型",
	"103": "翻译文本过长",
	"108": "应用 ID 无效（请核对 appKey）",
	"110": "无服务权限（请到 ai.youdao.com 绑定「文本翻译服务」）",
	"111": "开发者账号无效",
	"202": "签名检验失败（请核对应用密钥）",
	"203": "访问 IP 不在白名单",
	"205": "请求的接口与应用类型不匹配",
	"301": "词典查询失败",
	"302": "翻译查询失败",
	"303": "服务端解析异常",
	"401": "账户已欠费",
	"411": "访问频率受限（请稍后重试）",
	"412": "请求字符数超限（长文本请分段翻译）",
};

/**
 * 解析有道文本翻译响应：translation[] 按行 join；l（"zh-CHS->en"）源段映射。
 * errorCode 成功时**不存在**（存在且非 "0" 才报错；数字/字符串形态统一 String 化）。
 */
export function parseYoudaoResponse(data: unknown): TranslateOutcome {
	const obj = data as { translation?: unknown; l?: unknown; errorCode?: unknown } | null;
	const rawCode = obj?.errorCode;
	if (rawCode !== undefined && rawCode !== null && String(rawCode) !== "0") {
		const code = String(rawCode);
		throw new Error(
			`有道翻译错误 ${code}：${YOUDAO_ERRORS[code] ?? "请检查应用凭据或稍后重试"}`,
		);
	}
	const list = obj?.translation;
	if (!Array.isArray(list) || list.length === 0) {
		throw new Error("翻译响应格式异常");
	}
	const parts: string[] = [];
	for (const seg of list) {
		if (typeof seg === "string" && seg) {
			parts.push(seg);
		}
	}
	const text = parts.join("\n");
	if (!text) {
		throw new Error("翻译结果为空");
	}
	const rawL = typeof obj?.l === "string" ? obj.l : "";
	const fromCode = rawL.split("->")[0] ?? "";
	const from = fromCode ? (YOUDAO_FROM_LABELS[fromCode] ?? fromCode) : "auto";
	return { text, from };
}

const youdaoEngine: TranslateEngineDef = {
	id: "youdao",
	label: "有道翻译（需凭据）",
	mapTarget: (code) => YOUDAO_TARGETS[code] ?? null,
	buildRequest: (text, engineTarget, cred) => {
		// salt 随机串 + 经典 MD5 签名（from=auto 自动检测；不传 signType/curtime/input）
		const salt = `${Date.now()}${Math.floor(Math.random() * 1000)}`;
		return {
			url: "https://openapi.youdao.com/api",
			method: "POST",
			headers: { "Content-Type": "application/x-www-form-urlencoded" },
			body:
				`q=${encodeURIComponent(text)}&from=auto&to=${engineTarget}` +
				`&appKey=${encodeURIComponent(cred.youdaoAppKey)}&salt=${salt}` +
				`&sign=${buildYoudaoSign(cred.youdaoAppKey, text, salt, cred.youdaoAppSecret)}`,
		};
	},
	parse: parseYoudaoResponse,
	networkHint:
		"无法连接有道翻译：请检查网络（openapi.youdao.com 国内直连可用；应用需在 ai.youdao.com 创建并绑定「文本翻译服务」）",
};

/** DeepL 目标语言映射（大写化；zh-TW/粤语/文言文不支持 → null 由调用方友好报错） */
const DEEPL_TARGETS: Record<string, string> = {
	"zh-CN": "ZH",
	en: "EN",
	ja: "JA",
	ko: "KO",
	fr: "FR",
	de: "DE",
	es: "ES",
	it: "IT",
	pt: "PT",
	ru: "RU",
};

/** DeepL 源语言（大写）→ Google 风格代码（ZH 不分简繁，展示取简体中文） */
const DEEPL_FROM_LABELS: Record<string, string> = {
	ZH: "zh-CN",
	EN: "en",
	JA: "ja",
	KO: "ko",
	FR: "fr",
	DE: "de",
	ES: "es",
	IT: "it",
	PT: "pt",
	RU: "ru",
};

/** 解析 DeepL /v2/translate 响应：translations[0].text + detected_source_language */
export function parseDeepLResponse(data: unknown): TranslateOutcome {
	const list = (data as { translations?: unknown } | null)?.translations;
	if (!Array.isArray(list) || list.length === 0) {
		throw new Error("翻译响应格式异常");
	}
	const first = list[0] as { text?: unknown; detected_source_language?: unknown } | null;
	const text = typeof first?.text === "string" ? first.text : "";
	if (!text) {
		throw new Error("翻译结果为空");
	}
	const raw =
		typeof first?.detected_source_language === "string" ? first.detected_source_language : "";
	const from = raw ? (DEEPL_FROM_LABELS[raw] ?? raw.toLowerCase()) : "auto";
	return { text, from };
}

const deeplEngine: TranslateEngineDef = {
	id: "deepl",
	label: "DeepL（需 Auth-Key）",
	mapTarget: (code) => DEEPL_TARGETS[code] ?? null,
	buildRequest: (text, engineTarget, cred) => ({
		// 密钥以 ":fx" 结尾 = 免费版（api-free 域），否则 Pro（api 域）——官方约定
		url: `${
			cred.deeplKey.endsWith(":fx") ? "https://api-free.deepl.com" : "https://api.deepl.com"
		}/v2/translate`,
		method: "POST",
		headers: {
			Authorization: `DeepL-Auth-Key ${cred.deeplKey}`,
			"Content-Type": "application/json",
		},
		body: JSON.stringify({ text: [text], target_lang: engineTarget }),
	}),
	parse: parseDeepLResponse,
	networkHint: "无法连接 DeepL：请检查网络与 Auth-Key（免费版密钥以 :fx 结尾）",
};

/** 引擎注册表（google 首位 = 缺省引擎） */
export const TRANSLATE_ENGINES: readonly TranslateEngineDef[] = [
	googleEngine,
	baiduEngine,
	youdaoEngine,
	deeplEngine,
];

/** 一次翻译调用的引擎与凭据（resolveEngineCall 产物，service/modal 间传递） */
export interface EngineCall {
	engine: TranslateEngineDef;
	cred: TranslateCredentials;
}

/**
 * 按设置解析引擎与凭据：引擎脏值回 Google；百度/有道/DeepL 凭据缺失抛带中文
 * 提示的 Error（调用方 Notice 后返回，不进网络层）。
 */
export function resolveEngineCall(settings: {
	translateEngine?: unknown;
	translateBaiduAppid?: unknown;
	translateBaiduSecret?: unknown;
	translateYoudaoAppid?: unknown;
	translateYoudaoAppSecret?: unknown;
	translateDeeplKey?: unknown;
}): EngineCall {
	const id = isTranslateEngineId(settings.translateEngine) ? settings.translateEngine : "google";
	const engine = TRANSLATE_ENGINES.find((e) => e.id === id) ?? TRANSLATE_ENGINES[0];
	const str = (v: unknown): string => (typeof v === "string" ? v.trim() : "");
	const cred: TranslateCredentials = {
		baiduAppid: str(settings.translateBaiduAppid),
		baiduSecret: str(settings.translateBaiduSecret),
		youdaoAppKey: str(settings.translateYoudaoAppid),
		youdaoAppSecret: str(settings.translateYoudaoAppSecret),
		deeplKey: str(settings.translateDeeplKey),
	};
	if (engine.id === "baidu" && (!cred.baiduAppid || !cred.baiduSecret)) {
		throw new Error("百度翻译需要 APP ID 与密钥：请先在 设置 → 翻译 中填写");
	}
	if (engine.id === "youdao" && (!cred.youdaoAppKey || !cred.youdaoAppSecret)) {
		throw new Error("有道翻译需要应用 ID 与应用密钥：请先在 设置 → 翻译 中填写");
	}
	if (engine.id === "deepl" && !cred.deeplKey) {
		throw new Error("DeepL 需要 Auth-Key：请先在 设置 → 翻译 中填写");
	}
	return { engine, cred };
}

/** 缺省引擎调用（Google 免密钥）：TranslateModal 独立使用（未传 engineCall）的兜底 */
export function defaultEngineCall(): EngineCall {
	return {
		engine: TRANSLATE_ENGINES[0],
		cred: {
			baiduAppid: "",
			baiduSecret: "",
			youdaoAppKey: "",
			youdaoAppSecret: "",
			deeplKey: "",
		},
	};
}
