import { Modal, setIcon } from "obsidian";
import type { App } from "obsidian";
import type { MindmapNodeWithCard } from "../types";
import { NODE_SEARCH_FIELD_LABELS, searchMapNodes, type NodeSearchRow } from "./node-search";

/** 输入防抖（毫秒）：停顿后再扫（数千节点 includes 本 <10ms，防抖只为少扫） */
const DEBOUNCE_MS = 200;

/** 宿主注入项：节点快照提供者 + 选中回调 */
export interface NodeSearchModalOptions {
	/** 每次搜索现拉（打开期间跨标签改图也能看到最新） */
	nodes: () => readonly MindmapNodeWithCard[];
	/** 选中回调（Modal 已 close 后调用；定位失败兜底文案由宿主决定） */
	onChoose: (node: MindmapNodeWithCard) => void;
}

/**
 * 脑图节点搜索弹窗（89-C，MN3 搜索入口对齐）：输入框 + 结果列表
 * （92 批行式重排：文字左对齐占主行，命中字段徽标 = 标题/批注/摘录行尾右对齐，
 * 与文档搜索的页码徽标同构）+ ↑↓/Enter 键盘导航 + 底部计数（截断时"前 100"）。
 * 匹配逻辑在 node-search.ts。
 */
export class NodeSearchModal extends Modal {
	private readonly opts: NodeSearchModalOptions;
	private inputEl!: HTMLInputElement;
	private listEl!: HTMLElement;
	private countEl!: HTMLElement;
	private rows: NodeSearchRow[] = [];
	private truncated = false;
	private selected = 0;
	private timer: number | null = null;

	constructor(app: App, opts: NodeSearchModalOptions) {
		super(app);
		this.opts = opts;
	}

	onOpen(): void {
		// 93 批：标题美化为放大镜 icon + 文案（居中小号弱化，CSS 见 -title 类）
		this.titleEl.addClass("marinmind-search-modal-title");
		setIcon(this.titleEl, "search");
		this.titleEl.createSpan({ text: "搜索脑图节点" });
		const { contentEl } = this;
		contentEl.addClass("marinmind-search-modal");
		this.inputEl = contentEl.createEl("input", {
			cls: "marinmind-search-modal-input",
			attr: { type: "text", placeholder: "输入关键词，匹配标题 / 批注 / 摘录…" },
		});
		this.listEl = contentEl.createDiv({ cls: "marinmind-search-modal-list" });
		this.countEl = contentEl.createDiv({ cls: "marinmind-search-modal-count" });
		this.renderPlaceholder("输入关键词开始搜索");
		this.inputEl.addEventListener("input", () => {
			if (this.timer != null) {
				window.clearTimeout(this.timer);
			}
			const q = this.inputEl.value;
			this.timer = window.setTimeout(() => this.runSearch(q), DEBOUNCE_MS);
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
		window.setTimeout(() => this.inputEl.focus(), 0); // Modal 开启动画后聚焦
	}

	onClose(): void {
		if (this.timer != null) {
			window.clearTimeout(this.timer);
			this.timer = null;
		}
		this.contentEl.empty();
	}

	private runSearch(query: string): void {
		const result = searchMapNodes(this.opts.nodes(), query);
		this.rows = result.rows;
		this.truncated = result.truncated;
		this.selected = 0;
		this.renderList();
	}

	/** 占位文案（空态/无结果共用样式，区分提示内容） */
	private renderPlaceholder(text: string): void {
		this.listEl.empty();
		this.listEl.createDiv({ cls: "marinmind-search-modal-empty", text });
	}

	private renderList(): void {
		const list = this.listEl;
		list.empty();
		if (this.rows.length === 0) {
			this.renderPlaceholder("无匹配节点");
			this.countEl.setText("");
			return;
		}
		this.rows.forEach((row, i) => {
			const item = list.createDiv({
				cls: `marinmind-search-modal-item${i === this.selected ? " is-selected" : ""}`,
			});
			// 92 批行式重排：文字在前左对齐，字段徽标（标题/批注/摘录）行尾右对齐
			item.createSpan({ cls: "marinmind-picker-title", text: row.main });
			item.createSpan({
				cls: "marinmind-search-modal-badge",
				text: NODE_SEARCH_FIELD_LABELS[row.field],
			});
			item.addEventListener("click", () => this.pick(i));
			item.addEventListener("mouseenter", () => {
				if (this.selected !== i) {
					this.selected = i;
					this.refreshSelection();
				}
			});
		});
		this.countEl.setText(
			this.truncated ? `前 ${this.rows.length} 个匹配` : `${this.rows.length} 个匹配`,
		);
	}

	/** 选中态重刷（箭头/悬停后；只改 class 不重建列表） */
	private refreshSelection(): void {
		const items = this.listEl.querySelectorAll(".marinmind-search-modal-item");
		items.forEach((el, i) => el.classList.toggle("is-selected", i === this.selected));
	}

	private moveSelection(delta: number): void {
		if (this.rows.length === 0) {
			return;
		}
		this.selected = (this.selected + delta + this.rows.length) % this.rows.length; // 环绕
		this.refreshSelection();
		this.listEl
			.querySelectorAll(".marinmind-search-modal-item")
			.item(this.selected)
			?.scrollIntoView({ block: "nearest" });
	}

	private pickSelected(): void {
		if (this.rows.length > 0) {
			this.pick(this.selected);
		}
	}

	private pick(index: number): void {
		const row = this.rows[index];
		if (!row) {
			return;
		}
		this.close();
		this.opts.onChoose(row.node);
	}
}
