import { TFile, FileView, Menu, Notice, debounce } from "obsidian";
import type { WorkspaceLeaf } from "obsidian";
import type MarinMindPlugin from "../main";
import type { Card, DocRect } from "../types";
import { ExcerptLayer } from "./excerpt-layer";
import { PageView } from "./page-view";
import { PdfDocument } from "./pdf-document";
import { rectsRelativeToPage, type ViewportRect } from "./rect-utils";

/** 阅读视图的 viewType（不与内置 'pdf' 冲突，不接管默认打开方式） */
export const READER_VIEW_TYPE = "marinmind-reader";

/** 缩放边界 */
const MIN_ZOOM = 0.2;
const MAX_ZOOM = 5;
/** 缩放按钮步长倍率 */
const ZOOM_STEP = 1.25;
/** fit-width 计算预留的滚动容器水平内边距（与 CSS padding 12px×2 对应） */
const SCROLL_PADDING_X = 24;

/**
 * MarinMind 阅读视图：PDF 连续滚动渲染 + 区域/文字摘录 + 高亮回显。
 *
 * 生命周期约定：
 * - onLoadFile 可能重入（快速切换/会话恢复），以 loadToken 代际守卫，
 *   每次 await 后校验，旧代际立即销毁其新建资源
 * - onUnloadFile 与 onClose 均走 cleanupContent（幂等）
 */
export class MarinMindReaderView extends FileView {
	private readonly plugin: MarinMindPlugin;

	private pdf: PdfDocument | null = null;
	private pageViews: PageView[] = [];
	private readonly excerptLayers = new Map<number, ExcerptLayer>();
	private io: IntersectionObserver | null = null;
	/** 加载代际：onLoadFile 重入时旧流程作废 */
	private loadToken = 0;

	private scrollEl: HTMLElement | null = null;
	/** fit 模式基准页宽（取第 1 页 scale=1 宽度） */
	private basePageWidth = 0;
	private scale = 1;
	private zoomMode: "fit" | "fixed" = "fit";
	private excerptMode = false;
	private currentDocId: string | null = null;
	private currentFilePath: string | null = null;

	private readonly rerenderSoon: () => void;

	constructor(leaf: WorkspaceLeaf, plugin: MarinMindPlugin) {
		super(leaf);
		this.plugin = plugin;

		// 工具栏：摘录开关 / 放大 / 缩小 / 适应宽度
		const excerptBtn = this.addAction("square-pen", "区域摘录模式", () => {
			this.setExcerptMode(!this.excerptMode);
			excerptBtn.classList.toggle("is-active", this.excerptMode);
		});
		this.addAction("zoom-in", "放大", () => this.setZoom(this.scale * ZOOM_STEP));
		this.addAction("zoom-out", "缩小", () => this.setZoom(this.scale / ZOOM_STEP));
		this.addAction("stretch-horizontal", "适应宽度", () => this.fitWidth());

		this.rerenderSoon = debounce(() => this.handleResize(), 200, true);

		// 划选文字摘录：鼠标松开 / Shift+方向键调整选区后尝试生成 text 卡片
		this.registerDomEvent(this.contentEl, "mouseup", () => this.handleSelectionEnd());
		this.registerDomEvent(this.contentEl, "keyup", (evt: KeyboardEvent) => {
			if (evt.key === "Shift" || evt.key.startsWith("Arrow")) {
				this.handleSelectionEnd();
			}
		});

		// 文件重命名：FileView.onRename 只给新路径，oldPath 需从 vault 事件取
		this.registerEvent(
			this.app.vault.on("rename", (file, oldPath) => {
				if (
					file instanceof TFile &&
					oldPath === this.currentFilePath &&
					oldPath !== file.path
				) {
					this.plugin.documents.renamePath(oldPath, file.path);
					this.currentFilePath = file.path;
				}
			}),
		);
		// 文件被删除：清空视图为提示态（卡片数据保留在库中，不级联删）
		this.registerEvent(
			this.app.vault.on("delete", (file) => {
				if (file instanceof TFile && file.path === this.currentFilePath) {
					this.cleanupContent();
					this.contentEl.empty();
					const tip = document.createElement("p");
					tip.textContent = "该文件已从库中删除。";
					tip.className = "marinmind-reader-tip";
					this.contentEl.appendChild(tip);
				}
			}),
		);
	}

	getViewType(): string {
		return READER_VIEW_TYPE;
	}

	/** 让当前 leaf 已是本视图时 openFile 也能复用（不注册扩展名，不影响默认打开） */
	canAcceptExtension(extension: string): boolean {
		return extension === "pdf";
	}

	getDisplayText(): string {
		return this.file?.basename ?? "MarinMind 阅读器";
	}

	getIcon(): string {
		return "book-open";
	}

