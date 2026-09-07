import { ButtonComponent, Modal, Notice, Setting } from "obsidian";
import type { App, TextComponent } from "obsidian";
import type MarinMindPlugin from "../main";
import { clipWebpageToNote } from "./webclip-service";
import { normalizeClipUrl } from "./clip-url";
import { RegionClipModal } from "./region-clip-modal";

/**
 * 网页剪藏弹窗（113-B）：网址 / 标题（可选）/ 图片下载开关 + 阶段进度行。
 * 点击「剪藏」走 clipWebpageToNote（URL 预校验即时行内报错；抓取/下载/落盘
 * 失败显示中文错误并恢复表单可改可重试）；成功 Notice 汇总 + 自动打开阅读器。
 * 进度/错误渲染以 isConnected 守卫丢弃过期回调（镜像 TranslateModal 模式）。
 */
export class WebclipModal extends Modal {
	private urlText!: TextComponent;
	private titleText!: TextComponent;
	private downloadImages: boolean;
	private clipButton!: ButtonComponent;
	/** 阶段进度 / 错误行（is-loading / marinmind-clip-error 两态换色） */
	private progressEl!: HTMLElement;
	private busy = false;

	constructor(
		app: App,
		private readonly plugin: MarinMindPlugin,
	) {
		super(app);
		this.downloadImages = plugin.settings.webclipDownloadImages;
	}

	onOpen(): void {
		this.titleEl.setText("剪藏网页为笔记文档");

		const urlSetting = new Setting(this.contentEl)
			.setName("网址")
			.setDesc(
				"要保存的网页地址，将提取正文转为 Markdown 笔记（支持划选摘录 / 建卡 / 复习）。",
			);
		urlSetting.addText((text) => {
			this.urlText = text;
			// R3（W-14 同款）：URL 输入关拼写检查与自动填充
			text.inputEl.autocomplete = "off";
			text.inputEl.spellcheck = false;
			text.setPlaceholder("https://example.com/article");
			text.onChange(() => this.clearProgress());
			// Enter 直达剪藏（表单习惯；标题输入同样生效）
			text.inputEl.addEventListener("keydown", (evt) => {
				if (evt.key === "Enter") {
					void this.run();
				}
			});
		});

		new Setting(this.contentEl)
			.setName("标题")
			.setDesc("笔记文件名（留空使用网页标题）。")
			.addText((text) => {
				this.titleText = text;
				text.inputEl.spellcheck = false;
				text.setPlaceholder("留空使用网页标题");
				text.inputEl.addEventListener("keydown", (evt) => {
					if (evt.key === "Enter") {
						void this.run();
					}
				});
			});

		new Setting(this.contentEl)
			.setName("下载图片到本地")
			.setDesc(
				"把正文图片下载到数据目录 assets/（并发 3、至多 20 张）；失败的图片自动回退为远程链接。",
			)
			.addToggle((toggle) => {
				toggle.setValue(this.downloadImages).onChange((value) => {
					this.downloadImages = value;
				});
			});

		// R3（W-03 同款）：异步进度区播报（完成/出错时屏幕阅读器可感知）
		this.progressEl = this.contentEl.createDiv({
			cls: "marinmind-clip-progress",
			attr: { "aria-live": "polite" },
		});

		const actions = this.contentEl.createDiv({ cls: "marinmind-clip-actions" });
		this.clipButton = new ButtonComponent(actions)
			.setButtonText("剪藏")
			.setCta()
			.onClick(() => void this.run());
		// 116：自动提取之外的第二路径——预览里框定区域，算法不猜（正文提取失败
		// 或想只存页面一角时的所见即所得入口）
		new ButtonComponent(actions)
			.setButtonText("框选剪藏…")
			.onClick(() => this.openRegionClip());
	}

	/** 框选剪藏（116）：复用本弹窗 URL/标题/图片开关，切换到区域选择弹窗 */
	private openRegionClip(): void {
		if (this.busy) {
			return;
		}
		const check = normalizeClipUrl(this.urlText.getValue());
		if (!check.ok) {
			this.showError(check.reason);
			return;
		}
		const title = this.titleText.getValue();
		this.close();
		new RegionClipModal(this.app, this.plugin, check.url, {
			titleOverride: title,
			downloadImages: this.downloadImages,
		}).open();
	}

	/** 清除进度/错误显示（表单再次编辑时） */
	private clearProgress(): void {
		if (!this.progressEl.isConnected) {
			return;
		}
		this.progressEl.empty();
		this.progressEl.removeClass("is-loading", "marinmind-clip-error");
	}

	private showProgress(message: string): void {
		if (!this.progressEl.isConnected) {
			return;
		}
		this.progressEl.empty();
		this.progressEl.addClass("is-loading");
		this.progressEl.removeClass("marinmind-clip-error");
		this.progressEl.setText(message);
	}

	private showError(message: string): void {
		if (!this.progressEl.isConnected) {
			return;
		}
		this.progressEl.empty();
		this.progressEl.removeClass("is-loading");
		this.progressEl.addClass("marinmind-clip-error");
		this.progressEl.setText(message);
	}

	/** 执行剪藏：URL 预校验（行内错误不发起网络）→ 服务层 → 成功开阅读器 */
	private async run(): Promise<void> {
		if (this.busy) {
			return;
		}
		const raw = this.urlText.getValue();
		const check = normalizeClipUrl(raw);
		if (!check.ok) {
			this.showError(check.reason);
			return;
		}
		this.busy = true;
		this.clipButton.setDisabled(true).setButtonText("剪藏中…");
		this.showProgress("正在抓取网页…");
		try {
			const outcome = await clipWebpageToNote(this.plugin, check.url, {
				titleOverride: this.titleText.getValue(),
				downloadImages: this.downloadImages,
				onStage: (message) => this.showProgress(message),
			});
			this.close();
			const parts: string[] = [];
			if (outcome.imagesSaved > 0) {
				parts.push(`${outcome.imagesSaved} 张图片已本地化`);
			}
			const remote = outcome.imagesFallback + outcome.imagesDropped;
			if (remote > 0) {
				parts.push(`${remote} 张保留远程链接`);
			}
			const summary = parts.length > 0 ? `（${parts.join("，")}）` : "";
			new Notice(`已剪藏「${outcome.title}」${summary}`, 4000);
			// 打开即走 clip 阅读分支：upsertByPath 自动登记文档，摘录建卡全链路可用
			await this.plugin.openClip(outcome.path);
		} catch (err) {
			this.showError(err instanceof Error ? err.message : String(err));
			console.error("[MarinMind] 网页剪藏失败", err);
		} finally {
			this.busy = false;
			if (this.clipButton?.buttonEl.isConnected) {
				this.clipButton.setDisabled(false).setButtonText("剪藏");
			}
		}
	}
}
