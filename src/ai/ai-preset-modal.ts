import { ButtonComponent, Modal, Notice, setIcon } from "obsidian";
import type { App } from "obsidian";
import type MarinMindPlugin from "../main";
import { newAiId, sanitizeAiPresets, type AiPreset } from "./ai-provider";

/** 预设表单字段元数据（编辑视图渲染用；凭据字段标记 noAssist） */
interface PresetField {
	key: keyof Pick<AiPreset, "name" | "baseUrl" | "apiKey" | "model">;
	label: string;
	placeholder: string;
	password?: boolean;
}

const PRESET_FIELDS: readonly PresetField[] = [
	{ key: "name", label: "名称", placeholder: "如 DeepSeek / 公司中转" },
	{
		key: "baseUrl",
		label: "Base URL",
		placeholder: "https://api.deepseek.com/v1（填到 /v1 层级）",
	},
	{
		key: "apiKey",
		label: "API Key",
		placeholder: "sk-…（凭据明文存于插件数据文件）",
		password: true,
	},
	{ key: "model", label: "模型名", placeholder: "如 deepseek-chat / glm-4.6 / gpt-4o-mini" },
];

/**
 * AI 预设管理弹窗（96）：预设列表（点击进入编辑）+ 新增。编辑视图四字段
 * （名称/Base URL/API Key/模型名），凭据输入关自动补全（R3 W-14 同款）。
 * 保存/删除直接写 plugin.settings 并落盘，关闭时经 onClose 回调让设置页
 * 整页重建（预设下拉与 desc 同步——镜像翻译引擎切换的 display() 先例）。
 */
export class AiPresetModal extends Modal {
	/** 关闭回调（设置页 display() 重建，同步下拉与启用状态） */
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
		this.titleEl.setText("AI 模型预设");
		this.renderList();
	}

	onClose(): void {
		this.onCloseCb();
	}

	/** 列表视图：预设行（名称 + 模型/地址摘要，点击进编辑）+ 底部新增钮 */
	private renderList(): void {
		const body = this.contentEl;
		body.empty();
		const presets = sanitizeAiPresets(this.plugin.settings.aiPresets);
		const activeId = this.plugin.settings.aiActivePresetId;
		if (presets.length === 0) {
			body.createDiv({
				cls: "marinmind-ai-preset-empty",
				text: "尚无预设——点击下方「新增预设」添加一个 OpenAI 兼容端点（DeepSeek / 智谱 / OpenAI / oneapi 系中转站等）。",
			});
		}
		for (const preset of presets) {
			const row = body.createDiv({ cls: "marinmind-ai-preset-row" });
			if (preset.id === activeId) {
				row.addClass("is-active");
			}
			const main = row.createDiv({ cls: "marinmind-ai-preset-main" });
			main.createDiv({ cls: "marinmind-ai-preset-name", text: preset.name });
			main.createDiv({
				cls: "marinmind-ai-preset-meta",
				text: `${preset.model} · ${preset.baseUrl}`,
			});
			const actions = row.createDiv({ cls: "marinmind-ai-preset-actions" });
			// 启用切换：点击对勾图标在该预设与「未启用」间切换（当前启用行再次点击 = 停用）
			const toggle = actions.createEl("button", {
				cls: "marinmind-ai-preset-toggle clickable-icon",
				attr: { "aria-label": preset.id === activeId ? "停用此预设" : "启用此预设" },
			});
			setIcon(toggle, preset.id === activeId ? "circle-check" : "circle");
			toggle.addEventListener("click", (evt) => {
				evt.stopPropagation();
				this.plugin.settings.aiActivePresetId = preset.id === activeId ? "" : preset.id;
				void this.plugin.saveData({ ...this.plugin.settings });
				this.renderList();
			});
			const edit = actions.createEl("button", {
				cls: "clickable-icon",
				attr: { "aria-label": "编辑" },
			});
			setIcon(edit, "pencil");
			edit.addEventListener("click", (evt) => {
				evt.stopPropagation();
				this.renderEditor(preset);
			});
			row.addEventListener("click", () => this.renderEditor(preset));
		}
		new ButtonComponent(body.createDiv({ cls: "marinmind-ai-preset-add" }))
			.setButtonText("新增预设")
			.onClick(() =>
				this.renderEditor({
					id: newAiId("preset"),
					name: "",
					baseUrl: "",
					apiKey: "",
					model: "",
				}),
			);
	}

	/** 编辑视图：四字段表单 + 保存/删除（新增预设无删除钮）；取消回列表 */
	private renderEditor(preset: AiPreset): void {
		const body = this.contentEl;
		body.empty();
		const isNew = !sanitizeAiPresets(this.plugin.settings.aiPresets).some(
			(p) => p.id === preset.id,
		);
		const draft: AiPreset = { ...preset };
		for (const field of PRESET_FIELDS) {
			const row = body.createDiv({ cls: "marinmind-ai-preset-field" });
			row.createEl("label", { text: field.label, attr: { for: `mm-ai-${field.key}` } });
			const input = row.createEl("input", {
				cls: "marinmind-ai-preset-input",
				attr: {
					id: `mm-ai-${field.key}`,
					type: field.password ? "password" : "text",
					placeholder: field.placeholder,
					autocomplete: "off",
					spellcheck: "false",
				},
			});
			input.value = draft[field.key];
			input.addEventListener("input", () => {
				draft[field.key] = input.value.trim();
			});
		}
		const actions = body.createDiv({ cls: "marinmind-ai-preset-editor-actions" });
		if (!isNew) {
			new ButtonComponent(actions)
				.setButtonText("删除")
				.setWarning()
				.onClick(() => this.removePreset(preset.id));
		}
		const right = actions.createDiv({ cls: "marinmind-ai-preset-editor-right" });
		new ButtonComponent(right).setButtonText("取消").onClick(() => this.renderList());
		new ButtonComponent(right)
			.setButtonText("保存")
			.setCta()
			.onClick(() => this.savePreset(draft, isNew));
	}

	/** 保存：四字段校验非空（缺项 Notice 指明字段）→ 去重合并/追加 → 落盘回列表 */
	private savePreset(draft: AiPreset, _isNew: boolean): void {
		const missing = PRESET_FIELDS.find((f) => !draft[f.key]);
		if (missing) {
			new Notice(`预设缺少「${missing.label}」，请补全后保存`);
			return;
		}
		const presets = sanitizeAiPresets(this.plugin.settings.aiPresets).filter(
			(p) => p.id !== draft.id,
		);
		presets.push(draft);
		this.plugin.settings.aiPresets = presets;
		// 首个预设保存后自动启用（免去再回列表点启用的一步）；其余保持原启用态
		if (presets.length === 1) {
			this.plugin.settings.aiActivePresetId = draft.id;
		}
		void this.plugin.saveData({ ...this.plugin.settings });
		new Notice(`预设「${draft.name}」已保存`);
		this.renderList();
	}

	/** 删除：移除预设；若是启用项同步清空启用 id；落盘回列表 */
	private removePreset(id: string): void {
		this.plugin.settings.aiPresets = sanitizeAiPresets(this.plugin.settings.aiPresets).filter(
			(p) => p.id !== id,
		);
		if (this.plugin.settings.aiActivePresetId === id) {
			this.plugin.settings.aiActivePresetId = "";
		}
		void this.plugin.saveData({ ...this.plugin.settings });
		new Notice("预设已删除");
		this.renderList();
	}
}
