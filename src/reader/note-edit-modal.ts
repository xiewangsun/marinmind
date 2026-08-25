import { ButtonComponent, Modal } from "obsidian";
import type { App } from "obsidian";

/** 弹窗配置：不同场景复用（编辑批注 / 新建文字卡片 / 输入脑图名） */
export interface TextPromptOptions {
	/** 弹窗标题（默认"编辑批注"） */
	title?: string;
	/** 输入框占位提示 */
	placeholder?: string;
	/** 预填文本 */
	initialText?: string;
	/** 是否多行（单行用于名称类输入，限制高度） */
	multiline?: boolean;
}

/**
 * 通用文本输入弹窗（由"编辑批注"参数化而来，多场景复用）。
 * Modal 自带 esc / 背景点击关闭，无需额外处理。
 */
export class TextPromptModal extends Modal {
	constructor(
		app: App,
		private readonly opts: TextPromptOptions,
		/** 保存回调：trim 后空串转 null（表示清空/取消输入） */
		private readonly onSave: (text: string | null) => void,
	) {
		super(app);
	}

	onOpen(): void {
		this.titleEl.setText(this.opts.title ?? "编辑批注");
		const singleline = this.opts.multiline === false;
		const textarea = this.contentEl.createEl("textarea", {
			cls: singleline
				? "marinmind-note-textarea marinmind-note-singleline"
				: "marinmind-note-textarea",
		});
		textarea.value = this.opts.initialText ?? "";
		if (this.opts.placeholder) {
			textarea.placeholder = this.opts.placeholder;
		}

		const actions = this.contentEl.createDiv({ cls: "marinmind-note-actions" });
		new ButtonComponent(actions).setButtonText("取消").onClick(() => this.close());
		new ButtonComponent(actions)
			.setButtonText("保存")
			.setCta()
			.onClick(() => {
				const text = textarea.value.trim();
				this.onSave(text === "" ? null : text);
				this.close();
			});
		// 打开后聚焦输入框，提升键盘录入体验
		window.setTimeout(() => textarea.focus(), 0);
	}
}
