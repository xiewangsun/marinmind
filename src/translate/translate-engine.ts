/**
 * 翻译引擎纯函数层（㉔）——目标语言表 / Google 免费接口请求构造与响应解析 /
 * 译文留白锚点计算。零 obsidian 依赖（vitest 覆盖），网络调用在 translate-service。
 *
 * 对齐 MN4「翻译及保存译文」手册：13 种目标语言、自动检测源语言、
 * 译文存为留白（与原文并排对照）/ 复制到剪贴板。
 */
import type { DocRect } from "../types";

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
