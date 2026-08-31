import { App, Modal, Notice, setIcon } from "obsidian";
import type MarinMindPlugin from "../main";
import type { Card } from "../types";
import { detectBlocks, isDuplicateBlock, type AutoBlock, type AutoBlockKind } from "./auto-excerpt";
import type { PdfDocument } from "./pdf-document";
import type { PdfHandle } from "./pdf-cache";

/** 一键识别的页数上限（防误填范围卡 UI；pdf.js getTextContent 有页缓存，逐页便宜） */
const MAX_PAGES = 50;

/** 识别结果行（块 + 所在页 + 勾选态） */
interface DetectedRow {
	block: AutoBlock;
	page: number;
	checked: boolean;
	/** 与已有卡片重复（㉕）：默认不勾选 + 灰显 + 徽标提示 */
	duplicate: boolean;
}

/** 元素类型筛选的显示配置（MN4 摘录辅助的元素开关；标题浅红 / 正文跟随文字工具色） */
const KIND_LABELS: Record<AutoBlockKind, string> = {
	heading: "标题",
	body: "正文",
};

/**
 * AI 一键摘录弹窗（㉓，MN4「一键摘录」对齐）：
 * 选范围（当前页 / 页码范围）与元素类型（标题 / 正文）→ 基于文本层版面识别
 * 检出内容块 → 预览勾选 → 批量生成 text 卡（逐行矩形入 rects，跳原文/入脑图
 * 与划选摘录完全同构；高亮回显走 cardBus 事件回环）。
 */
export class AutoExcerptModal extends Modal {
	private rows: DetectedRow[] = [];
	private readonly kinds = new Set<AutoBlockKind>(["heading", "body"]);
	private scopeCurrentPage: boolean;
	private rangeFrom = 1;
	private rangeTo = 1;
	/** 弹窗已关闭（识别循环中止条件） */
	private closed = false;
	private listEl: HTMLElement | null = null;
	private createBtn: HTMLButtonElement | null = null;

	constructor(
		app: App,
		private readonly plugin: MarinMindPlugin,
		private readonly opts: {
			pdf: PdfDocument;
			/** ㊳ 共享缓存句柄：弹窗期间持有引用，防阅读器关标签把文档销毁；onClose 归还 */
			pdfHandle: PdfHandle;
			documentId: string;
			currentPage: number;
			numPages: number;
		},
	) {
		super(app);
		this.scopeCurrentPage = true;
		this.rangeFrom = Math.min(opts.currentPage, opts.numPages);
		this.rangeTo = this.rangeFrom;
	}

	onOpen(): void {
		this.contentEl.empty();
		this.contentEl.addClass("marinmind-autoex");
		this.renderForm();
	}

	onClose(): void {
		this.closed = true;
		this.contentEl.empty();
		this.opts.pdfHandle.release(); // ㊳ 归还共享引用（幂等）
	}

	// ---------- 表单（范围 + 元素类型） ----------

