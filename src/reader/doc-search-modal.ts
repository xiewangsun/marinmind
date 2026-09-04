import { Modal } from "obsidian";
import type { App } from "obsidian";
import type { DocSearchHit, PdfSearchLine } from "./doc-search";
import { searchTexts, TOTAL_HIT_CAP } from "./doc-search";

/** 输入防抖（毫秒）：扫描比节点搜索重（PDF 逐页 worker 往返），停顿再起 */
const DEBOUNCE_MS = 250;
/** PDF 扫描每 N 页让出主线程（paint/交互优先；buildTextLayer 的 worker 往返本身已异步） */
const PDF_YIELD_PAGES = 8;
/** EPUB 扫描每 N 章让出主线程（readEntry + DOMParser 同步段较重） */
const EPUB_YIELD_CHAPTERS = 4;

/** 块级文本元素选择器（md 预览 / EPUB 净化后的通用块；innermost 判定见收集器） */
const BLOCK_SELECTOR =
	"p, h1, h2, h3, h4, h5, h6, li, blockquote, pre, dd, dt, td, th, figcaption";

/**
 * 收集容器内的块级文本元素（89-D；EPUB 源解析 / MD·EPUB 渲染后定位三路共用）：
 * 只取 innermost 块（li 含 p 时只收 p，防同段文本重复命中/重复闪）；空文本跳过。
 */
export function collectBlockEls(root: Element): HTMLElement[] {
	const all = Array.from(root.querySelectorAll(BLOCK_SELECTOR)) as HTMLElement[];
	return all.filter(
		(el) =>
			!el.querySelector(BLOCK_SELECTOR) && (el.textContent ?? "").trim().length > 0,
	);
}

/** 宿主注入项（由 ReaderView 实现）：三形态数据源 + 徽标文案 + 定位回调 */
export interface DocSearchHost {
	/** 文档形态；未加载文档返回 null（入口处已守卫，防御双保险） */
	docSearchKind(): "pdf" | "epub" | "md" | null;
	/** PDF：总页数 */
	docSearchPdfPageCount(): number;
	/** PDF：第 page 页聚行文本（scale=1 spec → 纯逻辑聚行）；无句柄返回 null */
	docSearchPdfLines(page: number): Promise<readonly PdfSearchLine[] | null>;
	/** EPUB：总章数 */
	docSearchEpubChapterCount(): number;
	/** EPUB：第 chapter 章（1 基）源解析块文本（未渲染章也能搜）；解析失败空数组 */
	docSearchEpubBlocks(chapter: number): string[];
	/** MD：活 DOM 块文本（源文本渲染后即弃，必须扫活 DOM） */
	docSearchMdBlocks(): string[];
	/** 结果行徽标文案（"第 12 页" / "第 3 章" / "第 15 段"） */
	docSearchHitLabel(hit: DocSearchHit): string;
	/** 定位展示命中（Modal 已 close 后调用） */
	docSearchReveal(hit: DocSearchHit, query: string): void;
}

/**
 * 文档内搜索弹窗（89-D，MN3 搜索入口对齐）：三形态（PDF 逐页 / EPUB 逐章 /
 * MD 单页块）全量扫描，进度行 + 渐进追加结果；250ms 防抖 + 代际令牌（改词/
 * 关闭即作废在途扫描）；↑↓/Enter 键盘导航；点选 → 宿主 reveal 跳页滚行闪烁。
 * 匹配/聚行/摘要在 doc-search.ts（纯逻辑可测）。
 */
export class DocSearchModal extends Modal {
	private readonly host: DocSearchHost;
	private inputEl!: HTMLInputElement;
	private listEl!: HTMLElement;
	private countEl!: HTMLElement;
	private hits: DocSearchHit[] = [];
	private query = "";
	private selected = 0;
	private timer: number | null = null;
	/** 代际令牌：每次新扫描自增，在途扫描 await 后比对即中断 */
	private gen = 0;

	constructor(app: App, host: DocSearchHost) {
		super(app);
		this.host = host;
	}

	onOpen(): void {
		this.titleEl.setText("搜索文档");
		const { contentEl } = this;
		// 布局类与脑图节点搜索弹窗共用（89-C 泛化的 .marinmind-search-modal 系列）
		contentEl.addClass("marinmind-search-modal");
		this.inputEl = contentEl.createEl("input", {
			cls: "marinmind-search-modal-input",
			attr: { type: "text", placeholder: "输入关键词，搜索全文…" },
		});
		this.listEl = contentEl.createDiv({ cls: "marinmind-search-modal-list" });
		this.countEl = contentEl.createDiv({ cls: "marinmind-search-modal-count" });
		this.renderPlaceholder("输入关键词开始搜索");
		this.inputEl.addEventListener("input", () => {
			if (this.timer != null) {
				window.clearTimeout(this.timer);
			}
			const q = this.inputEl.value;
			this.timer = window.setTimeout(() => void this.scan(q), DEBOUNCE_MS);
		});
		this.inputEl.addEventListener("keydown", (evt) => {
			if (evt.key === "ArrowDown" || evt.key === "ArrowUp") {
				evt.preventDefault();
				this.moveSelection(evt.key === "ArrowDown" ? 1 : -1);
			} else if (evt.key === "Enter") {
				evt.preventDefault();
				this.pickSelected();
			}
		});
		window.setTimeout(() => this.inputEl.focus(), 0);
	}

	onClose(): void {
		this.gen++; // 在途扫描作废
		if (this.timer != null) {
			window.clearTimeout(this.timer);
			this.timer = null;
		}
		this.contentEl.empty();
	}

