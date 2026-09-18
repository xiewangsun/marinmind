import type { PdfDocument, RenderTicket } from "./pdf-document";
import type { DocRect, NormPoint } from "../types";
import { snapshotDomRegion } from "./dom-snapshot";
import { cropRegionSnapshot, type SnapshotImage } from "./region-snapshot";

/** 页面尺寸（scale=1 基准，PDF 用户单位） */
export interface PageSize {
	width: number;
	height: number;
}

/**
 * 单页视图：占位容器 + 位图 img + 文本层 + 覆盖层（overlay 由 ExcerptLayer 使用）。
 *
 * - 打开文档时先用第 1 页尺寸占位（避免千页文档逐页取尺寸卡顿），
 *   进入预渲染区后再以真实页尺寸校正（多数 PDF 页面同尺寸，校正通常无感）
 * - 渲染与卸载分离：unrender 释放位图，容器高度保留以防滚动跳动
 * - **位图显示走 <img> 而非 canvas**：部分环境（新版 Electron + Windows 缩放/GPU）
 *   canvas 位图无法上屏（元素可见、位图有数据、屏幕空白），img 的图像合成路径不受影响；
 *   pdf.js 照常渲染到离屏 canvas，完成后 toBlob → blob URL → img.src
 * - 层级：img（底）→ 文本层（透明可选中）→ overlay（高亮 + 拖框，最上层）
 * - 高亮用 % 定位挂在 overlay 上，缩放时无需重排
 */
export class PageView {
	/** 页面容器（.marinmind-pdf-page，定位上下文 + 占位高度承载者） */
	readonly el: HTMLElement;
	/** 文本层（.marinmind-text-layer，透明可选中 spans，划选文字摘录用） */
	readonly textLayerEl: HTMLElement;
	/** 摘录/高亮覆盖层（.marinmind-pdf-overlay，absolute 铺满页面） */
	readonly overlayEl: HTMLElement;

	/** 显示载体（位图 blob URL）；离屏渲染 canvas 由 PdfDocument.renderTo 使用 */
	private imgEl: HTMLImageElement | null = null;
	private renderCanvas: HTMLCanvasElement | null = null;
	/** 当前位图的 blob URL（换图/卸载时 revoke，防泄漏） */
	private blobUrl: string | null = null;
	private ticket: RenderTicket | null = null;
	private exactSize: PageSize | null = null;
	/** 渲染序号：位图转换/文本层异步填充时校验，防止缩放/卸载后的过期结果覆盖新状态 */
	private renderSerial = 0;
	/** 位图是否有效（渲染完成且未卸载）——snapshotRegion 的前置条件 */
	private renderedOk = false;
	/** 可重排文档内容容器（㊻-B md / ㊼ epub）：替代位图/文本层，高度内容驱动 */
	private reflowContentEl: HTMLElement | null = null;

	constructor(
		/** 1-based 页码，与 Card.page 一致 */
		readonly pageNumber: number,
		private placeholder: PageSize,
	) {
		this.el = document.createElement("div");
		this.el.classList.add("marinmind-pdf-page");
		this.el.style.setProperty("--marinmind-page", String(pageNumber));

		this.textLayerEl = document.createElement("div");
		this.textLayerEl.classList.add("marinmind-text-layer");

		this.overlayEl = document.createElement("div");
		this.overlayEl.classList.add("marinmind-pdf-overlay");

		this.el.appendChild(this.textLayerEl);
		this.el.appendChild(this.overlayEl);
	}

	/**
	 * 可重排文档模式（㊻-B md / ㊼ epub）：渲染内容容器替换文本层位置（不建
	 * 位图/文本层）。调用后本页进入 reflow 态——layout 只定宽度、高度由内容
	 * 驱动，快照/卸载/懒渲染均降级为 no-op；overlay 照常铺满承载高亮回显。
	 * kind 决定修饰类：md 单页关 content-visibility（内容本体不可折叠），
	 * epub 多章保留基类 auto（离屏章折叠，进预渲染区展开）。
	 */
	setReflowContent(content: HTMLElement, kind: "md" | "epub"): void {
		this.reflowContentEl = content;
		this.el.classList.add(kind === "md" ? "marinmind-md-page" : "marinmind-epub-page");
		this.el.insertBefore(content, this.overlayEl);
	}

	/** reflow 态判定（阅读器据此跳过懒渲染/尺寸巡检/快照回填等 PDF 专属路径） */
	get isReflow(): boolean {
		return this.reflowContentEl !== null;
	}

	/**
	 * ㊼ epub：章节渲染后以实测高度内联锚定 contain-intrinsic-size（覆盖基类
	 * 1000px 占位估值）——离屏折叠时占位即真实高度，滚动条稳定；px 非正忽略。
	 */
	setIntrinsicHeight(px: number): void {
		if (px > 0) {
			this.el.style.setProperty("contain-intrinsic-size", `auto ${Math.round(px)}px`);
		}
	}

	/** 以真实页尺寸替换占位尺寸（进入预渲染区、getPage 之后调用） */
	setExactSize(size: PageSize): void {
		this.exactSize = size;
	}

	/** 真实尺寸是否已获取（IO 预渲染/后台巡检跳过重复 getPageSize 的判据，㊳） */
	hasExactSize(): boolean {
		return this.exactSize !== null;
	}

	private get size(): PageSize {
		return this.exactSize ?? this.placeholder;
	}