	private renderForm(): void {
		this.contentEl.createEl("h3", { text: "AI 一键摘录" });
		this.contentEl.createEl("p", {
			cls: "marinmind-autoex-hint",
			text: "基于文档文字层自动识别 标题 / 正文 内容块并批量生成卡片（页眉页脚自动排除）。",
		});

		// 范围：当前页 / 页码范围
		const scopeRow = this.contentEl.createDiv({ cls: "marinmind-autoex-row" });
		scopeRow.createEl("span", { cls: "marinmind-autoex-label", text: "范围" });
		const select = scopeRow.createEl("select", { cls: "marinmind-autoex-select" });
		select.createEl("option", { value: "current", text: `当前页（第 ${this.opts.currentPage} 页）` });
		select.createEl("option", { value: "range", text: "页码范围" });
		const rangeBox = scopeRow.createDiv({ cls: "marinmind-autoex-range" });
		const from = rangeBox.createEl("input", { type: "number" });
		const to = rangeBox.createEl("input", { type: "number" });
		from.value = String(this.rangeFrom);
		to.value = String(this.rangeTo);
		from.min = "1";
		to.min = "1";
		from.max = String(this.opts.numPages);
		to.max = String(this.opts.numPages);
		const applyRange = () => {
			this.rangeFrom = this.clampPage(from.valueAsNumber || 1);
			this.rangeTo = this.clampPage(to.valueAsNumber || this.rangeFrom);
			if (this.rangeTo < this.rangeFrom) {
				[this.rangeFrom, this.rangeTo] = [this.rangeTo, this.rangeFrom];
				from.value = String(this.rangeFrom);
				to.value = String(this.rangeTo);
			}
		};
		from.addEventListener("change", applyRange);
		to.addEventListener("change", applyRange);
		const syncScope = () => {
			this.scopeCurrentPage = select.value === "current";
			rangeBox.classList.toggle("is-hidden", this.scopeCurrentPage);
		};
		select.addEventListener("change", syncScope);
		syncScope();

		// 元素类型（MN4 摘录辅助的元素开关）
		const kindRow = this.contentEl.createDiv({ cls: "marinmind-autoex-row" });
		kindRow.createEl("span", { cls: "marinmind-autoex-label", text: "元素" });
		for (const key of Object.keys(KIND_LABELS) as AutoBlockKind[]) {
			const box = kindRow.createEl("label", { cls: "marinmind-autoex-kind" });
			const cb = box.createEl("input", { type: "checkbox" });
			cb.checked = this.kinds.has(key);
			cb.addEventListener("change", () => {
				if (cb.checked) {
					this.kinds.add(key);
				} else {
					this.kinds.delete(key);
				}
			});
			box.createSpan({ text: KIND_LABELS[key] });
		}

		const runBtn = this.contentEl.createEl("button", {
			cls: "marinmind-autoex-run mod-cta",
			text: "开始识别",
		});
		runBtn.addEventListener("click", () => void this.detect());
	}

	private clampPage(v: number): number {
		return Math.min(this.opts.numPages, Math.max(1, Math.floor(v)));
	}

	// ---------- 识别与预览 ----------

	/** 逐页跑版面块检测（页码范围内、按勾选的元素类型过滤） */
	private async detect(): Promise<void> {
		if (this.kinds.size === 0) {
			new Notice("请至少选择一种元素类型");
			return;
		}
		const pages: number[] = [];
		if (this.scopeCurrentPage) {
			pages.push(Math.min(this.opts.currentPage, this.opts.numPages));
		} else {
			for (let p = this.rangeFrom; p <= this.rangeTo; p++) {
				pages.push(p);
			}
		}
		if (pages.length > MAX_PAGES) {
			new Notice(`单次最多识别 ${MAX_PAGES} 页，请缩小范围`);
			return;
		}
		const rows: DetectedRow[] = [];
		// 既有卡片按页分桶（㉕ 去重：重复执行的重复块默认不勾选）
		const existing = await this.loadExistingCards();
		const byPage = new Map<number, Card[]>();
		for (const c of existing) {
			if (c.page == null) {
				continue;
			}
			const arr = byPage.get(c.page);
			if (arr) {
				arr.push(c);
			} else {
				byPage.set(c.page, [c]);
			}
		}
		for (const page of pages) {
			if (this.closed) {
				return;
			}
			try {
				const [items, size] = await Promise.all([
					this.opts.pdf.getPageLayout(page),
					this.opts.pdf.getPageSize(page),
				]);
				if (this.closed) {
					return;
				}
				for (const block of detectBlocks(items, size.width, size.height)) {
					if (this.kinds.has(block.kind)) {
						const duplicate = byPage.get(page)?.some((c) => isDuplicateBlock(block, page, c)) ?? false;
						rows.push({ block, page, checked: !duplicate, duplicate });
					}
				}
			} catch (err) {
				// 单页失败不中断整体（文档销毁 / 页码越界）
				console.warn(`[MarinMind] 自动摘录第 ${page} 页识别失败`, err);
			}
		}
		if (this.closed) {
			return;
		}
		this.rows = rows;
		this.renderPreview();
	}

	/** 拉取本文档全部既有卡片（去重检测输入；失败不阻塞识别——重复检测尽力而为） */
	private async loadExistingCards(): Promise<Card[]> {
		try {
			return await this.plugin.cards.listByDocument(this.opts.documentId);
		} catch {
			return [];
		}
	}

