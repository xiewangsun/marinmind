import { Notice, Plugin } from "obsidian";
import { MarinMindDatabase } from "./db/database";
import wasmBinary from "./db/wasm-bytes";
import { CardRepository } from "./db/repositories/card-repo";
import { DocumentRepository } from "./db/repositories/document-repo";
import { LinkRepository } from "./db/repositories/link-repo";
import { ReviewRepository } from "./db/repositories/review-repo";

/** 数据库文件在库内的位置：点开头目录不出现在文件列表，也不会被插件更新清除 */
const DB_PATH = ".marinmind/marinmind.db";

/**
 * MarinMind 插件入口
 *
 * 定位：电子书阅读器 + 思维导图 + 学习卡"一站式学习工具"。
 * 当前阶段：SQLite 数据层（卡片 / 文档 / 链接 / 复习仓储）+ 占位命令；
 * 后续模块（阅读/标注视图、脑图、复习界面、多窗格工作区）逐步接入。
 */
export default class MarinMindPlugin extends Plugin {
	db?: MarinMindDatabase;
	documents!: DocumentRepository;
	cards!: CardRepository;
	links!: LinkRepository;
	reviews!: ReviewRepository;

	async onload(): Promise<void> {
		// 功能区图标：点击打开 MarinMind 工作区
		this.addRibbonIcon("book-open", "MarinMind", () => {
			this.openWorkspace();
		});

		// 命令面板入口
		this.addCommand({
			id: "open-workspace",
			name: "打开 MarinMind 工作区",
			callback: () => this.openWorkspace(),
		});
		this.addCommand({
			id: "show-stats",
			name: "显示库统计（文档 / 卡片 / 待复习）",
			callback: () => this.showStats(),
		});

		// 异步初始化数据层；失败时降级运行，不阻塞插件加载
		void this.initDatabase();
	}

	onunload(): void {
		// 尽力落盘：flush 先同步导出快照再异步写文件，随后的 close 不影响已导出数据
		void this.db?.flush();
		this.db?.close();
	}

	/** 打开 SQLite 数据库并装配仓储 */
	private async initDatabase(): Promise<void> {
		try {
			this.db = await MarinMindDatabase.open({
				adapter: this.app.vault.adapter,
				path: DB_PATH,
				wasmBinary,
			});
			this.documents = new DocumentRepository(this.db);
			this.cards = new CardRepository(this.db);
			this.links = new LinkRepository(this.db);
			this.reviews = new ReviewRepository(this.db);
			console.info(
				`[MarinMind] 数据库就绪（schema v${this.db.version}）：` +
					`文档 ${this.documents.count()}，卡片 ${this.cards.count()}，待复习 ${this.reviews.dueCount()}`,
			);
		} catch (err) {
			console.error("[MarinMind] 数据库初始化失败", err);
			new Notice("MarinMind：数据库初始化失败，相关功能不可用");
		}
	}

	/** 打开多窗格工作区（阅读 / 脑图 / 卡片）——占位实现 */
	private openWorkspace(): void {
		new Notice("MarinMind 工作区开发中");
	}

	private showStats(): void {
		if (!this.db) {
			new Notice("MarinMind：数据库未就绪");
			return;
		}
		new Notice(
			`文档 ${this.documents.count()} · 卡片 ${this.cards.count()} · 待复习 ${this.reviews.dueCount()}`,
		);
	}
}
