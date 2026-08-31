import { loadPdfJs } from "obsidian";
import type {
	PdfDocumentProxy,
	PdfLoadingTask,
	PdfOutlineItem,
	PdfPageProxy,
	PdfPageRef,
	PdfRenderTask,
	PdfViewport,
	PdfjsLib,
} from "./pdfjs-types";
import type { LayoutItem } from "./auto-excerpt";
import { mapLimit } from "../utils";

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

/** 解析后的目录条目（㉓ 书签/目录侧栏）：页码已解析，子级平铺为树 */
export interface OutlineEntry {
	title: string;
	/** 目标页码（1 基）；目的地损坏/无法解析时为 null（条目仍展示，点击无动作） */
	page: number | null;
	children: OutlineEntry[];
	/**
	 * 标题锚点元素（㊻-B md 文档专用；PDF 路径不填）——点击目录条目直接滚动
	 * 到该标题而非跳页（md 单页长文，标题才是导航粒度）。
	 */
	anchor?: HTMLElement;
	/**
	 * 章内锚点 id（㊼ EPUB 专用）——章节懒渲染，建目录时锚点元素尚不存在，
	 * 先存 fragment id，跳转时确保章节渲染后 querySelector 解析。
	 */
	fragment?: string | null;
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

/** spec@1 → 按 cssScale 线性派生（P5 文本层缓存命中路径的换算步骤） */
function scaleSpec(cssScale: number): (s: PdfTextSpanSpec) => PdfTextSpanSpec {
	return (s) => ({
		text: s.text,
		left: s.left * cssScale,
		top: s.top * cssScale,
		fontSize: s.fontSize * cssScale,
	});
}

/**
 * PdfDocument：对 `loadPdfJs() → getDocument` 的封装。
 *
 * - 传入的 ArrayBuffer 会被 pdf.js transfer 给 worker（原 buffer 随即 detach），
 *   因此内部先复制一份，避免调用方持有的 buffer 被意外失效
 * - renderTo 集中处理 devicePixelRatio 钳制与 canvas 总像素上限；
 *   同 canvas 在途任务自动取消，防止 "same canvas" 并发渲染错误
 *   （㊳ 按 canvas 而非页码索引：多视图共享同一文档渲染同页互不干扰）
 * - destroy 幂等：onUnloadFile 与 onClose 重复调用均安全
 *   （document 级 destroy 不会影响 Obsidian 全局共享的 pdf.js worker）
 */
export class PdfDocument {
	/** 每页 scale=1 的基准尺寸缓存（页 proxy 在 pdf.js 内部亦有缓存，二次调用便宜） */
	private readonly sizeCache = new Map<number, { width: number; height: number }>();
	/**
	 * P5 文本层规格缓存：spec 按 scale=1 换算存底（left/top/fontSize 随 scale
	 * 严格线性——getViewport transform 各分量含平移项均随 scale 线性，旋转页同理），
	 * 缩放/重渲染不再重复 getTextContent worker 往返。插入序 LRU，上限 128 页
	 * （每页 spec 约 50KB 级，≈6MB 封顶）；实例随 pdf-cache release 归零被 GC。
	 */
	private readonly textSpecCache = new Map<number, PdfTextSpanSpec[]>();
	private static readonly TEXT_CACHE_MAX_PAGES = 128;
	/** 在途渲染任务（按目标 canvas 索引），新渲染前取消旧的。
	 *  ㊳ 键从页码改为 canvas：pdf.js 的并发约束是"同 canvas 不能并发渲染"——
	 *  两个标签页共享同一 PdfDocument 渲染同一页到各自 canvas 互不冲突，
	 *  按页码索引会把对方在途任务误取消（屏幕留白）；同 leaf 的重渲染/缩放
	 *  仍走同一 canvas 依旧抢占 */
	private readonly inFlight = new Map<HTMLCanvasElement, PdfRenderTask>();
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
	 * @param opts.isolated 隔离渲染（OCR 离屏高清渲染用）：不取消同页在途任务、
	 *   也不注册 inFlight——与显示渲染互不抢占（pdf.js 允许同页并发渲染到不同 canvas）
	 *
	 * 内部乘以 dpr 提升清晰度；总像素超上限时按比例回缩渲染精度（CSS 尺寸不变）。
	 */
	renderTo(
		canvas: HTMLCanvasElement,
		pageNumber: number,
		cssScale: number,
		opts?: { isolated?: boolean },
	): RenderTicket {
		// 取消同 canvas 在途任务（快速缩放/翻页场景）
		if (!opts?.isolated) {
			this.inFlight.get(canvas)?.cancel();
		}

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

				// willReadFrequently 强制 CPU 后端：部分环境（新版 Electron + Windows 缩放/GPU）
				// GPU 加速 canvas 位图无法上屏（元素可见、位图全空、无报错），CPU 后端不受影响
				const ctx = canvas.getContext("2d", { willReadFrequently: true });
				if (!ctx) {
					throw new Error("无法获取 canvas 2d 上下文");
				}
				task = page.render({ canvasContext: ctx, viewport });
				if (!opts?.isolated) {
					this.inFlight.set(canvas, task);
				}
				await task.promise;
				// 排障日志（debug 级默认隐藏）：确认渲染任务真正完成
				// （画面空白的场景需区分"挂起"与"画完仍空"）
				console.debug(`[MarinMind] render 完成 p${pageNumber}`);
			} catch (err) {
				if (!isCancellation(err)) {
					throw err;
				}
				// 取消属正常路径（同页重渲染抢占 / 滚离视口卸载 / 文档销毁），静默吞掉。
				// 留 debug 级痕备查：worker 通道断裂也会伪装成取消类错误走到这里且无红色报错
				console.debug(`[MarinMind] render 静默取消 p${pageNumber}`, err);
			} finally {
				if (this.inFlight.get(canvas) === task) {
					this.inFlight.delete(canvas);
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
		// P5 缓存命中：spec@1 × cssScale 线性派生（LRU 触碰：delete+set 重排插入序）
		const hit = this.textSpecCache.get(pageNumber);
		if (hit) {
			this.textSpecCache.delete(pageNumber);
			this.textSpecCache.set(pageNumber, hit);
			return hit.map(scaleSpec(cssScale));
		}
		const page = await this.getPage(pageNumber);
		const content = await page.getTextContent();
		// 视口矩阵（含 y 轴翻转）：PDF 用户坐标 → 视口像素坐标（按 scale=1 入缓存）
		const m = page.getViewport({ scale: 1 }).transform;
		const specs: PdfTextSpanSpec[] = [];
		for (const item of content.items) {
			if (!("str" in item) || item.str === "") {
				continue; // 跳过标记内容项与空串
			}
			const t = item.transform;
			// 矩阵乘法：文本基线起点 (t[4], t[5]) 映射到视口坐标
			const x = m[0] * t[4] + m[2] * t[5] + m[4];
			const y = m[1] * t[4] + m[3] * t[5] + m[5];
			const fontSize = Math.hypot(t[2], t[3]);
			specs.push({ text: item.str, left: x, top: y - fontSize, fontSize });
		}
		this.textSpecCache.set(pageNumber, specs);
		// LRU 淘汰：超上限逐最旧（Map 首键 = 最久未触碰）
		while (this.textSpecCache.size > PdfDocument.TEXT_CACHE_MAX_PAGES) {
			const oldest = this.textSpecCache.keys().next().value;
			if (oldest === undefined) {
				break;
			}
			this.textSpecCache.delete(oldest);
		}
		return specs.map(scaleSpec(cssScale));
	}

	/**
	 * 提取内嵌大纲（目录/书签）并解析各条目目标页码（㉓）。
	 * 每条目独立 try/catch：个别目的地损坏不影响整树（页码 null 的条目照常展示）。
	 * 无大纲的文档返回空数组。
	 */
	async outline(): Promise<OutlineEntry[]> {
		// pdf.js 4.0+（Obsidian 1.7 内置 5.x）getOutline 返回 Promise，更旧版本返回同步
		// 数组——Promise.resolve 双态兼容，直接消费 Promise 对象会抛 TypeError 被上层
		// catch 吞掉（㉕ 修复：此前所有 PDF 的目录都判空）
		const raw = this.destroyed ? null : await Promise.resolve(this.doc.getOutline());
		if (!raw) {
			return [];
		}
		const resolvePage = async (dest: string | unknown[] | null): Promise<number | null> => {
			try {
				if (typeof dest === "string") {
					// 命名目的地 → 显式目的地数组
					const explicit = await this.doc.getDestination(dest);
					return await this.pageOfDest(explicit);
				}
				return await this.pageOfDest(dest);
			} catch {
				return null; // 目的地损坏 / worker 已断：条目保留但不可跳转
			}
		};
		const walk = async (items: PdfOutlineItem[]): Promise<OutlineEntry[]> => {
			// ㊳ 并行解析：逐条目串行 await 在大目录（数千条目）下秒级卡顿——
			// mapLimit 每层各限 8 并发（深层叠加 ≈ 8×深度，刻意不做全局信号量，简单优先）；
			// 条目级容错在 resolvePage 内部保留（损坏条目 page=null 不阻塞整树）
			return mapLimit(items, 8, async (item) => ({
				title: item.title || "（无标题）",
				page: await resolvePage(item.dest),
				children: item.items ? await walk(item.items) : [],
			}));
		};
		return walk(raw);
	}

	/** 显式目的地数组 → 1 基页码（首元素为页引用；极旧 PDF 可能直接存页号） */
	private async pageOfDest(dest: unknown[] | null): Promise<number | null> {
		if (!Array.isArray(dest) || dest.length === 0) {
			return null;
		}
		const head = dest[0] as Partial<PdfPageRef> | number;
		if (typeof head === "number") {
			return head + 1; // 0 基页号直存形态
		}
		if (typeof head?.num !== "number") {
			return null;
		}
		const index = await this.doc.getPageIndex({ num: head.num, gen: head.gen ?? 0 });
		return index + 1;
	}

	/**
	 * 取某页文本项的版面几何（scale=1 视口坐标，y 向下）——AI 一键摘录（㉓）
	 * 块检测的输入。与 buildTextLayer 同一套矩阵换算，但保留宽度并按页基准归一。
	 */
	async getPageLayout(pageNumber: number): Promise<LayoutItem[]> {
		const page = await this.getPage(pageNumber);
		const content = await page.getTextContent();
		// scale=1 视口矩阵：[1,0,0,-1,0,H]（y 翻转）
		const height = page.getViewport({ scale: 1 }).height;
		const items: LayoutItem[] = [];
		for (const item of content.items) {
			if (!("str" in item) || item.str.trim() === "") {
				continue;
			}
			const t = item.transform;
			items.push({
				str: item.str,
				x: t[4],
				yTop: height - t[5],
				w: item.width,
				h: Math.hypot(t[2], t[3]),
			});
		}
		return items;
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
