import { TFile, FileView, Menu, Notice, Platform, debounce } from "obsidian";
import type { ViewStateResult, WorkspaceLeaf } from "obsidian";
import type MarinMindPlugin from "../main";
import { MindmapPickerModal } from "../mindmap/mindmap-picker-modal";
import { ConfirmModal } from "../mindmap/confirm-modal";
import { suggestRootPosition } from "../mindmap/mindmap-graph";
import { ocrCanvasRegions } from "../ocr/ocr-service";
import type { Card, DocRect } from "../types";
import { AudioRecorder } from "./audio-recorder";
import { ExcerptLayer, flashEl } from "./excerpt-layer";
import { HandwriteLayer } from "./handwrite-layer";
import { MediaPreviewModal } from "./media-preview-modal";
import { TextPromptModal } from "./note-edit-modal";
import { PageView } from "./page-view";
import { PdfDocument } from "./pdf-document";
import { jumpAnchorY, rectsRelativeToPage, type ViewportRect } from "./rect-utils";

/** 阅读视图的 viewType（不与内置 'pdf' 冲突，不接管默认打开方式） */
export const READER_VIEW_TYPE = "marinmind-reader";

/** 缩放边界 */
const MIN_ZOOM = 0.2;
const MAX_ZOOM = 5;
/** 缩放按钮步长倍率 */
const ZOOM_STEP = 1.25;
/** fit-width 计算预留的滚动容器水平内边距（与 CSS padding 12px×2 对应） */
const SCROLL_PADDING_X = 24;

/** 照片/语音卡的菜单标签 */
function mediaCardLabel(card: Card): string {
	const page = card.page != null ? ` · 第 ${card.page} 页` : "";
	if (card.excerptType === "audio") {
		return `语音摘录${page}`;
	}
	if (card.excerptType === "handwriting") {
		return `手写摘录${page}`;
	}
	return `照片摘录${page}`;
}

/** MIME 类型 → 图片扩展名（未知类型兜底 png） */
function imageExtOf(mime: string): string {
	const map: Record<string, string> = {
		"image/png": "png",
		"image/jpeg": "jpg",
		"image/webp": "webp",
		"image/gif": "gif",
		"image/svg+xml": "svg",
		"image/bmp": "bmp",
	};
	return map[mime] ?? "png";
}

