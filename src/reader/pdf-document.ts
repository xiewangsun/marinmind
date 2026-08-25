import { loadPdfJs } from "obsidian";
import type {
	PdfDocumentProxy,
	PdfLoadingTask,
	PdfPageProxy,
	PdfRenderTask,
	PdfViewport,
	PdfjsLib,
} from "./pdfjs-types";

/** devicePixelRatio 上限：更高对清晰度收益小、canvas 内存却翻倍 */
const MAX_DPR = 2;
/** 单页 canvas 总像素上限（约 16M，iOS Safari 的 canvas 面积限制，超出会渲染失败） */
const MAX_CANVAS_PIXELS = 16_000_000;

/** 一次页面渲染的凭据：调用方持有以取消（页面卸载 / 视图销毁时） */
export interface RenderTicket {
	done: Promise<void>;
	cancel(): void;
}

/** 文本层 span 的 CSS 定位规格（像素，相对页面容器左上角） */
export interface PdfTextSpanSpec {
	text: string;
	left: number;
	top: number;
	fontSize: number;
}

/** 判定 pdf.js 抛出的"已取消 / 已销毁"类错误（属正常路径，静默即可） */
function isCancellation(err: unknown): boolean {
	const name = (err as { name?: string })?.name ?? "";
	const msg = err instanceof Error ? err.message : String(err);
	return (
		name === "RenderingCancelledException" ||
		/cancelled|canceled|worker was destroyed/i.test(msg)
	);
}

/**
 * PdfDocument：对 `loadPdfJs() → getDocument` 的封装。
 *
 * - 传入的 ArrayBuffer 会被 pdf.js transfer 给 worker（原 buffer 随即 detach），
 *   因此内部先复制一份，避免调用方持有的 buffer 被意外失效
 * - renderTo 集中处理 devicePixelRatio 钳制与 canvas 总像素上限；
 *   同页在途任务自动取消，防止 "same canvas" 并发渲染错误
 * - destroy 幂等：onUnloadFile 与 onClose 重复调用均安全
 *   （document 级 destroy 不会影响 Obsidian 全局共享的 pdf.js worker）
 */
export class PdfDocument {
	/** 每页 scale=1 的基准尺寸缓存（页 proxy 在 pdf.js 内部亦有缓存，二次调用便宜） */
	private readonly sizeCache = new Map<number, { width: number; height: number }>();
	/** 在途渲染任务（按页码索引），新渲染前取消旧的 */
	private readonly inFlight = new Map<number, PdfRenderTask>();
	private destroyed = false;

	private constructor(
		private readonly doc: PdfDocumentProxy,
		private readonly loadingTask: PdfLoadingTask,
	) {}

	/** 从文件二进制内容打开文档 */
	static async open(data: ArrayBuffer): Promise<PdfDocument> {
		const lib = (await loadPdfJs()) as PdfjsLib;
		// slice(0) 复制：pdf.js 会 transfer 走传入的 buffer
		const task = lib.getDocument({ data: new Uint8Array(data.slice(0)) });
		try {
			const doc = await task.promise;
			return new PdfDocument(doc, task);
		} catch (err) {
			// 加载失败也要销毁 loadingTask，释放 worker 侧通道
			task.destroy().catch(() => undefined);
			throw err;
		}
	}

	get numPages(): number {
		return this.doc.numPages;
	}

	/** 第 pageNumber 页的基准尺寸（scale=1，PDF 用户单位） */
	async getPageSize(pageNumber: number): Promise<{ width: number; height: number }> {
		const cached = this.sizeCache.get(pageNumber);
		if (cached) {
			return cached;
		}
		const viewport = (await this.getPage(pageNumber)).getViewport({ scale: 1 });
		const size = { width: viewport.width, height: viewport.height };
		this.sizeCache.set(pageNumber, size);
		return size;
	}

