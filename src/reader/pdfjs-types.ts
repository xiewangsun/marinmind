/**
 * Obsidian 内置 PDF.js 的最小类型声明。
 *
 * `loadPdfJs()`（obsidian 公开 API）返回 `Promise<any>`，这里收敛我们实际用到的
 * API 面——getDocument / getPage / getViewport / render / destroy。
 * 这些接口自 pdf.js 2.x 起保持稳定；刻意不引入更多依赖面，
 * 以降低 Obsidian 升级内置 pdf.js 版本时的破坏风险。
 */

/** 页面视口：给定 scale 下的渲染坐标系宽高（像素） */
export interface PdfViewport {
	width: number;
	height: number;
}

/** 一次渲染任务：可取消（缩放切换/页面卸载时避免同 canvas 并发渲染冲突） */
export interface PdfRenderTask {
	promise: Promise<void>;
	cancel(): void;
}

/** PDF 单页代理 */
export interface PdfPageProxy {
	/** scale=1 即 PDF 用户单位（1pt = 1px），用于计算归一化坐标基准 */
	getViewport(params: { scale: number }): PdfViewport;
	/** 同一 canvas 上的并发 render 会抛错，必须先 cancel 旧任务 */
	render(params: {
		canvasContext: CanvasRenderingContext2D;
		viewport: PdfViewport;
	}): PdfRenderTask;
}

/** PDF 文档代理 */
export interface PdfDocumentProxy {
	numPages: number;
	getPage(pageNumber: number): Promise<PdfPageProxy>;
	destroy(): Promise<void>;
}

/** getDocument 返回的加载任务 */
export interface PdfLoadingTask {
	promise: Promise<PdfDocumentProxy>;
	destroy(): Promise<void>;
}

/** loadPdfJs() 的返回值（即全局 pdfjsLib） */
export interface PdfjsLib {
	getDocument(params: { data: Uint8Array }): PdfLoadingTask;
}