/** 毫秒 → m:ss（录音计时显示） */
function formatMs(ms: number): string {
	const s = Math.floor(ms / 1000);
	return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

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
	private readonly handwriteLayers = new Map<number, HandwriteLayer>();
	private io: IntersectionObserver | null = null;
	/** 加载代际：onLoadFile 重入时旧流程作废 */
	private loadToken = 0;

	private scrollEl: HTMLElement | null = null;
	/** 待跳转的页码（setState 暂存，加载完成后滚动定位） */
	private pendingPage: number | null = null;
	/** 待定位的卡片（setState 暂存，滚到页后精滚到矩形并闪烁高亮） */
	private pendingCardId: string | null = null;
	/** fit 模式基准页宽（取第 1 页 scale=1 宽度） */
	private basePageWidth = 0;
	private scale = 1;
	private zoomMode: "fit" | "fixed" = "fit";
	private excerptMode = false;
	private handwriteMode = false;
	private currentDocId: string | null = null;
	private currentFilePath: string | null = null;

	/** photo/audio 卡按页分组（页角徽标数据源，运行期增删维护） */
	private readonly mediaCardsByPage = new Map<number, Card[]>();
	private readonly mediaBadges = new Map<number, HTMLElement>();
	/** 录音状态条与计时器 */
	private recorder: AudioRecorder | null = null;
	private recBar: HTMLElement | null = null;
	private recTimer: ReturnType<typeof setInterval> | null = null;
	/** 互斥模式的两个工具栏按钮（状态同步用） */
	private excerptBtn: HTMLElement | null = null;
	private handwriteBtn: HTMLElement | null = null;
	/** 卡片变更事件退订器（onClose 统一退订防泄漏） */
	private cardBusOffs: Array<() => void> = [];

	/** 滚动离开手写页后延迟提交（防抖） */
	private readonly commitOffscreenSoon: () => void;

	private readonly rerenderSoon: () => void;

	constructor(leaf: WorkspaceLeaf, plugin: MarinMindPlugin) {
		super(leaf);
		this.plugin = plugin;
		// 卡片变更订阅（跨标签同步；回调只做 DOM/内存更新，禁止写库——契约见 card-bus.ts）
		this.cardBusOffs.push(
			plugin.cardBus.onCardChanged((card) => this.handleCardChanged(card)),
			plugin.cardBus.onCardRemoved((cardId, last) => this.handleCardRemoved(cardId, last)),
		);

		// 工具栏：摘录开关 / 手写开关 / 插图 / 录音 / 放大 / 缩小 / 适应宽度
		this.excerptBtn = this.addAction("square-pen", "区域摘录模式", () => {
			this.setExcerptMode(!this.excerptMode);
		});
		this.handwriteBtn = this.addAction("pencil-line", "手写批注模式", () => {
			this.setHandwriteMode(!this.handwriteMode);
		});
		this.addAction("image-plus", "插入图片摘录（亦可粘贴 / 拖入）", () => this.pickImages());
		this.addAction("mic", "录音摘录", () => void this.toggleRecording());
		this.addAction("zoom-in", "放大", () => this.setZoom(this.scale * ZOOM_STEP));
		this.addAction("zoom-out", "缩小", () => this.setZoom(this.scale / ZOOM_STEP));
		this.addAction("stretch-horizontal", "适应宽度", () => this.fitWidth());

		this.rerenderSoon = debounce(() => this.handleResize(), 200, true);
		this.commitOffscreenSoon = debounce(() => this.commitOffscreenInk(), 400, true);

		// 划选文字摘录：鼠标松开 / Shift+方向键调整选区后尝试生成 text 卡片
		this.registerDomEvent(this.contentEl, "mouseup", () => this.handleSelectionEnd());
		this.registerDomEvent(this.contentEl, "keyup", (evt: KeyboardEvent) => {
			if (evt.key === "Shift" || evt.key.startsWith("Arrow")) {
				this.handleSelectionEnd();
			}
		});

		// 照片摘录三入口之二：粘贴（挂 document，仅本视图激活时响应）与拖入
		this.registerDomEvent(document, "paste", (evt) => this.onPaste(evt));
		this.registerDomEvent(this.contentEl, "dragover", (evt) => evt.preventDefault());
		this.registerDomEvent(this.contentEl, "drop", (evt) => this.onDrop(evt));

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
				readAttachment: (ref) => this.plugin.attachments.read(ref),
			});
			layer.setExcerptMode(this.excerptMode);
			this.excerptLayers.set(n, layer);
			const hw = new HandwriteLayer(pv, { getScale: () => this.scale });
			hw.setHandwriteMode(this.handwriteMode);
			this.handwriteLayers.set(n, hw);
			this.pageViews.push(pv);
		}

		// 滚动离开手写页 → 延迟提交该页笔迹（页面骨架卸载不影响手写层，但尽早成卡便于回显）
		this.registerDomEvent(this.scrollEl, "scroll", () => {
			if (this.handwriteMode) {
				this.commitOffscreenSoon();
			}
		});

		// 回显已有卡片高亮（按页分组）；photo/audio 卡进页角徽标数据源
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
			const media = cards.filter((c) => c.excerptType === "photo" || c.excerptType === "audio");
			if (media.length > 0) {
				this.mediaCardsByPage.set(page, media);
				this.updateMediaBadge(page);
			}
		}

		this.setupLazyRender();
	}

	async onUnloadFile(file: TFile): Promise<void> {
		this.cleanupContent();
		this.contentEl.empty();
		this.currentFilePath = null;
	}

	/**
	 * 页码/卡片经 setViewState state 传入（跳转原文入口）。
	 * 应用点必须在 await super.setState() 之后：同文件时 FileView 不会重跑
	 * onLoadFile，若只在加载末尾应用，pending 永不消费；
	 * state 无 page 时清空 pending（历史导航恢复不得重置用户滚动位置）。
	 */
	async setState(
		state: { file?: string; page?: number; cardId?: string } & Record<string, unknown>,
		result: ViewStateResult,
	): Promise<void> {
		this.pendingPage = typeof state.page === "number" ? state.page : null;
		this.pendingCardId = typeof state.cardId === "string" ? state.cardId : null;
		await super.setState(state, result);
		await this.applyPendingPage();
	}

	protected async onClose(): Promise<void> {
		for (const off of this.cardBusOffs) {
			off();
		}
		this.cardBusOffs = [];
		this.cleanupContent();
		this.contentEl.empty();
	}

	// ---------- 卡片变更事件（跨标签同步，⑨-B） ----------

	/**
	 * 卡片创建/更新：本视图打开的文档才处理。
	 * photo/audio 走页角徽标数据；其余走摘录层——已登记只更新缓存
	 * （本标签写库的回环），未登记则回显（另一标签页新建的摘录）。
	 */
	private handleCardChanged(card: Card): void {
		if (card.documentId !== this.currentDocId || card.page == null) {
			return;
		}
		if (card.excerptType === "photo" || card.excerptType === "audio") {
			const list = this.mediaCardsByPage.get(card.page);
			const i = list?.findIndex((c) => c.id === card.id) ?? -1;
			if (list && i >= 0) {
				list[i] = card;
			} else {
				this.addMediaCard(card.page, card);
			}
			return;
		}
		this.excerptLayers.get(card.page)?.syncCard(card);
	}

	/** 卡片删除：移除高亮与徽标数据（cleanup 后各 Map 已清空，天然 no-op） */
	private handleCardRemoved(_cardId: string, last: Card): void {
		if (last.documentId !== this.currentDocId || last.page == null) {
			return;
		}
		this.excerptLayers.get(last.page)?.removeHighlight(last.id);
		this.removeMediaCard(last);
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

	/** 滚动定位到 pending 页（跳转原文入口；加载失败分支静默丢弃），再精确定位卡片 */
	private async applyPendingPage(): Promise<void> {
		const page = this.pendingPage;
		const cardId = this.pendingCardId;
		this.pendingPage = null;
		this.pendingCardId = null;
		if (page == null) {
			return;
		}
		const pv = this.pageViews.find((p) => p.pageNumber === page);
		const pdf = this.pdf;
		const scroll = this.scrollEl;
		if (!pv || !pdf || !scroll) {
			return;
		}
		const token = this.loadToken;
		try {
			// 目标页可能仍是第 1 页占位尺寸：先校正再滚，消除大头偏差
			pv.setExactSize(await pdf.getPageSize(page));
		} catch {
			return; // 文档已销毁 / 页码越界：丢弃
		}
		if (token !== this.loadToken) {
			return;
		}
		pv.layout(this.scale);
		// getBoundingClientRect 差值定位（offsetTop 的 offsetParent 链不含 scrollEl，不可靠）
		const rootTop = scroll.getBoundingClientRect().top;
		const pageTop = pv.el.getBoundingClientRect().top;
		scroll.scrollTop += pageTop - rootTop - 12; // 12px 顶部留白（对应容器 padding）
		if (cardId) {
			this.locateCard(cardId, pv, scroll);
		}
		// 目标页渲染交给 IntersectionObserver：滚动后自动进入预渲染区异步渲染
	}

	/**
	 * 精确定位卡片：滚动到矩形上方约 1/4 视口处并闪烁高亮。
	 * photo/audio 卡（无矩形）降级为闪烁页角徽标；卡片不属于当前文档时只滚到页。
	 */
	private locateCard(cardId: string, pv: PageView, scroll: HTMLElement): void {
		const card = this.plugin.cards.get(cardId);
		if (!card || card.documentId !== this.currentDocId) {
			return;
		}
		const anchor = jumpAnchorY(card.rects);
		if (anchor == null) {
			// 无矩形（照片/语音卡）：闪页角徽标作为视觉锚点
			if (card.page != null) {
				this.flashMediaBadge(card.page);
			}
			return;
		}
		// 锚点 = 页内归一化 y × 页高（layout 后的实测高度），目标让它落在视口上部约 1/4 处
		const anchorPx = pv.el.clientHeight * anchor;
		const current = pv.el.getBoundingClientRect().top - scroll.getBoundingClientRect().top;
		const target = Math.max(0, anchorPx - scroll.clientHeight * 0.25);
		scroll.scrollTop += current + target;
		this.excerptLayers.get(pv.pageNumber)?.flashHighlights(cardId);
	}

	/** 页角媒体徽标闪烁（photo/audio 卡跳转降级锚点） */
	private flashMediaBadge(page: number): void {
		const badge = this.mediaBadges.get(page);
		if (!badge) {
			return;
		}
		flashEl(badge);
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
		if (on === this.excerptMode) {
			return; // 幂等 + 防互斥递归
		}
		this.excerptMode = on;
		if (on) {
			this.setHandwriteMode(false); // 互斥：overlay 只能有一个指针捕获者
		}
		for (const layer of this.excerptLayers.values()) {
			layer.setExcerptMode(on);
		}
		this.excerptBtn?.classList.toggle("is-active", on);
	}

	/** 手写模式开关（与摘录模式互斥；关闭时提交全部未提交笔迹） */
	private setHandwriteMode(on: boolean): void {
		if (on === this.handwriteMode) {
			return; // 幂等 + 防互斥递归
		}
		this.handwriteMode = on;
		if (on) {
			this.setExcerptMode(false);
		} else {
			for (const [page, layer] of this.handwriteLayers) {
				if (layer.hasInk()) {
					this.commitHandwrite(page);
				}
			}
		}
		for (const layer of this.handwriteLayers.values()) {
			layer.setHandwriteMode(on);
		}
		this.handwriteBtn?.classList.toggle("is-active", on);
	}

	/** 滚动离开的带笔迹页：整页移出视口即提交（还在视口内的保留继续画） */
	private commitOffscreenInk(): void {
		const scroll = this.scrollEl;
		if (!scroll) {
			return;
		}
		const box = scroll.getBoundingClientRect();
		for (const [page, layer] of this.handwriteLayers) {
			if (!layer.hasInk()) {
				continue;
			}
			const pb = this.pageViews
				.find((p) => p.pageNumber === page)
				?.el.getBoundingClientRect();
			// 页面与滚动视口完全不相交 → 已滚离，提交
			if (pb && (pb.bottom < box.top || pb.top > box.bottom)) {
				this.commitHandwrite(page);
			}
		}
	}

	/** 提交某页手写层：落库建卡 + img 高亮回显（docId 在异步前同步捕获） */
	private commitHandwrite(page: number): void {
		const layer = this.handwriteLayers.get(page);
		const docId = this.currentDocId;
		if (!layer || !layer.hasInk() || !docId) {
			return;
		}
		void layer
			.commit()
			.then(async (result) => {
				if (!result || !docId) {
					return;
				}
				const ref = await this.plugin.attachments.save(result.png, "png");
				const card = this.plugin.cards.create({
					documentId: docId,
					page,
					rects: [result.bbox],
					excerptType: "handwriting",
					excerptRef: ref,
					color: "green",
				});
				// 回显由 cardBus 事件回环完成（cleanup 后 excerptLayers 已清空则跳过，
				// 重开文档自然回显）
			})
			.catch((err) => {
				console.error("[MarinMind] 手写提交失败", err);
				new Notice("手写摘录保存失败");
			});
	}

	/** 视口中心所在页（照片/音频锚定用；占位尺寸下可能偏差 ±1 页，可接受） */
	getCurrentPage(): number {
		const scroll = this.scrollEl;
		if (!scroll || this.pageViews.length === 0) {
			return 1;
		}
		const cy = scroll.getBoundingClientRect().top + scroll.clientHeight / 2;
		for (const pv of this.pageViews) {
			const b = pv.el.getBoundingClientRect();
			if (cy >= b.top && cy < b.bottom) {
				return pv.pageNumber;
			}
		}
		// 落在页间隙：回退最近页
		let best = this.pageViews[0];
		let bestDist = Infinity;
		for (const pv of this.pageViews) {
			const b = pv.el.getBoundingClientRect();
			const d = Math.abs(b.top + b.height / 2 - cy);
			if (d < bestDist) {
				bestDist = d;
				best = pv;
			}
		}
		return best.pageNumber;
	}

	// ---------- 照片摘录（粘贴 / 拖入 / 按钮选图） ----------

	private onPaste(evt: ClipboardEvent): void {
		// 挂 document：必须限定本视图激活，否则别的标签复制图片也会被吞
		if (this.app.workspace.activeLeaf !== this.leaf) {
			return;
		}
		this.handleImageFiles(Array.from(evt.clipboardData?.files ?? []));
	}

	private onDrop(evt: DragEvent): void {
		// dragover 已 preventDefault，这里也必须阻止默认（浏览器直接打开文件）
		evt.preventDefault();
		this.handleImageFiles(Array.from(evt.dataTransfer?.files ?? []));
	}

	/** 工具栏按钮选图（隐藏 file input，移动端同样可用） */
	private pickImages(): void {
		const input = document.createElement("input");
		input.type = "file";
		input.accept = "image/*";
		input.multiple = true;
		input.style.display = "none";
		input.addEventListener("change", () => {
			this.handleImageFiles(Array.from(input.files ?? []));
			input.remove();
		});
		input.addEventListener("cancel", () => input.remove());
		document.body.appendChild(input);
		input.click();
	}

	/** 图片文件 → 附件 → photo 卡（锚定当前页；原样存字节保 EXIF 方向） */
	private handleImageFiles(files: File[]): void {
		const docId = this.currentDocId;
		if (files.filter((f) => f.type.startsWith("image/")).length === 0) {
			return;
		}
		if (!docId) {
			new Notice("请先在阅读器打开文档，再插入图片摘录");
			return;
		}
		const page = this.getCurrentPage();
		for (const file of files.filter((f) => f.type.startsWith("image/"))) {
			void file
				.arrayBuffer()
				.then(async (bytes) => {
					const ref = await this.plugin.attachments.save(bytes, imageExtOf(file.type));
					// 徽标回显由 cardBus 事件回环完成（本标签或另一标签打开同文档均生效）
					this.plugin.cards.create({
						documentId: docId,
						page,
						rects: [],
						excerptType: "photo",
						excerptRef: ref,
						color: "pink",
					});
				})
				.catch((err) => {
					console.error("[MarinMind] 图片保存失败", err);
					new Notice("图片保存失败");
				});
		}
	}

	// ---------- 录音摘录 ----------

	private async toggleRecording(): Promise<void> {
		if (this.recorder?.active) {
			await this.stopAndSaveRecording();
			return;
		}
		if (!this.currentDocId) {
			new Notice("请先在阅读器打开文档，再录音");
			return;
		}
		try {
			this.recorder ??= new AudioRecorder();
			await this.recorder.start();
			this.showRecBar();
		} catch (err) {
			console.warn("[MarinMind] 麦克风不可用", err);
			new Notice("无法访问麦克风：请在系统设置中允许 Obsidian 使用麦克风");
			this.recorder = null;
		}
	}

	/** 停止录音并保存为 audio 卡（docId/page 在异步前同步捕获） */
	private async stopAndSaveRecording(): Promise<void> {
		const rec = this.recorder;
		if (!rec?.active) {
			return;
		}
		const docId = this.currentDocId;
		const page = this.getCurrentPage();
		this.removeRecBar();
		try {
			const { bytes, ext } = await rec.stop();
			if (!docId) {
				new Notice("录音已丢弃（未打开文档）");
				return;
			}
			if (bytes.byteLength === 0) {
				new Notice("录音为空，已忽略");
				return;
			}
			const ref = await this.plugin.attachments.save(bytes, ext);
			// 徽标回显由 cardBus 事件回环完成
			this.plugin.cards.create({
				documentId: docId,
				page,
				rects: [],
				excerptType: "audio",
				excerptRef: ref,
				color: "pink",
			});
			new Notice(`语音摘录已保存（第 ${page} 页）`);
		} catch (err) {
			console.error("[MarinMind] 录音保存失败", err);
			new Notice("录音保存失败");
		}
	}

	/** 录音状态条：红点 + 计时 + 保存/丢弃 */
	private showRecBar(): void {
		this.removeRecBar();
		const bar = this.contentEl.createDiv({ cls: "marinmind-rec-bar" });
		bar.createSpan({ cls: "marinmind-rec-dot" });
		const time = bar.createSpan({ cls: "marinmind-rec-time" });
		const save = bar.createEl("button", { text: "保存并建卡" });
		save.addEventListener("click", () => void this.stopAndSaveRecording());
		const drop = bar.createEl("button", { text: "丢弃" });
		drop.addEventListener("click", () => {
			this.removeRecBar();
			this.recorder?.discard();
			new Notice("已丢弃录音");
		});
		this.recBar = bar;
		const update = () => {
			time.textContent = formatMs(this.recorder?.elapsedMs ?? 0);
		};
		update();
		this.recTimer = setInterval(update, 500);
	}

	private removeRecBar(): void {
		if (this.recTimer !== null) {
			clearInterval(this.recTimer);
			this.recTimer = null;
		}
		this.recBar?.remove();
		this.recBar = null;
	}

	// ---------- photo/audio 页角徽标 ----------

	private addMediaCard(page: number, card: Card): void {
		const list = this.mediaCardsByPage.get(page) ?? [];
		list.push(card);
		this.mediaCardsByPage.set(page, list);
		this.updateMediaBadge(page);
	}

	private removeMediaCard(card: Card): void {
		if (card.page == null) {
			return;
		}
		const list = this.mediaCardsByPage.get(card.page);
		if (!list) {
			return;
		}
		const next = list.filter((c) => c.id !== card.id);
		if (next.length > 0) {
			this.mediaCardsByPage.set(card.page, next);
		} else {
			this.mediaCardsByPage.delete(card.page);
		}
		this.updateMediaBadge(card.page);
	}

	/** 维护页角徽标 DOM（有媒体卡显示并计数，无则移除） */
	private updateMediaBadge(page: number): void {
		const cards = this.mediaCardsByPage.get(page) ?? [];
		let badge = this.mediaBadges.get(page);
		if (cards.length === 0) {
			badge?.remove();
			this.mediaBadges.delete(page);
			return;
		}
		if (!badge) {
			const pv = this.pageViews.find((p) => p.pageNumber === page);
			if (!pv) {
				return;
			}
			badge = pv.el.createDiv({ cls: "marinmind-media-badge" });
			badge.addEventListener("click", (evt) => {
				evt.stopPropagation();
				this.onMediaBadgeClick(page, evt);
			});
			this.mediaBadges.set(page, badge);
		}
		badge.setText(`${cards.length} 个媒体摘录`);
	}

	/** 页角徽标点击：列出该页媒体卡（点击查看与管理） */
	private onMediaBadgeClick(page: number, evt: MouseEvent): void {
		const cards = this.mediaCardsByPage.get(page) ?? [];
		if (cards.length === 0) {
			return;
		}
		const menu = new Menu();
		for (const card of cards) {
			const label = mediaCardLabel(card);
			menu.addItem((item) =>
				item
					.setTitle(card.note ? `${label} · ${card.note.slice(0, 24)}` : label)
					.setIcon(card.excerptType === "audio" ? "mic" : "image")
					.onClick(() => {
						new MediaPreviewModal(this.app, this.plugin, card, {
							// 批注/闪卡变更经 cardBus 事件同步；删除需发起方清附件
							onDelete: (victim) => this.deleteCard(victim),
						}).open();
					}),
			);
		}
		menu.showAtMouseEvent(evt);
	}

	/** 拖拽框选完成：创建 area 卡片并即时回显 */
	private createAreaCard(pageNumber: number, rect: DocRect): void {
		if (!this.currentDocId) {
			return;
		}
		// 高亮回显由 cardBus 事件回环完成
		this.plugin.cards.create({
			documentId: this.currentDocId,
			page: pageNumber,
			rects: [rect],
			excerptType: "area",
			color: "yellow",
		});
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
		// 高亮回显由 cardBus 事件回环完成
		this.plugin.cards.create({
			documentId: this.currentDocId,
			page,
			rects: rectsRelativeToPage(rects, pageBox),
			excerptType: "text",
			excerptText: text,
			color: "blue",
		});
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
		// 闪卡开关：每次打开菜单即时查 DB（卡片可能在会话外被改变）
		const isFlashcard = this.plugin.reviews.get(card.id)?.isFlashcard ?? false;
		menu.addItem((item) =>
			item
				.setTitle(isFlashcard ? "取消闪卡" : "转为闪卡")
				.setIcon(isFlashcard ? "layers" : "graduation-cap")
				.onClick(() => {
					if (isFlashcard) {
						this.plugin.reviews.disable(card.id);
					} else {
						this.plugin.reviews.enable(card.id);
					}
				}),
		);
		menu.addItem((item) =>
			item.setTitle("加入思维导图…").setIcon("git-fork").onClick(() => this.addToMindmap(card)),
		);
		// OCR：区域/手写摘录有矩形才可识别（文字摘录已有文本，照片无矩形）
		if (
			(card.excerptType === "area" || card.excerptType === "handwriting") &&
			card.page != null &&
			card.rects.length > 0
		) {
			menu.addItem((item) =>
				item
					.setTitle("识别文字 (OCR)")
					.setIcon("scan-text")
					.onClick(() => void this.ocrCard(card)),
			);
		}
		menu.addItem((item) =>
			item
				.setTitle("编辑批注")
				.setIcon("pencil")
				.onClick(() => {
					new TextPromptModal(
						this.app,
						{ title: "编辑批注", initialText: card.note ?? "" },
						(note) => {
							// 各视图同步由 cardBus 事件回环完成
							this.plugin.cards.update(card.id, { note });
						},
					).open();
				}),
		);
		menu.addItem((item) =>
			item
				.setTitle("删除卡片")
				.setIcon("trash-2")
				.onClick(() => this.deleteCard(card)),
		);
		menu.showAtMouseEvent(evt);
	}

	/**
	 * 区域/手写卡 OCR：离屏高清渲染该页 → 逐矩形识别 → 写回 excerptText。
	 * 渲染用 isolated 模式（不打断显示渲染也不被打断）；已有文字时确认覆盖；
	 * 失败 Notice 明示首次需联网下载引擎。
	 */
	private async ocrCard(card: Card): Promise<void> {
		// tesseract 的 worker/WASM 在移动端 Obsidian 不可用，入口直接禁用
		if (Platform.isMobile) {
			new Notice("移动端暂不支持 OCR");
			return;
		}
		const pdf = this.pdf;
		const page = card.page;
		if (!pdf || page == null || card.rects.length === 0) {
			return;
		}
		const notice = new Notice(
			"正在识别文字…（首次使用需联网下载引擎与中文语言包，约 10-20MB）",
			0,
		);
		try {
			const size = await pdf.getPageSize(page);
			// 目标物理宽约 2200px 的离屏渲染（renderTo 内部 16M 像素钳制自动兜底）
			const cssScale = Math.max(1, 2200 / size.width);
			const canvas = document.createElement("canvas");
			await pdf.renderTo(canvas, page, cssScale, { isolated: true }).done;
			if (canvas.width === 0) {
				return; // 渲染期文档被销毁（done 静默返回）：放弃本次识别
			}
			const text = await ocrCanvasRegions(canvas, card.rects, (u) => {
				if (u.progress != null && u.progress > 0 && u.progress < 1) {
					notice.setMessage(`正在识别文字… ${Math.round(u.progress * 100)}%`);
				}
			});
			if (!text) {
				new Notice("未识别出文字（区域可能不含文本，或清晰度不足）");
				return;
			}
			const apply = () => {
				// 各视图同步由 cardBus 事件回环完成
				this.plugin.cards.update(card.id, { excerptText: text });
				new Notice("已识别文字并写入卡片（复习/脑图自动显示该文本）");
			};
			if (card.excerptText) {
				new ConfirmModal(
					this.app,
					"覆盖已有识别文字？",
					"该卡片已有摘录文字，OCR 结果将替换它。",
					apply,
				).open();
			} else {
				apply();
			}
		} catch (err) {
			console.error("[MarinMind] OCR 失败", err);
			new Notice(
				"OCR 失败：首次使用需联网下载引擎（约 10-20MB），请检查网络或代理后重试",
			);
		} finally {
			notice.hide();
		}
	}

	/** 把卡片加入脑图：选图器（可就地新建）→ 根节点区顺延落位为根节点 */
	private addToMindmap(card: Card): void {
		new MindmapPickerModal(this.app, this.plugin, (map) => {
			const roots = this.plugin.mindmaps
				.listNodes(map.id)
				.filter((n) => n.parentId === null)
				.map((n) => ({ x: n.x, y: n.y }));
			const pos = suggestRootPosition(roots);
			const added = this.plugin.mindmaps.addNode(map.id, card.id, null, pos.x, pos.y);
			new Notice(
				added
					? `已加入脑图《${map.name}》（根节点区顺延落位）`
					: "该卡片已在此图中",
			);
		}).open();
	}

	private deleteCard(card: Card): void {
		// 高亮/徽标清理由 cardBus 事件回环完成（handleCardRemoved）
		this.plugin.cards.delete(card.id);
		// 附件随卡片级联删除：uid 唯一命名 ⇒ 一卡一附件（失败静默，下次清理兜底）
		if (card.excerptRef) {
			void this.plugin.attachments.remove(card.excerptRef).catch(() => undefined);
		}
	}

	/** 释放全部资源（幂等；onLoadFile 开头 / onUnloadFile / onClose 均调用） */
	private cleanupContent(): void {
		++this.loadToken; // 使在途加载流程作废
		// 录音中：保存而非丢弃（误关标签不损失已录内容；docId/page 由函数内部同步捕获）
		void this.stopAndSaveRecording();
		// 手写层：先提交未落库笔迹（layer.commit 同步快照，destroy 不影响其异步完成）
		for (const [page, layer] of this.handwriteLayers) {
			if (layer.hasInk()) {
				this.commitHandwrite(page);
			}
			layer.destroy();
		}
		this.handwriteLayers.clear();
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
		for (const badge of this.mediaBadges.values()) {
			badge.remove();
		}
		this.mediaBadges.clear();
		this.mediaCardsByPage.clear();
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