	async onLoadFile(file: TFile): Promise<void> {
		const token = ++this.loadToken;
		this.cleanupContent();
		this.contentEl.empty();
		this.contentEl.classList.add("marinmind-reader");
		this.currentFilePath = file.path;

		// 等数据层就绪（会话恢复时视图可能先于数据库创建）
		await this.plugin.whenReady();
		if (!this.plugin.db) {
			this.showTip("MarinMind 数据库未就绪，无法加载摘录数据。");
			return;
		}
		if (token !== this.loadToken) {
			return;
		}

		// 读取并打开 PDF
		const buf = await this.app.vault.readBinary(file);
		if (token !== this.loadToken) {
			return;
		}
		const pdf = await PdfDocument.open(buf);
		if (token !== this.loadToken) {
			await pdf.destroy();
			return;
		}
		this.pdf = pdf;

		// 文档登记（以路径为业务键，重复打开复用记录）
		const doc = this.plugin.documents.upsertByPath(file.path, file.basename);
		this.currentDocId = doc.id;

		// 滚动容器 + 各页骨架（先用第 1 页尺寸占位）
		const first = await pdf.getPageSize(1);
		if (token !== this.loadToken) {
			return;
		}
		this.basePageWidth = first.width;

		this.scrollEl = document.createElement("div");
		this.scrollEl.classList.add("marinmind-pdf-scroll");
		this.contentEl.appendChild(this.scrollEl);

		this.zoomMode = "fit";
		this.scale = this.computeFitScale();

		for (let n = 1; n <= pdf.numPages; n++) {
			const pv = new PageView(n, first);
			pv.layout(this.scale);
			this.scrollEl.appendChild(pv.el);
			const layer = new ExcerptLayer(pv, {
				isExcerptMode: () => this.excerptMode,
				onCreateAreaCard: (page, rect) => this.createAreaCard(page, rect),
				onHighlightClick: (card, evt) => this.onHighlightClick(card, evt),
			});
			layer.setExcerptMode(this.excerptMode);
			this.excerptLayers.set(n, layer);
			this.pageViews.push(pv);
		}

		// 回显已有卡片高亮（按页分组）
		const byPage = new Map<number, Card[]>();
		for (const card of this.plugin.cards.listByDocument(doc.id)) {
			if (card.page == null) {
				continue;
			}
			const list = byPage.get(card.page) ?? [];
			list.push(card);
			byPage.set(card.page, list);
		}
		for (const [page, cards] of byPage) {
			this.excerptLayers.get(page)?.setCards(cards);
		}

		this.setupLazyRender();
	}

	async onUnloadFile(file: TFile): Promise<void> {
		this.cleanupContent();
		this.contentEl.empty();
		this.currentFilePath = null;
	}

	protected async onClose(): Promise<void> {
		this.cleanupContent();
		this.contentEl.empty();
	}

	onResize(): void {
		this.rerenderSoon();
	}

	// ---------- 内部实现 ----------

	/** 建立懒渲染：进入视口上方/下方各一屏的预渲染区才渲染，远离则卸载 canvas */
	private setupLazyRender(): void {
		const root = this.scrollEl;
		if (!root) {
			return;
		}
		const token = this.loadToken;
		this.io = new IntersectionObserver(
			(entries) => {
				for (const entry of entries) {
					const pv = this.pageViews.find((p) => p.el === entry.target);
					if (!pv) {
						continue;
					}
					if (entry.isIntersecting) {
						void this.pdf
							?.getPageSize(pv.pageNumber)
							.then((size) => {
								if (token !== this.loadToken || !this.pdf) {
									return;
								}
								pv.setExactSize(size);
								pv.layout(this.scale);
								pv.render(this.pdf, this.scale);
							})
							.catch(() => undefined);
					} else {
						pv.unrender();
					}
				}
			},
			{ root, rootMargin: "100% 0px", threshold: 0 },
		);
		for (const pv of this.pageViews) {
			this.io.observe(pv.el);
		}
	}

	/** fit 模式的目标缩放（容器宽度不可用时保持当前值，等 onResize 再算） */
	private computeFitScale(): number {
		const cw = this.scrollEl?.clientWidth ?? 0;
		if (!cw || !this.basePageWidth) {
			return this.scale || 1;
		}
		return Math.max(MIN_ZOOM, (cw - SCROLL_PADDING_X) / this.basePageWidth);
	}

	private fitWidth(): void {
		this.zoomMode = "fit";
		this.applyScale(this.computeFitScale());
	}

