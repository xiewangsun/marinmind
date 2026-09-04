import { ButtonComponent, Notice, Platform, PluginSettingTab, Setting } from "obsidian";
import type { App, TextComponent } from "obsidian";
import type MarinMindPlugin from "../main";
import { HOME_VIEW_TYPE, MarinMindHomeView } from "../home/home-view";
import { validateDirInput, type MarinMindSettings } from "./settings";
import { migrateDataDir } from "./migrate-data-dir";
import { DocumentManagerModal } from "../documents/document-manager-modal";
import { resolveBackupLocation } from "../storage/data-location";
import {
	isLinkDirection,
	isLineStyle,
	LINK_DIRECTIONS,
	LINK_DIRECTION_LABELS,
	LINE_STYLES,
	LINE_STYLE_LABELS,
} from "../types";
import {
	DEFAULT_TRANSLATE_TARGET,
	TRANSLATE_ENGINES,
	TRANSLATE_LANGUAGES,
	isTranslateEngineId,
	isTranslateLangCode,
} from "../translate/translate-engine";
import { DEFAULT_OCR_LANGS, OCR_LANGUAGES, isOcrLangs } from "../ocr/ocr-text";

/** R3（W-14）：路径/凭据输入关拼写检查与自动填充——防红线误报与密码管理器误触发 */
function noAssist(text: TextComponent): void {
	text.inputEl.autocomplete = "off";
	text.inputEl.spellcheck = false;
}

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
		this.renderWorkspaceSection(containerEl);
		this.renderDataSection(containerEl);
		this.renderBackupSection(containerEl);
		this.renderReaderSection(containerEl);
		this.renderOcrSection(containerEl);
		this.renderTranslateSection(containerEl);
		this.renderReviewSection(containerEl);
	}

	/** 工作区（79-1）：联动方向四档——门控自动跟随/点击定位/互关，显式编排不受限 */
	private renderWorkspaceSection(containerEl: HTMLElement): void {
		containerEl.createEl("h2", { text: "工作区" });

		new Setting(containerEl)
			.setName("联动方向")
			.setDesc(
				"文档与脑图联动的门控：双向（默认）为自动跟随 + 点击互相定位；单向档只放行对应方向；「关闭」则两窗格完全独立（自动跟随、点击定位、联动互关全部停用）。工作区命令与视图切换条等显式编排不受此开关影响。",
			)
			.addDropdown((dropdown) => {
				for (const dir of LINK_DIRECTIONS) {
					dropdown.addOption(dir, LINK_DIRECTION_LABELS[dir]);
				}
				dropdown.setValue(this.plugin.settings.linkDirection).onChange((value) => {
					if (!isLinkDirection(value)) {
						return;
					}
					this.plugin.settings.linkDirection = value;
					void this.plugin.saveData({ ...this.plugin.settings });
				});
			});
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
			noAssist(text); // R3（W-14）：路径输入
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

	/** 阅读（75 划选工具栏 / 77 线型）：text 工具划选的交互与文字摘录形态 */
	private renderReaderSection(containerEl: HTMLElement): void {
		containerEl.createEl("h2", { text: "阅读" });

		new Setting(containerEl)
			.setName("划选工具栏")
			.setDesc("选中文字后弹出浮动工具栏（色点摘录 / 线型 / 翻译 / 复制 / 书签 / 搜索）；关闭后恢复划选松开即直接建卡。")
			.addToggle((toggle) => {
				toggle
					.setValue(this.plugin.settings.selectionToolbar)
					.onChange(async (value) => {
						this.plugin.settings.selectionToolbar = value;
						await this.plugin.saveData({ ...this.plugin.settings });
					});
			});

		new Setting(containerEl)
			.setName("文字摘录线型")
			.setDesc("新建文字摘录的高亮形态（下划线 / 波浪线 / 删除线）；已有卡片点击高亮块菜单「线型…」单独修改。")
			.addDropdown((dropdown) => {
				for (const style of LINE_STYLES) {
					dropdown.addOption(style, LINE_STYLE_LABELS[style]);
				}
				dropdown
					.setValue(this.plugin.settings.excerptLineStyle)
					.onChange((value) => {
						if (!isLineStyle(value)) {
							return;
						}
						this.plugin.settings.excerptLineStyle = value;
						void this.plugin.saveData({ ...this.plugin.settings });
					});
			});
	}

	/** 文字识别 (OCR)（83）：识别语言组合 / 拖框即识 / 识别后自动翻译 */
	private renderOcrSection(containerEl: HTMLElement): void {
		containerEl.createEl("h2", { text: "文字识别 (OCR)" });

		new Setting(containerEl)
			.setName("识别语言")
			.setDesc(
				"区域 / 手写 / 整页 OCR 的识别语言组合；切换后首次识别会联网下载对应语言包（约 10-20MB，之后缓存本地离线可用）。",
			)
			.addDropdown((dropdown) => {
				for (const lang of OCR_LANGUAGES) {
					dropdown.addOption(lang.value, lang.label);
				}
				const current = this.plugin.settings.ocrLangs;
				dropdown
					.setValue(isOcrLangs(current) ? current : DEFAULT_OCR_LANGS)
					.onChange((value) => {
						if (!isOcrLangs(value)) {
							return;
						}
						this.plugin.settings.ocrLangs = value;
						void this.plugin.saveData({ ...this.plugin.settings });
					});
			});

		new Setting(containerEl)
			.setName("拖框即识")
			.setDesc(
				"区域摘录工具下框选松开即自动 OCR（免去二次点菜单识别）。默认关：首次使用会静默联网下载引擎，且连续摘录会被逐框识别等待打断。仅桌面端 PDF 文档生效。",
			)
			.addToggle((toggle) => {
				toggle
					.setValue(this.plugin.settings.ocrOnAreaExcerpt)
					.onChange(async (value) => {
						this.plugin.settings.ocrOnAreaExcerpt = value;
						await this.plugin.saveData({ ...this.plugin.settings });
					});
			});

		new Setting(containerEl)
			.setName("识别后自动翻译")
			.setDesc(
				"OCR 识别成功后自动翻译识别文字，并把译文存为原文正下方的留白卡（目标语言与引擎跟随「翻译」节设置）；翻译失败不影响已识别的文字。",
			)
			.addToggle((toggle) => {
				toggle
					.setValue(this.plugin.settings.ocrAutoTranslate)
					.onChange(async (value) => {
						this.plugin.settings.ocrAutoTranslate = value;
						await this.plugin.saveData({ ...this.plugin.settings });
					});
			});

		// 84-E 照片入库压缩：缩放 + WebP 转码省库体积（GIF/SVG 与小图不受影响）
		new Setting(containerEl)
			.setName("照片入库压缩")
			.setDesc(
				"超 300KB 的照片在保存为摘录卡片前，先缩放到最长边 2560px 并转为 WebP（画质 0.85，肉眼无损），显著减小库体积；GIF、SVG 与小图原样保留。",
			)
			.addToggle((toggle) => {
				toggle
					.setValue(this.plugin.settings.photoCompress)
					.onChange(async (value) => {
						this.plugin.settings.photoCompress = value;
						await this.plugin.saveData({ ...this.plugin.settings });
					});
			});
	}

	/** 翻译（㉔ + 83 多引擎）：目标语言 / 引擎选择 / 分引擎凭据 */
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

		// 83 备选引擎（85-B 增有道）：Google（免密钥，国内需代理）/ 百度 · 有道
		// （国内直连，需凭据）/ DeepL
		new Setting(containerEl)
			.setName("翻译引擎")
			.setDesc(
				"Google 免费接口免密钥（国内通常需代理）；百度 / 有道 / DeepL 需在下方填写凭据（百度与有道国内可直连）。目标语言中的粤语/文言文仅 Google 与百度支持。",
			)
			.addDropdown((dropdown) => {
				for (const engine of TRANSLATE_ENGINES) {
					dropdown.addOption(engine.id, engine.label);
				}
				const current = this.plugin.settings.translateEngine;
				dropdown
					.setValue(isTranslateEngineId(current) ? current : "google")
					.onChange((value) => {
						if (!isTranslateEngineId(value)) {
							return;
						}
						this.plugin.settings.translateEngine = value;
						void this.plugin.saveData({ ...this.plugin.settings });
						// 凭据输入按引擎显隐：整页重建最简实现（暂存字段构造器初始化不受影响）
						this.display();
					});
			});

		if (this.plugin.settings.translateEngine === "baidu") {
			new Setting(containerEl)
				.setName("百度翻译凭据")
				.setDesc(
					"fanyi.baidu.com 注册「通用翻译API」（标准版免费，限 1 次/秒），在管理控制台「开发者信息」查 APP ID 与密钥。凭据明文存于插件数据文件，请勿在共享库中使用。",
				)
				.addText((text) => {
					noAssist(text); // R3（W-14）：凭据输入
					text.setPlaceholder("APP ID").setValue(this.plugin.settings.translateBaiduAppid);
					text.onChange((value) => {
						this.plugin.settings.translateBaiduAppid = value.trim();
						void this.plugin.saveData({ ...this.plugin.settings });
					});
				})
				.addText((text) => {
					noAssist(text); // R3（W-14）：凭据输入
					text.setPlaceholder("密钥").setValue(this.plugin.settings.translateBaiduSecret);
					text.onChange((value) => {
						this.plugin.settings.translateBaiduSecret = value.trim();
						void this.plugin.saveData({ ...this.plugin.settings });
					});
				});
		}

		if (this.plugin.settings.translateEngine === "youdao") {
			new Setting(containerEl)
				.setName("有道翻译凭据")
				.setDesc(
					"ai.youdao.com 注册并创建「自然语言翻译服务」应用（文本翻译，新用户免费额度），在应用详情查应用 ID 与应用密钥，并确认已绑定「文本翻译服务」。凭据明文存于插件数据文件，请勿在共享库中使用。",
				)
				.addText((text) => {
					noAssist(text); // R3（W-14）：凭据输入
					text.setPlaceholder("应用 ID（appKey）").setValue(this.plugin.settings.translateYoudaoAppid);
					text.onChange((value) => {
						this.plugin.settings.translateYoudaoAppid = value.trim();
						void this.plugin.saveData({ ...this.plugin.settings });
					});
				})
				.addText((text) => {
					noAssist(text); // R3（W-14）：凭据输入
					text.setPlaceholder("应用密钥").setValue(this.plugin.settings.translateYoudaoAppSecret);
					text.onChange((value) => {
						this.plugin.settings.translateYoudaoAppSecret = value.trim();
						void this.plugin.saveData({ ...this.plugin.settings });
					});
				});
		}

		if (this.plugin.settings.translateEngine === "deepl") {
			new Setting(containerEl)
				.setName("DeepL Auth-Key")
				.setDesc(
					"deepl.com/pro#developer 注册 DeepL API Free（每月 50 万字符免费）获取密钥；免费版密钥以 :fx 结尾（自动走免费版端点）。凭据明文存于插件数据文件，请勿在共享库中使用。",
				)
				.addText((text) => {
					noAssist(text); // R3（W-14）：凭据输入
					text.setPlaceholder("Auth-Key（免费版以 :fx 结尾）").setValue(
						this.plugin.settings.translateDeeplKey,
					);
					text.onChange((value) => {
						this.plugin.settings.translateDeeplKey = value.trim();
						void this.plugin.saveData({ ...this.plugin.settings });
					});
				});
		}
	}

	/** 复习（65）：批次张数与每日新卡上限（68 起消费——due 分批与新卡混排） */
	private renderReviewSection(containerEl: HTMLElement): void {
		containerEl.createEl("h2", { text: "复习" });

		// R3（W-08/W-16）：数字字段 type=number（移动端弹数字键盘）+ 越界行内红字
		// （镜像数据目录校验先例——Notice 转瞬即逝且与字段分离）
		const batchDesc =
			"每次拉取的到期复习卡上限（5-200，默认 20）。新卡（首次考的卡）不占此名额，在复习卡之后追加。";
		const batchSetting = new Setting(containerEl).setName("每批复习张数").setDesc(batchDesc);
		batchSetting.addText((text) => {
			text.inputEl.type = "number";
			text.inputEl.setAttribute("inputmode", "numeric");
			text.setValue(String(this.plugin.settings.reviewBatchSize)).onChange((value) => {
				const n = Math.round(Number(value));
				const ok = Number.isFinite(n) && n >= 5 && n <= 200;
				batchSetting.descEl.textContent = ok ? batchDesc : "每批复习张数需为 5-200 的整数";
				batchSetting.descEl.style.color = ok ? "" : "var(--text-error)";
				if (!ok) {
					return;
				}
				this.plugin.settings.reviewBatchSize = n;
				void this.plugin.saveData({ ...this.plugin.settings });
			});
		});

		const newPerDayDesc =
			"每天最多引入多少张新闪卡（0-999，0 = 不限，默认 0）。开启后新卡排在到期复习卡之后，当日已考新卡计入配额；适合控制新知识引入速度。";
		const newPerDaySetting = new Setting(containerEl).setName("每日新卡上限").setDesc(newPerDayDesc);
		newPerDaySetting.addText((text) => {
			text.inputEl.type = "number";
			text.inputEl.setAttribute("inputmode", "numeric");
			text.setValue(String(this.plugin.settings.reviewNewPerDay)).onChange((value) => {
				const n = Math.round(Number(value));
				const ok = Number.isFinite(n) && n >= 0 && n <= 999;
				newPerDaySetting.descEl.textContent = ok
					? newPerDayDesc
					: "每日新卡上限需为 0-999 的整数（0 表示不限）";
				newPerDaySetting.descEl.style.color = ok ? "" : "var(--text-error)";
				if (!ok) {
					return;
				}
				this.plugin.settings.reviewNewPerDay = n;
				void this.plugin.saveData({ ...this.plugin.settings });
			});
		});
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
				noAssist(text); // R3（W-14）：路径输入
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
