import { ButtonComponent, Modal, Notice } from "obsidian";
import type { App } from "obsidian";
import type MarinMindPlugin from "../main";
import type { MarinMindReaderView } from "../reader/reader-view";
import { translationAnchor } from "../translate/translate-engine";
import { buildContextText, clampToTokenBudget, type AiContextScope } from "./ai-context";
import { collectDocContext } from "./ai-context-service";
import { summarizeText } from "./ai-summary";

/**
 * AI 摘要弹窗（98 P2，MN4「AI 摘要」对齐）：范围选择（全文/当前页章）→
 * 进度（长文 map-reduce 逐块）→ 结果展示 → 「存为摘要卡」——摘要落为
 * 范围锚定页顶部的留白卡（documentId+page 有值 → 自动入图归章 chapterParentFor
 * 白赚），与译文留白/AI 结果转卡同一路径语义。obsidian 耦合不单测
 * （镜像 AiActionModal 分层）。
 */
export class AiSummaryModal extends Modal {
	private sumScope: AiContextScope = "doc";
	private busy = false;
	private result: string | null = null;
	/** 摘要卡落点（收集上下文时锚定） */
	private docId: string | null = null;
	private anchorPage: number | null = null;

	constructor(
		app: App,
		private readonly plugin: MarinMindPlugin,
		/** 打开入口的阅读视图（上下文与摘要卡落点都锚定它） */
		private readonly reader: MarinMindReaderView,
	) {
		super(app);
	}

	onOpen(): void {
		this.titleEl.setText("AI 摘要");
		const wrap = this.contentEl.createDiv({ cls: "marinmind-ai-summary" });

		// 范围选择（md 单页两档同义，仍给选择器保持一致交互）
		const scopeRow = wrap.createDiv({ cls: "marinmind-ai-summary-row" });
		scopeRow.createEl("label", { text: "摘要范围", attr: { for: "mm-ai-sum-scope" } });
		const selectEl = scopeRow.createEl("select", {
			attr: { id: "mm-ai-sum-scope", "aria-label": "摘要范围" },
		});
		selectEl.createEl("option", { text: "全文" }).value = "doc";
		selectEl.createEl("option", { text: "当前页/章" }).value = "page";
		selectEl.value = this.sumScope;
		selectEl.addEventListener("change", () => {
			this.sumScope = selectEl.value === "page" ? "page" : "doc";
		});

		// 进度行（生成中可见）
		const progress = wrap.createDiv({ cls: "marinmind-ai-summary-progress", text: " " });

		// 结果区（复用翻译对照的文本块样式）
		wrap.createDiv({ cls: "marinmind-tr-label", text: "摘要" });
		const resultEl = wrap.createDiv({
			cls: "marinmind-tr-text marinmind-tr-result",
			attr: { "aria-live": "polite" },
		});

		// 动作区：开始 / 存为摘要卡
		const actions = wrap.createDiv({ cls: "marinmind-tr-actions" });
		const startBtn = new ButtonComponent(actions).setButtonText("开始摘要").setCta();
		const saveBtn = new ButtonComponent(actions).setButtonText("存为摘要卡").setDisabled(true);

		startBtn.onClick(() => void this.run(resultEl, progress, startBtn, saveBtn));
		saveBtn.onClick(() => this.saveCard());
	}

	/** 执行摘要：收集上下文 → 预算裁剪 → map-reduce（进度行） */
	private async run(
		resultEl: HTMLElement,
		progress: HTMLElement,
		startBtn: ButtonComponent,
		saveBtn: ButtonComponent,
	): Promise<void> {
		if (this.busy) {
			return;
		}
		let contextText: string;
		try {
			const ctx = await collectDocContext(this.reader, this.sumScope);
			if (!ctx || ctx.blocks.length === 0) {
				new Notice("当前文档没有可提取的文本");
				return;
			}
			this.docId = ctx.docId;
			this.anchorPage = ctx.page;
			const clamped = clampToTokenBudget(ctx.blocks, this.plugin.settings.aiMaxContextTokens);
			contextText = buildContextText(clamped.blocks, ctx.kind);
			if (clamped.truncated) {
				new Notice("文档超出 token 预算，摘要基于从头截取的部分");
			}
		} catch (err) {
			console.error("[MarinMind] AI 摘要上下文收集失败", err);
			new Notice("提取文档文本失败，请重试");
			return;
		}
		this.busy = true;
		this.result = null;
		saveBtn.setDisabled(true);
		startBtn.setDisabled(true).setButtonText("摘要中…");
		resultEl.empty();
		resultEl.addClass("is-loading");
		resultEl.setText("正在阅读文档…");
		try {
			const summary = await summarizeText(this.plugin.settings, contextText, {
				onProgress: (p) => {
					progress.setText(
						p.stage === "map"
							? `分块提炼 ${p.done + 1}/${p.total}…`
							: p.stage === "reduce"
								? "合并要点…"
								: "完成",
					);
				},
				onUsage: (usage) => this.plugin.addAiUsage(usage),
			});
			if (!resultEl.isConnected) {
				return;
			}
			if (!summary.trim()) {
				resultEl.removeClass("is-loading");
				resultEl.addClass("marinmind-tr-error");
				resultEl.setText("AI 返回内容为空，请重试或更换模型");
				return;
			}
			this.result = summary;
			resultEl.removeClass("is-loading", "marinmind-tr-error");
			resultEl.setText(summary);
			saveBtn.setDisabled(false);
		} catch (err) {
			if (!resultEl.isConnected) {
				return;
			}
			resultEl.removeClass("is-loading");
			resultEl.addClass("marinmind-tr-error");
			resultEl.setText(err instanceof Error ? err.message : String(err));
		} finally {
			this.busy = false;
			startBtn.setDisabled(false).setButtonText("重新摘要");
			progress.setText(" ");
		}
	}

	/** 摘要卡落库：范围锚定页顶部留白卡（自动入图归章白赚）；title 带《书名》 */
	private saveCard(): void {
		const summary = this.result;
		if (!summary || !this.docId || this.anchorPage == null) {
			return;
		}
		const docTitle = this.plugin.documents.get(this.docId)?.title;
		this.plugin.cards.create({
			documentId: this.docId,
			page: this.anchorPage,
			// 页顶默认锚点（translationAnchor 空矩形回退路径：0.02/0.02）
			rects: [translationAnchor([])],
			excerptType: "blank",
			excerptText: summary,
			title: docTitle ? `《${docTitle}》AI 摘要` : "AI 摘要",
			color: this.plugin.settings.excerptColors.blank,
			tags: ["AI", "摘要"],
		});
		new Notice("摘要已存为卡片（自动入图归章）");
		this.close();
	}
}
