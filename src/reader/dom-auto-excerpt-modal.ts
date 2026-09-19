import { Modal, Notice } from "obsidian";
import type { App } from "obsidian";
import type MarinMindPlugin from "../main";
import { t } from "../i18n/i18n";
import type { AutoBlock } from "./auto-excerpt";

/**
 * 可重排文档 AI 一键摘录弹窗（164）：DOM 版面候选（dom-auto-excerpt）的
 * 勾选预览 + 批量建卡。语义与 pdf 版 AutoExcerptModal 对齐：同页同文的
 * 既有卡默认不勾 + 「已有」徽标；建卡走 cards.create（摘录色系/线型跟随
 * 设置，自动入图归章由插件级 cardBus created 订阅统一承接）。
 */
export class DomAutoExcerptModal extends Modal {
	private readonly checked: boolean[] = [];

	constructor(
		app: App,
		private readonly plugin: MarinMindPlugin,
		private readonly opts: {
			documentId: string;
			page: number;
			blocks: AutoBlock[];
			truncated: boolean;
			/** 页语义标签（md「全文」/ epub「第 N 章」），标题栏展示 */
			pageLabel: string;
		},
	) {
		super(app);
		// 去重基线：同页既有卡的摘录文本（同文即「已有」——DOM 块无几何歧义）
		const existing = new Set(
			this.plugin.cards
				.listByDocument(opts.documentId)
				.filter((c) => c.page === opts.page)
				.map((c) => (c.excerptText ?? "").trim()),
		);
		opts.blocks.forEach((b, i) => {
			this.checked[i] = !existing.has(b.text.trim());
		});
	}

	onOpen(): void {
		const { blocks } = this.opts;
		this.titleEl.setText(t("AI 摘录") + " · " + this.opts.pageLabel);
		if (this.opts.truncated) {
			this.contentEl.createDiv({
				cls: "marinmind-domx-hint",
				text: t("内容块较多，仅列出前 {n} 块（可分章执行）", { n: blocks.length }),
			});
		}
		const list = this.contentEl.createDiv({ cls: "marinmind-domx-list" });
		blocks.forEach((b, i) => {
			const row = list.createDiv({
				cls: `marinmind-domx-row is-${b.kind}${this.checked[i] ? "" : " is-dup"}`,
			});
			const box = row.createEl("input", { type: "checkbox" }) as HTMLInputElement;
			box.checked = this.checked[i];
			box.addEventListener("change", () => {
				this.checked[i] = box.checked;
				this.syncCount();
			});
			const label = row.createDiv({ cls: "marinmind-domx-text" });
			label.createSpan({
				cls: `marinmind-domx-kind${b.kind === "heading" ? " is-heading" : ""}`,
				text: b.kind === "heading" ? t("标题") : t("正文"),
			});
			label.createSpan({
				cls: "marinmind-domx-body",
				text: b.text.length > 120 ? `${b.text.slice(0, 120)}…` : b.text,
			});
			if (!this.checked[i]) {
				row.createDiv({ cls: "marinmind-domx-dup", text: t("已有") });
			}
		});
		// 操作行：全选/全不选 + 建卡
		const actions = this.contentEl.createDiv({ cls: "marinmind-domx-actions" });
		const toggleBtn = actions.createEl("button", {
			text: t("全选"),
			attr: { type: "button" },
		});
		toggleBtn.addEventListener("click", () => {
			const target = !this.checked.every(Boolean);
			this.checked.fill(target);
			list.querySelectorAll("input[type=checkbox]").forEach((el, i) => {
				(el as HTMLInputElement).checked = this.checked[i] ?? false;
			});
			this.syncCount();
		});
		const createBtn = actions.createEl("button", {
			cls: "mod-cta",
			text: t("转为卡片"),
			attr: { type: "button" },
		});
		createBtn.addEventListener("click", () => this.createCards());
		this.countEl = actions.createDiv({ cls: "marinmind-domx-count" });
		this.syncCount();
	}

	private countEl: HTMLElement | null = null;

	private syncCount(): void {
		const n = this.checked.filter(Boolean).length;
		this.countEl?.setText(t("已选 {n} 块", { n }));
		(
			this.contentEl.querySelector(
				".marinmind-domx-actions .mod-cta",
			) as HTMLButtonElement | null
		)?.toggleAttribute("disabled", n === 0);
	}

	/** 批量建卡：形状镜像划选建卡（finishTextCard）——色系/线型跟随设置 */
	private createCards(): void {
		const s = this.plugin.settings;
		let created = 0;
		this.opts.blocks.forEach((b, i) => {
			if (!this.checked[i]) {
				return;
			}
			this.plugin.cards.create({
				documentId: this.opts.documentId,
				page: this.opts.page,
				rects: b.rects,
				excerptType: "text",
				excerptText: b.text,
				color: s.excerptColors.text,
				lineStyle: s.excerptLineStyle !== "underline" ? s.excerptLineStyle : null,
			});
			created++;
		});
		new Notice(t("已创建 {n} 张卡片", { n: created }));
		this.close();
	}
}
