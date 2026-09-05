/**
 * OCR 结果的拼接与清洗纯函数（无 DOM/网络依赖，vitest 覆盖）。
 * ocr-service 逐矩形识别出的原始文本经这里归一后写回 Card.excerptText。
 * 85-C 起兼放识别提示文案（ocrStartNotice/ocrFailNotice——按引擎就绪态分流）。
 */

import type { DocRect } from "../types";

/**
 * 清洗单段 OCR 原文：
 * - 全角空格（U+3000，中文 OCR 高频噪声）归一为半角；
 * - CRLF/CR 归一为 \n；
 * - 行内连续空格/制表符折叠为单个空格；
 * - 每行 trim，去掉空行（保留换行——多行结构反映版面段落）。
 */
export function normalizeOcrText(text: string): string {
	return text
		.replace(/　/g, " ")
		.replace(/\r\n?/g, "\n")
		.split("\n")
		.map((line) => line.replace(/[ \t]+/g, " ").trim())
		.filter((line) => line.length > 0)
		.join("\n");
}

/**
 * 按矩形顺序拼接各区域文本：逐段 normalize、丢弃空段，以 \n 连接
 * （多矩形 = 多块版面，块间换行保持阅读顺序）。
 */
export function joinRectTexts(texts: (string | null | undefined)[]): string {
	return texts
		.map((t) => normalizeOcrText(t ?? ""))
		.filter((t) => t.length > 0)
		.join("\n");
}

/**
 * 识别语言预设组合表（83 语言可选，镜像 TRANSLATE_LANGUAGES 形态）：
 * value 即 tesseract createWorker 的 langs 参数（"+" 连接多语言），
 * label 供设置页下拉展示。每加一门语言首用多下载一份语言包（10-20MB 量级），
 * 故只收预设组合不做自由多选。
 */
export const OCR_LANGUAGES: readonly { value: string; label: string }[] = [
	{ value: "chi_sim+eng", label: "简体中文 + 英文（默认）" },
	{ value: "chi_sim+chi_tra+eng", label: "简繁中文 + 英文" },
	{ value: "chi_tra+eng", label: "繁体中文 + 英文" },
	{ value: "eng", label: "英语" },
	{ value: "jpn+eng", label: "日语 + 英语" },
	{ value: "kor+eng", label: "韩语 + 英语" },
	{ value: "fra+eng", label: "法语 + 英语" },
	{ value: "deu+eng", label: "德语 + 英语" },
	{ value: "spa+eng", label: "西班牙语 + 英语" },
	{ value: "ita+eng", label: "意大利语 + 英语" },
	{ value: "por+eng", label: "葡萄牙语 + 英语" },
	{ value: "rus+eng", label: "俄语 + 英语" },
];

/** 识别语言默认组合（沿用 v1 以来的中英混排） */
export const DEFAULT_OCR_LANGS = "chi_sim+eng";

/**
 * OCR 开始提示文案（85-C 提示分流）：
 * - kind：区域识别（单框/高亮）或整页识别；
 * - ready：本会话引擎已就绪（isOcrEngineReady）——不再附"首次需联网下载"
 *   （语言包缓存 IndexedDB，同会话二次调用秒加载）；未就绪才附下载说明。
 */
export function ocrStartNotice(kind: "region" | "page", ready: boolean): string {
	const base = kind === "page" ? "正在识别整页文字…" : "正在识别文字…";
	return ready ? base : `${base}（首次使用需联网下载引擎与语言包，约 10-20MB）`;
}

/**
 * OCR 失败提示文案（85-C）：未就绪时失败大概率是引擎/语言包下载未完成——
 * 提示检查网络重试；已就绪后的失败给通用提示。
 */
export function ocrFailNotice(ready: boolean): string {
	return ready
		? "文字识别失败，请稍后重试"
		: "文字识别失败：引擎与语言包可能尚未下载完成，请检查网络后重试";
}

/** ocrLangs 设置守卫：表内值才放行（手编 data.json 防御，镜像 isTranslateLangCode） */
export function isOcrLangs(v: unknown): v is string {
	return typeof v === "string" && OCR_LANGUAGES.some((l) => l.value === v);
}

