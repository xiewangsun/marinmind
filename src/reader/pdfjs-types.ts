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
	/** 视口变换矩阵 [a,b,c,d,e,f]（含 y 轴翻转），用于 PDF 坐标 → 视口坐标 */
	transform: number[];
}

/** 一次渲染任务：可取消（缩放切换/页面卸载时避免同 canvas 并发渲染冲突） */
export interface PdfRenderTask {
	promise: Promise<void>;
	cancel(): void;
}

/** 文本项：PDF 内容流中的一个文本片段（带变换矩阵） */
export interface PdfTextItem {
	str: string;
	dir: string;
	width: number;
	height: number;
	/** 文本矩阵 [a,b,c,d,e,f]：(e,f) 为基线起点，纵向量模长即字号 */
	transform: number[];
}

/** getTextContent 结果（items 中还可能混杂无 str 的标记内容项，使用时过滤） */
export interface PdfTextContent {
	items: (PdfTextItem | { type: string })[];
}

/** PDF 大纲（书签）节点：getOutline 返回的树形结构（dest 可为命名目的地字符串或显式数组） */
export interface PdfOutlineItem {
	title: string;
	dest: string | unknown[] | null;
	items: PdfOutlineItem[] | null;
	bold?: boolean;
	italic?: boolean;
}

/** PDF 内部页引用（显式目的地数组的首元素） */
export interface PdfPageRef {
	num: number;
	gen: number;
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
	/** 页面文本项列表（pdf.js 内部有缓存，重复调用便宜） */
	getTextContent(): Promise<PdfTextContent>;
}

/** PDF 文档代理 */
export interface PdfDocumentProxy {
	numPages: number;
	getPage(pageNumber: number): Promise<PdfPageProxy>;
	/** 内嵌大纲（书签/目录）树；无大纲返回 null（pdf.js 4.0+ 返回 Promise） */
	getOutline(): Promise<PdfOutlineItem[] | null>;
	/** 命名目的地 → 显式目的地数组（outline dest 为字符串时解析用） */
	getDestination(id: string): Promise<unknown[] | null>;
	/** 页引用 → 0 基页码（显式目的地数组首元素解析用） */
	getPageIndex(ref: PdfPageRef): Promise<number>;
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
