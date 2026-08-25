import { Notice, Plugin, TFile } from "obsidian";
import type { App, PluginManifest, WorkspaceLeaf } from "obsidian";
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
import { exportBackup, promptImportBackup } from "./backup/backup-service";
import { AttachmentStore } from "./attachments/attachment-store";
import { DB_PATH } from "./constants";

/** 工作区预设：study = 阅读 + 复习；research = 阅读 + 脑图 */
type WorkspaceMode = "study" | "research";

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
	/** 媒体附件仓（照片/手写 PNG/音频，uid 命名存 .marinmind/assets/） */
	attachments!: AttachmentStore;

	/** 数据层初始化 promise（失败在内部消化为 db 保持 undefined，不产生未处理拒绝） */
	private readonly dbReady: Promise<void>;

	constructor(app: App, manifest: PluginManifest) {
		super(app, manifest);
		this.dbReady = this.initDatabase();
		// 附件仓不依赖 DB，构造期即可用（vault.adapter 在构造时已可用）
		this.attachments = new AttachmentStore(this.app.vault.adapter);
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
			id: "open-workspace-study",
			name: "学习模式工作区（阅读 + 复习）",
			callback: () => void this.openWorkspace("study"),
		});
		this.addCommand({
			id: "open-workspace-research",
			name: "研究模式工作区（阅读 + 脑图）",
			callback: () => void this.openWorkspace("research"),
		});
		this.addCommand({
			id: "show-stats",
			name: "显示库统计（文档 / 卡片 / 待复习）",
			callback: () => this.showStats(),
		});
		this.addCommand({
			id: "export-backup",
			name: "导出备份（.marginpkg）",
			callback: () => void exportBackup(this),
		});
		this.addCommand({
			id: "import-backup",
			name: "导入备份（.marginpkg）",
			callback: () => promptImportBackup(this),
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
	 * 可携带页码滚动定位（复习界面"跳转原文"入口）。返回所在 leaf（工作区布局复用）。
	 */
	async openInReader(file: TFile, page?: number): Promise<WorkspaceLeaf> {
		const leaf = this.app.workspace.getLeaf("tab");
		await leaf.setViewState({
			type: READER_VIEW_TYPE,
			state: { file: file.path, ...(page != null ? { page } : {}) },
		});
		return leaf;
	}

	// ---------- 多窗格工作区 ----------

	/**
	 * 工作区预设：阅读窗格 + 右侧复习（study）/ 脑图（research）。
	 * 已有阅读器标签则复用；没有则弹 PDF 选择器新标签页打开
	 * （选择器取消无回调 → 放弃布局，不动用户当前笔记）。
	 */
	private async openWorkspace(mode: WorkspaceMode): Promise<void> {
		const reader = this.app.workspace.getLeavesOfType(READER_VIEW_TYPE)[0];
		if (reader) {
			await this.ensureSidePane(reader, mode);
			return;
		}
		new PdfPickerModal(
			this.app,
			(file) =>
				void (async () => {
					const leaf = await this.openInReader(file);
					await this.ensureSidePane(leaf, mode);
				})(),
		).open();
	}

	/**
	 * 保证右侧窗格存在并就位（幂等）：
	 * 已有目标视图标签则复用（复习重启会话，脑图保持当前图）；没有则从阅读窗格右侧分裂。
	 */
	private async ensureSidePane(readerLeaf: WorkspaceLeaf, mode: WorkspaceMode): Promise<void> {
		const target = mode === "study" ? REVIEW_VIEW_TYPE : MINDMAP_VIEW_TYPE;
		let side = this.app.workspace.getLeavesOfType(target)[0];
		if (!side) {
			// split 锚点是"调用时刻的激活 leaf"：setActiveLeaf 与 getLeaf('split') 之间不得有 await
			this.app.workspace.setActiveLeaf(readerLeaf, { focus: true });
			side = this.app.workspace.getLeaf("split", "vertical"); // 'vertical' = 右侧
			await side.setViewState({ type: target }); // 脑图 onOpen 自动弹选图器
			// 研究模式此刻选图器已聚焦输入框：不抢焦点；学习模式焦点还给阅读器
			this.app.workspace.setActiveLeaf(readerLeaf, { focus: mode === "study" });
			return;
		}
		// 后台标签可能是延迟加载的占位视图，需先加载拿到真实 view
		await side.loadIfDeferred();
		if (mode === "study" && side.view instanceof MarinMindReviewView) {
			await side.view.startSession(); // 与"开始复习"命令一致：进入学习状态即重启会话
		}
		this.app.workspace.setActiveLeaf(readerLeaf, { focus: true });
		// 脑图复用路径刻意不 loadMap：保持用户当前打开的图
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