	/** 入口扫描：清场 → 按形态走三条数据源路径（代际令牌贯穿所有 await） */
	private async scan(query: string): Promise<void> {
		const gen = ++this.gen;
		const q = query.trim().toLowerCase();
		this.hits = [];
		this.selected = 0;
		this.query = q;
		this.listEl.empty();
		if (!q) {
			this.renderPlaceholder("输入关键词开始搜索");
			this.countEl.setText("");
			return;
		}
		const kind = this.host.docSearchKind();
		if (!kind) {
			this.renderPlaceholder("当前没有打开的文档");
			this.countEl.setText("");
			return;
		}
		this.renderPlaceholder("搜索中…");
		let truncated = false;
		if (kind === "pdf") {
			truncated = await this.scanPdf(gen, q);
		} else if (kind === "epub") {
			truncated = await this.scanEpub(gen, q);
		} else {
			this.scanMd(q);
		}
		if (gen !== this.gen) {
			return; // 改词/关闭：结果作废（DOM 已被新一轮清场）
		}
		if (this.hits.length === 0) {
			this.renderPlaceholder("无匹配内容");
			this.countEl.setText("");
			return;
		}
		this.countEl.setText(
			truncated
				? `已达上限，仅显示前 ${this.hits.length} 条`
				: `${this.hits.length} 条匹配`,
		);
	}

	/** PDF：逐页 buildTextLayer（带文本缓存）→ 聚行匹配，命中渐进上屏 */
	private async scanPdf(gen: number, q: string): Promise<boolean> {
		const total = this.host.docSearchPdfPageCount();
		for (let page = 1; page <= total; page++) {
			if (gen !== this.gen) {
				return true; // 已作废（返回值不再被消费）
			}
			const lines = await this.host.docSearchPdfLines(page);
			if (gen !== this.gen) {
				return true;
			}
			if (lines && lines.length > 0) {
				const { hits } = searchTexts(page, lines.map((l) => l.text), q);
				this.appendHits(hits);
			}
			if (this.hits.length >= TOTAL_HIT_CAP) {
				return true;
			}
			this.countEl.setText(`已找到 ${this.hits.length} 条 · 第 ${page}/${total} 页`);
			if (page % PDF_YIELD_PAGES === 0) {
				await new Promise<void>((r) => window.setTimeout(r, 0));
				if (gen !== this.gen) {
					return true;
				}
			}
		}
		return false;
	}

	/** EPUB：逐章 readEntry → DOMParser 块文本（未渲染章可搜）→ 块匹配 */
	private async scanEpub(gen: number, q: string): Promise<boolean> {
		const total = this.host.docSearchEpubChapterCount();
		for (let chapter = 1; chapter <= total; chapter++) {
			if (gen !== this.gen) {
				return true;
			}
			const blocks = this.host.docSearchEpubBlocks(chapter);
			if (blocks.length > 0) {
				const { hits } = searchTexts(chapter, blocks, q);
				this.appendHits(hits);
			}
			if (this.hits.length >= TOTAL_HIT_CAP) {
				return true;
			}
			this.countEl.setText(`已找到 ${this.hits.length} 条 · 第 ${chapter}/${total} 章`);
			if (chapter % EPUB_YIELD_CHAPTERS === 0) {
				await new Promise<void>((r) => window.setTimeout(r, 0));
				if (gen !== this.gen) {
					return true;
				}
			}
		}
		return false;
	}

	/** MD：单页活 DOM 块一次匹配（无扫描循环） */
	private scanMd(q: string): void {
		const blocks = this.host.docSearchMdBlocks();
		const { hits } = searchTexts(1, blocks, q);
		this.appendHits(hits);
	}

	/** 命中渐进追加（扫描中即可见可点）；首轮命中替换"搜索中…"占位 */
	private appendHits(hits: readonly DocSearchHit[]): void {
		if (hits.length === 0) {
			return;
		}
		if (this.hits.length === 0) {
			this.listEl.empty();
		}
		for (const hit of hits) {
			const item = this.listEl.createDiv({
				cls: `marinmind-search-modal-item${this.hits.length === 0 ? " is-selected" : ""}`,
			});
			const name = item.createDiv({ cls: "marinmind-picker-name" });
			name.createSpan({
				cls: "marinmind-search-modal-badge",
				text: this.host.docSearchHitLabel(hit),
			});
			name.createSpan({ cls: "marinmind-picker-title", text: hit.snippet });
			const index = this.hits.length;
			item.addEventListener("click", () => this.pick(index));
			item.addEventListener("mouseenter", () => {
				if (this.selected !== index) {
					this.selected = index;
					this.refreshSelection();
				}
			});
			this.hits.push(hit);
		}
		this.listEl.scrollTop = this.listEl.scrollHeight; // 扫描中跟随追加（用户上滚后仍强吸底可接受：结果单调增长）
	}

	private renderPlaceholder(text: string): void {
		this.listEl.empty();
		this.listEl.createDiv({ cls: "marinmind-search-modal-empty", text });
	}

	private refreshSelection(): void {
		const items = this.listEl.querySelectorAll(".marinmind-search-modal-item");
		items.forEach((el, i) => el.classList.toggle("is-selected", i === this.selected));
	}

	private moveSelection(delta: number): void {
		if (this.hits.length === 0) {
			return;
		}
		this.selected = (this.selected + delta + this.hits.length) % this.hits.length;
		this.refreshSelection();
		this.listEl
			.querySelectorAll(".marinmind-search-modal-item")
			.item(this.selected)
			?.scrollIntoView({ block: "nearest" });
	}

	private pickSelected(): void {
		if (this.hits.length > 0) {
			this.pick(this.selected);
		}
	}

	private pick(index: number): void {
		const hit = this.hits[index];
		if (!hit) {
			return;
		}
		this.close();
		this.host.docSearchReveal(hit, this.query);
	}
}
