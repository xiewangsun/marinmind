import { estimateTokens } from "./ai-provider";

/**
 * AI 上下文（98 P2，纯函数层）：文档文本的页标记拼装、token 预算裁剪、
 * map-reduce 分块、AI 回答的页引用提取。提取本身在耦合层
 * （ai-context-service 经 reader 的 DocSearchHost 三形态接口）。
 */

/** 上下文块：page 统一为 pdf 页码 / epub 章号（md 恒 1）——与跳页/标签口径一致 */
export interface AiContextBlock {
	page: number;
	text: string;
}

/** 上下文范围（98 首档两态：当前页/全文；pdf 大纲章范围留后续批次） */
export type AiContextScope = "page" | "doc";

/** 页标签文案（与 docSearchHitLabel 同口径：pdf 页 / epub 章 / md·clip 段） */
export function aiPageLabel(kind: "pdf" | "epub" | "md" | "clip", page: number): string {
	if (kind === "epub") {
		return `第 ${page} 章`;
	}
	if (kind === "md" || kind === "clip") {
		return "全文";
	}
	return `第 ${page} 页`;
}

/**
 * 拼装带页标记的上下文文本：每块前加 `[第 N 页]`/`[第 N 章]` 标记
 * （prompt 约束 AI 只引用这些标记值——页码幻觉防线的数据侧）。
 * 空块过滤；相邻同页块合并为一个标记。
 */
export function buildContextText(
	blocks: readonly AiContextBlock[],
	kind: "pdf" | "epub" | "md" | "clip",
): string {
	const parts: string[] = [];
	for (const block of blocks) {
		const text = block.text.trim();
		if (!text) {
			continue;
		}
		const mark = kind === "epub" ? `[第 ${block.page} 章]` : `[第 ${block.page} 页]`;
		parts.push(`${mark}\n${text}`);
	}
	return parts.join("\n\n");
}

/**
 * token 预算裁剪（98）：逐块累计 estimateTokens，超预算即停——保头部
 * （阅读问答/摘要的头部信息密度最高），返回 truncated 标记供 UI 明示
 * 「内容已截断」。至少保留一块（预算极小时不产生空上下文）。
 */
export function clampToTokenBudget(
	blocks: readonly AiContextBlock[],
	budgetTokens: number,
): { blocks: AiContextBlock[]; truncated: boolean } {
	const out: AiContextBlock[] = [];
	let used = 0;
	for (const block of blocks) {
		const cost = estimateTokens(block.text);
		if (out.length > 0 && used + cost > budgetTokens) {
			return { blocks: out, truncated: true };
		}
		out.push(block);
		used += cost;
	}
	return { blocks: out, truncated: false };
}

/** map-reduce 分块的目标块字符数（约 3000 字/块：一块一请求，兼顾吞吐与限流） */
export const SUMMARY_CHUNK_CHARS = 3000;

/**
 * 按段落边界分块（98 摘要 map 阶段）：优先在空行处切，无空行长段按句号
 * 硬切；块内保留原文（含 [第 N 页] 标记——要点可带出处）。空块过滤。
 */
export function chunkText(text: string, maxChars: number): string[] {
	const paragraphs = text
		.split(/\n{2,}/)
		.map((p) => p.trim())
		.filter(Boolean);
	const chunks: string[] = [];
	let current = "";
	const pushCurrent = (): void => {
		if (current.trim()) {
			chunks.push(current.trim());
		}
		current = "";
	};
	for (const para of paragraphs) {
		if (para.length > maxChars) {
			// 超长段独立处理：先落当前累积，再按句边界硬切该段
			pushCurrent();
			for (const piece of splitBySentence(para, maxChars)) {
				chunks.push(piece);
			}
			continue;
		}
		if (current.length + para.length + 2 > maxChars) {
			pushCurrent();
		}
		current = current ? `${current}\n\n${para}` : para;
	}
	pushCurrent();
	return chunks;
}

/** 句边界硬切（chunkText 的超长段兜底：句号/问号/叹号后切，实在无界按字符切） */
function splitBySentence(para: string, maxChars: number): string[] {
	const out: string[] = [];
	let rest = para;
	while (rest.length > maxChars) {
		const window = rest.slice(0, maxChars);
		// 窗口内最后一个句末标点（含全角）处切；找不到则按窗口硬切
		let cut = Math.max(
			window.lastIndexOf("。"),
			window.lastIndexOf("！"),
			window.lastIndexOf("？"),
			window.lastIndexOf("."),
		);
		if (cut <= 0) {
			cut = maxChars - 1;
		}
		out.push(rest.slice(0, cut + 1));
		rest = rest.slice(cut + 1);
	}
	if (rest.trim()) {
		out.push(rest.trim());
	}
	return out;
}

/**
 * 提取 AI 回答中的页引用（98）：匹配「（第 N 页）」「(第 N 页)」「（第 N 章）」
 * 及无括号形态「第 N 页」，返回去重保序的 N 列表——chat 面板据此渲染跳页 chip。
 */
export function extractPageRefs(reply: string): number[] {
	const seen = new Set<number>();
	const re = /[（(]?第\s*(\d{1,5})\s*[页章][）)]?/g;
	for (const match of reply.matchAll(re)) {
		const n = Number(match[1]);
		if (Number.isFinite(n) && n > 0) {
			seen.add(n);
		}
	}
	return [...seen];
}