	private setZoom(scale: number): void {
		this.zoomMode = "fixed";
		this.applyScale(Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, scale)));
	}

	private applyScale(scale: number): void {
		this.scale = scale;
		for (const pv of this.pageViews) {
			pv.layout(scale);
		}
		// IO 不会对"已可见"的页重触发，手动重渲染当前已渲染的页
		const pdf = this.pdf;
		if (pdf) {
			for (const pv of this.pageViews) {
				if (pv.isRendered()) {
					pv.render(pdf, scale);
				}
			}
		}
	}

	private handleResize(): void {
		if (this.zoomMode === "fit") {
			this.applyScale(this.computeFitScale());
		}
	}

	private setExcerptMode(on: boolean): void {
		this.excerptMode = on;
		for (const layer of this.excerptLayers.values()) {
			layer.setExcerptMode(on);
		}
	}

	/** 拖拽框选完成：创建 area 卡片并即时回显 */
	private createAreaCard(pageNumber: number, rect: DocRect): void {
		if (!this.currentDocId) {
			return;
		}
		const card = this.plugin.cards.create({
			documentId: this.currentDocId,
			page: pageNumber,
			rects: [rect],
			excerptType: "area",
			color: "yellow",
		});
		this.excerptLayers.get(pageNumber)?.addHighlight(card);
	}

	/**
	 * 划选文字 → text 卡片闭环：
	 * 选区行矩形（getClientRects 实测，比 span 定位精确）按中心点归属页；
	 * 跨页选区拦截提示分次选择；蓝色高亮区别于区域摘录的黄色。
	 */
	private handleSelectionEnd(): void {
		if (this.excerptMode || !this.currentDocId) {
			return; // 摘录模式由 overlay 接管指针，不应存在文字选区
		}
		const sel = window.getSelection();
		if (!sel || sel.isCollapsed || sel.rangeCount === 0) {
			return;
		}
		const text = sel.toString().trim();
		if (!text) {
			return;
		}
		const range = sel.getRangeAt(0);
		// 选区可能来自应用其他区域（键盘残留），限定在本视图内才处理
		if (!this.contentEl.contains(range.commonAncestorContainer)) {
			return;
		}

		// 行矩形按中心点归属页（文本行的中心必落在渲染该文本的页面内）
		const rectsByPage = new Map<number, ViewportRect[]>();
		for (const r of Array.from(range.getClientRects())) {
			if (r.width <= 0 || r.height <= 0) {
				continue; // getClientRects 可能产生零尺寸行
			}
			const cx = r.left + r.width / 2;
			const cy = r.top + r.height / 2;
			const pv = this.pageViews.find((p) => {
				const box = p.el.getBoundingClientRect();
				return cx >= box.left && cx <= box.right && cy >= box.top && cy <= box.bottom;
			});
			if (!pv) {
				continue;
			}
			const list = rectsByPage.get(pv.pageNumber) ?? [];
			list.push({ left: r.left, top: r.top, width: r.width, height: r.height });
			rectsByPage.set(pv.pageNumber, list);
		}
		if (rectsByPage.size === 0) {
			return;
		}
		if (rectsByPage.size > 1) {
			new Notice("跨页摘录请分次选择");
			return;
		}

		const [page, rects] = [...rectsByPage.entries()][0];
		const pageBox = this.pageViews
			.find((p) => p.pageNumber === page)!
			.el.getBoundingClientRect();
		const card = this.plugin.cards.create({
			documentId: this.currentDocId,
			page,
			rects: rectsRelativeToPage(rects, pageBox),
			excerptType: "text",
			excerptText: text,
			color: "blue",
		});
		this.excerptLayers.get(page)?.addHighlight(card);
		sel.removeAllRanges();
	}

	/** 点击高亮：弹出卡片信息与操作菜单 */
	private onHighlightClick(card: Card, evt: MouseEvent): void {
		const info = card.note ?? card.excerptText ?? "区域摘录";
		const menu = new Menu();
		menu.addItem((item) =>
			item.setTitle(`第 ${card.page} 页 · ${info}`).setIcon("square-pen").setDisabled(true),
		);
		menu.addSeparator();
		menu.addItem((item) =>
			item
				.setTitle("删除卡片")
				.setIcon("trash-2")
				.onClick(() => this.deleteCard(card)),
		);
		menu.showAtMouseEvent(evt);
	}

	private deleteCard(card: Card): void {
		this.plugin.cards.delete(card.id);
		if (card.page != null) {
			this.excerptLayers.get(card.page)?.removeHighlight(card.id);
		}
	}

	/** 释放全部资源（幂等；onLoadFile 开头 / onUnloadFile / onClose 均调用） */
	private cleanupContent(): void {
		++this.loadToken; // 使在途加载流程作废
		this.io?.disconnect();
		this.io = null;
		for (const layer of this.excerptLayers.values()) {
			layer.destroy();
		}
		this.excerptLayers.clear();
		for (const pv of this.pageViews) {
			pv.unrender();
		}
		this.pageViews = [];
		void this.pdf?.destroy();
		this.pdf = null;
		this.scrollEl = null;
		this.currentDocId = null;
	}

	private showTip(text: string): void {
		this.contentEl.empty();
		const tip = document.createElement("p");
		tip.textContent = text;
		tip.className = "marinmind-reader-tip";
		this.contentEl.appendChild(tip);
	}
}
