import { Notice, Plugin, TFile } from "obsidian";
import type { App, PluginManifest } from "obsidian";
import { MarinMindDatabase } from "./db/database";
import wasmBinary from "./db/wasm-bytes";
import { CardRepository } from "./db/repositories/card-repo";
import { DocumentRepository } from "./db/repositories/document-repo";
import { LinkRepository } from "./db/repositories/link-repo";
import { MindmapRepository } from "./db/repositories/mindmap-repo";
import { ReviewRepository } from "./db/repositories/review-repo";
import {
	MarinMindMindmapView,
	MINDMAP_VIEW_TYPE,
} from "./mindmap/mindmap-view";
import { MindmapPickerModal } from "./mindmap/mindmap-picker-modal";
import { MarinMindReaderView, READER_VIEW_TYPE } from "./reader/reader-view";
import { PdfPickerModal } from "./reader/pdf-picker-modal";
import { MarinMindReviewView, REVIEW_VIEW_TYPE } from "./review/review-view";

/** 数据库文件在库内的位置：点开头目录不出现在文件列表，也不会被插件更新清除 */
const DB_PATH = ".marinmind/marinmind.db";

/**
 * MarinMind 插件入口
 *
 * 定位：电子书阅读器 + 思维导图 + 学习卡"一站式学习工具"。
 * 当前阶段：SQLite 数据层 + PDF 阅读视图（区域/文字摘录）+ 复习界面（闪卡）
 * + 思维导图（卡片即节点）；后续模块（多窗格工作区、OCR、备份）逐步接入。
 */
export default class MarinMindPlugin extends Plugin {
	db?: MarinMindDatabase;
	documents!: DocumentRepository;
	cards!: CardRepository;
	links!: LinkRepository;
	reviews!: ReviewRepository;
	mindmaps!: MindmapRepository;

	/** 数据层初始化 promise（失败在内部消化为 db 保持 undefined，不产生未处理拒绝） */
	private readonly dbReady: Promise<void>;

	constructor(app: App, manifest: PluginManifest) {
		super(app, manifest);
		this.dbReady = this.initDatabase();
	}

	/** 等待数据层就绪：视图/命令在使用仓储前应 await，再检查 this.db */
	whenReady(): Promise<void> {
		return this.dbReady;
	}

	async onload(): Promise<void> {
		// 阅读视图（不 registerExtensions，不接管 PDF 默认打开方式）
		this.registerView(READER_VIEW_TYPE, (leaf) => new MarinMindReaderView(leaf, this));
		// 复习视图（闪卡）
		this.registerView(REVIEW_VIEW_TYPE, (leaf) => new MarinMindReviewView(leaf, this));
		// 思维导图视图
		this.registerView(MINDMAP_VIEW_TYPE, (leaf) => new MarinMindMindmapView(leaf, this));

		// 功能区图标：打开 PDF 快速选择
		this.addRibbonIcon("book-open", "MarinMind", () => {
			this.openPdfPicker();
		});

		// 命令面板入口
		this.addCommand({
			id: "open-reader",
			name: "打开 MarinMind 阅读器（选择 PDF）",
			callback: () => this.openPdfPicker(),
		});
		this.addCommand({
			id: "start-review",
			name: "开始复习（到期闪卡）",
			callback: () => void this.openReview(),
		});
		this.addCommand({
			id: "open-mindmap",
			name: "打开思维导图（选择 / 新建脑图）",
			callback: () => this.openMindmapPicker(),
		});
		this.addCommand({
			id: "open-workspace",
			name: "打开 MarinMind 工作区",
			callback: () => {
				new Notice("MarinMind 工作区开发中");
			},
		});
		this.addCommand({
			id: "show-stats",
			name: "显示库统计（文档 / 卡片 / 待复习）",
			callback: () => this.showStats(),
		});
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
			this.mindmaps = new MindmapRepository(this.db);
			console.info(
				`[MarinMind] 数据库就绪（schema v${this.db.version}）：` +
					`文档 ${this.documents.count()}，卡片 ${this.cards.count()}，` +
					`待复习 ${this.reviews.dueCount()}，脑图 ${this.mindmaps.list().length}`,
			);
		} catch (err) {
			// 失败时 this.db 保持 undefined，调用方以 whenReady + db 判空降级
			console.error("[MarinMind] 数据库初始化失败", err);
			new Notice("MarinMind：数据库初始化失败，相关功能不可用");
		}
	}

	private openPdfPicker(): void {
		new PdfPickerModal(this.app, (file) => void this.openInReader(file)).open();
	}

	/** 选图器入口（命令 / reader 菜单共用）：选中即打开（新建图在弹窗内完成命名） */
	openMindmapPicker(): void {
		new MindmapPickerModal(this.app, this, (map) => void this.openMindmap(map.id)).open();
	}

	/** 打开指定脑图：复用已有脑图标签页则激活并切换，否则新开标签页 */
	async openMindmap(mapId: string): Promise<void> {
		let leaf = this.app.workspace.getLeavesOfType(MINDMAP_VIEW_TYPE)[0];
		if (!leaf) {
			leaf = this.app.workspace.getLeaf("tab");
			// setState 暂存 mapId，视图 onOpen 时消费（此时骨架未建）
			await leaf.setViewState({ type: MINDMAP_VIEW_TYPE, state: { mapId } });
		}
		this.app.workspace.setActiveLeaf(leaf, { focus: true });
		// 后台标签页可能是延迟加载的占位视图，需先加载拿到真实 view
		await leaf.loadIfDeferred();
		if (leaf.view instanceof MarinMindMindmapView) {
			// 新开路径 onOpen 已消费 mapId；复用路径在此切换（相同图相当于刷新）
			leaf.view.loadMap(mapId);
		}
	}

	/** 打开复习：复用已有复习标签页则激活并重启会话，否则新开标签页 */
	private async openReview(): Promise<void> {
		let leaf = this.app.workspace.getLeavesOfType(REVIEW_VIEW_TYPE)[0];
		if (!leaf) {
			leaf = this.app.workspace.getLeaf("tab");
			await leaf.setViewState({ type: REVIEW_VIEW_TYPE });
		}
		this.app.workspace.setActiveLeaf(leaf, { focus: true });
		// 后台标签页可能是延迟加载的占位视图，需先加载拿到真实 view
		await leaf.loadIfDeferred();
		if (leaf.view instanceof MarinMindReviewView) {
			await leaf.view.startSession();
		}
	}

	/**
	 * 在新标签页用阅读视图打开指定 PDF（setViewState 而非 openFile：后者会落入内置 PDF 视图），
	 * 可携带页码滚动定位（复习界面"跳转原文"入口）。
	 */
	async openInReader(file: TFile, page?: number): Promise<void> {
		const leaf = this.app.workspace.getLeaf("tab");
		await leaf.setViewState({
			type: READER_VIEW_TYPE,
			state: { file: file.path, ...(page != null ? { page } : {}) },
		});
	}

	private showStats(): void {
		if (!this.db) {
			new Notice("MarinMind：数据库未就绪");
			return;
		}
		new Notice(
			`文档 ${this.documents.count()} · 卡片 ${this.cards.count()} · ` +
				`待复习 ${this.reviews.dueCount()} · 脑图 ${this.mindmaps.list().length}`,
		);
	}
}
