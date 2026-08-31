import { ButtonComponent, Notice, Platform, PluginSettingTab, Setting } from "obsidian";
import type { App } from "obsidian";
import type MarinMindPlugin from "../main";
import { HOME_VIEW_TYPE, MarinMindHomeView } from "../home/home-view";
import { validateDirInput, type MarinMindSettings } from "./settings";
import { migrateDataDir } from "./migrate-data-dir";
import { DocumentManagerModal } from "../documents/document-manager-modal";
import { resolveBackupLocation } from "../storage/data-location";
import {
	DEFAULT_TRANSLATE_TARGET,
	TRANSLATE_LANGUAGES,
	isTranslateLangCode,
} from "../translate/translate-engine";

/**
 * MarinMind 设置页。
 * 数据目录采用"暂存 + 显式迁移"而非即时生效：避免每次击键触发迁移、
 * 以及无迁移的静默切换造成"设置指向新目录但数据在旧目录"的悬空态。
 */
export class MarinMindSettingTab extends PluginSettingTab {
	/** 数据目录暂存值与校验态（onChange 只暂存，迁移动作显式触发） */
	private pendingDataDir: string;
	private dataDirError: string | null = null;

	constructor(app: App, private readonly plugin: MarinMindPlugin) {
		super(app, plugin);
		this.pendingDataDir = plugin.settings.dataDir;
	}

	display(): void {
		const { containerEl } = this;
		containerEl.empty();

		this.renderAppearanceSection(containerEl);
		this.renderDataSection(containerEl);
		this.renderBackupSection(containerEl);
		this.renderTranslateSection(containerEl);
	}

	/** 外观（㊲ 起，㊸ 三态）：主页主题——Linear 深色（默认）/ Linear 浅色 / 跟随 Obsidian 主题 */
	private renderAppearanceSection(containerEl: HTMLElement): void {
		containerEl.createEl("h2", { text: "外观" });

		new Setting(containerEl)
			.setName("主页主题")
			.setDesc("Linear 深色为项目默认风格；浅色为 Linear 浅色变体（㊸）；「跟随 Obsidian 主题」则随当前亮/暗色主题变化。均立即生效。")
			.addDropdown((dropdown) => {
				// 选项值直接用存储值（dark/light/auto）——存量 data.json 仅有 dark/auto，均仍合法零迁移
				dropdown
					.addOption("dark", "Linear 深色（默认）")
					.addOption("light", "Linear 浅色")
					.addOption("auto", "跟随 Obsidian 主题")
					.setValue(this.plugin.settings.homeTheme)
					.onChange((value) => {
						// 选项值即合法三态（收窄 string 联合）
						this.plugin.settings.homeTheme = value as MarinMindSettings["homeTheme"];
						void this.plugin.saveData({ ...this.plugin.settings });
						// 已打开的主页视图立即换肤（无需重开）
						for (const leaf of this.app.workspace.getLeavesOfType(HOME_VIEW_TYPE)) {
							const view = leaf.view;
							if (view instanceof MarinMindHomeView) view.applyTheme();
						}
					});
			});
	}

	/** 数据存储：数据目录输入（暂存校验）+ 迁移入口 */
	private renderDataSection(containerEl: HTMLElement): void {
		containerEl.createEl("h2", { text: "数据存储" });

		const setting = new Setting(containerEl)
			.setName("数据目录")
			.setDesc(this.dataDirDesc());
		let migrateButton: ButtonComponent | undefined;
		setting.addText((text) => {
			text.setValue(this.pendingDataDir).onChange((value) => {
				const result = validateDirInput(value, Platform.isDesktopApp);
				if (result.ok) {
					this.pendingDataDir = result.normalized;
					this.dataDirError = null;
					setting.descEl.textContent = this.dataDirDesc();
					setting.descEl.style.color = "";
				} else {
					this.dataDirError = result.reason;
					setting.descEl.textContent = result.reason;
					setting.descEl.style.color = "var(--text-error)";
				}
				migrateButton?.setDisabled(!result.ok || result.normalized === this.plugin.settings.dataDir);
			});
		});
		new Setting(containerEl)
			.setName("应用并迁移数据")
			.setDesc("将数据库与媒体附件复制到上方新目录（旧位置保留作为回退），完成后自动重载。")
			.addButton((button) => {
				migrateButton = button
					.setButtonText("应用并迁移数据…")
					.setCta()
					.setDisabled(this.pendingDataDir === this.plugin.settings.dataDir || this.dataDirError !== null)
					.onClick(() => void migrateDataDir(this.plugin, this.pendingDataDir));
			});

		new Setting(containerEl)
			.setName("文档管理")
			.setDesc("查看全部文档记录与失联状态，重关联失联文档（卡片与复习进度保留）或清理无用记录。")
			.addButton((button) =>
				button.setButtonText("打开文档管理面板").onClick(() => {
					new DocumentManagerModal(this.app, this.plugin).open();
				}),
			);
	}

