import { ButtonComponent, Modal, Notice } from "obsidian";
import type { App } from "obsidian";
import {
	DEFAULT_TRANSLATE_TARGET,
	MAX_TRANSLATE_CHARS,
	TRANSLATE_LANGUAGES,
	isTranslateLangCode,
	translateLangLabel,
} from "./translate-engine";
import { translateText } from "./translate-service";

/** 弹窗配置：设置持久化与译文落卡由调用方（reader-view）承接 */
export interface TranslateModalOptions {
	/** 待译原文（卡片摘录文字，已 trim 非空） */
	sourceText: string;
	/** 初始目标语言代码（设置页默认值；非法值回退简体中文） */
	target: string;
	/** 目标语言被切换：持久化设置（弹窗内切换即记住，下次沿用） */
	onTargetChange: (code: string) => void;
	/** 「存为留白」：以译文在原文下方创建留白卡片（MN4 同款并排对照） */
	onSaveBlank: (translation: string) => void;
}

/**
 * 翻译弹窗（㉔，MN4「翻译及保存译文」对齐）：原文/译文对照 +
 * 目标语言下拉（13 种，切换即重译并记住）+ 存为留白 / 复制译文。
 * 翻译请求经 requestUrl（绕 CORS）；过期渲染用 isConnected 守卫丢弃
 * （与复习界面媒体分支同款模式）。
 */
export class TranslateModal extends Modal {
	private target: string;
	/** 当前译文（null = 尚无可用结果，存为留白/复制禁用） */
	private translation: string | null = null;
	private detectEl!: HTMLElement;
	private resultEl!: HTMLElement;
	private saveButton!: ButtonComponent;
	private copyButton!: ButtonComponent;

	constructor(app: App, private readonly opts: TranslateModalOptions) {
		super(app);
		this.target = isTranslateLangCode(opts.target) ? opts.target : DEFAULT_TRANSLATE_TARGET;
	}

	onOpen(): void {
		this.titleEl.setText("翻译");

		// 头部：目标语言下拉 + 源语言检测结果
		const head = this.contentEl.createDiv({ cls: "marinmind-tr-head" });
		const selectEl = head.createEl("select", { cls: "marinmind-tr-lang" });
		for (const lang of TRANSLATE_LANGUAGES) {
			const option = selectEl.createEl("option", { text: lang.label });
			option.value = lang.code;
		}
		selectEl.value = this.target;
		selectEl.addEventListener("change", () => {
			if (!isTranslateLangCode(selectEl.value)) {
				return;
			}
			this.target = selectEl.value;
			this.opts.onTargetChange(this.target);
			void this.run();
		});
		this.detectEl = head.createSpan({ cls: "marinmind-tr-detect" });

		this.contentEl.createDiv({ cls: "marinmind-tr-label", text: "原文" });
		this.contentEl.createDiv({
			cls: "marinmind-tr-text marinmind-tr-source",
			text: this.opts.sourceText,
		});

		this.contentEl.createDiv({ cls: "marinmind-tr-label", text: "译文" });
		this.resultEl = this.contentEl.createDiv({ cls: "marinmind-tr-text marinmind-tr-result" });

		const actions = this.contentEl.createDiv({ cls: "marinmind-tr-actions" });
		this.saveButton = new ButtonComponent(actions)
			.setButtonText("存为留白")
			.setCta()
			.setDisabled(true)
			.onClick(() => this.saveBlank());
		this.copyButton = new ButtonComponent(actions)
			.setButtonText("复制译文")
			.setDisabled(true)
			.onClick(() => void this.copyTranslation());

		void this.run();
	}

	/** 执行翻译并渲染结果；弹窗已关时（isConnected 失效）丢弃过期渲染 */
	private async run(): Promise<void> {
		if (this.opts.sourceText.length > MAX_TRANSLATE_CHARS) {
			this.renderError(
				`文本过长（${this.opts.sourceText.length} 字符，上限 ${MAX_TRANSLATE_CHARS}），请拆分后再译`,
			);
			return;
		}
		this.setBusy("翻译中…");
		try {
			const outcome = await translateText(this.opts.sourceText, this.target);
			if (!this.resultEl.isConnected) {
				return;
			}
			this.translation = outcome.text;
			this.detectEl.setText(`源语言：${translateLangLabel(outcome.from)}`);
			this.resultEl.empty();
			this.resultEl.removeClass("is-loading", "marinmind-tr-error");
			this.resultEl.setText(outcome.text);
			this.saveButton.setDisabled(false);
			this.copyButton.setDisabled(false);
		} catch (err) {
			if (!this.resultEl.isConnected) {
				return;
			}
			this.renderError(err instanceof Error ? err.message : String(err));
		}
	}

	/** 加载态：清空译文区并禁用动作按钮 */
	private setBusy(message: string): void {
		this.translation = null;
		this.saveButton.setDisabled(true);
		this.copyButton.setDisabled(true);
		this.resultEl.empty();
		this.resultEl.addClass("is-loading");
		this.resultEl.removeClass("marinmind-tr-error");
		this.resultEl.setText(message);
	}

	/** 错误态：错误文案 + 重试按钮 */
	private renderError(message: string): void {
		this.translation = null;
		this.saveButton.setDisabled(true);
		this.copyButton.setDisabled(true);
		this.resultEl.empty();
		this.resultEl.removeClass("is-loading");
		this.resultEl.addClass("marinmind-tr-error");
		this.resultEl.createDiv({ text: message });
		new ButtonComponent(this.resultEl.createDiv({ cls: "marinmind-tr-retry" }))
			.setButtonText("重试")
			.onClick(() => void this.run());
	}

	private saveBlank(): void {
		if (!this.translation) {
			return;
		}
		this.opts.onSaveBlank(this.translation);
		this.close();
	}

	private async copyTranslation(): Promise<void> {
		if (!this.translation) {
			return;
		}
		try {
			await navigator.clipboard.writeText(this.translation);
			new Notice("译文已复制到剪贴板");
		} catch (err) {
			console.error("[MarinMind] 复制译文失败", err);
			new Notice("复制失败（剪贴板不可用）");
		}
	}
}
