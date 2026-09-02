import { Notice, Platform, Plugin, TFile } from "obsidian";
import type { App, PluginManifest, WorkspaceLeaf } from "obsidian";
import { MarinMindStore } from "./store/marinmind-store";
import { convertLegacyDb, openLegacyDb } from "./store/legacy-import";
import { CardRepository } from "./db/repositories/card-repo";
import { DocumentRepository } from "./db/repositories/document-repo";
import { LinkRepository } from "./db/repositories/link-repo";
import { MindmapRepository } from "./db/repositories/mindmap-repo";
import { ReviewRepository } from "./db/repositories/review-repo";
import { BookmarkRepository } from "./db/repositories/bookmark-repo";
import {
	MarinMindMindmapView,
	MINDMAP_VIEW_TYPE,
	locateCardInActiveMindmaps,
	refreshActiveMindmaps,
} from "./mindmap/mindmap-view";
import { MindmapPickerModal } from "./mindmap/mindmap-picker-modal";
import { autoAddCard, ensureBookMindmap, followBookRename, linkedMapOf } from "./mindmap/auto-collect";
import { MarinMindReaderView, READER_VIEW_TYPE } from "./reader/reader-view";
import { MarinMindHomeView, HOME_VIEW_TYPE } from "./home/home-view";
import { PdfPickerModal, pickTarget, type ExternalDocEntry } from "./reader/pdf-picker-modal";
import type { ViewMode } from "./ui/view-mode-bar";
import { MarinMindReviewView, REVIEW_VIEW_TYPE } from "./review/review-view";
import type { ReviewScope } from "./review/review-view";
import { DeckPickerModal } from "./review/deck-picker-modal";
import { ReviewStatsModal } from "./review/review-stats-modal";
import { exportBackup, promptImportBackup } from "./backup/backup-service";
import { AttachmentStore } from "./attachments/attachment-store";
import { CardEventBus } from "./events/card-bus";
import {
	ASSETS_SUBDIR,
	DEFAULT_BACKUP_DIR,
	DEFAULT_DATA_DIR,
	DB_FILENAME,
	LEGACY_DATA_DIR,
	MSG_EXTERNAL_DOC_MOBILE,
} from "./constants";
import { loadSettings, type MarinMindSettings } from "./settings/settings";
import { MarinMindSettingTab } from "./settings/settings-tab";
import { ConfirmModal } from "./mindmap/confirm-modal";
import { DocumentManagerModal } from "./documents/document-manager-modal";
import { ExternalDocWatcher } from "./documents/external-watcher";
import { copyTree } from "./storage/copy-tree";
import { externalFileExists, pickExternalPath } from "./storage/external-file";
import { isAbsoluteFsPath, isHiddenVaultDir } from "./storage/paths";
import { buildCardCopyText, type CardCopyMode } from "./links/card-links";
import {
	resolveBackupLocation,
	resolveDataLocation,
	type ResolvedLocation,
} from "./storage/data-location";
import type { Card } from "./types";

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
	/** Markdown 存储引擎（㉚：内存权威 + 脏粒度分文件防抖落盘；六仓储在此之上实现） */
	store?: MarinMindStore;
	documents!: DocumentRepository;
	cards!: CardRepository;
	links!: LinkRepository;
	reviews!: ReviewRepository;
	mindmaps!: MindmapRepository;
	/** 文档书签仓储（㉓ 目录侧栏；阅读位置标记） */
	bookmarks!: BookmarkRepository;
	/** 媒体附件仓（照片/手写 PNG/音频，uid 命名存数据根 assets/）——onload 期创建 */
	attachments!: AttachmentStore;
	/**
	 * 卡片变更事件总线：构造期同步创建（视图 constructor 即可订阅，先于 dbReady），
	 * 注入 CardRepository 后所有写操作自动广播（订阅契约见 events/card-bus.ts）。
	 */
	readonly cardBus = new CardEventBus();
	/** 插件设置（onload 期加载；数据/备份目录由它决定，故先于数据层初始化） */
	settings!: MarinMindSettings;
	/** 数据目录定位（onload 期解析缓存；附件仓、备份服务、迁移共用） */
	dataLoc!: ResolvedLocation;
	/** 备份目录定位（onload 期解析缓存；备份导出用，设置页变更时刷新） */
	backupLoc!: ResolvedLocation;
	/**
	 * 库外文档 fs watcher（㊳，仅桌面实例化）：vault rename 事件覆盖不到库外
	 * 绝对路径——本 watcher 对账改名/移动自动跟随（决策见 external-reconcile）。
	 */
	externalWatcher?: ExternalDocWatcher;

	/**
	 * 数据层初始化 promise（失败在内部消化为 db 保持 undefined，不产生未处理拒绝）。
	 * 默认已解决：onload 中 initStorage 完成后才指向真正的初始化（设置先行）。
	 */
	private dbReady: Promise<void> = Promise.resolve();

	/**
	 * 视图模式切换的恢复缓存（内存级，重启不保留）：隐藏侧 detach 前保存
	 * 阅读状态（文件 + 页码）与脑图 id，切回联动/另一侧时原位恢复。
	 */
	private lastReaderState: { file: string; page: number | null } | null = null;
	private lastMapId: string | null = null;
	/**
	 * 用户显式表达的视图模式意图（㊿ 会话内存，重启不保留；null = 未表达）：
	 * 仅 setViewMode / openWorkspace 置位，手动关标签不更新。联动同步
	 * （syncLinkedMindmap）只在 intent === "linked" 时自动跟随——不经用户
	 * 显式表达（如主页开脑图 + 打开文档的并排浏览）不被打扰；联动级联
	 * 关闭（linkedClose*）置回 null（用户已离开联动）。
	 */
	private viewModeIntent: ViewMode | null = null;
	/**
	 * 联动互关抑制标志（㊿）：模式切换（doc/map 分支 detach 隐藏侧）触发的
	 * 视图 onClose 不得级联关掉保留侧——setViewMode 执行期间置 true。
	 */
	private suppressLinkedClose = false;
	/** 视图模式变化监听（切换条激活态同步；layout-change 外部变化也触发） */
	private readonly viewModeListeners = new Set<(mode: ViewMode) => void>();
	/** 自动入图反馈聚合（㉘）：短窗口内同图累计，批量建卡只弹一条 Notice */
	private autoAddNotice: {
		mapId: string;
		name: string;
		count: number;
		timer: number;
	} | null = null;
	/** 自动转闪卡反馈聚合（㊷）：短窗口内累计计数，批量建卡只弹一条 Notice */
	private autoFlashNotice: { count: number; timer: number } | null = null;

	constructor(app: App, manifest: PluginManifest) {
		super(app, manifest);
		// 数据库路径与附件仓根目录均由设置决定，而 loadData 是异步 API——
		// 它们的创建统一移到 onload（Obsidian 保证视图实例化晚于插件 onload 完成），
		// 这里只保留 cardBus 的构造期同步创建契约。
	}

	/** 等待数据层就绪：视图/命令在使用仓储前应 await，再检查 this.store */
	whenReady(): Promise<void> {
		return this.dbReady;
	}

	async onload(): Promise<void> {
		// 构建标记：控制台一眼确认当前跑的是哪一轮构建（复制产物后必须关/开插件
		// 或重启 Obsidian 才会加载新代码——曾因此误判修复无效）
		console.info("[MarinMind] 插件已加载 · build ㊻-20260830");
		// 0) 设置与存储定位先行（后续一切初始化依赖它们）
		await this.initStorage();

		// 阅读视图（不 registerExtensions，不接管 PDF 默认打开方式）
		this.registerView(READER_VIEW_TYPE, (leaf) => new MarinMindReaderView(leaf, this));
		// 复习视图（闪卡）
		this.registerView(REVIEW_VIEW_TYPE, (leaf) => new MarinMindReviewView(leaf, this));
		// 思维导图视图
		this.registerView(MINDMAP_VIEW_TYPE, (leaf) => new MarinMindMindmapView(leaf, this));
		// 主页视图（㉟：Linear 风深色导航主页，ribbon 点击进入）
		this.registerView(HOME_VIEW_TYPE, (leaf) => new MarinMindHomeView(leaf, this));

		// 数据层启动（设置/定位就绪之后）
		this.dbReady = this.initStore();

		// 库外文档观察（㊳）：仅桌面（fs.watch / fs 直读都不可用于移动端）；
		// initStore 成功尾部会做首次 sync
		if (Platform.isDesktopApp) {
			this.externalWatcher = new ExternalDocWatcher(this);
		}

		// 摘录自动入图（㉗）：插件级订阅——不要求打开任何脑图视图
		this.setupAutoCollect();
		// 按书自动转闪卡（㊷）：插件级订阅，开关存书文件 frontmatter
		this.setupAutoFlashcard();

		// 功能区图标：打开主页（㉟：概览/文档/卡片/脑图导航；PDF 选择器入口移至主页按钮 + 命令面板）
		this.addRibbonIcon("layout-dashboard", "MarinMind 主页", () => {
			void this.openHome();
		});

		// 命令面板入口
		this.addCommand({
			id: "open-home",
			name: "打开 MarinMind 主页",
			callback: () => void this.openHome(),
		});
		this.addCommand({
			id: "open-reader",
			name: "打开 MarinMind 阅读器（选择文档）",
			callback: () => this.openPdfPicker(),
		});
		// 库外文档直读入口（㉞；㊼ 起收 PDF/EPUB）：仅桌面注册
		//（系统文件对话框 + fs 直读都不可用于移动端）
		if (Platform.isDesktopApp) {
			this.addCommand({
				id: "open-external-pdf",
				name: "打开库外文档（桌面）",
				callback: () => void this.openExternalPdf(),
			});
		}
		this.addCommand({
			id: "start-review",
			name: "开始复习（到期闪卡）",
			callback: () => void this.openReview(),
		});
		// 卡组批：按卡组开练——先弹卡组选择器（卡组由卡片 deck 设置派生，无实体表）
		this.addCommand({
			id: "start-review-deck",
			name: "按卡组复习（选择卡组）",
			checkCallback: (checking: boolean) => {
				// 数据层未就绪时 cards 为空——选组器无从取组，命令不可用
				if (!this.store) return false;
				if (!checking) {
					new DeckPickerModal(this.app, this, (deck) => {
						void this.openReviewDeck(deck);
					}).open();
				}
				return true;
			},
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
			id: "view-mode-doc",
			name: "切换视图：单文档（隐藏脑图）",
			callback: () => void this.setViewMode("doc"),
		});
		this.addCommand({
			id: "view-mode-map",
			name: "切换视图：单脑图（隐藏文档）",
			callback: () => void this.setViewMode("map"),
		});
		this.addCommand({
			id: "view-mode-linked",
			name: "切换视图：文档·脑图联动",
			callback: () => void this.setViewMode("linked"),
		});
		// 视图模式由工作区实际布局推导：手动关标签等外部变化也要刷新切换条激活态
		this.registerEvent(
			this.app.workspace.on("layout-change", () => this.notifyViewMode()),
		);
		this.addCommand({
			id: "show-stats",
			name: "复习统计（热力图 / 到期分布 / 库统计）",
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
		this.addCommand({
			id: "import-legacy-db",
			name: "从旧版数据库导入（SQLite → Markdown 迁移）",
			callback: () => void this.promptLegacyImport(),
		});
		this.addCommand({
			id: "manage-documents",
			name: "文档管理（重关联失联文档）",
			callback: () => new DocumentManagerModal(this.app, this).open(),
		});

		// 设置页
		this.addSettingTab(new MarinMindSettingTab(this.app, this));
	}

	onunload(): void {
		// 未弹出的自动入图反馈直接丢弃（计时器随插件卸载失效）
		if (this.autoAddNotice) {
			window.clearTimeout(this.autoAddNotice.timer);
			this.autoAddNotice = null;
		}
		if (this.autoFlashNotice) {
			window.clearTimeout(this.autoFlashNotice.timer);
			this.autoFlashNotice = null;
		}
		// 尽力落盘：flush 先落盘后 close 终止防抖定时器（此后 markDirty 静默忽略）
		void this.store?.flush();
		this.store?.close();
		// 库外文档观察（㊳）：停 watcher 与对账定时器
		this.externalWatcher?.close();
	}

	/**
	 * 加载设置并解析数据/备份目录定位（onload 最先执行）。
	 * 数据目录设置值不可用时（如移动端读到桌面绝对路径的同步 data.json）
	 * 回退默认 vault 内目录——插件保持可用，用户可在设置页修正。
	 */
	private async initStorage(): Promise<void> {
		this.settings = await loadSettings(this);
		try {
			this.dataLoc = await resolveDataLocation(this.app, this.settings.dataDir);
		} catch (err) {
			console.error("[MarinMind] 数据目录解析失败，回退默认目录", err);
			new Notice("MarinMind：数据目录设置无效，已回退到默认目录 MarinMind");
			this.settings.dataDir = DEFAULT_DATA_DIR;
			this.dataLoc = await resolveDataLocation(this.app, DEFAULT_DATA_DIR);
		}
		try {
			this.backupLoc = await resolveBackupLocation(this.app, this.settings.backupDir);
		} catch (err) {
			console.warn("[MarinMind] 备份目录解析失败，回退默认目录", err);
			this.settings.backupDir = DEFAULT_BACKUP_DIR;
			this.backupLoc = await resolveBackupLocation(this.app, DEFAULT_BACKUP_DIR);
		}
		// 附件仓只依赖数据定位（不依赖 DB）；视图均在使用期访问，此处同步赋值即可
		this.attachments = new AttachmentStore(this.dataLoc.adapter);
	}

	/** 打开 Markdown 存储并装配仓储 */
	private async initStore(): Promise<void> {
		try {
			await this.openAndWire(this.dataLoc);
			this.registerVaultFileSync();
			// ㊳ 库外文档观察首同步（记录集就绪；无库外记录时是空操作）
			this.externalWatcher?.sync();
			const stats = this.store!.stats();
			console.info(
				`[MarinMind] 数据层就绪（md 格式 v${this.store!.formatVersion}）：` +
					`文档 ${stats.documents}，卡片 ${stats.cards}，` +
					`待复习 ${this.reviews.dueCount()}，脑图 ${stats.mindmaps}（${stats.nodes} 节点）`,
			);
			// 旧版 SQLite 库迁移引导（不阻塞启动；库为空 + 发现旧库才弹）
			void this.detectLegacyDb();
			// ㊻-A-2：数据根为 vault 隐藏目录（点开头，如旧版 .marinmind）——Obsidian
			// 索引不到其中笔记（搜索/阅读失效、卡片链接与嵌入解析失败、手编也无
			// vault 事件回灌）。有数据时提醒迁移，否则用户只在复制链接失败时才隐约察觉
			if (
				this.dataLoc.kind === "vault" &&
				isHiddenVaultDir(this.dataLoc.rootDir) &&
				(stats.documents > 0 || stats.cards > 0)
			) {
				new Notice(
					`MarinMind：数据目录 ${this.dataLoc.rootDir} 是隐藏目录，Obsidian 搜索不到` +
						"其中的卡片笔记、卡片链接无法解析。建议在 设置 → MarinMind → 数据目录 迁移到普通文件夹（如 MarinMind）",
				);
			}
		} catch (err) {
			// 失败时 this.store 保持 undefined，调用方以 whenReady + store 判空降级
			console.error("[MarinMind] 数据层初始化失败", err);
			new Notice("MarinMind：数据层初始化失败，相关功能不可用");
		}
	}

	/**
	 * 打开 Markdown 存储并装配仓储（onload 初始化与数据目录迁移失败回滚共用，故为 public）。
	 */
	async openAndWire(loc: ResolvedLocation): Promise<void> {
		this.store = await MarinMindStore.open(loc.adapter);
		this.documents = new DocumentRepository(this.store);
		this.cards = new CardRepository(this.store, this.cardBus);
		this.links = new LinkRepository(this.store);
		this.reviews = new ReviewRepository(this.store);
		this.mindmaps = new MindmapRepository(this.store);
		this.bookmarks = new BookmarkRepository(this.store);
	}

	/**
	 * 全局文件事件同步（rename 分流 + 数据根内 md 的 modify/delete 回灌）：
	 * - rename：数据根内 md → 存储引擎回灌（标题/图名跟随新文件名；移出数据根视同删除）；
	 *   数据根外 → documents.file_path 业务键同步（库内任何 TFile 改名都要跟上，
	 *   否则卡片回链失联。目录移动时 Obsidian 对每个 TFile 逐个发事件，只处理 TFile 即覆盖）。
	 * - modify/delete：仅数据根内 md（用户手编即权威，见 store.handleExternalChange；
	 *   插件自写经 lastWritten 回声过滤）。
	 * - 数据根外文件 delete 刻意不全局级联删——见 reader-view 注释。
	 * - fs 数据根（桌面绝对路径）不在 vault 事件覆盖范围，无回灌。
	 */
	private registerVaultFileSync(): void {
		this.registerEvent(
			this.app.vault.on("rename", (file, oldPath) => {
				if (!(file instanceof TFile) || oldPath === file.path) return;
				if (file.extension === "md") {
					const oldRel = this.dataRootRelPath(oldPath);
					if (oldRel !== null) {
						const newRel = this.dataRootRelPath(file.path);
						if (newRel !== null) {
							this.store?.handleExternalRename(oldRel, newRel);
						} else {
							void this.applyExternalChange(oldRel, null); // 移出数据根 = 删除
						}
						return;
					}
				}
				this.documents.renamePath(oldPath, file.path);
			}),
		);
		this.registerEvent(
			this.app.vault.on("modify", (file) => {
				if (!(file instanceof TFile) || file.extension !== "md") return;
				const rel = this.dataRootRelPath(file.path);
				if (rel !== null) void this.applyExternalChange(rel, file);
			}),
		);
		this.registerEvent(
			this.app.vault.on("delete", (file) => {
				if (!(file instanceof TFile) || file.extension !== "md") return;
				const rel = this.dataRootRelPath(file.path);
				if (rel !== null) void this.applyExternalChange(rel, null);
			}),
		);
	}

	/**
	 * vault 路径 → 数据根相对路径（不在数据根内或 fs 数据根返回 null）。
	 * ㊻-B 起公开：文档选择器据此排除数据根内的 md（插件数据不作为可阅读文档）。
	 */
	dataRootRelPath(vaultPath: string): string | null {
		if (this.dataLoc.kind !== "vault") return null;
		const root = this.dataLoc.rootDir;
		if (!vaultPath.startsWith(`${root}/`)) return null;
		return vaultPath.slice(root.length + 1);
	}

	/** 数据根内 md 的外部变更回灌：读盘 → store 合并 → removed 发事件、warning 聚合 Notice */
	private async applyExternalChange(rel: string, file: TFile | null): Promise<void> {
		if (!this.store) return;
		let content: string | null = null;
		if (file) {
			try {
				content = new TextDecoder().decode(await this.app.vault.adapter.readBinary(file.path));
			} catch (err) {
				console.warn("[MarinMind] 外部修改文件读取失败", file.path, err);
				return;
			}
		}
		let result;
		try {
			result = await this.store.handleExternalChange(rel, content);
		} catch (err) {
			console.error("[MarinMind] 外部修改回灌失败", rel, err);
			return;
		}
		for (const card of result.removedCards) {
			this.cardBus.emitCardRemoved(card.id, card);
		}
		for (const warning of result.warnings) {
			new Notice(`MarinMind：${warning}`);
		}
	}

	// ---------- 旧版 SQLite 库迁移（㉚；sql.js 保留在 bundle 供此路径使用） ----------

	/** 命令入口：发现旧库 → 确认弹窗（默认取消）；无旧库 Notice 告知 */
	private async promptLegacyImport(): Promise<void> {
		await this.whenReady();
		const legacy = await this.findLegacyDb();
		if (!legacy) {
			new Notice("MarinMind：未找到旧版数据库（marinmind.db）");
			return;
		}
		new ConfirmModal(
			this.app,
			"从旧版数据库导入",
			`将把 ${legacy.rootDir} 下的 SQLite 旧数据转换为 Markdown 存储并入当前库。\n` +
				"旧数据库文件原样保留（可回退到旧版插件）。\n注意：与现有库同路径的文档会被跳过。继续？",
			() => void this.runLegacyImport(legacy),
		).open();
	}

	/**
	 * 启动迁移引导：当前库为空且发现旧库 → 确认弹窗（默认取消，宁拒不赌）。
	 * 默认目录用户在 DEFAULT_DATA_DIR 改名后数据仍在 .marinmind/，首次启动由此引导。
	 */
	private async detectLegacyDb(): Promise<void> {
		try {
			if (!this.store) return;
			const stats = this.store.stats();
			if (stats.documents > 0 || stats.mindmaps > 0 || stats.cards > 0) return;
			const legacy = await this.findLegacyDb();
			if (!legacy) return;
			const fromDir = legacy === this.dataLoc ? "当前数据目录" : `旧默认目录 ${LEGACY_DATA_DIR}/`;
			new ConfirmModal(
				this.app,
				"检测到旧版数据库",
				`发现 SQLite 存储时代的旧数据（${fromDir}）。\n` +
					"是否迁移为 Markdown 文件存储？旧文件将原样保留，可随时回退。",
				() => void this.runLegacyImport(legacy),
			).open();
		} catch (err) {
			console.warn("[MarinMind] 旧库检测失败", err);
		}
	}

	/**
	 * 旧库位置：当前数据根优先（自定义目录用户旧库就在同一根下），
	 * 回溯历史默认目录 .marinmind/（存在性先经 vault 查询，避免解析定位时建空目录）。
	 */
	private async findLegacyDb(): Promise<ResolvedLocation | null> {
		if (await this.dataLoc.adapter.exists(DB_FILENAME)) {
			return this.dataLoc;
		}
		if (this.app.vault.getAbstractFileByPath(`${LEGACY_DATA_DIR}/${DB_FILENAME}`) instanceof TFile) {
			try {
				return await resolveDataLocation(this.app, LEGACY_DATA_DIR);
			} catch {
				return null;
			}
		}
		return null;
	}

	/**
	 * 旧库迁移执行：读库（内存升到 v8，不回写源文件）→ 转换 → 灌入 →
	 * 附件复制（跨根时）→ 落盘。全程不动旧库文件；失败可重试（灌入幂等）。
	 */
	private async runLegacyImport(source: ResolvedLocation): Promise<void> {
		if (!this.store) {
			new Notice("MarinMind：数据层未就绪，无法迁移");
			return;
		}
		const before = this.store.stats();
		const notice = new Notice("MarinMind：正在从旧版数据库迁移…", 0);
		try {
			const db = await openLegacyDb(source.adapter);
			let converted: ReturnType<typeof convertLegacyDb>;
			try {
				converted = convertLegacyDb(db);
			} finally {
				db.close();
			}
			const result = this.store.importLegacy(converted);
			// 旧库在不同根（默认目录用户）：附件整树复制到新根（excerptRef 已在转换层归一为根相对）
			if (source !== this.dataLoc) {
				await copyTree(source.adapter, this.dataLoc.adapter, ASSETS_SUBDIR);
			}
			await this.store.flush();
			notice.hide();
			const after = this.store.stats();
			new Notice(
				`迁移完成：文档 +${after.documents - before.documents}，卡片 +${after.cards - before.cards}，` +
					`脑图 +${after.mindmaps - before.mindmaps}。旧数据库保留在 ${source.rootDir}`,
				6000,
			);
			const warnings = [...converted.warnings, ...result.warnings];
			if (warnings.length > 0) {
				new Notice(
					`迁移警告 ${warnings.length} 条：\n${warnings.slice(0, 5).join("\n")}` +
						(warnings.length > 5 ? "\n…" : ""),
					10000,
				);
			}
		} catch (err) {
			console.error("[MarinMind] 旧库迁移失败", err);
			notice.hide();
			new Notice("MarinMind：旧库迁移失败（旧文件未动），详见控制台", 10000);
		}
	}

	/**
	 * 摘录自动入图（㉗，替代 ⑲ 的视图级自动收录）：订阅 cardBus 新建事件，
	 * 开关读 settings.autoAddToMindmap（默认开，脑图 header「添加到脑图」切换）。
	 * 落点决策见 src/mindmap/auto-collect.ts——固定根节点优先，否则按书目标图
	 * （collectMapId 覆盖，㊴）或该书的默认脑图
	 * （get-or-create，书名分组卡为根）。写库延迟到 microtask 守 cardBus 只读契约；
	 * 写后通知正在展示该图的视图重拉（loadMap 保平移缩放）。
	 */
	private setupAutoCollect(): void {
		this.cardBus.onCardCreated((card) => {
			if (!this.settings.autoAddToMindmap) {
				return;
			}
			// 只收文档摘录卡：分组卡（page null）与手工卡（documentId null）在
			// autoAddCard 内被拦——订阅回调保持只读，判定也一并延迟到 microtask
			if (card.documentId == null || card.page == null) {
				return;
			}
			queueMicrotask(() => {
				if (!this.store || !this.cards.get(card.id)) {
					return; // 数据层未就绪 / 卡片在延迟间隙被删（外键会拒挂）
				}
				const mapId = autoAddCard(
					{ documents: this.documents, cards: this.cards, mindmaps: this.mindmaps },
					card,
				);
				if (mapId) {
					refreshActiveMindmaps(mapId);
					this.notifyAutoAdded(mapId);
				}
			});
		});
	}

	/**
	 * 自动入图成功反馈（㉘）：入图本身不打开任何视图，用户无从感知——
	 * 「功能没实现」的误判根因。这里用 Notice 即时告知落点；1.2s 窗口内
	 * 同图累计计数（AI 批量建卡 N 张只弹一条），换图先冲销上一图的计数。
	 */
	private notifyAutoAdded(mapId: string): void {
		const name = this.mindmaps.get(mapId)?.name ?? "";
		if (this.autoAddNotice && this.autoAddNotice.mapId !== mapId) {
			this.flushAutoAddNotice();
		}
		if (!this.autoAddNotice) {
			this.autoAddNotice = {
				mapId,
				name,
				count: 0,
				timer: window.setTimeout(() => this.flushAutoAddNotice(), 1200),
			};
		}
		this.autoAddNotice.count += 1;
	}

	/** 冲销并弹出聚合中的自动入图反馈（窗口到期 / 换图 / 卸载前调用） */
	private flushAutoAddNotice(): void {
		const pending = this.autoAddNotice;
		if (!pending) {
			return;
		}
		this.autoAddNotice = null;
		window.clearTimeout(pending.timer);
		const where = pending.name ? `《${pending.name}》` : "脑图";
		new Notice(
			pending.count > 1
				? `已自动加入脑图${where}：${pending.count} 张卡片`
				: `已自动加入脑图${where}`,
			2500,
		);
	}

	/**
	 * 按书自动转闪卡（㊷）：订阅 cardBus 新建事件，开关读文档 frontmatter
	 * autoFlashcard（阅读器工具行「闪卡」按钮切换，每本书独立）。
	 * 守卫与 setupAutoCollect 同款：documentId/page 判空拦手工卡与《书名》分组卡
	 * （分组卡 documentId=本书但 page=null）；写库延迟到 microtask 守 cardBus 只读契约。
	 */
	private setupAutoFlashcard(): void {
		this.cardBus.onCardCreated((card) => {
			// 判空结果收窄进局部常量：闭包内 card.documentId 的收窄会丢失
			const docId = card.documentId;
			if (docId == null || card.page == null) {
				return;
			}
			queueMicrotask(() => {
				if (!this.store || !this.cards.get(card.id)) {
					return; // 数据层未就绪 / 卡片在延迟间隙被删
				}
				if (!this.documents.get(docId)?.autoFlashcard) {
					return;
				}
				try {
					this.reviews.enable(card.id);
					this.notifyAutoFlash();
				} catch (err) {
					console.error("[MarinMind] 自动转闪卡失败", err);
				}
			});
		});
	}

	/** 自动转闪卡反馈聚合（镜像 notifyAutoAdded）：1.2s 窗口计数，AI 批量只弹一条 */
	private notifyAutoFlash(): void {
		if (!this.autoFlashNotice) {
			this.autoFlashNotice = {
				count: 0,
				timer: window.setTimeout(() => this.flushAutoFlashNotice(), 1200),
			};
		}
		this.autoFlashNotice.count += 1;
	}

	/** 冲销并弹出聚合中的自动转闪卡反馈 */
	private flushAutoFlashNotice(): void {
		const pending = this.autoFlashNotice;
		if (!pending) {
			return;
		}
		this.autoFlashNotice = null;
		window.clearTimeout(pending.timer);
		new Notice(
			pending.count > 1
				? `已自动转为闪卡：${pending.count} 张`
				: "已自动转为闪卡",
			2500,
		);
	}

	/**
	 * 打开文档即确保摘录目标图就绪（㊴）：同名默认图 get-or-create + 《书名》
	 * 分组根节点；按书覆盖生效时返回覆盖图不建同名图。语义见 auto-collect.ts。
	 * reader loadFromPath 调用（store 已由 whenReady 保证就绪），失败降级不阻塞阅读。
	 */
	public ensureBookMindmapFor(docId: string): void {
		if (!this.store) {
			return;
		}
		try {
			const mapId = ensureBookMindmap(
				{ documents: this.documents, cards: this.cards, mindmaps: this.mindmaps },
				docId,
			);
			if (mapId) {
				refreshActiveMindmaps(mapId);
			}
		} catch (err) {
			console.error("[MarinMind] 摘录目标图创建失败", err);
			new Notice("MarinMind：摘录目标脑图创建失败（不影响阅读），详见控制台", 6000);
		}
	}

	/**
	 * 书名变化时同名图跟随改名（㊴）：图名/组卡文本未手动改过才跟随。
	 * reader loadFromPath 在 upsert 检测到标题变化后调用。
	 */
	public followBookMindmapRename(docId: string, oldTitle: string, newTitle: string): void {
		if (!this.store || oldTitle === newTitle) {
			return;
		}
		try {
			followBookRename(
				{ documents: this.documents, cards: this.cards, mindmaps: this.mindmaps },
				docId,
				oldTitle,
				newTitle,
			);
		} catch (err) {
			console.error("[MarinMind] 同名脑图改名跟随失败", err);
		}
	}

	/**
	 * PDF 选择器入口（命令 / 主页侧栏按钮共用）。
	 * ㉟ 起 ribbon 图标让位主页，本方法 public 供主页「打开文档」按钮调用。
	 */
	openPdfPicker(): void {
		new PdfPickerModal(
			this.app,
			(pick) => void this.openInReader(pickTarget(pick)),
			this.recentExternalDocs(),
			{ plugin: this },
		).open();
	}

	/**
	 * 最近打开的库外文档（㉞-A 重开入口）：文档记录按 updatedAt（= 最近打开时间）
	 * 倒序取前 8 条，供 PDF 选择器置顶列出——关闭标签后无需再走系统对话框找文件。
	 * 数据层未就绪返回空列表（选择器照常只列库内）。
	 */
	recentExternalDocs(): ExternalDocEntry[] {
		if (!this.documents) {
			return [];
		}
		return this.documents
			.list()
			.filter((doc) => isAbsoluteFsPath(doc.filePath))
			.sort((a, b) => b.updatedAt - a.updatedAt)
			.slice(0, 8)
			.map((doc) => ({ absPath: doc.filePath, title: doc.title, updatedAt: doc.updatedAt }));
	}

	/** 库外文档命令入口（㉞；㊼ 起 PDF/EPUB）：系统文件对话框选路径直接开（取消静默） */
	private async openExternalPdf(): Promise<void> {
		const absPath = await pickExternalPath();
		if (absPath) {
			await this.openInReader(absPath);
		}
	}

	/** 选图器入口（命令 / reader 菜单共用）：选中即打开（新建图在弹窗内完成命名） */
	openMindmapPicker(): void {
		new MindmapPickerModal(this.app, this, (map) => void this.openMindmap(map.id)).open();
	}

	/**
	 * 获取新标签页 leaf。工作区一个标签都没有时 getLeaf("tab") 会抛
	 * "No tab group found"（其内部 getMostRecentLeaf 返回 null 即 throw——
	 * 三视图切换 detach 全部旧标签后补开、选图器回调在空工作区上开图都会踩中）。
	 * 兜底在根分裂下直接建 leaf——与官方 getUnpinnedLeaf 的空工作区分支行为一致。
	 */
	private newTabLeaf(): WorkspaceLeaf {
		const ws = this.app.workspace;
		try {
			return ws.getLeaf("tab");
		} catch {
			return ws.createLeafInParent(ws.rootSplit, 0);
		}
	}

	/**
	 * 打开主页（㉟）：复用已有主页标签页则激活，否则新开标签页。
	 * 页面状态由视图 getState/setState 自管（导航页持久化），无需 instanceof 调用。
	 */
	async openHome(): Promise<void> {
		let leaf = this.app.workspace.getLeavesOfType(HOME_VIEW_TYPE)[0];
		if (!leaf) {
			leaf = this.newTabLeaf();
			await leaf.setViewState({ type: HOME_VIEW_TYPE });
		}
		this.app.workspace.setActiveLeaf(leaf, { focus: true });
		// 后台标签页可能是延迟加载的占位视图，需先加载拿真实视图（渲染数据）
		await leaf.loadIfDeferred();
	}

	/** 打开指定脑图：复用已有脑图标签页则激活并切换，否则新开标签页 */
	async openMindmap(mapId: string): Promise<void> {
		let leaf = this.app.workspace.getLeavesOfType(MINDMAP_VIEW_TYPE)[0];
		if (!leaf) {
			leaf = this.newTabLeaf();
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

	/**
	 * 打开指定脑图并定位到卡片（71 溯源进阶）：openMindmap 后 locateCard
	 * 居中平移 + 闪烁。loadMap 是同步内存读取，await 后即可定位；卡片不在
	 * 图中（折叠隐藏/已移出）locateCard 返 false → Notice 提示。
	 */
	async openMindmapAtCard(mapId: string, cardId: string): Promise<void> {
		await this.openMindmap(mapId);
		const leaf = this.app.workspace.getLeavesOfType(MINDMAP_VIEW_TYPE)[0];
		const view = leaf?.view;
		if (view instanceof MarinMindMindmapView && !view.locateCard(cardId)) {
			new Notice("该卡片不在图中（可能已被折叠或移出）");
		}
	}

	/**
	 * 打开复习：复用已有复习标签页则激活并重启会话，否则新开标签页。
	 * public——阅读器工具行与脑图 header 的「复习」入口按钮也走这里（㉑）。
	 * docId（㊷）：传入 = 只复习该书（阅读器入口按书过滤）；缺省 = 全部书籍
	 * （命令面板/脑图/主页入口）。
	 */
	async openReview(docId?: string): Promise<void> {
		// undefined 归一 null：显式传参语义（null = 清范围为全部书籍）与入口缺省一致
		await this.focusReviewView(docId != null ? { kind: "book", docId } : null);
	}

	/**
	 * 按卡组开练（卡组批）：公开入口——命令「按卡组复习」与主页卡片页
	 * 「复习本组」link 调用；选组弹窗由调用方负责（命令入口弹、主页直传）。
	 */
	async openReviewDeck(deck: string): Promise<void> {
		await this.focusReviewView({ kind: "deck", deck });
	}

	/**
	 * 按卡片 id 集合开练（70 cards 泛化范围）：公开入口——主页卡片页
	 * 「复习筛选结果」与脑图节点右键「复习此分支」调用；label 供范围 chip 显示。
	 */
	async openReviewCards(cardIds: string[], label: string): Promise<void> {
		await this.focusReviewView({ kind: "cards", cardIds, label });
	}

	/** 复习视图聚焦 + 重启会话（openReview / openReviewDeck 共用的样板抽取） */
	private async focusReviewView(scope: ReviewScope): Promise<void> {
		let leaf = this.app.workspace.getLeavesOfType(REVIEW_VIEW_TYPE)[0];
		if (!leaf) {
			leaf = this.newTabLeaf();
			await leaf.setViewState({ type: REVIEW_VIEW_TYPE });
		}
		this.app.workspace.setActiveLeaf(leaf, { focus: true });
		// 后台标签页可能是延迟加载的占位视图，需先加载拿到真实 view
		await leaf.loadIfDeferred();
		if (leaf.view instanceof MarinMindReviewView) {
			await leaf.view.startSession(scope);
		}
	}

	/**
	 * 用阅读视图打开指定 PDF（setViewState 而非直接 openFile：后者会落入内置 PDF 视图），
	 * 可携带页码与卡片 id 滚动定位（复习/脑图"跳转原文"入口）。
	 * 默认新标签页；可传入既有 leaf（联动视图分裂出的窗格）就地打开。
	 * 返回所在 leaf（工作区布局复用）。
	 * ㉞ 起目标可为库外绝对路径字符串（仅桌面；阅读视图 ItemView 化后 state.file
	 * 由本插件 setState→pendingFile/openPath 链路自控，不再依赖 FileView 机制——
	 * 旧 openFile 兜底（1.10–1.12 setViewState 不驱动加载的兼容补偿）随之删除，
	 * 该 bug 类别对 ItemView 不存在）。
	 */
	async openInReader(
		target: TFile | string,
		page?: number,
		cardId?: string,
		leaf: WorkspaceLeaf = this.newTabLeaf(),
	): Promise<WorkspaceLeaf> {
		let filePath: string;
		if (typeof target === "string") {
			if (!isAbsoluteFsPath(target)) {
				// 防误用：字符串目标必须是库外绝对路径（库内文件应传 TFile）
				console.error("[MarinMind] openInReader 收到非法路径字符串", target);
				new Notice("打开失败：路径必须是库外绝对路径");
				return leaf;
			}
			if (Platform.isMobile) {
				new Notice(MSG_EXTERNAL_DOC_MOBILE);
				return leaf;
			}
			filePath = target;
		} else {
			filePath = target.path;
		}
		const state = {
			...(page != null ? { page } : {}),
			...(cardId != null ? { cardId } : {}),
		};
		await leaf.setViewState({ type: READER_VIEW_TYPE, state: { file: filePath, ...state } });
		// 后台标签页可能是延迟加载的占位视图，需先加载拿到真实 view
		await leaf.loadIfDeferred();
		if (leaf.view instanceof MarinMindReaderView && leaf.view.filePath !== filePath) {
			// 仅诊断日志：ItemView 加载链完全自控，正常不应走到这里（setViewState 未生效时便于排障）
			console.warn("[MarinMind] setViewState 后视图未持有目标文件", filePath);
		}
		return leaf;
	}

	/**
	 * 跳转到卡片原文位置：打开阅读器并精确定位（页码 + 矩形滚动 + 高亮闪烁）。
	 * 复习界面与脑图的共用入口（原先两处各写一份）。文档/文件缺失时 Notice 降级；
	 * 库外绝对路径（㉞）桌面直开，移动端 Notice 拒绝（openInReader 内分流）。
	 */
	async openCardSource(card: Card): Promise<void> {
		const doc = card.documentId ? this.documents.get(card.documentId) : undefined;
		if (!doc) {
			return;
		}
		if (isAbsoluteFsPath(doc.filePath)) {
			// 库外文档：openInReader 桌面直开 / 移动端拒绝 Notice（含路径校验）
			await this.openInReader(doc.filePath, card.page ?? undefined, card.id);
			return;
		}
		const file = this.app.vault.getAbstractFileByPath(doc.filePath);
		if (!(file instanceof TFile)) {
			new Notice("原文文件不在当前库中，无法跳转");
			return;
		}
		await this.openInReader(file, card.page ?? undefined, card.id);
	}

	/**
	 * 复制卡片互链文本（㊻-A）：wikilink / 嵌入语法进剪贴板——贴到普通笔记
	 * 或 Canvas 白板即可跳转 / 渲染整卡 callout。卡片存标准 md（`^card-<id>`
	 * 块锚点），Obsidian 原生解析；书文件随改名跟随，链接**点击时现算**不可缓存。
	 */
	async copyCardLink(card: Card, mode: CardCopyMode): Promise<void> {
		if (this.dataLoc.kind !== "vault") {
			new Notice("数据目录在库外（桌面路径），无法生成 Obsidian 笔记链接");
			return;
		}
		// ㊻-A-2：vault 隐藏目录（点开头，如旧版 .marinmind）不在 Obsidian 索引内，
		// 指向其中笔记的链接/嵌入永不解析——复制死链不如明确引导迁移（设置页已有迁移功能）
		if (isHiddenVaultDir(this.dataLoc.rootDir)) {
			new Notice(
				`数据目录 ${this.dataLoc.rootDir} 是隐藏目录（以 . 开头），Obsidian 索引不到` +
					"其中的笔记，链接不会生效。请到 设置 → MarinMind → 数据目录 迁移到普通文件夹（如 MarinMind）",
			);
			return;
		}
		const store = this.store;
		if (!store) {
			new Notice("数据层未就绪，无法生成链接");
			return;
		}
		const book = store.bookOfCard(card.id);
		if (!book) {
			new Notice("未找到卡片所属文件，无法生成链接");
			return;
		}
		// ㊻-A-2：磁盘锚点保底——㊻-A 之前写入且未再改动的书文件缺 ^card-<id> 行，
		// 链接解析同样失败；复制前确保该文件按当前格式落盘（已最新则零写）
		await store.ensureBookWritten(book.doc.id);
		const text = buildCardCopyText(mode, this.dataLoc.rootDir, book.relPath, card);
		try {
			await navigator.clipboard.writeText(text);
			new Notice(mode === "embed" ? "嵌入代码已复制" : "卡片链接已复制");
		} catch {
			new Notice("复制失败：剪贴板不可用");
		}
	}

	// ---------- 多窗格工作区 ----------

	/**
	 * 工作区预设：阅读窗格 + 右侧复习（study）/ 脑图（research）。
	 * 已有阅读器标签则复用；没有则弹 PDF 选择器新标签页打开
	 * （选择器取消无回调 → 放弃布局，不动用户当前笔记）。
	 */
	private async openWorkspace(mode: WorkspaceMode): Promise<void> {
		// ㊿ 记录显式意图：研究模式 = 阅读+脑图联动（sync 自动跟随），学习模式无脑图
		this.viewModeIntent = mode === "research" ? "linked" : "doc";
		const reader = this.app.workspace.getLeavesOfType(READER_VIEW_TYPE)[0];
		if (reader) {
			await this.ensureSidePane(reader, mode);
			return;
		}
		new PdfPickerModal(
			this.app,
			(pick) =>
				void (async () => {
					const leaf = await this.openInReader(pickTarget(pick));
					await this.ensureSidePane(leaf, mode);
				})(),
			this.recentExternalDocs(),
			{ plugin: this },
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
			// ㊴ 研究模式选图：本书摘录目标图 > 上次浏览的图；皆 null（文档加载中）
			// 不建空态脑图（㊿ 空态 onOpen 会弹选图器），由 loadFromPath 尾部 sync 补建
			const mapId =
				mode === "research"
					? this.bookTargetMapId(readerLeaf) ?? this.restoreMapId()
					: null;
			if (mode !== "research" || mapId) {
				await side.setViewState(
					mapId
						? { type: MINDMAP_VIEW_TYPE, state: { mapId } }
						: { type: target },
				);
				// 同 splitMindmapPane 双保险（㊿-A）：新视图 onOpen 先于 setState
				if (mapId && side.view instanceof MarinMindMindmapView) {
					side.view.loadMap(mapId);
				}
			}
			// 学习模式焦点还给阅读器（研究模式此刻脑图侧可能未建，无焦点可让）
			this.app.workspace.setActiveLeaf(readerLeaf, { focus: mode === "study" });
			return;
		}
		// 后台标签可能是延迟加载的占位视图，需先加载拿到真实 view
		await side.loadIfDeferred();
		if (mode === "study" && side.view instanceof MarinMindReviewView) {
			// 与"开始复习"命令一致：进入学习状态即重启会话；㊷ 学习模式必有阅读器——
			// 复习窗格跟随其当前书（无文档/库外读失败时为全部书籍）。卡组批起
			// scope 是判别联合：必须显式传 null（省略参数 = 保持当前范围，语义相反）
			const readerDocId =
				readerLeaf.view instanceof MarinMindReaderView ? readerLeaf.view.docId : null;
			await side.view.startSession(readerDocId != null ? { kind: "book", docId: readerDocId } : null);
		}
		this.app.workspace.setActiveLeaf(readerLeaf, { focus: true });
		// 研究模式复用脑图窗格时纠正到本书目标图（㊿ 一对一，弃「保持当前图」）
		if (mode === "research") {
			await this.syncLinkedMindmap();
		}
	}

	// ---------- 视图模式切换（单文档 / 单脑图 / 联动，⑰） ----------

	/**
	 * 当前视图模式：由工作区实际存在的阅读器/脑图标签推导——
	 * 手动关标签 = 隐式切换；重启后 Obsidian 恢复的布局即上次的模式。
	 */
	getViewMode(): ViewMode {
		const hasReader = this.app.workspace.getLeavesOfType(READER_VIEW_TYPE).length > 0;
		const hasMap = this.app.workspace.getLeavesOfType(MINDMAP_VIEW_TYPE).length > 0;
		if (hasReader && hasMap) {
			return "linked";
		}
		if (hasReader) {
			return "doc";
		}
		if (hasMap) {
			return "map";
		}
		return "linked"; // 两侧皆无：默认联动（首次点开依次补齐两侧）
	}

	/** 订阅视图模式变化（切换条激活态同步）；返回退订函数 */
	onViewModeChange(cb: (mode: ViewMode) => void): () => void {
		this.viewModeListeners.add(cb);
		return () => {
			this.viewModeListeners.delete(cb);
		};
	}

	private notifyViewMode(): void {
		const mode = this.getViewMode();
		for (const cb of this.viewModeListeners) {
			cb(mode);
		}
	}

	/**
	 * 切换到目标视图模式。隐藏 = detach 标签（Obsidian 无"收起窗格"API），
	 * 隐藏侧状态先存内存缓存（文件 + 页码 / 图 id），切回时原位恢复；
	 * 取消选择器等一切路径都保证通知切换条刷新（finally）。
	 */
	async setViewMode(mode: ViewMode): Promise<void> {
		this.viewModeIntent = mode; // ㊿ 记录显式意图：联动 sync 仅在 linked 意图下自动跟随
		// ㊿ 模式切换 detach 隐藏侧期间抑制联动互关（防级联关掉保留侧）
		this.suppressLinkedClose = true;
		try {
			await this.whenReady();
			if (!this.store) {
				new Notice("MarinMind：数据层未就绪，无法切换视图");
				return;
			}
			await this.applyViewMode(mode);
		} catch (err) {
			// 布局编排失败要可见可诊断，不能变成 "Uncaught (in promise)" 静默搁浅
			console.error("[MarinMind] 视图模式切换失败", err);
			new Notice("MarinMind：视图切换失败，详见控制台");
		} finally {
			this.suppressLinkedClose = false;
			this.notifyViewMode();
		}
	}

	/** 模式切换布局编排（dbReady + db 判空已由 setViewMode 保证） */
	private async applyViewMode(mode: ViewMode): Promise<void> {
		const ws = this.app.workspace;
		if (mode === "doc") {
			// 脑图侧：先记下当前图（优先激活标签），再补齐阅读窗格，最后才关脑图标签——
			// 顺序不能反：先 detach 会把工作区清空，后续 getLeaf("tab") 抛
			// "No tab group found"（⑲-2 修复，newTabLeaf 兜底为第二道防线）
			const maps = ws.getLeavesOfType(MINDMAP_VIEW_TYPE);
			const active = maps.find((l) => l === ws.activeLeaf) ?? maps[0];
			const st = (active?.getViewState().state ?? {}) as { mapId?: string };
			if (typeof st.mapId === "string") {
				this.lastMapId = st.mapId;
			}
			await this.ensureReaderPane();
			if (ws.getLeavesOfType(READER_VIEW_TYPE).length === 0) {
				return; // PDF 选择器被取消：无阅读窗格可切，中止切换保持现状（脑图不关）
			}
			for (const leaf of maps) {
				leaf.detach();
			}
			return;
		}
		if (mode === "map") {
			// 阅读侧：保存文件 + 当前页码（优先激活标签），先补齐脑图窗格再关闭全部阅读标签
			// （同上：先 detach 会空置工作区，⑲-2 修复）。
			// 页码来自 reader.getState 的实时值——手写/录音由 detach 触发的
			// onClose → cleanupContent 自动提交，不丢内容
			const readers = ws.getLeavesOfType(READER_VIEW_TYPE);
			const active = readers.find((l) => l === ws.activeLeaf) ?? readers[0];
			const st = (active?.getViewState().state ?? {}) as { file?: string; page?: number };
			if (typeof st.file === "string") {
				this.lastReaderState = {
					file: st.file,
					page: typeof st.page === "number" ? st.page : null,
				};
			}
			await this.ensureMindmapPane();
			// 脑图侧选图器是异步用户交互（无法在此等待）：选图回调补开脑图时工作区
			// 可能已空，由 newTabLeaf 兜底；取消选择则空工作区可经「文档」一键恢复
			// （lastReaderState 已在上方缓存）。
			for (const leaf of readers) {
				leaf.detach();
			}
			return;
		}
		// linked：缺侧从对侧右侧分裂补齐（文档居左为常态，
		// 仅脑图存在时文档居右——MarginNote 同样支持文档右置）；
		// 两侧齐备也不再只聚焦——syncLinkedMindmap 纠正脑图侧到本书目标图
		// （㊿ 一对一：空态/无关图标签一律被拉回，不再依赖用户手动选图）
		const reader = ws.getLeavesOfType(READER_VIEW_TYPE)[0];
		const map = ws.getLeavesOfType(MINDMAP_VIEW_TYPE)[0];
		if (reader && map) {
			ws.setActiveLeaf(reader, { focus: true });
			await this.syncLinkedMindmap();
			return;
		}
		if (reader) {
			await this.splitMindmapPane(reader);
			return;
		}
		if (map) {
			const file = await this.pickRestoredPdf();
			if (!file) {
				return; // 取消选择：不动布局
			}
			ws.setActiveLeaf(map, { focus: true });
			const side = ws.getLeaf("split", "vertical");
			await this.openInReader(file, undefined, undefined, side);
			ws.setActiveLeaf(map, { focus: false });
			return;
		}
		// 两侧皆无：先开阅读器（必经选择器），再分裂脑图
		const file = await this.pickPdfFile();
		if (!file) {
			return;
		}
		const leaf = await this.openInReader(file);
		await this.splitMindmapPane(leaf);
	}

	/**
	 * 从 anchor 右侧分裂脑图窗格：选图优先级见 bookTargetMapId（㊴），回退
	 * lastMapId（过渡展示，加载完成后 syncLinkedMindmap 会纠正到本书目标图）。
	 * 两者皆 null（文档加载中未 upsert）时**不建空态脑图**——空态 onOpen 会弹
	 * 选图器（㊿ 消灭联动弹窗路径），由 loadFromPath 尾部的 sync 补建。
	 */
	private async splitMindmapPane(anchor: WorkspaceLeaf): Promise<void> {
		const ws = this.app.workspace;
		const mapId = this.bookTargetMapId(anchor) ?? this.restoreMapId();
		if (!mapId) {
			// 文档尚未加载完成：联动 sync（loadFromPath 尾部）稍后补建，此处静默
			return;
		}
		// split 锚点是"调用时刻的激活 leaf"：setActiveLeaf 与 getLeaf 之间不得有 await
		ws.setActiveLeaf(anchor, { focus: true });
		const side = ws.getLeaf("split", "vertical");
		await side.setViewState({ type: MINDMAP_VIEW_TYPE, state: { mapId } });
		// 双保险（㊿-A）：Obsidian 新视图 onOpen 先于 setState——若 mapId 未及
		// 送达（版本差异），此处显式加载；已加载则幂等重拉
		if (side.view instanceof MarinMindMindmapView) {
			side.view.loadMap(mapId);
		}
		ws.setActiveLeaf(anchor, { focus: false });
	}

	/**
	 * 联动一对一同步（㊿）：激活阅读文档的目标图 → 脑图侧显示的图与之对齐。
	 * 仅在用户显式表达联动意图（viewModeIntent === "linked"，即点过「联动」/
	 * 研究模式）后自动跟随——并排浏览（主页开图 + 打开文档）不被打扰。
	 * 接线点：applyViewMode linked 分支 / reader loadFromPath 尾部（联动下
	 * 切文档自动跟随新书）/ setCollectTarget（主动切换目标图立即反映）/
	 * 研究模式 ensureSidePane。目标图拿不到（文档加载中）静默返回。
	 */
	public async syncLinkedMindmap(): Promise<void> {
		if (this.viewModeIntent !== "linked" || !this.store) {
			return;
		}
		const ws = this.app.workspace;
		const readers = ws.getLeavesOfType(READER_VIEW_TYPE);
		if (readers.length === 0) {
			return;
		}
		const reader = readers.find((l) => l === ws.activeLeaf) ?? readers[0];
		const st = (reader.getViewState().state ?? {}) as { file?: string };
		if (typeof st.file !== "string") {
			return;
		}
		const target = this.bookTargetByFilePath(st.file);
		if (!target) {
			return;
		}
		const mapLeaf = ws.getLeavesOfType(MINDMAP_VIEW_TYPE)[0];
		if (!mapLeaf) {
			await this.splitMindmapPane(reader); // 补建（splitMindmapPane 内部同源选图）
			return;
		}
		const cur = (mapLeaf.getViewState().state ?? {}) as { mapId?: string };
		if (cur.mapId !== target) {
			await this.openMindmap(target); // 复用标签 loadMap 切换（空态标签同样纠正）
		}
	}

	/**
	 * 联动互关（㊿）：阅读视图关闭时，关闭显示其目标图的脑图标签。
	 * 判定用目标图匹配而非模式推导——onClose 时本 leaf 可能已出标签列表，
	 * 推导不可靠；且文档 A + 无关图并排时不误关。模式切换的 detach 由
	 * suppressLinkedClose 拦截。级联关闭 = 用户离开联动，viewModeIntent 置回 null。
	 */
	public linkedCloseMindmap(filePath: string | null): void {
		if (this.suppressLinkedClose || filePath == null || !this.store) {
			return;
		}
		const target = this.bookTargetByFilePath(filePath);
		if (!target) {
			return;
		}
		for (const leaf of this.app.workspace.getLeavesOfType(MINDMAP_VIEW_TYPE)) {
			const st = (leaf.getViewState().state ?? {}) as { mapId?: string };
			if (st.mapId === target) {
				this.viewModeIntent = null;
				leaf.detach();
			}
		}
	}

	/** 联动互关（㊿）反向：脑图视图关闭时，关闭绑定到该图的阅读标签 */
	public linkedCloseReader(mapId: string | null): void {
		if (this.suppressLinkedClose || mapId == null || !this.store) {
			return;
		}
		for (const leaf of this.app.workspace.getLeavesOfType(READER_VIEW_TYPE)) {
			const st = (leaf.getViewState().state ?? {}) as { file?: string };
			if (typeof st.file === "string" && this.bookTargetByFilePath(st.file) === mapId) {
				this.viewModeIntent = null;
				leaf.detach();
			}
		}
	}


	/** 保证阅读窗格存在：已有则聚焦；缓存可恢复则带页码重开；否则弹 PDF 选择器 */
	private async ensureReaderPane(): Promise<void> {
		const ws = this.app.workspace;
		const reader = ws.getLeavesOfType(READER_VIEW_TYPE)[0];
		if (reader) {
			ws.setActiveLeaf(reader, { focus: true });
			return;
		}
		const file = await this.pickRestoredPdf();
		if (file) {
			await this.openInReader(file, this.lastReaderState?.page ?? undefined);
		}
	}

	/** 保证脑图窗格存在：已有则聚焦；选图优先级见 bookTargetMapId（㊴），否则弹选图器 */
	private async ensureMindmapPane(): Promise<void> {
		const ws = this.app.workspace;
		const map = ws.getLeavesOfType(MINDMAP_VIEW_TYPE)[0];
		if (map) {
			ws.setActiveLeaf(map, { focus: true });
			return;
		}
		// 调用时机（applyViewMode map 分支）阅读标签尚未 detach，可解析本书目标图
		const readers = ws.getLeavesOfType(READER_VIEW_TYPE);
		const mapId =
			this.bookTargetMapId(readers.find((l) => l === ws.activeLeaf) ?? readers[0]) ??
			this.restoreMapId();
		if (mapId) {
			await this.openMindmap(mapId);
		} else {
			this.openMindmapPicker();
		}
	}

	/** lastMapId 可恢复则返回（本会话曾打开过的图），否则 null */
	private restoreMapId(): string | null {
		return this.lastMapId && this.mindmaps.get(this.lastMapId) ? this.lastMapId : null;
	}

	/**
	 * 当前阅读文档的摘录目标图 id（㊴ 视图切换自动定位）：见 bookTargetByFilePath。
	 * 阅读窗格缺失/未登记文档返回 null（调用方回退 lastMapId/等待联动 sync）。
	 */
	private bookTargetMapId(reader: WorkspaceLeaf | undefined): string | null {
		if (!reader) {
			return null;
		}
		const st = (reader.getViewState().state ?? {}) as { file?: string };
		if (typeof st.file !== "string") {
			return null;
		}
		return this.bookTargetByFilePath(st.file);
	}

	/**
	 * 按文档路径解析「联动展示图」（㊿ 文档↔脑图一对一）：linkedMapOf——
	 * 固定根所在图 > 按书覆盖/同名默认图（get-or-create）——与摘录落点
	 * （autoAddCard）同源："下一张摘录进哪张图，联动就看哪张图"。
	 * 未登记文档（加载中尚未 upsert）/解析失败返回 null；公开供联动互关
	 * （linkedCloseMindmap/Reader）按目标图匹配对侧标签。
	 */
	public bookTargetByFilePath(filePath: string): string | null {
		const doc = this.documents.getByPath(filePath);
		if (!doc) {
			return null;
		}
		try {
			return linkedMapOf(
				{ documents: this.documents, cards: this.cards, mindmaps: this.mindmaps },
				doc.id,
			);
		} catch (err) {
			console.error("[MarinMind] 解析联动目标图失败", err);
			return null;
		}
	}

	/**
	 * 取要打开的 PDF：视图模式切换缓存的文件仍可读则直接返回（不弹窗）——
	 * 库内路径经 vault 解析 TFile，库外绝对路径（㉞）桌面端 stat 探活；
	 * 否则弹快速选择器；取消返回 null（调用方放弃布局，不动现状）。
	 */
	private async pickRestoredPdf(): Promise<TFile | string | null> {
		if (this.lastReaderState) {
			const cached = this.lastReaderState.file;
			if (isAbsoluteFsPath(cached)) {
				// 库外路径仅桌面可探活复用；移动端 / 文件已失存落回选择器
				if (!Platform.isMobile && (await externalFileExists(cached))) {
					return cached;
				}
			} else {
				const file = this.app.vault.getAbstractFileByPath(cached);
				if (file instanceof TFile) {
					return file;
				}
			}
		}
		return this.pickPdfFile();
	}

	/** PDF 快速选择器包装为 Promise：选择回调 / 关闭取消（onClose 兜底 resolve null） */
	private pickPdfFile(): Promise<TFile | string | null> {
		return new Promise((resolve) => {
			let settled = false;
			const modal = new PdfPickerModal(
				this.app,
				(pick) => {
					settled = true;
					resolve(pickTarget(pick));
				},
				this.recentExternalDocs(),
				{ plugin: this },
			);
			// 取消路径没有选择回调：实例级 onClose 兜底（基类 onClose 为空钩子，覆盖安全）
			modal.onClose = () => {
				if (!settled) {
					resolve(null);
				}
			};
			modal.open();
		});
	}

	/**
	 * 联动定位（脑图→文档）：点击脑图节点把阅读器滚到该卡原文。
	 * 已有打开同文件的阅读标签就地定位；异文件复用第一个阅读标签切换
	 * （联动视图单一阅读窗格语义）；没有阅读标签才新开（openCardSource）。
	 */
	async revealCardInReader(card: Card): Promise<void> {
		const doc = card.documentId ? this.documents.get(card.documentId) : undefined;
		if (!doc) {
			return;
		}
		// 路径双语义（㉞）：库外绝对路径不解析 TFile（存在性在读文件时校验），移动端无法读取
		if (isAbsoluteFsPath(doc.filePath)) {
			if (Platform.isMobile) {
				new Notice(MSG_EXTERNAL_DOC_MOBILE);
				return;
			}
		} else if (!(this.app.vault.getAbstractFileByPath(doc.filePath) instanceof TFile)) {
			new Notice("原文文件不在当前库中，无法跳转");
			return;
		}
		const filePath = doc.filePath;
		const ws = this.app.workspace;
		const leaves = ws.getLeavesOfType(READER_VIEW_TYPE);
		if (leaves.length === 0) {
			await this.openCardSource(card);
			return;
		}
		const state: Record<string, unknown> = { file: filePath, cardId: card.id };
		if (card.page != null) {
			state.page = card.page;
		}
		// leaf 匹配按 state.file 字符串比较——库内/库外两种路径形态天然兼容
		const leaf =
			leaves.find(
				(l) => ((l.getViewState().state ?? {}) as { file?: string }).file === filePath,
			) ?? leaves[0];
		ws.setActiveLeaf(leaf, { focus: false });
		await leaf.loadIfDeferred();
		if (leaf.view instanceof MarinMindReaderView && leaf.view.filePath === filePath) {
			// 同文件不重跑加载，setState 内部精确定位 + 闪烁（⑨-A）
			await leaf.setViewState({ type: READER_VIEW_TYPE, state });
		} else {
			// 异文件：切换文件加载（openInReader setViewState 驱动新加载）
			await this.openInReader(filePath, card.page ?? undefined, card.id, leaf);
		}
	}

	/** 联动定位（文档→脑图）：阅读器点高亮时让打开着的脑图平移到对应节点并闪烁 */
	locateCardInMindmaps(cardId: string): boolean {
		return locateCardInActiveMindmaps(cardId);
	}

	/** 书签跨阅读标签同步（㊳）：同文档的全部阅读视图刷新侧栏（侧栏未开 no-op） */
	refreshReaderBookmarks(docId: string): void {
		for (const leaf of this.app.workspace.getLeavesOfType(READER_VIEW_TYPE)) {
			const view = leaf.view;
			if (view instanceof MarinMindReaderView && view.docId === docId) {
				view.refreshBookmarks();
			}
		}
	}

	/**
	 * 库外文档改名跟随分发（㊳ fs watcher）：打开中的阅读视图更新内存路径键。
	 * 补齐 vault rename 监听覆盖不到的库外绝对路径；不重载内容（字节同源，
	 * pdf-cache 键与文档记录均指向新路径）。
	 */
	applyExternalRename(oldPath: string, newPath: string): void {
		for (const leaf of this.app.workspace.getLeavesOfType(READER_VIEW_TYPE)) {
			const view = leaf.view;
			if (view instanceof MarinMindReaderView) {
				view.followExternalRename(oldPath, newPath);
			}
		}
	}

	private showStats(): void {
		if (!this.store) {
			new Notice("MarinMind：数据层未就绪");
			return;
		}
		// 69 升级为统计面板（原 Notice 的文档/卡片/脑图计数吸收为面板库统计行）
		new ReviewStatsModal(this.app, this).open();
	}
}