	/**
	 * 按缩放设置容器 CSS 尺寸（占位高度由容器承载，卸载 canvas 也不会塌陷）。
	 * ㊳ 混合页尺寸 = 统一列宽语义：所有页显示宽 = 第 1 页（placeholder）宽 × scale，
	 * 高按自身宽高比换算——宽页（横版/折页）不再被 overflow-x 裁切；
	 * 统一尺寸 PDF（exact 与 placeholder 同宽）与旧实现逐值相同，零回归。
	 */
	layout(scale: number): void {
		const w = Math.floor(this.placeholder.width * scale);
		if (this.reflowContentEl) {
			// reflow 态（㊻-B md / ㊼ epub）：只定列宽、高度内容驱动（定比公式
			// 不适用长文）；content-visibility 由修饰类分流（md 关闭，epub 保留 auto）
			this.el.setCssStyles({ width: `${w}px` });
			this.el.setCssStyles({ height: "" });
			return;
		}
		const { width, height } = this.size;
		this.el.setCssStyles({ width: `${w}px` });
		this.el.setCssStyles({ height: `${Math.floor((w * height) / width)}px` });
	}

	/** 当前页显示宽度（供坐标换算用） */
	get displayWidth(): number {
		return this.el.clientWidth;
	}

	/** 当前页显示高度（供坐标换算用） */
	get displayHeight(): number {
		return this.el.clientHeight;
	}

	/** canvas 是否已挂载（用于缩放后判断哪些页需要立即重渲染；reflow 态恒 true 免重渲染路径） */
	isRendered(): boolean {
		return this.reflowContentEl !== null || this.imgEl !== null;
	}

	/** 本页基准尺寸（scale=1，exact 优先）——手写层笔迹归一化的页基准（㊳） */
	get baseSize(): PageSize {
		return this.size;
	}

	/** 渲染本页：离屏 canvas 绘制（pdf.js）→ toBlob → img 显示；文本层异步填充，过期结果自动丢弃 */
	render(doc: PdfDocument, scale: number, onBitmapReady?: () => void): void {
		const serial = ++this.renderSerial;
		// ㊳ 混合页尺寸：本页实际显示宽 = 列宽（placeholder 宽 × scale），折算本页
		// 有效缩放——位图与文本层共用，保证文本层与位图/高亮对齐
		const eff = (this.placeholder.width * scale) / this.size.width;
		// 新渲染在途时旧位图随时可能被清/半绘，快照窗口关闭直到新位图就绪
		this.renderedOk = false;
		if (!this.renderCanvas || !this.imgEl) {
			this.renderCanvas = document.createElement("canvas"); // 离屏：只作渲染目标，永不挂 DOM
			this.imgEl = document.createElement("img");
			this.imgEl.className = "marinmind-pdf-img";
			this.imgEl.decoding = "async";
			this.el.insertBefore(this.imgEl, this.textLayerEl);
		}
		const canvas = this.renderCanvas;
		const img = this.imgEl;
		this.ticket = doc.renderTo(canvas, this.pageNumber, eff);
		// 位图就绪后转 blob URL 换载到 img（toBlob 异步，双段 serial 校验防过期换图）
		void this.ticket.done
			.then(() => {
				if (serial !== this.renderSerial) {
					return;
				}
				canvas.toBlob((blob) => {
					if (serial !== this.renderSerial || !blob) {
						return;
					}
					if (this.blobUrl) {
						URL.revokeObjectURL(this.blobUrl);
					}
					this.blobUrl = URL.createObjectURL(blob);
					img.src = this.blobUrl;
					this.renderedOk = true;
					onBitmapReady?.();
				}, "image/png");
			})
			.catch(() => undefined);

		void doc
			.buildTextLayer(this.pageNumber, eff)
			.then((specs) => {
				if (serial !== this.renderSerial) {
					return; // 缩放/卸载后过期
				}
				this.textLayerEl.replaceChildren(
					...specs.map((spec) => {
						const span = document.createElement("span");
						span.textContent = spec.text;
						span.setCssStyles({ left: `${spec.left}px` });
						span.setCssStyles({ top: `${spec.top}px` });
						span.setCssStyles({ fontSize: `${spec.fontSize}px` });
						return span;
					}),
				);
			})
			.catch(() => undefined);
	}

	/** 释放位图与文本层（远离视口时控制内存），容器高度保留；reflow 态无位图 no-op */
	unrender(): void {
		if (this.reflowContentEl) {
			return; // 可重排内容是唯一形态，卸载即空页
		}
		++this.renderSerial;
		this.renderedOk = false;
		this.ticket?.cancel();
		this.ticket = null;
		this.textLayerEl.replaceChildren();
		if (this.blobUrl) {
			URL.revokeObjectURL(this.blobUrl);
			this.blobUrl = null;
		}
		this.imgEl?.remove();
		this.imgEl = null;
		this.renderCanvas = null;
	}

	/**
	 * 裁剪本页摘录区域为图片字节（⑳ 区域/套索快照；㉛ 起优先 WebP，环境不支持回退 PNG）：
	 * 位图无效（未渲染/在途/已卸载）返回 null，由调用方决定降级——
	 * 新建摘录时等价于"无快照照常建卡"，回填场景留待下次渲染重试。
	 * ㊽ reflow 态（md/epub）：DOM 窗口化栅格化出图，同一裁剪/编码管线（含套索 clip）。
	 */
	async snapshotRegion(
		rect: DocRect,
		polygon: NormPoint[] | null,
	): Promise<SnapshotImage | null> {
		if (this.reflowContentEl) {
			return await snapshotDomRegion(this.el, rect, polygon);
		}
		if (!this.renderedOk || !this.renderCanvas) {
			return null;
		}
		return cropRegionSnapshot(this.renderCanvas, rect, polygon);
	}
}
