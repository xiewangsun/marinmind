import { ButtonComponent, Modal, Notice } from "obsidian";
import type { App } from "obsidian";
import type MarinMindPlugin from "../main";
import { newAiId, sanitizeAiCustomPrompts, type AiCustomPrompt } from "./ai-provider";

/**
 * 自定义 AI 指令管理弹窗（97）：列表（label + 指令摘要）+ 编辑视图
 * （名称 + 指令多行文本）。保存/删除直接写 plugin.settings 并落盘，
 * 关闭时经 onClose 回调让设置页整页重建（镜像 AiPresetModal 样板）。
 * 自定义指令出现在划选工具栏的 AI 菜单尾部。
 */
export class AiCustomPromptModal extends Modal {
	/** 关闭回调（设置页 display() 重建，同步 desc 计数） */
	private readonly onCloseCb: () => void;

	constructor(
		app: App,
		private readonly plugin: MarinMindPlugin,
		onCloseCb: () => void = () => {},
	) {
		super(app);
		this.onCloseCb = onCloseCb;
	}

	onOpen(): void {
		this.titleEl.setText("自定义 AI 指令");
		this.renderList();
	}

	onClose(): void {
		this.onCloseCb();
	}

	/** 列表视图：指令行（label + 指令首行摘要，点击进编辑）+ 底部新增钮 */
	private renderList(): void {
		const body = this.contentEl;
		body.empty();
		const prompts = sanitizeAiCustomPrompts(this.plugin.settings.aiCustomPrompts);
		if (prompts.length === 0) {
			body.createDiv({
				cls: "marinmind-ai-preset-empty",
				text: "尚无自定义指令——添加后它会出现在划选工具栏的 AI 菜单里（如「举例说明」「翻译成英文」「出 3 道练习题」）。",
			});
		}
		for (const item of prompts) {
			const row = body.createDiv({ cls: "marinmind-ai-preset-row" });
			row.addEventListener("click", () => this.renderEditor(item));
			const main = row.createDiv({ cls: "marinmind-ai-preset-main" });
			main.createDiv({ cls: "marinmind-ai-preset-name", text: item.label });
			// 摘要取指令首行截 40 字（多行指令整段进列表会爆高）
			const brief = item.prompt.split("\n")[0] ?? "";
			main.createDiv({
				cls: "marinmind-ai-preset-meta",
				text: brief.length > 40 ? `${brief.slice(0, 40)}…` : brief,
			});
		}
		new ButtonComponent(body.createDiv({ cls: "marinmind-ai-preset-add" }))
			.setButtonText("新增指令")
			.onClick(() => this.renderEditor({ id: newAiId("prompt"), label: "", prompt: "" }));
	}

	/** 编辑视图：名称 + 指令多行文本 + 保存/删除（新增无删除钮）；取消回列表 */
	private renderEditor(item: AiCustomPrompt): void {
		const body = this.contentEl;
		body.empty();
		const isNew = !sanitizeAiCustomPrompts(this.plugin.settings.aiCustomPrompts).some(
			(p) => p.id === item.id,
		);
		const draft: AiCustomPrompt = { ...item };

		const labelRow = body.createDiv({ cls: "marinmind-ai-preset-field" });
		labelRow.createEl("label", { text: "名称", attr: { for: "mm-ai-cp-label" } });
		const labelInput = labelRow.createEl("input", {
			cls: "marinmind-ai-preset-input",
			attr: {
				id: "mm-ai-cp-label",
				type: "text",
				placeholder: "菜单项显示名（如：举例说明）",
				autocomplete: "off",
			},
		});
		labelInput.value = draft.label;
		labelInput.addEventListener("input", () => {
			draft.label = labelInput.value.trim();
		});

		const promptRow = body.createDiv({ cls: "marinmind-ai-preset-field" });
		promptRow.createEl("label", { text: "指令", attr: { for: "mm-ai-cp-prompt" } });
		const promptInput = promptRow.createEl("textarea", {
			cls: "marinmind-ai-prompt-input",
			attr: {
				id: "mm-ai-cp-prompt",
				placeholder: "对选中文本执行的操作（如：针对这段内容出 3 道练习题并附答案）",
				spellcheck: "false",
			},
		});
		promptInput.rows = 5;
		promptInput.value = draft.prompt;
		promptInput.addEventListener("input", () => {
			draft.prompt = promptInput.value.trim();
		});

		const actions = body.createDiv({ cls: "marinmind-ai-preset-editor-actions" });
		if (!isNew) {
			new ButtonComponent(actions)
				.setButtonText("删除")
				.setWarning()
				.onClick(() => this.removeItem(item.id));
		}
		const right = actions.createDiv({ cls: "marinmind-ai-preset-editor-right" });
		new ButtonComponent(right).setButtonText("取消").onClick(() => this.renderList());
		new ButtonComponent(right)
			.setButtonText("保存")
			.setCta()
			.onClick(() => this.saveItem(draft, isNew));
		labelInput.focus();
	}

	/** 保存：名称/指令非空（缺项 Notice 指明）→ 去重合并/追加 → 落盘回列表 */
	private saveItem(draft: AiCustomPrompt, _isNew: boolean): void {
		if (!draft.label) {
			new Notice("请填写名称（菜单项显示名）");
			return;
		}
		if (!draft.prompt) {
			new Notice("请填写指令内容");
			return;
		}
		const prompts = sanitizeAiCustomPrompts(this.plugin.settings.aiCustomPrompts).filter(
			(p) => p.id !== draft.id,
		);
		prompts.push(draft);
		this.plugin.settings.aiCustomPrompts = prompts;
		void this.plugin.saveData({ ...this.plugin.settings });
		new Notice(`自定义指令「${draft.label}」已保存`);
		this.renderList();
	}

	/** 删除：移除指令并落盘回列表（无级联——设置层 sanitize 会清悬空引用） */
	private removeItem(id: string): void {
		this.plugin.settings.aiCustomPrompts = sanitizeAiCustomPrompts(
			this.plugin.settings.aiCustomPrompts,
		).filter((p) => p.id !== id);
		void this.plugin.saveData({ ...this.plugin.settings });
		new Notice("自定义指令已删除");
		this.renderList();
	}
}