/**
 * tesseract Page Segmentation Mode 子集（83 PSM 细分）——字符串值与
 * tesseract.js PSM 枚举一致（纯文本层不 import tesseract，service 层按值透传）：
 * "3" AUTO 整页/大区域全自动版面；"6" SINGLE_BLOCK 单一文本块；
 * "7" SINGLE_LINE 单行；"8" SINGLE_WORD 单词；"11" SPARSE_TEXT 散落稀疏文字。
 */
export type OcrPsm = "3" | "6" | "7" | "8" | "11";

/**
 * 按矩形几何挑 PSM（83 启发式纯函数）：
 * - 归一化面积占比 ≥ 0.5 → "3"（近整页，交给全自动版面分析）；
 * - 像素宽高比 ≥ 6 → "7"（扁长条 = 单行高亮/摘录）；
 * - 像素宽高均 < 100 → "8"（小方块 = 单词/标题级）；
 * - 其余 → "6"（普通段落块——比默认 "3" 少一层版面切分，小区域更稳）。
 */
export function pickOcrPsm(rect: DocRect, pagePixelW: number, pagePixelH: number): OcrPsm {
	if (!(pagePixelW > 0) || !(pagePixelH > 0)) {
		return "6"; // 画布尺寸异常（0/负/NaN）时退保守单块
	}
	if (rect.w * rect.h >= 0.5) {
		return "3";
	}
	const wPx = rect.w * pagePixelW;
	const hPx = rect.h * pagePixelH;
	if (hPx > 0 && wPx / hPx >= 6) {
		return "7";
	}
	if (wPx < 100 && hPx < 100) {
		return "8";
	}
	return "6";
}

/** 整页行级识别结果的一行：清洗后的文本 + 归一化页内矩形（83 整页 OCR 建逐行下划线卡） */
export interface OcrLine {
	text: string;
	rect: DocRect;
}

/**
 * 解析 tesseract `recognize(canvas, {}, { blocks: true })` 的 blocks 结构
 * （Block→paragraphs→lines），逐行取 bbox 像素坐标换算归一化 DocRect：
 * - 行文本经 normalizeOcrText 清洗，空行丢弃；
 * - bbox 越界/负值 clamp 到 [0,1]，退化矩形（宽高 ≤ 0）丢弃；
 * - 行序即 tesseract 版面阅读序，不重排；
 * - 结构异常（非数组/缺字段/画布尺寸非正）一律返回 []（宁拒不赌）。
 */
export function ocrLinesFromBlocks(blocks: unknown, canvasW: number, canvasH: number): OcrLine[] {
	if (!Array.isArray(blocks) || !(canvasW > 0) || !(canvasH > 0)) {
		return [];
	}
	const clamp01 = (v: number): number => Math.min(1, Math.max(0, v));
	const out: OcrLine[] = [];
	for (const block of blocks) {
		const paragraphs = (block as { paragraphs?: unknown } | null)?.paragraphs;
		if (!Array.isArray(paragraphs)) {
			continue;
		}
		for (const para of paragraphs) {
			const lines = (para as { lines?: unknown } | null)?.lines;
			if (!Array.isArray(lines)) {
				continue;
			}
			for (const line of lines) {
				const raw = line as { text?: unknown; bbox?: unknown } | null;
				// 单行文本清洗后理论上无换行；防御性折叠保证「一行 = 一段文本 = 一个矩形」
				const text = normalizeOcrText(String(raw?.text ?? "")).replace(/\n/g, " ");
				if (!text) {
					continue;
				}
				const b = raw?.bbox as
					{ x0?: unknown; y0?: unknown; x1?: unknown; y1?: unknown } | undefined;
				const x0 = Number(b?.x0);
				const y0 = Number(b?.y0);
				const x1 = Number(b?.x1);
				const y1 = Number(b?.y1);
				if (![x0, y0, x1, y1].every(Number.isFinite)) {
					continue;
				}
				const x = clamp01(x0 / canvasW);
				const y = clamp01(y0 / canvasH);
				const w = clamp01(x1 / canvasW) - x;
				const h = clamp01(y1 / canvasH) - y;
				if (w <= 0 || h <= 0) {
					continue;
				}
				out.push({ text, rect: { x, y, w, h } });
			}
		}
	}
	return out;
}
