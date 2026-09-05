import { ButtonComponent, Modal, Notice } from "obsidian";
import type { App } from "obsidian";
import type { AiUsage, ChatMessage } from "./ai-provider";
import { sendChat, type AiSettingsView } from "./ai-service";

/** 弹窗配置：请求载荷由调用方经 ai-prompts 构造，应用动作（转卡/填批注）可选 */
export interface AiActionModalOptions {
	/** 弹窗标题（aiActionTitle 产物：AI 解释 / AI · 〈label〉…） */
	title: string;
	/** 原文展示（划选文本或卡片摘录，只读对照区） */
	sourceText: string;
	/** 请求载荷（ai-prompts 构造的 messages） */
	messages: ChatMessage[];
	/** 设置视图（sendChat 读预设/温度/流式；MarinMindPlugin.settings 结构性满足） */
	settings: AiSettingsView;
	/** 用量上报（main 聚合入 settings.aiUsage） */
	onUsage?: (usage: AiUsage) => void;
	/** 应用动作（可选）：结果可用后启用，如「转为卡片」/「填入批注」 */
	apply?: {
		label: string;
		onApply: (text: string) => void;
	};
}

/**
 * AI 结果弹窗（97，MN4「选中文字 AI 操作」结果面）：原文/AI 结果对照 +
 * 流式逐字渲染（sendChat 路由；网络不支持自动降级整包）+ 应用/复制/停止。
 * 布局复用翻译弹窗 marinmind-tr-* 类（原文/译文对照同一语义，样式零新增）。
 * obsidian 耦合不单测（镜像 TranslateModal 分层先例）。
 */
export class AiActionModal extends Modal {
	/** 当前结果累计（null = 尚无可用结果，应用/复制禁用） */
	private result: string | null = null;
	private resultEl!: HTMLElement;
	private applyButton: ButtonComponent | null = null;
	private copyButton!: ButtonComponent;
	private stopButton!: ButtonComponent;
	/** 本轮请求的中断器（onClose 也走它断流省 token）；非流式路径靠 stopped 旗标丢弃 */
	private abort: AbortController | null = null;
	private stopped = false;

	constructor(
		app: App,
		private readonly opts: AiActionModalOptions,
	) {
		super(app);
	}

	onOpen(): void {
		this.titleEl.setText(this.opts.title);

		this.contentEl.createDiv({ cls: "marinmind-tr-label", text: "原文" });
		this.contentEl.createDiv({
			cls: "marinmind-tr-text marinmind-tr-source",
			text: this.opts.sourceText,
		});

		this.contentEl.createDiv({ cls: "marinmind-tr-label", text: "AI 结果" });
		this.resultEl = this.contentEl.createDiv({
			cls: "marinmind-tr-text marinmind-tr-result",
			attr: { "aria-live": "polite" },
		});

		const actions = this.contentEl.createDiv({ cls: "marinmind-tr-actions" });
		if (this.opts.apply) {
			this.applyButton = new ButtonComponent(actions)
				.setButtonText(this.opts.apply.label)
				.setCta()
				.setDisabled(true)
				.onClick(() => this.applyResult());
		}
		this.copyButton = new ButtonComponent(actions)
			.setButtonText("复制结果")
			.setDisabled(true)
			.onClick(() => void this.copyResult());
		// 停止钮（流式中断）：仅生成中可用，结束/停止/出错后禁用
		this.stopButton = new ButtonComponent(actions)
			.setButtonText("停止")
			.setDisabled(true)
			.onClick(() => {
				this.stopped = true;
				this.abort?.abort();
				// 非流式路径（requestUrl 不可中断）：abort 不产生异常，finish 时按旗标丢弃
			});

		void this.run();
	}

	/** 弹窗关闭即中断后台流（省 token；已生成的部分文本随弹窗丢弃） */
	onClose(): void {
		this.stopped = true;
		this.abort?.abort();
	}

