import { ButtonComponent, Notice, Platform, PluginSettingTab, Setting } from "obsidian";
import type { App, TextComponent } from "obsidian";
import type MarinMindPlugin from "../main";
import { isUiLocale, setLocale, t } from "../i18n/i18n";
import { HOME_VIEW_TYPE, MarinMindHomeView } from "../home/home-view";
import { validateDirInput, type MarinMindSettings } from "./settings";
import { migrateDataDir } from "./migrate-data-dir";
import { DocumentManagerModal } from "../documents/document-manager-modal";
import { resolveBackupLocation } from "../storage/data-location";
import {
	isLinkDirection,
	isLineStyle,
	isReflowColumnWidth,
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
import { AiPresetModal } from "../ai/ai-preset-modal";
import { AiCustomPromptModal } from "../ai/ai-custom-prompt-modal";
import { sanitizeAiCustomPrompts, sanitizeAiPresets } from "../ai/ai-provider";
import { testAiConnection } from "../ai/ai-service";
import {
	WEB_SEARCH_ENGINES,
	isWebSearchServiceId,
	searchServiceReady,
} from "../ai/web-search-engine";
import { testSearchConnection } from "../ai/web-search-service";
import { validateAccelerator } from "../capture/screen-capture";

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

	constructor(
		app: App,
		private readonly plugin: MarinMindPlugin,
	) {
		super(app, plugin);
		this.pendingDataDir = plugin.settings.dataDir;
	}

	display(): void {
		const { containerEl } = this;
		containerEl.empty();

		this.renderGeneralSection(containerEl);
		this.renderAppearanceSection(containerEl);
		this.renderWorkspaceSection(containerEl);
		this.renderDataSection(containerEl);
		this.renderWebclipSection(containerEl);
		this.renderCaptureSection(containerEl);
		this.renderBackupSection(containerEl);
		this.renderReaderSection(containerEl);
		this.renderOcrSection(containerEl);
		this.renderTranslateSection(containerEl);
		this.renderAiSection(containerEl);
		this.renderReviewSection(containerEl);
	}

	/** 工作区（79-1）：联动方向四档——门控自动跟随/点击定位/互关，显式编排不受限 */
	/** 常规（148 i18n）：界面语言——中文（默认）/ English（缺词条回退中文） */
	private renderGeneralSection(containerEl: HTMLElement): void {
		new Setting(containerEl).setName(t("常规")).setHeading();

		new Setting(containerEl)
			.setName(t("界面语言 / Language"))
			.setDesc(
				t(
					"Interface language. English translations are added progressively; untranslated texts fall back to Chinese. 已打开的界面即时生效，命令面板名称需重启 Obsidian 后更新。",
				),
			)
			.addDropdown((dropdown) => {
				dropdown
					.addOption("zh", t("中文（默认）"))
					.addOption("en", t("English"))
					.setValue(this.plugin.settings.language)
					.onChange((value) => {
						if (!isUiLocale(value)) {
							return;
						}
						this.plugin.settings.language = value;
						setLocale(value); // 即时生效：此后渲染的界面走新语言
						void this.plugin.saveData({ ...this.plugin.settings });
						new Notice(
							t("语言已切换——已打开的界面需重开（或重启 Obsidian）后完全生效"),
						);
						this.display(); // 设置页本身换语言重渲染
					});
			});
	}

	private renderWorkspaceSection(containerEl: HTMLElement): void {
		new Setting(containerEl).setName(t("工作区")).setHeading();

		new Setting(containerEl)
			.setName(t("联动方向"))
			.setDesc(
				t(
					"文档与脑图联动的门控：双向（默认）为自动跟随 + 点击互相定位；单向档只放行对应方向；「关闭」则两窗格完全独立（自动跟随、点击定位、联动互关全部停用）。工作区命令与视图切换条等显式编排不受此开关影响。",
				),
			)
			.addDropdown((dropdown) => {
				for (const dir of LINK_DIRECTIONS) {
					dropdown.addOption(dir, t(LINK_DIRECTION_LABELS[dir]));
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
		new Setting(containerEl).setName(t("外观")).setHeading();

		new Setting(containerEl)
			.setName(t("主页主题"))
			.setDesc(
				t(
					"Linear 深色为项目默认风格；浅色为 Linear 浅色变体（㊸）；「跟随 Obsidian 主题」则随当前亮/暗色主题变化。均立即生效。",
				),
			)
			.addDropdown((dropdown) => {
				// 选项值直接用存储值（dark/light/auto）——存量 data.json 仅有 dark/auto，均仍合法零迁移
				dropdown
					.addOption("dark", t("Linear 深色（默认）"))
					.addOption("light", t("Linear 浅色"))
					.addOption("auto", t("跟随 Obsidian 主题"))
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
		new Setting(containerEl).setName(t("数据存储")).setHeading();

		const setting = new Setting(containerEl).setName(t("数据目录")).setDesc(this.dataDirDesc());
		let migrateButton: ButtonComponent | undefined;
		setting.addText((text) => {
			noAssist(text); // R3（W-14）：路径输入
			text.setValue(this.pendingDataDir).onChange((value) => {
				const result = validateDirInput(value, Platform.isDesktopApp);
				if (result.ok) {
					this.pendingDataDir = result.normalized;
					this.dataDirError = null;
					setting.descEl.textContent = this.dataDirDesc();
					setting.descEl.setCssStyles({ color: "" });
				} else {
					this.dataDirError = result.reason;
					setting.descEl.textContent = result.reason;
					setting.descEl.setCssStyles({ color: "var(--text-error)" });
				}
				migrateButton?.setDisabled(
					!result.ok || result.normalized === this.plugin.settings.dataDir,
				);
			});
		});
		new Setting(containerEl)
			.setName(t("应用并迁移数据"))
			.setDesc(
				t("将数据库与媒体附件复制到上方新目录（旧位置保留作为回退），完成后自动重载。"),
			)
			.addButton((button) => {
				migrateButton = button
					.setButtonText(t("应用并迁移数据…"))
					.setCta()
					.setDisabled(
						this.pendingDataDir === this.plugin.settings.dataDir ||
							this.dataDirError !== null,
					)
					.onClick(() => void migrateDataDir(this.plugin, this.pendingDataDir));
			});

		new Setting(containerEl)
			.setName(t("文档管理"))
			.setDesc(
				t(
					"查看全部文档记录与失联状态，重关联失联文档（卡片与复习进度保留）或清理无用记录。",
				),
			)
			.addButton((button) =>
				button.setButtonText(t("打开文档管理面板")).onClick(() => {
					new DocumentManagerModal(this.app, this.plugin).open();
				}),
			);
	}

	/** 阅读（75 划选工具栏 / 77 线型）：text 工具划选的交互与文字摘录形态 */
	private renderReaderSection(containerEl: HTMLElement): void {
		new Setting(containerEl).setName(t("阅读")).setHeading();

		new Setting(containerEl)
			.setName(t("划选工具栏"))
			.setDesc(
				t(
					"选中文字后弹出浮动工具栏（色点摘录 / 线型 / 翻译 / 复制 / 书签 / 搜索）；关闭后恢复划选松开即直接建卡。",
				),
			)
			.addToggle((toggle) => {
				toggle.setValue(this.plugin.settings.selectionToolbar).onChange(async (value) => {
					this.plugin.settings.selectionToolbar = value;
					await this.plugin.saveData({ ...this.plugin.settings });
				});
			});

		new Setting(containerEl)
			.setName(t("文字摘录线型"))
			.setDesc(
				t(
					"新建文字摘录的高亮形态（下划线 / 波浪线 / 删除线）；已有卡片点击高亮块菜单「线型…」单独修改。",
				),
			)
			.addDropdown((dropdown) => {
				for (const style of LINE_STYLES) {
					dropdown.addOption(style, t(LINE_STYLE_LABELS[style]));
				}
				dropdown.setValue(this.plugin.settings.excerptLineStyle).onChange((value) => {
					if (!isLineStyle(value)) {
						return;
					}
					this.plugin.settings.excerptLineStyle = value;
					void this.plugin.saveData({ ...this.plugin.settings });
				});
			});

		new Setting(containerEl)
			.setName(t("重排文档栏宽"))
			.setDesc(
				t(
					"Markdown / 剪藏 / EPUB 阅读的栏宽三档（窄 640 / 标准 820 / 宽 1040）；标准为历史默认。换档后需重开文档生效。",
				),
			)
			.addDropdown((dropdown) => {
				dropdown
					.addOption("narrow", t("窄（640px）"))
					.addOption("standard", t("标准（820px，默认）"))
					.addOption("wide", t("宽（1040px）"))
					.setValue(this.plugin.settings.reflowColumnWidth)
					.onChange((value) => {
						if (!isReflowColumnWidth(value)) {
							return;
						}
						this.plugin.settings.reflowColumnWidth = value;
						void this.plugin.saveData({ ...this.plugin.settings });
					});
			});
	}

	/** 文字识别 (OCR)（83）：识别语言组合 / 拖框即识 / 识别后自动翻译 */
	private renderOcrSection(containerEl: HTMLElement): void {
		new Setting(containerEl).setName(t("文字识别 (OCR)")).setHeading();

		new Setting(containerEl)
			.setName(t("识别语言"))
			.setDesc(
				t(
					"区域 / 手写 / 整页 OCR 的识别语言组合；切换后首次识别会联网下载对应语言包（约 10-20MB，之后缓存本地离线可用）。",
				),
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
			.setName(t("拖框即识"))
			.setDesc(
				t(
					"区域摘录工具下框选松开即自动 OCR（免去二次点菜单识别）。默认关：首次使用会静默联网下载引擎，且连续摘录会被逐框识别等待打断。仅桌面端 PDF 文档生效。",
				),
			)
			.addToggle((toggle) => {
				toggle.setValue(this.plugin.settings.ocrOnAreaExcerpt).onChange(async (value) => {
					this.plugin.settings.ocrOnAreaExcerpt = value;
					await this.plugin.saveData({ ...this.plugin.settings });
				});
			});

		new Setting(containerEl)
			.setName(t("识别后自动翻译"))
			.setDesc(
				t(
					"OCR 识别成功后自动翻译识别文字，并把译文存为原文正下方的留白卡（目标语言与引擎跟随「翻译」节设置）；翻译失败不影响已识别的文字。",
				),
			)
			.addToggle((toggle) => {
				toggle.setValue(this.plugin.settings.ocrAutoTranslate).onChange(async (value) => {
					this.plugin.settings.ocrAutoTranslate = value;
					await this.plugin.saveData({ ...this.plugin.settings });
				});
			});

		// 84-E 照片入库压缩：缩放 + WebP 转码省库体积（GIF/SVG 与小图不受影响）
		new Setting(containerEl)
			.setName(t("照片入库压缩"))
			.setDesc(
				t(
					"超 300KB 的照片在保存为摘录卡片前，先缩放到最长边 2560px 并转为 WebP（画质 0.85，肉眼无损），显著减小库体积；GIF、SVG 与小图原样保留。",
				),
			)
			.addToggle((toggle) => {
				toggle.setValue(this.plugin.settings.photoCompress).onChange(async (value) => {
					this.plugin.settings.photoCompress = value;
					await this.plugin.saveData({ ...this.plugin.settings });
				});
			});
	}

	/** 翻译（㉔ + 83 多引擎）：目标语言 / 引擎选择 / 分引擎凭据 */
	private renderTranslateSection(containerEl: HTMLElement): void {
		new Setting(containerEl).setName(t("翻译")).setHeading();

		new Setting(containerEl)
			.setName(t("目标语言"))
			.setDesc(t("高亮菜单「翻译」的默认目标语言（翻译弹窗内可临时切换并会记住）。"))
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
			.setName(t("翻译引擎"))
			.setDesc(
				t(
					"Google 免费接口免密钥（国内通常需代理）；百度 / 有道 / DeepL 需在下方填写凭据（百度与有道国内可直连）。目标语言中的粤语/文言文仅 Google 与百度支持。",
				),
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
				.setName(t("百度翻译凭据"))
				.setDesc(
					t(
						"fanyi.baidu.com 注册「通用翻译API」（标准版免费，限 1 次/秒），在管理控制台「开发者信息」查 APP ID 与密钥。凭据明文存于插件数据文件，请勿在共享库中使用。",
					),
				)
				.addText((text) => {
					noAssist(text); // R3（W-14）：凭据输入
					text.setPlaceholder("APP ID").setValue(
						this.plugin.settings.translateBaiduAppid,
					);
					text.onChange((value) => {
						this.plugin.settings.translateBaiduAppid = value.trim();
						void this.plugin.saveData({ ...this.plugin.settings });
					});
				})
				.addText((text) => {
					noAssist(text); // R3（W-14）：凭据输入
					text.inputEl.type = "password"; // 密钥防肩窥（对齐 AI 预设弹窗，139-A）
					text.setPlaceholder("密钥").setValue(this.plugin.settings.translateBaiduSecret);
					text.onChange((value) => {
						this.plugin.settings.translateBaiduSecret = value.trim();
						void this.plugin.saveData({ ...this.plugin.settings });
					});
				});
		}

		if (this.plugin.settings.translateEngine === "youdao") {
			new Setting(containerEl)
				.setName(t("有道翻译凭据"))
				.setDesc(
					t(
						"ai.youdao.com 注册并创建「自然语言翻译服务」应用（文本翻译，新用户免费额度），在应用详情查应用 ID 与应用密钥，并确认已绑定「文本翻译服务」。凭据明文存于插件数据文件，请勿在共享库中使用。",
					),
				)
				.addText((text) => {
					noAssist(text); // R3（W-14）：凭据输入
					text.setPlaceholder("应用 ID（appKey）").setValue(
						this.plugin.settings.translateYoudaoAppid,
					);
					text.onChange((value) => {
						this.plugin.settings.translateYoudaoAppid = value.trim();
						void this.plugin.saveData({ ...this.plugin.settings });
					});
				})
				.addText((text) => {
					noAssist(text); // R3（W-14）：凭据输入
					text.inputEl.type = "password"; // 密钥防肩窥（对齐 AI 预设弹窗，139-A）
					text.setPlaceholder("应用密钥").setValue(
						this.plugin.settings.translateYoudaoAppSecret,
					);
					text.onChange((value) => {
						this.plugin.settings.translateYoudaoAppSecret = value.trim();
						void this.plugin.saveData({ ...this.plugin.settings });
					});
				});
		}

		if (this.plugin.settings.translateEngine === "deepl") {
			new Setting(containerEl)
				.setName(t("DeepL Auth-Key"))
				.setDesc(
					t(
						"deepl.com/pro#developer 注册 DeepL API Free（每月 50 万字符免费）获取密钥；免费版密钥以 :fx 结尾（自动走免费版端点）。凭据明文存于插件数据文件，请勿在共享库中使用。",
					),
				)
				.addText((text) => {
					noAssist(text); // R3（W-14）：凭据输入
					text.inputEl.type = "password"; // 密钥防肩窥（对齐 AI 预设弹窗，139-A）
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

	/** AI（96）：模型预设（OpenAI 兼容端点）/ 测试连接 / 采样与流式 / 上下文预算 / 用量 */
	private renderAiSection(containerEl: HTMLElement): void {
		new Setting(containerEl).setName(t("AI")).setHeading();

		const presets = sanitizeAiPresets(this.plugin.settings.aiPresets);
		const activePreset = presets.find((p) => p.id === this.plugin.settings.aiActivePresetId);
		new Setting(containerEl)
			.setName(t("模型预设"))
			.setDesc(
				activePreset
					? `当前启用「${activePreset.name}」（${activePreset.model}）。凭据明文存于插件数据文件，请勿在共享库中使用。`
					: "未启用——AI 功能需先添加并启用一个模型预设。支持 OpenAI 兼容端点（DeepSeek / 智谱 / OpenAI / oneapi 系中转站等）。",
			)
			.addDropdown((dropdown) => {
				dropdown.addOption("", t("未启用"));
				for (const preset of presets) {
					dropdown.addOption(preset.id, preset.name);
				}
				dropdown.setValue(this.plugin.settings.aiActivePresetId).onChange((value) => {
					this.plugin.settings.aiActivePresetId = value;
					void this.plugin.saveData({ ...this.plugin.settings });
					// desc 与测试连接钮状态随启用态变化：整页重建（镜像翻译引擎切换先例）
					this.display();
				});
			})
			.addButton((button) =>
				button.setButtonText(t("管理预设…")).onClick(() => {
					new AiPresetModal(this.app, this.plugin, () => this.display()).open();
				}),
			);

		// 测试连接：max_tokens=1 的 ping（未启用时按钮禁用；成功 Notice 带模型名）
		new Setting(containerEl)
			.setName(t("测试连接"))
			.setDesc(t("向当前启用预设发送一条最小请求，验证地址、密钥与模型名可用。"))
			.addButton((button) => {
				button
					.setButtonText(t("测试连接"))
					.setDisabled(!activePreset)
					.onClick(async () => {
						button.setDisabled(true).setButtonText(t("测试中…"));
						try {
							const model = await testAiConnection(this.plugin.settings);
							new Notice(`AI 连接成功：模型 ${model}`);
						} catch (err) {
							console.error("[MarinMind] AI 测试连接失败", err);
							new Notice(
								`AI 连接失败：${err instanceof Error ? err.message : String(err)}`,
							);
						} finally {
							button.setDisabled(false).setButtonText(t("测试连接"));
						}
					});
			});

		// 温度（96）：浮点输入 + 行内红字校验（镜像复习节数字校验先例）
		const tempDesc =
			"采样温度（0-2，默认 0.3）：越低越确定、越高越发散；制卡/整理等结构化场景建议保持低值。";
		const tempSetting = new Setting(containerEl).setName(t("采样温度")).setDesc(tempDesc);
		tempSetting.addText((text) => {
			text.inputEl.type = "number";
			text.inputEl.setAttribute("inputmode", "decimal");
			text.inputEl.setAttribute("step", "0.1");
			text.setValue(String(this.plugin.settings.aiTemperature)).onChange((value) => {
				const n = Number(value);
				const ok = Number.isFinite(n) && n >= 0 && n <= 2;
				tempSetting.descEl.textContent = ok
					? tempDesc
					: "采样温度需为 0-2 之间的数值（默认 0.3）";
				tempSetting.descEl.setCssStyles({ color: ok ? "" : "var(--text-error)" });
				if (!ok) {
					return;
				}
				this.plugin.settings.aiTemperature = n;
				void this.plugin.saveData({ ...this.plugin.settings });
			});
		});

		new Setting(containerEl)
			.setName(t("流式输出"))
			.setDesc(
				t(
					"开启（默认）逐字流式显示 AI 回复；个别自建网关或移动端不支持流式时自动降级整包返回。「关闭」则始终整包返回（最稳但无逐字效果）。",
				),
			)
			.addDropdown((dropdown) => {
				dropdown
					.addOption("auto", t("开启（自动降级）"))
					.addOption("off", t("关闭（始终整包）"))
					.setValue(this.plugin.settings.aiStream)
					.onChange((value) => {
						this.plugin.settings.aiStream = value === "off" ? "off" : "auto";
						void this.plugin.saveData({ ...this.plugin.settings });
					});
			});

		// 上下文预算（96）：文档问答/摘要的分块裁剪上限
		const budgetDesc =
			"单次请求上下文 token 预算（2000-200000，默认 24000）：文档问答与摘要按此裁剪送入的内容量（估算值，中文约一字一 token）。";
		const budgetSetting = new Setting(containerEl)
			.setName(t("上下文 token 预算"))
			.setDesc(budgetDesc);
		budgetSetting.addText((text) => {
			text.inputEl.type = "number";
			text.inputEl.setAttribute("inputmode", "numeric");
			text.setValue(String(this.plugin.settings.aiMaxContextTokens)).onChange((value) => {
				const n = Math.round(Number(value));
				const ok = Number.isFinite(n) && n >= 2000 && n <= 200000;
				budgetSetting.descEl.textContent = ok
					? budgetDesc
					: "上下文 token 预算需为 2000-200000 的整数（默认 24000）";
				budgetSetting.descEl.setCssStyles({ color: ok ? "" : "var(--text-error)" });
				if (!ok) {
					return;
				}
				this.plugin.settings.aiMaxContextTokens = n;
				void this.plugin.saveData({ ...this.plugin.settings });
			});
		});

		// 自定义指令（97）：划选工具栏 AI 菜单的自定义项管理
		const customPrompts = sanitizeAiCustomPrompts(this.plugin.settings.aiCustomPrompts);
		new Setting(containerEl)
			.setName(t("自定义 AI 指令"))
			.setDesc(
				customPrompts.length > 0
					? `已有 ${customPrompts.length} 条（${customPrompts.map((p) => p.label).join("、")}），出现在划选工具栏的 AI 菜单里。`
					: "添加后出现在划选工具栏的 AI 菜单里（如「举例说明」「出 3 道练习题」）。",
			)
			.addButton((button) =>
				button.setButtonText(t("管理指令…")).onClick(() => {
					new AiCustomPromptModal(this.app, this.plugin, () => this.display()).open();
				}),
			);

		new Setting(containerEl)
			.setName(t("AI 制卡自动转闪卡"))
			.setDesc(t("AI 生成的卡片默认直接进入复习队列（可在制卡预览中逐批调整）。"))
			.addToggle((toggle) => {
				toggle.setValue(this.plugin.settings.aiAutoFlashcard).onChange(async (value) => {
					this.plugin.settings.aiAutoFlashcard = value;
					await this.plugin.saveData({ ...this.plugin.settings });
				});
			});

		// 用量展示（96）：请求次数与累计 token（流式为估算值），只读 + 清零
		const usage = this.plugin.settings.aiUsage;
		new Setting(containerEl)
			.setName(t("累计用量"))
			.setDesc(
				`请求 ${usage.requests} 次 · 输入 ${usage.promptTokens.toLocaleString()} · 输出 ${usage.completionTokens.toLocaleString()} token（流式请求为估算值）。`,
			)
			.addButton((button) =>
				button.setButtonText(t("清零")).onClick(() => {
					this.plugin.settings.aiUsage = {
						requests: 0,
						promptTokens: 0,
						completionTokens: 0,
					};
					void this.plugin.saveData({ ...this.plugin.settings });
					this.display();
				}),
			);

		// ---------- 联网搜索服务（128 AI 联网后备） ----------

		new Setting(containerEl)
			.setName(t("联网搜索服务"))
			.setDesc(
				t(
					"普通模型（DeepSeek 等）无联网能力时，插件先经所选搜索服务取回资料、拼进提问上下文（RAG）让回答带网络信息；GLM / search-preview / sonar / :online 等自带搜索的模型优先走厂商能力、不经此服务。搜索按服务方计费（Tavily 免费档每月 1000 次、博查按次计费、SearXNG 自建免费）。",
				),
			)
			.addDropdown((dropdown) => {
				dropdown.addOption("off", t("关闭（默认）"));
				for (const engine of WEB_SEARCH_ENGINES) {
					dropdown.addOption(engine.id, engine.label);
				}
				const current = this.plugin.settings.webSearchService;
				dropdown
					.setValue(isWebSearchServiceId(current) ? current : "off")
					.onChange((value) => {
						if (!isWebSearchServiceId(value)) {
							return;
						}
						this.plugin.settings.webSearchService = value;
						void this.plugin.saveData({ ...this.plugin.settings });
						// 凭据输入按服务显隐：整页重建最简实现（镜像翻译引擎切换先例）
						this.display();
					});
			});

		if (this.plugin.settings.webSearchService === "tavily") {
			new Setting(containerEl)
				.setName(t("Tavily API Key"))
				.setDesc(
					t(
						"app.tavily.com 注册获取（免费档每月 1000 次调用）。凭据明文存于插件数据文件，请勿在共享库中使用。",
					),
				)
				.addText((text) => {
					noAssist(text); // R3（W-14）：凭据输入
					text.inputEl.type = "password"; // 密钥防肩窥（对齐 AI 预设弹窗，139-A）
					text.setPlaceholder("tvly-…").setValue(this.plugin.settings.webSearchTavilyKey);
					text.onChange((value) => {
						this.plugin.settings.webSearchTavilyKey = value.trim();
						void this.plugin.saveData({ ...this.plugin.settings });
					});
				});
		}

		if (this.plugin.settings.webSearchService === "bocha") {
			new Setting(containerEl)
				.setName(t("博查 API Key"))
				.setDesc(
					t(
						"open.bochaai.com 注册获取（按次计费，Web Search 每千次 ¥40 起）。国内直连可用。凭据明文存于插件数据文件，请勿在共享库中使用。",
					),
				)
				.addText((text) => {
					noAssist(text); // R3（W-14）：凭据输入
					text.inputEl.type = "password"; // 密钥防肩窥（对齐 AI 预设弹窗，139-A）
					text.setPlaceholder("sk-…").setValue(this.plugin.settings.webSearchBochaKey);
					text.onChange((value) => {
						this.plugin.settings.webSearchBochaKey = value.trim();
						void this.plugin.saveData({ ...this.plugin.settings });
					});
				});
		}

		if (this.plugin.settings.webSearchService === "searxng") {
			new Setting(containerEl)
				.setName(t("SearXNG 实例地址"))
				.setDesc(
					t(
						"自建聚合搜索引擎（searx.github.io/searxng）的地址，如 http://127.0.0.1:8080；实例需在设置中开启 json 输出格式（search.formats 含 json）。自建免费且数据不出本地网络。",
					),
				)
				.addText((text) => {
					noAssist(text); // R3（W-14）：地址输入
					text.setPlaceholder("http://127.0.0.1:8080").setValue(
						this.plugin.settings.webSearchSearxngUrl,
					);
					text.onChange((value) => {
						this.plugin.settings.webSearchSearxngUrl = value.trim().replace(/\/+$/, "");
						void this.plugin.saveData({ ...this.plugin.settings });
					});
				});
		}

		// 搜索测试连接：off 时隐藏（与 AI 测试连接并列；凭据缺失时按钮禁用 + desc 引导）
		if (this.plugin.settings.webSearchService !== "off") {
			const callReady = searchServiceReady(this.plugin.settings);
			new Setting(containerEl)
				.setName(t("测试搜索连接"))
				.setDesc(
					callReady
						? "用固定词搜一次，验证服务地址与凭据可用。"
						: "凭据未填写完整——补全上方输入后自动启用测试。",
				)
				.addButton((button) => {
					button
						.setButtonText(t("测试搜索"))
						.setDisabled(!callReady)
						.onClick(async () => {
							button.setDisabled(true).setButtonText(t("测试中…"));
							try {
								const results = await testSearchConnection(this.plugin.settings);
								new Notice(
									results && results.length > 0
										? `搜索连接成功：返回 ${results.length} 条结果`
										: "搜索连接成功（无结果，可换个词再试）",
								);
							} catch (err) {
								console.error("[MarinMind] 搜索测试连接失败", err);
								new Notice(
									`搜索连接失败：${err instanceof Error ? err.message : String(err)}`,
								);
							} finally {
								button.setDisabled(false).setButtonText(t("测试搜索"));
							}
						});
				});
		}
	}

	/** 复习（65）：批次张数与每日新卡上限（68 起消费——due 分批与新卡混排） */
	private renderReviewSection(containerEl: HTMLElement): void {
		new Setting(containerEl).setName(t("复习")).setHeading();

		// R3（W-08/W-16）：数字字段 type=number（移动端弹数字键盘）+ 越界行内红字
		// （镜像数据目录校验先例——Notice 转瞬即逝且与字段分离）
		const batchDesc =
			"每次拉取的到期复习卡上限（5-200，默认 20）。新卡（首次考的卡）不占此名额，在复习卡之后追加。";
		const batchSetting = new Setting(containerEl).setName(t("每批复习张数")).setDesc(batchDesc);
		batchSetting.addText((text) => {
			text.inputEl.type = "number";
			text.inputEl.setAttribute("inputmode", "numeric");
			text.setValue(String(this.plugin.settings.reviewBatchSize)).onChange((value) => {
				const n = Math.round(Number(value));
				const ok = Number.isFinite(n) && n >= 5 && n <= 200;
				batchSetting.descEl.textContent = ok ? batchDesc : "每批复习张数需为 5-200 的整数";
				batchSetting.descEl.setCssStyles({ color: ok ? "" : "var(--text-error)" });
				if (!ok) {
					return;
				}
				this.plugin.settings.reviewBatchSize = n;
				void this.plugin.saveData({ ...this.plugin.settings });
			});
		});

		const newPerDayDesc =
			"每天最多引入多少张新闪卡（0-999，0 = 不限，默认 0）。开启后新卡排在到期复习卡之后，当日已考新卡计入配额；适合控制新知识引入速度。";
		const newPerDaySetting = new Setting(containerEl)
			.setName(t("每日新卡上限"))
			.setDesc(newPerDayDesc);
		newPerDaySetting.addText((text) => {
			text.inputEl.type = "number";
			text.inputEl.setAttribute("inputmode", "numeric");
			text.setValue(String(this.plugin.settings.reviewNewPerDay)).onChange((value) => {
				const n = Math.round(Number(value));
				const ok = Number.isFinite(n) && n >= 0 && n <= 999;
				newPerDaySetting.descEl.textContent = ok
					? newPerDayDesc
					: "每日新卡上限需为 0-999 的整数（0 表示不限）";
				newPerDaySetting.descEl.setCssStyles({ color: ok ? "" : "var(--text-error)" });
				if (!ok) {
					return;
				}
				this.plugin.settings.reviewNewPerDay = n;
				void this.plugin.saveData({ ...this.plugin.settings });
			});
		});

		// 103 调度算法：SM-2 / FSRS-4.5 切换（即时生效；SM-2 存量卡切 fsrs 后
		// 首次评分惰性迁移记忆状态，切回零成本——双向可退）
		new Setting(containerEl)
			.setName(t("调度算法"))
			.setDesc(
				t(
					"SM-2（Anki 简化版，默认）或 FSRS-4.5（记忆稳定性/难度模型，间隔更平滑）。切换即时生效；切换只影响之后的评分，已算出的到期时间不变。",
				),
			)
			.addDropdown((drop) => {
				drop.addOption("sm2", t("SM-2（Anki 简化版）"));
				drop.addOption("fsrs", t("FSRS-4.5"));
				drop.setValue(this.plugin.settings.scheduler).onChange((value) => {
					this.plugin.settings.scheduler = value === "fsrs" ? "fsrs" : "sm2";
					void this.plugin.saveData({ ...this.plugin.settings });
				});
			});
	}

	private dataDirDesc(): string {
		return Platform.isDesktopApp
			? "存放 md 笔记与媒体附件。vault 内相对路径（如 MarinMind），或本机绝对路径（如 D:\\MarinMindData）。更改后需迁移数据。"
			: "存放 md 笔记与媒体附件，vault 内相对路径（移动端不支持本机路径）。更改后需迁移数据。";
	}

	/** 网页剪藏（113 起 / 124 落点固定）：图片本地化开关（存量剪藏已由启动迁移搬入数据根 clips/） */
	private renderWebclipSection(containerEl: HTMLElement): void {
		new Setting(containerEl).setName(t("网页剪藏")).setHeading();

		new Setting(containerEl)
			.setName(t("剪藏落点"))
			.setDesc(
				`网页剪藏与屏幕剪藏保存到数据目录的 clips/ 子文件夹（与 books/、mindmaps/ 同级），正文图片统一存 assets/。`,
			);

		new Setting(containerEl)
			.setName(t("图片下载到本地"))
			.setDesc(
				t(
					"剪藏时把正文图片下载到数据目录 assets/（并发 3、至多 20 张、单张 ≤20MB）；失败与超限的图片自动回退为远程链接。",
				),
			)
			.addToggle((toggle) => {
				toggle
					.setValue(this.plugin.settings.webclipDownloadImages)
					.onChange(async (value) => {
						this.plugin.settings.webclipDownloadImages = value;
						await this.plugin.saveData({ ...this.plugin.settings });
					});
			});
	}

	/** 屏幕截图（117/119）：全局热键 + 屏幕剪藏 OCR 开关（仅桌面） */
	private renderCaptureSection(containerEl: HTMLElement): void {
		new Setting(containerEl).setName(t("屏幕截图")).setHeading();

		const hotkeyDesc =
			"在任何应用内按下即冻结全屏直接框选（仅桌面）。格式：修饰键+单键，如 Ctrl+Shift+S；修饰键 Ctrl/Cmd/Alt/Shift/Super（macOS Cmd），至少一个。留空关闭。热键被其他应用占用时注册会失败并提示。";
		const hotkeySetting = new Setting(containerEl)
			.setName(t("全局截图热键"))
			.setDesc(hotkeyDesc);
		hotkeySetting.addText((text) => {
			noAssist(text); // R3（W-14）：热键输入
			text.setValue(this.plugin.settings.captureGlobalHotkey).onChange((value) => {
				const trimmed = value.trim();
				if (trimmed && !validateAccelerator(trimmed)) {
					hotkeySetting.descEl.textContent =
						"热键格式无效：需「修饰键+单键」（如 Ctrl+Shift+S），且至少一个修饰键。";
					hotkeySetting.descEl.setCssStyles({ color: "var(--text-error)" });
					return;
				}
				hotkeySetting.descEl.textContent = hotkeyDesc;
				hotkeySetting.descEl.setCssStyles({ color: "" });
				if (trimmed === this.plugin.settings.captureGlobalHotkey) {
					return; // 值未变化不写盘
				}
				this.plugin.settings.captureGlobalHotkey = trimmed;
				void this.plugin.saveData({ ...this.plugin.settings });
				// 即时生效：注销旧热键注册新热键（冲突时 Notice）
				this.plugin.applyCaptureGlobalHotkey();
			});
		});

		new Setting(containerEl)
			.setName(t("屏幕剪藏识别文字（OCR）"))
			.setDesc(
				t(
					"「剪藏屏幕区域为笔记」对选中区域做文字识别，识别文字写入笔记正文与标题；关闭或识别失败则只存截图。首次识别需联网下载语言包（语言同 OCR 设置）。",
				),
			)
			.addToggle((toggle) => {
				toggle.setValue(this.plugin.settings.screenClipOcr).onChange(async (value) => {
					this.plugin.settings.screenClipOcr = value;
					await this.plugin.saveData({ ...this.plugin.settings });
				});
			});

		new Setting(containerEl)
			.setName(t("任务栏托盘常驻图标"))
			.setDesc(
				t(
					"系统托盘常驻 MarinMind 截图入口（仅桌面）：左键单击 = 截图（框选）复制；右键菜单 = 剪藏屏幕区域为笔记 / 打开设置。关闭即移除；环境不支持时静默不显示（命令与热键入口不受影响）。",
				),
			)
			.addToggle((toggle) => {
				toggle.setValue(this.plugin.settings.showCaptureTray).onChange(async (value) => {
					this.plugin.settings.showCaptureTray = value;
					await this.plugin.saveData({ ...this.plugin.settings });
					// 即时生效：销毁旧托盘按新设置重建（关闭即移除）
					this.plugin.applyCaptureTray();
				});
			});
	}

	/** 备份：目录即时保存（只影响后续导出落点，无数据迁移） */
	private renderBackupSection(containerEl: HTMLElement): void {
		new Setting(containerEl).setName(t("备份")).setHeading();

		new Setting(containerEl)
			.setName(t("备份目录"))
			.setDesc(
				t(
					".marginpkg 导出落点。vault 内相对路径或本机绝对路径（仅桌面）；不影响已导出的历史备份。",
				),
			)
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
