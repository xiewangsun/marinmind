import type { PdfDocument, RenderTicket } from "./pdf-document";

/** 页面尺寸（scale=1 基准，PDF 用户单位） */
export interface PageSize {
	width: number;
	height: number;
}

/**
 * 单页视图：占位容器 + canvas + 覆盖层（overlay 由 ExcerptLayer 使用）。
 *
 * - 打开文档时先用第 1 页尺寸占位（避免千页文档逐页取尺寸卡顿），
 *   进入预渲染区后再以真实页尺寸校正（多数 PDF 页面同尺寸，校正通常无感）
 * - 渲染与卸载分离：unrender 释放 canvas 显存，容器高度保留以防滚动跳动
 * - 高亮用 % 定位挂在 overlay 上，缩放时无需重排
 */
export class PageView {
	/** 页面容器（.marinmind-pdf-page，定位上下文 + 占位高度承载者） */
	readonly el: HTMLElement;
	/** 摘录/高亮覆盖层（.marinmind-pdf-overlay，absolute 铺满页面） */
	readonly overlayEl: HTMLElement;

	private canvas: HTMLCanvasElement | null = null;
	private ticket: RenderTicket | null = null;
	private exactSize: PageSize | null = null;

	constructor(
		/** 1-based 页码，与 Card.page 一致 */
		readonly pageNumber: number,
		private placeholder: PageSize,
	) {
		this.el = document.createElement("div");
		this.el.classList.add("marinmind-pdf-page");
		this.el.style.setProperty("--marinmind-page", String(pageNumber));

		this.overlayEl = document.createElement("div");
		this.overlayEl.classList.add("marinmind-pdf-overlay");
		this.el.appendChild(this.overlayEl);
	}

	/** 以真实页尺寸替换占位尺寸（进入预渲染区、getPage 之后调用） */
	setExactSize(size: PageSize): void {
		this.exactSize = size;
	}

	private get size(): PageSize {
		return this.exactSize ?? this.placeholder;
	}

	/** 按缩放设置容器 CSS 尺寸（占位高度由容器承载，卸载 canvas 也不会塌陷） */
	layout(scale: number): void {
		const { width, height } = this.size;
		this.el.style.width = `${Math.floor(width * scale)}px`;
		this.el.style.height = `${Math.floor(height * scale)}px`;
	}

	/** 当前页显示宽度（供坐标换算用） */
	get displayWidth(): number {
		return this.el.clientWidth;
	}

	/** 当前页显示高度（供坐标换算用） */
	get displayHeight(): number {
		return this.el.clientHeight;
	}

	/** canvas 是否已挂载（用于缩放后判断哪些页需要立即重渲染） */
	isRendered(): boolean {
		return this.canvas !== null;
	}

	/** 渲染本页（懒创建 canvas；旧任务由 PdfDocument.renderTo 内部取消） */
	render(doc: PdfDocument, scale: number): void {
		if (!this.canvas) {
			this.canvas = document.createElement("canvas");
			this.el.insertBefore(this.canvas, this.overlayEl);
		}
		this.ticket = doc.renderTo(this.canvas, this.pageNumber, scale);
	}

	/** 释放 canvas（远离视口时控制内存），容器高度保留 */
	unrender(): void {
		this.ticket?.cancel();
		this.ticket = null;
		if (this.canvas) {
			this.canvas.remove();
			this.canvas = null;
		}
	}
}
