import type { MarinMindReaderView } from "../reader/reader-view";
import { mapLimit } from "../utils";
import type { AiContextBlock, AiContextScope } from "./ai-context";

/**
 * AI 上下文收集（98 P2，耦合层）：从阅读视图提取三形态文本为上下文块。
 * 提取完全复用 reader 的 DocSearchHost 接口（89-D 文档搜索的同一数据源：
 * pdf 逐页聚行 / epub 逐章源解析块 / md 活 DOM 块）——零新增 reader 提取代码。
 * 纯逻辑（拼装/裁剪/分块）在 ai-context.ts（vitest 覆盖）。
 */

/** 收集结果：kind 供页标签/跳页口径，blocks 为带页号的文本块（原文序） */
export interface AiDocContext {
	kind: "pdf" | "epub" | "md" | "clip";
	docId: string;
	/** 范围锚定页（摘要卡落页/「当前页」快照；pdf=当前页码，epub=当前章号） */
	page: number;
	blocks: AiContextBlock[];
}

/** PDF 逐页提取的并发上限（buildTextLayer 走 worker 往返，限并发防压垮） */
const PDF_PAGE_CONCURRENCY = 4;

/**
 * 收集当前阅读文档的上下文块（98）：
 * - scope "page"：pdf=当前页 | epub=当前章 | md=全文（单页形态两者同义）
 * - scope "doc"：全文逐页/逐章
 * 视图未加载文档（docSearchKind null）返回 null 由调用方引导。
 */
export async function collectDocContext(
	view: MarinMindReaderView,
	scope: AiContextScope,
): Promise<AiDocContext | null> {
	const kind = view.docSearchKind();
	const docId = view.docId;
	if (!kind || !docId) {
		return null;
	}
	const page = view.getCurrentPage();
	if (kind === "pdf") {
		const blocks =
			scope === "page" ? [await pdfPageBlock(view, page)] : await pdfAllBlocks(view);
		return { kind, docId, page, blocks: blocks.filter((b) => b.text.trim().length > 0) };
	}
	if (kind === "epub") {
		const total = view.docSearchEpubChapterCount();
		const chapters = scope === "page" ? [page] : Array.from({ length: total }, (_, i) => i + 1);
		const blocks = chapters.map((chapter) => ({
			page: chapter,
			text: view.docSearchEpubBlocks(chapter).join("\n"),
		}));
		return { kind, docId, page, blocks: blocks.filter((b) => b.text.trim().length > 0) };
	}
	// md/clip（124）：单页形态，全文即当前页（clip 的图已渲染进 DOM，文本块同 md 提取）
	const blocks = [{ page, text: view.docSearchMdBlocks().join("\n") }];
	return { kind, docId, page, blocks: blocks.filter((b) => b.text.trim().length > 0) };
}

/** pdf 单页聚行 → 一块（docSearchPdfLines 为空/失败返回空文本块由调用方过滤） */
async function pdfPageBlock(view: MarinMindReaderView, page: number): Promise<AiContextBlock> {
	const lines = await view.docSearchPdfLines(page);
	return { page, text: (lines ?? []).map((l) => l.text).join("\n") };
}

/** pdf 全文逐页（98）：并发提取（worker 往返），页序即块序 */
async function pdfAllBlocks(view: MarinMindReaderView): Promise<AiContextBlock[]> {
	const total = view.docSearchPdfPageCount();
	const pages = Array.from({ length: total }, (_, i) => i + 1);
	return mapLimit(pages, PDF_PAGE_CONCURRENCY, (page) => pdfPageBlock(view, page));
}
