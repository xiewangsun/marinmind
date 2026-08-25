import { ButtonComponent, Modal } from "obsidian";
import type { App } from "obsidian";
import type { Card } from "../types";

/**
 * 卡片批注编辑弹窗：textarea 预填现有批注。
 * Modal 自带 esc / 背景点击关闭，无需额外处理。
 */
export class NoteEditModal extends Modal {
	constructor(
		app: App,
		private readonly card: Card,
		/** 保存回调：trim 后空串转 null（表示清空批注） */
		private readonly onSave: (note: string | null) => void,
	) {
		super(app);
	}

	onOpen(): void {
		this.titleEl.setText("编辑批注");

		const textarea = this.contentEl.createEl("textarea", {
			cls: "marinmind-note-textarea",
		});
		textarea.value = this.card.note ?? "";

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
	}
}
