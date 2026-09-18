import type { PdfTextSpanSpec } from "./pdf-document";

/**
 * 文档内搜索纯逻辑（89-D，MN3 搜索入口对齐）：PDF 文本 spec 聚行 + 三形态
 * （PDF 行 / EPUB·MD 块）统一子串匹配 + 摘要截取。零 obsidian 依赖，vitest
 * 直测（同 node-search / epub-document 先例）；IO/DOM 侧在 doc-search-modal.ts。
 */

/** 聚行后的 PDF 文本行（scale=1 坐标；reveal 定位闪烁框用） */
export interface PdfSearchLine {
	/** 行内 item 文本直接拼接（CJK 分 item 短语可搜；空格语义由 item 自带） */
	text: string;
	/** 行内最小 top（spec.top = 基线 y - fontSize，取行首代表值） */
	top: number;
	/** 行内最左 left */
	left: number;
	/** 行内最大字号 */
	fontSize: number;
}

/** 单条搜索命中（三形态共用：lineIndex = PDF 聚行序 / EPUB·MD 块序） */
export interface DocSearchHit {
	/** 1 基页码（PDF 页 / EPUB 章；md 恒 1） */
	page: number;
	lineIndex: number;
	/** 命中摘要（前后各约 radius 字符，越界加省略号） */
	snippet: string;
}

/** 单页（章/块集）命中上限：同词刷屏的页面只取前 N 行展示 */
export const PAGE_HIT_CAP = 5;
/** 全文档命中总数上限：常见词（"的"）防千条刷屏与扫描拖尾 */
export const TOTAL_HIT_CAP = 200;

/**
 * PDF 文本 spec 聚行：按 top 升序扫描，行内判定容差取两侧最大字号的 35%
 * （下限 2px——同视觉行混排字号时基线近似 top 有固有偏差），行内按 left
 * 排序后直接拼接。不合成空格：pdf.js 的 item.str 自带空白字符，CJK 被
 * 分 item 打散的短语（"中"+"文"）直接相连即恢复可搜性；拉丁字母跨界补
 * 空格反而会打断 mid-word 拆分（"Hel"+"lo"），宁缺毋滥。
 */
export function pdfLinesFromSpecs(specs: readonly PdfTextSpanSpec[]): PdfSearchLine[] {
	if (specs.length === 0) {
		return [];
	}
	const sorted = [...specs].sort((a, b) => a.top - b.top || a.left - b.left);
	const lines: PdfSearchLine[] = [];
	let parts: PdfTextSpanSpec[] = [];
	let minTop = 0;
	let maxFont = 0;
	const flush = () => {
		if (parts.length === 0) {
			return;
		}
		parts.sort((a, b) => a.left - b.left);
		lines.push({
			text: parts.map((p) => p.text).join(""),
			top: Math.min(...parts.map((p) => p.top)),
			left: parts[0].left,
			fontSize: maxFont,
		});
		parts = [];
	};
	for (const s of sorted) {
		// 行容差：max(2px, 两侧最大字号 × 0.35)——对比当前行的 minTop
		const tol = Math.max(2, Math.max(s.fontSize, maxFont) * 0.35);
		if (parts.length > 0 && Math.abs(s.top - minTop) > tol) {
			flush();
			minTop = s.top;
			maxFont = s.fontSize;
		} else if (parts.length === 0) {
			minTop = s.top;
			maxFont = s.fontSize;
		} else {
			minTop = Math.min(minTop, s.top);
			maxFont = Math.max(maxFont, s.fontSize);
		}
		parts.push(s);
	}
	flush();
	return lines;
}

/** 单段文本内全部命中位置（小写化子串；空查询早退空） */
function occurrences(text: string, q: string): number[] {
	const starts: number[] = [];
	let from = 0;
	for (;;) {
		const at = text.toLowerCase().indexOf(q, from);
		if (at < 0) {
			return starts;
		}
		starts.push(at);
		from = at + 1; // 重叠命中各计一处（"aa" 搜 "a" = 2 处）
	}
}

/** 命中摘要：前后各 radius 字符（CJK 按 1 计），越界侧加 "…" */
export function buildSnippet(text: string, start: number, hitLength: number, radius = 24): string {
	const from = Math.max(0, start - radius);
	const to = Math.min(text.length, start + hitLength + radius);
	return (from > 0 ? "…" : "") + text.slice(from, to) + (to < text.length ? "…" : "");
}

/**
 * 命中摘要分段（91 批语义，151 审查改版）：命中段与非命中段交替返回，
 * 调用方把 hit 段渲染为 <mark> 元素——不再拼 HTML 串，**结构性免疫注入**
 * （原「分段转义」纪律随之退役）；匹配语义不变：原文 indexOf 定位（查询词
 * 含正则元字符/实体字符不错位）+ 非重叠推进。
 */
export interface SnippetSegment {
	text: string;
	/** true = 命中段（渲染为 mark 元素） */
	hit: boolean;
}

export function snippetSegments(query: string, snippet: string): SnippetSegment[] {
	const q = query.trim().toLowerCase();
	if (!q) {
		return snippet ? [{ text: snippet, hit: false }] : [];
	}
	const hay = snippet.toLowerCase();
	const segs: SnippetSegment[] = [];
	let from = 0;
	for (;;) {
		const at = hay.indexOf(q, from);
		if (at < 0) {
			break;
		}
		if (at > from) {
			segs.push({ text: snippet.slice(from, at), hit: false });
		}
		segs.push({ text: snippet.slice(at, at + q.length), hit: true });
		from = at + q.length; // 非重叠推进（"aaa" 搜 "aa" 只标首个，防嵌套 mark）
	}
	if (from < snippet.length) {
		segs.push({ text: snippet.slice(from), hit: false });
	}
	return segs;
}

/**
 * 搜一页（章/文档）的文本集合：texts 为聚行文本（PDF）或块文本（EPUB/MD），
 * 每段所有命中各成一条 hit（cap 截断），返回按扫描顺序排列的命中。
 */
export function searchTexts(
	page: number,
	texts: readonly string[],
	query: string,
	cap: number = PAGE_HIT_CAP,
): { hits: DocSearchHit[]; truncated: boolean } {
	const q = query.trim().toLowerCase();
	const hits: DocSearchHit[] = [];
	if (!q) {
		return { hits, truncated: false };
	}
	for (let i = 0; i < texts.length; i++) {
		for (const at of occurrences(texts[i], q)) {
			if (hits.length >= cap) {
				return { hits, truncated: true };
			}
			hits.push({
				page,
				lineIndex: i,
				snippet: buildSnippet(texts[i], at, q.length),
			});
		}
	}
	return { hits, truncated: false };
}