	/**
	 * 渲染第 pageNumber 页到 canvas。
	 *
	 * @param cssScale CSS 像素缩放（决定页面在页面布局中的显示尺寸）
	 * 内部乘以 dpr 提升清晰度；总像素超上限时按比例回缩渲染精度（CSS 尺寸不变）。
	 */
	renderTo(canvas: HTMLCanvasElement, pageNumber: number, cssScale: number): RenderTicket {
		// 取消同页在途任务（快速缩放/翻页场景）
		this.inFlight.get(pageNumber)?.cancel();

		let task: PdfRenderTask | undefined;
		let cancelled = false;
		const done = (async () => {
			try {
				const page = await this.getPage(pageNumber);
				if (cancelled || this.destroyed) {
					return;
				}
				const base = page.getViewport({ scale: 1 });
				const dpr = Math.min(window.devicePixelRatio || 1, MAX_DPR);
				// 渲染精度：cssScale × dpr，超出 canvas 面积上限则回缩
				const renderScale = Math.min(
					cssScale * dpr,
					Math.sqrt(MAX_CANVAS_PIXELS / (base.width * base.height)),
				);
				const viewport = page.getViewport({ scale: renderScale });
				// 物理像素给 canvas，CSS 尺寸只由 cssScale 决定（与渲染精度解耦）
				canvas.width = Math.floor(viewport.width);
				canvas.height = Math.floor(viewport.height);
				canvas.style.width = `${Math.floor(base.width * cssScale)}px`;
				canvas.style.height = `${Math.floor(base.height * cssScale)}px`;

				const ctx = canvas.getContext("2d");
				if (!ctx) {
					throw new Error("无法获取 canvas 2d 上下文");
				}
				task = page.render({ canvasContext: ctx, viewport });
				this.inFlight.set(pageNumber, task);
				await task.promise;
			} catch (err) {
				if (!isCancellation(err)) {
					throw err;
				}
			} finally {
				if (this.inFlight.get(pageNumber) === task) {
					this.inFlight.delete(pageNumber);
				}
			}
		})();
		return {
			done,
			cancel: () => {
				cancelled = true;
				task?.cancel();
			},
		};
	}

	/**
	 * 构建第 pageNumber 页的文本层规格（透明可选中 spans 的定位数据）。
	 *
	 * span 定位只需"接近正确"即可保证可选中；精确的高亮矩形来自选区的
	 * getClientRects 实测（reader-view 侧），因此这里用基线近似（top = y - fontSize）。
	 */
	async buildTextLayer(pageNumber: number, cssScale: number): Promise<PdfTextSpanSpec[]> {
		const page = await this.getPage(pageNumber);
		const content = await page.getTextContent();
		// 视口矩阵（含 y 轴翻转）：PDF 用户坐标 → 视口像素坐标
		const m = page.getViewport({ scale: cssScale }).transform;
		const specs: PdfTextSpanSpec[] = [];
		for (const item of content.items) {
			if (!("str" in item) || item.str === "") {
				continue; // 跳过标记内容项与空串
			}
			const t = item.transform;
			// 矩阵乘法：文本基线起点 (t[4], t[5]) 映射到视口坐标
			const x = m[0] * t[4] + m[2] * t[5] + m[4];
			const y = m[1] * t[4] + m[3] * t[5] + m[5];
			const fontSize = Math.hypot(t[2], t[3]) * cssScale;
			specs.push({ text: item.str, left: x, top: y - fontSize, fontSize });
		}
		return specs;
	}

	/** 销毁文档与在途渲染（幂等；不触碰 Obsidian 全局 worker 配置） */
	async destroy(): Promise<void> {
		if (this.destroyed) {
			return;
		}
		this.destroyed = true;
		for (const task of this.inFlight.values()) {
			task.cancel();
		}
		this.inFlight.clear();
		try {
			await this.doc.destroy();
		} catch {
			// 已销毁 / worker 通道已断：无需处理
		}
	}

	private async getPage(pageNumber: number): Promise<PdfPageProxy> {
		if (this.destroyed) {
			throw new Error("PdfDocument 已销毁");
		}
		return this.doc.getPage(pageNumber);
	}
}
