import { ButtonComponent, Modal } from "obsidian";
import type { App } from "obsidian";

/**
 * 危险操作确认弹窗（Obsidian 1.13.0 才有 ConfirmationModal，minAppVersion 1.4.0 不可用）。
 * Modal 自带 esc / 背景点击关闭（等同取消）。
 */
export class ConfirmModal extends Modal {
	constructor(
		app: App,
		title: string,
		message: string,
		private readonly onConfirm: () => void,
	) {
		super(app);
		this.titleEl.setText(title);
		this.contentEl.createEl("p", { text: message });
	}

	onOpen(): void {
		const actions = this.contentEl.createDiv({ cls: "marinmind-note-actions" });
		new ButtonComponent(actions).setButtonText("取消").onClick(() => this.close());
		new ButtonComponent(actions)
			.setButtonText("确认")
			.setWarning()
			.onClick(() => {
				this.onConfirm();
				this.close();
			});
	}
}