	/** 执行请求并流式渲染；过期渲染用 isConnected 守卫丢弃（镜像 TranslateModal） */
	private async run(): Promise<void> {
		this.stopped = false;
		this.abort = new AbortController();
		this.setBusy("AI 生成中…");
		try {
			const text = await sendChat(this.opts.settings, this.opts.messages, {
				signal: this.abort.signal,
				onDelta: (delta) => {
					if (!this.resultEl.isConnected || this.stopped) {
						return;
					}
					this.result = (this.result ?? "") + delta;
					this.resultEl.setText(this.result);
				},
				onDegraded: () => new Notice("当前网络不支持流式输出，已切换整包返回"),
				onUsage: (usage) => this.opts.onUsage?.(usage),
			});
			if (!this.resultEl.isConnected) {
				return; // 弹窗已关：丢弃渲染（onClose 已断流，此为竞态兜底）
			}
			if (this.stopped) {
				this.finishStopped();
				return;
			}
			this.finish(text);
		} catch (err) {
			if (!this.resultEl.isConnected) {
				return;
			}
			if (err instanceof DOMException && err.name === "AbortError") {
				this.finishStopped();
				return; // 用户主动停止：保留已生成部分，非错误态
			}
			this.renderError(err instanceof Error ? err.message : String(err));
		}
	}

	/** 完成态：结果可用，应用/复制启用，停止禁用；空文本按错误处理 */
	private finish(text: string): void {
		if (!text.trim()) {
			this.renderError("AI 返回内容为空，请重试或更换模型");
			return;
		}
		this.result = text;
		this.setButtonsEnabled(true);
		this.resultEl.empty();
		this.resultEl.removeClass("is-loading", "marinmind-tr-error");
		this.resultEl.setText(text);
	}

	/** 停止态：保留已生成部分（可复制/应用）；无内容时明示已停止 */
	private finishStopped(): void {
		this.setButtonsEnabled(this.result != null && this.result.trim().length > 0);
		this.resultEl.removeClass("is-loading");
		if (this.result == null || !this.result.trim()) {
			this.result = null;
			this.resultEl.setText("已停止（未生成内容）");
		}
	}

	/** 加载态：清空结果区并禁用动作钮（停止除外——生成中它要可用） */
	private setBusy(message: string): void {
		this.result = null;
		this.setButtonsEnabled(false);
		this.stopButton.setDisabled(false);
		this.resultEl.empty();
		this.resultEl.addClass("is-loading");
		this.resultEl.removeClass("marinmind-tr-error");
		this.resultEl.setText(message);
	}

	/** 应用/复制钮的可用性（停止钮取反） */
	private setButtonsEnabled(enabled: boolean): void {
		this.applyButton?.setDisabled(!enabled);
		this.copyButton.setDisabled(!enabled);
		this.stopButton.setDisabled(enabled);
	}

	/** 错误态：错误文案 + 重试按钮（镜像 TranslateModal） */
	private renderError(message: string): void {
		this.result = null;
		this.setButtonsEnabled(false);
		this.resultEl.empty();
		this.resultEl.removeClass("is-loading");
		this.resultEl.addClass("marinmind-tr-error");
		this.resultEl.createDiv({ text: message });
		new ButtonComponent(this.resultEl.createDiv({ cls: "marinmind-tr-retry" }))
			.setButtonText("重试")
			.onClick(() => void this.run());
	}

	private applyResult(): void {
		if (this.result == null || !this.opts.apply) {
			return;
		}
		this.opts.apply.onApply(this.result);
		this.close();
	}

	private async copyResult(): Promise<void> {
		if (this.result == null) {
			return;
		}
		try {
			await navigator.clipboard.writeText(this.result);
			new Notice("AI 结果已复制到剪贴板");
		} catch (err) {
			console.error("[MarinMind] 复制 AI 结果失败", err);
			new Notice("复制失败（剪贴板不可用）");
		}
	}
}