	/** 翻译（㉔）：目标语言默认值；引擎为 Google 免费接口（免密钥）故无配置项 */
	private renderTranslateSection(containerEl: HTMLElement): void {
		containerEl.createEl("h2", { text: "翻译" });

		new Setting(containerEl)
			.setName("目标语言")
			.setDesc("高亮菜单「翻译」的默认目标语言（翻译弹窗内可临时切换并会记住）。")
			.addDropdown((dropdown) => {
				for (const lang of TRANSLATE_LANGUAGES) {
					dropdown.addOption(lang.code, lang.label);
				}
				const current = this.plugin.settings.translateTarget;
				dropdown
					.setValue(isTranslateLangCode(current) ? current : DEFAULT_TRANSLATE_TARGET)
					.onChange((value) => {
						if (!isTranslateLangCode(value)) {
							return;
						}
						this.plugin.settings.translateTarget = value;
						void this.plugin.saveData({ ...this.plugin.settings });
					});
			});

		new Setting(containerEl)
			.setName("翻译引擎")
			.setDesc(
				"Google 免费翻译接口（免密钥，自动检测源语言）。需网络可达 translate.googleapis.com（国内通常需代理）；移动端同样可用。",
			);
	}

	private dataDirDesc(): string {
		return Platform.isDesktopApp
			? "存放 md 笔记与媒体附件。vault 内相对路径（如 MarinMind），或本机绝对路径（如 D:\\MarinMindData）。更改后需迁移数据。"
			: "存放 md 笔记与媒体附件，vault 内相对路径（移动端不支持本机路径）。更改后需迁移数据。";
	}

	/** 备份：目录即时保存（只影响后续导出落点，无数据迁移） */
	private renderBackupSection(containerEl: HTMLElement): void {
		containerEl.createEl("h2", { text: "备份" });

		new Setting(containerEl)
			.setName("备份目录")
			.setDesc(".marginpkg 导出落点。vault 内相对路径或本机绝对路径（仅桌面）；不影响已导出的历史备份。")
			.addText((text) => {
				text.setValue(this.plugin.settings.backupDir).onChange((value) => {
					void this.applyBackupDir(value.trim());
				});
			});
	}

	private async applyBackupDir(value: string): Promise<void> {
		const result = validateDirInput(value, Platform.isDesktopApp);
		if (!result.ok) {
			new Notice(`备份目录无效：${result.reason}`);
			return;
		}
		// 跨字段校验：备份目录不得与数据目录重叠（互相写满/误删风险）
		if (result.normalized === this.pendingDataDir) {
			new Notice("备份目录不能与数据目录相同");
			return;
		}
		if (result.normalized === this.plugin.settings.backupDir) return;
		const previous = this.plugin.settings.backupDir;
		this.plugin.settings.backupDir = result.normalized;
		try {
			// 先验证新目录可解析（可写）再落盘设置
			const loc = await resolveBackupLocation(this.app, result.normalized);
			await this.plugin.saveData({ ...this.plugin.settings });
			this.plugin.backupLoc = loc;
			new Notice(`备份目录已更新：${result.normalized}`);
		} catch (err) {
			this.plugin.settings.backupDir = previous;
			console.error("[MarinMind] 备份目录解析失败", err);
			new Notice(`备份目录不可用：${err instanceof Error ? err.message : String(err)}`);
		}
	}
}