	private renderPreview(): void {
		this.contentEl.empty();
		this.contentEl.addClass("marinmind-autoex");
		if (this.rows.length === 0) {
			this.contentEl.createEl("p", {
				cls: "marinmind-autoex-hint",
				text: "未识别到内容块——扫描版 PDF 无文字层，请先用矩形摘录 + OCR（或确认范围内确有文字）。",
			});
			const back = this.contentEl.createEl("button", { text: "返回" });
			back.addEventListener("click", () => {
				this.contentEl.empty();
				this.renderForm();
			});
			return;
		}

		// 预览头：全选开关 + 计数
		const head = this.contentEl.createDiv({ cls: "marinmind-autoex-head" });
		const all = head.createEl("label", { cls: "marinmind-autoex-kind" });
		const allCb = all.createEl("input", { type: "checkbox" });
		allCb.checked = this.rows.every((r) => r.checked);
		const dupCount = this.rows.filter((r) => r.duplicate).length;
		const countLabel = head.createSpan({
			cls: "marinmind-autoex-count",
			text: `共 ${this.rows.length} 块${dupCount > 0 ? ` · ${dupCount} 块与已有卡片重复` : ""}`,
		});
		allCb.addEventListener("change", () => {
			for (const row of this.rows) {
				row.checked = allCb.checked;
			}
			this.syncChecks();
		});

		this.listEl = this.contentEl.createDiv({ cls: "marinmind-autoex-list" });
		for (const row of this.rows) {
			const el = this.listEl.createEl("label", { cls: "marinmind-autoex-item" });
			if (row.duplicate) {
				// 与已有卡片重复：灰显 + 提示（仍可手动勾选补建）
				el.addClass("is-dup");
				el.title = "与已有卡片文本/位置重复";
			}
			const cb = el.createEl("input", { type: "checkbox" });
			cb.checked = row.checked;
			cb.addEventListener("change", () => {
				row.checked = cb.checked;
				this.syncChecks();
			});
			el.createSpan({
				cls: `marinmind-autoex-badge is-${row.block.kind}`,
				text: KIND_LABELS[row.block.kind],
			});
			if (row.duplicate) {
				el.createSpan({ cls: "marinmind-autoex-badge is-dup", text: "已有" });
			}
			el.createSpan({ cls: "marinmind-autoex-page", text: `第 ${row.page} 页` });
			el.createSpan({
				cls: "marinmind-autoex-snippet",
				text: row.block.text.replace(/\n/g, " "),
			});
		}

		const foot = this.contentEl.createDiv({ cls: "marinmind-autoex-foot" });
		this.createBtn = foot.createEl("button", {
			cls: "mod-cta",
			attr: { type: "button" },
		});
		this.updateCreateBtn();
		this.createBtn.addEventListener("click", () => void this.createCards());
		const back = foot.createEl("button", { text: "返回" });
		back.addEventListener("click", () => {
			this.contentEl.empty();
			this.renderForm();
		});
	}

	/** 同步计数与生成按钮态（勾选变化后） */
	private syncChecks(): void {
		const boxes = this.listEl?.querySelectorAll<HTMLInputElement>(
			".marinmind-autoex-item input[type=checkbox]",
		);
		boxes?.forEach((cb, i) => {
			const row = this.rows[i];
			if (row) {
				cb.checked = row.checked;
			}
		});
		this.updateCreateBtn();
	}

	private updateCreateBtn(): void {
		const n = this.rows.filter((r) => r.checked).length;
		if (this.createBtn) {
			this.createBtn.setText(`生成 ${n} 张卡片`);
			this.createBtn.disabled = n === 0;
		}
	}

	/** 批量建卡（text 卡：逐行矩形 + 类型颜色；回显/自动收录走 cardBus 事件回环） */
	private createCards(): void {
		let n = 0;
		for (const row of this.rows) {
			if (!row.checked) {
				continue;
			}
			this.plugin.cards.create({
				documentId: this.opts.documentId,
				page: row.page,
				rects: row.block.rects,
				excerptType: "text",
				excerptText: row.block.text,
				// ㊹ 四色化：标题浅红（MN4"同一类元素同一种颜色"），正文跟随文字工具当前色系
				color: row.block.kind === "heading" ? "red" : this.plugin.settings.excerptColors.text,
			});
			n++;
		}
		new Notice(`AI 摘录已生成 ${n} 张卡片`);
		this.close();
	}
}
