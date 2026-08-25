import { Notice, Plugin } from "obsidian";

/**
 * MarinMind 插件入口
 *
 * 定位：电子书阅读器 + 思维导图 + 学习卡"一站式学习工具"。
 * 当前为脚手架阶段：仅注册基础入口（功能区图标 + 命令面板命令），
 * 用于验证插件能被 Obsidian 正常加载。
 * 后续模块（阅读/标注、卡片、脑图、间隔重复）将在各自文件中实现。
 */
export default class MarinMindPlugin extends Plugin {
	async onload(): Promise<void> {
		// 功能区图标：点击打开 MarinMind 工作区
		this.addRibbonIcon("book-open", "MarinMind", () => {
			this.openWorkspace();
		});

		// 命令面板入口
		this.addCommand({
			id: "open-workspace",
			name: "打开 MarinMind 工作区",
			callback: () => {
				this.openWorkspace();
			},
		});
	}

	onunload(): void {
		// 目前无需清理的资源；后续释放视图、数据库连接等时在此处理
	}

	/** 打开多窗格工作区（阅读 / 脑图 / 卡片）——占位实现 */
	private openWorkspace(): void {
		new Notice("MarinMind 工作区开发中");
	}
}
