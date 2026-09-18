import { Notice, Platform, Plugin, TFile } from "obsidian";
import type { App, PluginManifest, WorkspaceLeaf } from "obsidian";
import { MarinMindStore } from "./store/marinmind-store";
import { loggedReviewTotal, totalReviewsApprox } from "./store/review-log";
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
import {
	autoAddCard,
	ensureBookMindmap,
	followBookRename,
	linkedMapOf,
} from "./mindmap/auto-collect";
import { MarinMindReaderView, READER_VIEW_TYPE } from "./reader/reader-view";
import { MarinMindHomeView, HOME_VIEW_TYPE } from "./home/home-view";
import { AiChatView, AI_CHAT_VIEW_TYPE } from "./ai/ai-chat-view";
import { PdfPickerModal, pickTarget, type ExternalDocEntry } from "./reader/pdf-picker-modal";
import { WebclipModal } from "./webclip/webclip-modal";
import {
	captureAllScreens,
	captureOutside,
	focusOwnWindow,
	registerGlobalHotkey,
	unregisterGlobalHotkey,
	validateAccelerator,
	writePngToClipboard,
	type CapturedScreen,
} from "./capture/screen-capture";
import { cropScreenRegion } from "./capture/image-crop";
import { clipScreenRegionToNote } from "./capture/screen-clip";
import {
	destroyActiveOverlaySession,
	selectScreenRegion,
	type OverlayAction,
	type OverlayOutcome,
	type ScreenSelectResult,
} from "./capture/screen-select";
import { createCaptureTray, destroyCaptureTray, type CaptureTrayLike } from "./capture/tray-icon";
import { ScreenshotCropModal } from "./capture/screenshot-crop-modal";
import type { ViewMode } from "./ui/view-mode-bar";
// 139-H 工作区编排下沉：布局操作函数自本类迁 ui/workspace-layout.ts（零行为变化）；
// 状态字段与联动事件接线（syncLinkedMindmap/linkedClose*/deepNavigateToCard）留本类
import {
	openWorkspace,
	readerIsLeft,
	setViewMode as setViewModeLayout,
	splitMindmapPane,
} from "./ui/workspace-layout";
import { MarinMindReviewView, REVIEW_VIEW_TYPE } from "./review/review-view";
import type { ReviewScope } from "./review/review-view";
import { DeckPickerModal } from "./review/deck-picker-modal";
import { ReviewStatsModal } from "./review/review-stats-modal";
import { exportAnkiCsv } from "./review/anki-export";
import { exportBackup, promptImportBackup } from "./backup/backup-service";
import { AttachmentStore } from "./attachments/attachment-store";
import { removeOrphanAttachments, scanAttachments } from "./attachments/attachment-audit";
import { importPhotoCard, pickImageFiles, type MediaAnchor } from "./attachments/media-import";
import { AudioRecorder, audioDurationSec } from "./reader/audio-recorder";
import { RecordingBar } from "./reader/recording-bar";
import { CardEventBus } from "./events/card-bus";
// 147 通知机制收敛：书签/改名等 leaf 扫描式中介广播改走通用视图注册表
import { broadcastToViews } from "./events/view-registry";
// 148 i18n：界面语言装配（设置读取后 setLocale）
import { setLocale, t } from "./i18n/i18n";
import {
	CLIPS_SUBDIR,
	DEFAULT_BACKUP_DIR,
	DEFAULT_DATA_DIR,
	MSG_EXTERNAL_DOC_MOBILE,
} from "./constants";
import {
	loadSettings,
	extractLegacyWebclipFolder,
	type MarinMindSettings,
} from "./settings/settings";
import type { AiUsage } from "./ai/ai-provider";
import { MarinMindSettingTab } from "./settings/settings-tab";
import { ConfirmModal } from "./mindmap/confirm-modal";
import { DocumentManagerModal } from "./documents/document-manager-modal";
import { ExternalDocWatcher } from "./documents/external-watcher";
import { externalFileExists, pickExternalPath } from "./storage/external-file";
import { isAbsoluteFsPath, isHiddenVaultDir, joinRel } from "./storage/paths";
import { buildCardCopyText, type CardCopyMode } from "./links/card-links";
import { migrateLegacyWebclips } from "./webclip/webclip-migrate";
import {
	resolveBackupLocation,
	resolveDataLocation,
	type ResolvedLocation,
} from "./storage/data-location";
import type { Card } from "./types";

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
	 * 已退役的 webclipFolder 旧设置值（124，initStorage 从原始 data.json 提取；
	 * 仅供存量剪藏迁移定位旧目录，此后不再使用）。
	 */
	private legacyWebclipFolder: string | null = null;

	/**
	 * 全局录音器（84-C：命令面板「录音摘录（自由卡片）」与主页重录入口共用，
	 * 不依赖阅读器打开文档）。录音条挂 document.body 跨视图存续。
	 */
	private globalRecorder: AudioRecorder | null = null;
	/** 全局录音条（84-C，挂 document.body；onunload 销毁） */
	private globalRecBar: RecordingBar | null = null;
	/** 当前全局录音的落卡锚点（84-C：start 时同步捕获，保存时消费） */
	private globalRecAnchor: MediaAnchor | null = null;
	/** 已注册的截图全局热键（117，空串 = 未注册；onunload 注销） */
	private captureHotkeyRegistered = "";
	/** 截图托盘实例（120，空 = 未创建；onunload 销毁） */
	private captureTray: CaptureTrayLike | null = null;

	/**
	 * 数据层初始化 promise（失败在内部消化为 db 保持 undefined，不产生未处理拒绝）。
	 * 默认已解决：onload 中 initStorage 完成后才指向真正的初始化（设置先行）。
	 */
	private dbReady: Promise<void> = Promise.resolve();

	/**
	 * 视图模式切换的恢复缓存（内存级，读取时优先于 79-3 持久缓存）：隐藏侧
	 * detach 前保存阅读状态（文件 + 页码）与脑图 id，切回联动/另一侧时原位恢复；
	 * 跨会话回退源见 settings.workspaceHidden（restoreMapId/hiddenReaderState）。
	 * 139-H 起随工作区编排下沉 ui/workspace-layout.ts 读写（public 中间态）。
	 */
	public lastReaderState: { file: string; page: number | null } | null = null;
	public lastMapId: string | null = null;
	/**
	 * 深度复习上次导航到的卡（79-5 翻面去重）：评分/翻面会多次 render 同一张
	 * 当前卡，重复触发阅读滚动 + 脑图定位；换卡才重新导航。
	 */
	public lastDeepCardId: string | null = null;
	/**
	 * 用户显式表达的视图模式意图（㊿ 会话内存，重启不保留；null = 未表达）：
	 * 仅 setViewMode / openWorkspace 置位，手动关标签不更新。联动同步
	 * （syncLinkedMindmap）只在任一联动档（isLinkedIntent，93 批起含
	 * linked / linked-swapped）时自动跟随——不经用户显式表达（如主页开
	 * 脑图 + 打开文档的并排浏览）不被打扰；联动级联关闭（linkedClose*）
	 * 置回 null（用户已离开联动）。
	 */
	public viewModeIntent: ViewMode | null = null;
	/**
	 * 联动互关抑制标志（㊿）：模式切换（doc/map 分支 detach 隐藏侧）触发的
	 * 视图 onClose 不得级联关掉保留侧——setViewMode 执行期间置 true。
	 */
	public suppressLinkedClose = false;
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
	/** AI 用量落盘防抖句柄（96）：内存累加 + 3s 防抖 saveData（避免高频调用逐次写盘） */
	private aiUsageFlushTimer: number | null = null;

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
		// AI 助手对话面板（98：右停靠侧栏，基于当前阅读文档问答）
		this.registerView(AI_CHAT_VIEW_TYPE, (leaf) => new AiChatView(leaf, this));

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
		// 大脑图标（brain）：呼应"思维/记忆"产品定位（Obsidian 1.4+ 捆绑 lucide 含 brain）
		this.addRibbonIcon("brain", "MarinMind 主页", () => {
			void this.openHome();
		});

		// 命令面板入口
		this.addCommand({
			id: "open-home",
			name: t("打开 MarinMind 主页"),
			callback: () => void this.openHome(),
		});
		this.addCommand({
			id: "open-reader",
			name: t("打开 MarinMind 阅读器（选择文档）"),
			callback: () => this.openPdfPicker(),
		});
		// 库外文档直读入口（㉞；㊼ 起收 PDF/EPUB）：仅桌面注册
		//（系统文件对话框 + fs 直读都不可用于移动端）
		if (Platform.isDesktopApp) {
			this.addCommand({
				id: "open-external-pdf",
				name: t("打开库外文档（桌面）"),
				callback: () => void this.openExternalPdf(),
			});
			// 114 截图工具：desktopCapturer / getDisplayMedia 仅桌面可靠；
			// 不注册默认热键（用户可在快捷键面板自绑）
			this.addCommand({
				id: "capture-screen",
				name: t("截图并复制到剪贴板（桌面）"),
				callback: () => void this.captureScreen(),
			});
			// 117 外截：Obsidian 窗口挡住目标时的互补路径——隐藏本窗口后拍摄
			this.addCommand({
				id: "capture-screen-outside",
				name: t("截图其他窗口（隐藏本窗口后拍摄，桌面）"),
				callback: () => void this.captureScreenOutside(),
			});
			// 119 屏幕区域剪藏：真实屏幕所见即所得（浏览器页面排版不再失真）
			this.addCommand({
				id: "clip-screen-region",
				name: t("剪藏屏幕区域为笔记（桌面）"),
				callback: () => void this.runScreenCaptureAction("note"),
			});
		}
		// 113 网页剪藏：抓网页正文转 md 笔记文档（全平台——requestUrl 桌面/移动端均可用）
		this.addCommand({
			id: "clip-webpage",
			name: t("保存网页为笔记文档"),
			callback: () => new WebclipModal(this.app, this).open(),
		});
		this.addCommand({
			id: "start-review",
			name: t("开始复习（到期闪卡）"),
			callback: () => void this.openReview(),
		});
		// 卡组批：按卡组开练——先弹卡组选择器（卡组由卡片 deck 设置派生，无实体表）
		this.addCommand({
			id: "start-review-deck",
			name: t("按卡组复习（选择卡组）"),
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
		// 139-G Anki 导出：闪卡出口通道（CSV 到 vault 根，Anki 文件导入）
		this.addCommand({
			id: "export-anki-csv",
			name: t("导出闪卡为 Anki CSV"),
			callback: () => void exportAnkiCsv(this),
		});
		this.addCommand({
			id: "open-mindmap",
			name: t("打开思维导图（选择 / 新建脑图）"),
			callback: () => this.openMindmapPicker(),
		});
		this.addCommand({
			id: "open-ai-chat",
			name: t("打开 AI 助手（当前文档问答）"),
			callback: () => void this.openAiChat(),
		});
		this.addCommand({
			id: "open-workspace-study",
			name: t("学习模式工作区（阅读 + 复习）"),
			callback: () => void openWorkspace(this, "study"),
		});
		this.addCommand({
			id: "open-workspace-research",
			name: t("研究模式工作区（阅读 + 脑图）"),
			callback: () => void openWorkspace(this, "research"),
		});
		this.addCommand({
			id: "open-workspace-deep",
			name: t("深度复习工作区（阅读 + 脑图 + 复习）"),
			callback: () => void openWorkspace(this, "deep"),
		});
		this.addCommand({
			id: "view-mode-doc",
			name: t("切换视图：单文档（隐藏脑图）"),
			callback: () => void this.setViewMode("doc"),
		});
		this.addCommand({
			id: "view-mode-map",
			name: t("切换视图：单脑图（隐藏文档）"),
			callback: () => void this.setViewMode("map"),
		});
		this.addCommand({
			id: "view-mode-linked",
			name: t("切换视图：联动（左文档右脑图）"),
			callback: () => void this.setViewMode("linked"),
		});
		this.addCommand({
			id: "view-mode-linked-swapped",
			name: t("切换视图：联动（左脑图右文档）"),
			callback: () => void this.setViewMode("linked-swapped"),
		});
		// 视图模式由工作区实际布局推导：手动关标签等外部变化也要刷新切换条激活态
		this.registerEvent(this.app.workspace.on("layout-change", () => this.notifyViewMode()));
		this.addCommand({
			id: "show-stats",
			name: t("复习统计（热力图 / 到期分布 / 库统计）"),
			callback: () => this.showStats(),
		});
		this.addCommand({
			id: "export-backup",
			name: t("导出备份（.marginpkg）"),
			callback: () => void exportBackup(this),
		});
		this.addCommand({
			id: "import-backup",
			name: t("导入备份（.marginpkg）"),
			callback: () => promptImportBackup(this),
		});
		this.addCommand({
			id: "manage-documents",
			name: t("文档管理（重关联失联文档）"),
			callback: () => new DocumentManagerModal(this.app, this).open(),
		});
		// 84-C 自由媒体卡：无文档归属的照片/语音卡（落「未归类卡片」，主页可见）
		this.addCommand({
			id: "capture-photo-card",
			name: t("捕捉照片为自由卡片"),
			checkCallback: (checking: boolean) => {
				// 数据层未就绪时建不了卡——命令不可用（镜像 start-review-deck 先例）
				if (!this.store) return false;
				if (!checking) {
					void (async () => {
						// 取消返回 []：saved 0 时静默（用户主动放弃不扰民）
						const files = await pickImageFiles(true);
						const saved = await importPhotoCard(this, files, {
							documentId: null,
							page: null,
						});
						if (saved > 0) {
							new Notice(`已保存 ${saved} 张照片卡（未归类卡片）`);
						}
					})();
				}
				return true;
			},
		});
		this.addCommand({
			id: "record-free-audio",
			name: t("录音摘录（自由卡片）"),
			checkCallback: (checking: boolean) => {
				if (!this.store) return false;
				if (!checking) {
					// toggle 语义：在录则保存，未录则以 null 锚启动（→ 未归类卡片）
					if (this.globalRecordingActive) {
						void this.stopAndSaveGlobalRecording();
					} else {
						void this.startGlobalRecording({ documentId: null, page: null });
					}
				}
				return true;
			},
		});
		// 84-E 附件仓对账：孤儿文件确认后清理（默认取消，宁拒不赌）
		this.addCommand({
			id: "cleanup-attachments",
			name: t("扫描并清理附件…"),
			checkCallback: (checking: boolean) => {
				if (!this.store) return false;
				if (!checking) {
					void this.auditAttachments(false);
				}
				return true;
			},
		});

		// 设置页
		this.addSettingTab(new MarinMindSettingTab(this.app, this));
		// 117 截图全局热键：设置非空且桌面时注册（内部自带桌面守卫）
		this.applyCaptureGlobalHotkey();
		// 120 截图托盘：设置开启且桌面时创建（内部自带桌面与环境守卫）
		this.applyCaptureTray();
	}

	onunload(): void {
		// 117 截图全局热键：注销（系统级注册不随插件卸载自动释放）
		if (this.captureHotkeyRegistered) {
			unregisterGlobalHotkey(this.captureHotkeyRegistered);
			this.captureHotkeyRegistered = "";
		}
		// 120 截图托盘：销毁（系统托盘图标不随插件卸载自动消失）
		destroyCaptureTray(this.captureTray);
		this.captureTray = null;
		// 118 覆盖窗直选会话：销毁置顶窗 + 清临时目录（幂等，无会话时静默）
		destroyActiveOverlaySession();
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
		// 84-C 全局录音：卸载即丢弃（未保存的录音不落库——宁丢勿残）
		this.removeGlobalRecBar();
		this.globalRecorder?.discard();
		this.globalRecorder = null;
	}

	/** 全局录音是否进行中（阅读器 toggleRecording 启动前互斥反查用，84-C） */
	get globalRecordingActive(): boolean {
		return this.globalRecorder?.active ?? false;
	}

	/**
	 * 启动全局录音（84-C）：锚点为建卡归属——命令面板传 null 锚（未归类卡片），
	 * 主页重录传原卡归属。与阅读器录音互斥（麦克风独占，两条录音条并存必混淆）。
	 */
	async startGlobalRecording(anchor: MediaAnchor): Promise<void> {
		if (this.globalRecordingActive) {
			new Notice("已在录音中（命令面板再次执行「录音摘录（自由卡片）」可保存）");
			return;
		}
		if (!this.store) {
			new Notice("数据层未就绪，无法录音");
			return;
		}
		// 防重：任一阅读器标签正在录音时不抢
		for (const leaf of this.app.workspace.getLeavesOfType(READER_VIEW_TYPE)) {
			if (leaf.view instanceof MarinMindReaderView && leaf.view.isRecording) {
				new Notice("阅读器正在录音，请先在阅读器中保存或丢弃");
				return;
			}
		}
		try {
			this.globalRecorder ??= new AudioRecorder();
			await this.globalRecorder.start();
		} catch (err) {
			console.warn("[MarinMind] 麦克风不可用", err);
			new Notice("无法访问麦克风：请在系统设置中允许 Obsidian 使用麦克风");
			this.globalRecorder = null;
			return;
		}
		this.globalRecAnchor = anchor;
		this.globalRecBar = new RecordingBar({
			app: this.app,
			host: document.body, // 挂 body 跨视图存续（阅读器关标签录音条不消失）
			recorder: this.globalRecorder,
			onSave: () => void this.stopAndSaveGlobalRecording(),
			onDiscard: () => {
				this.removeGlobalRecBar();
				this.globalRecorder?.discard();
				new Notice("已丢弃录音");
			},
		});
	}

	/** 停止全局录音并保存为 audio 卡（锚点在启动时捕获——录音期间视图可能已切换） */
	private async stopAndSaveGlobalRecording(): Promise<void> {
		const rec = this.globalRecorder;
		if (!rec?.active) {
			return;
		}
		const anchor = this.globalRecAnchor;
		this.removeGlobalRecBar();
		try {
			const { bytes, ext, durationMs } = await rec.stop();
			if (bytes.byteLength === 0) {
				new Notice("录音为空，已忽略");
				return;
			}
			const ref = await this.attachments.save(bytes, ext);
			this.cards.create({
				documentId: anchor?.documentId ?? null,
				page: anchor?.page ?? null,
				rects: [],
				excerptType: "audio",
				excerptRef: ref,
				color: "red", // ㊹ 四色化：照片/语音统一浅红
				durationSec: audioDurationSec(durationMs), // 84-B 时长落库
			});
			new Notice(
				anchor?.documentId != null ? "语音摘录已保存" : "语音摘录已保存（未归类卡片）", // 84-C 自由卡落点：主页「未归类卡片」可见
			);
		} catch (err) {
			console.error("[MarinMind] 录音保存失败", err);
			new Notice("录音保存失败");
		}
	}

	private removeGlobalRecBar(): void {
		this.globalRecBar?.destroy();
		this.globalRecBar = null;
	}

	/**
	 * 附件仓对账（84-E）：孤儿（文件无卡引用——删卡级联中断的残留）弹确认
	 * 清理，**默认取消宁拒不赌**（误删无法从库内恢复）；缺失（卡有 ref 无文件）
	 * 不弹窗——用户只能自行恢复文件，弹窗无补救动作反而打扰，Notice 计数 +
	 * console 明细足够。失败静默（启动路径不容错崩）。
	 * @param idle true = 启动静默路径（无孤儿零提示）；false = 手动命令（无问题报平安）
	 */
	private async auditAttachments(idle: boolean): Promise<void> {
		try {
			const { orphans, missing } = await scanAttachments(this);
			if (missing.length > 0) {
				console.warn("[MarinMind] 附件缺失（卡片引用的文件不存在）", missing);
				new Notice(`MarinMind：${missing.length} 张卡片的附件缺失（详见控制台）`);
			}
			if (orphans.length === 0) {
				if (!idle) {
					new Notice("附件完好：无孤儿文件");
				}
				return;
			}
			const preview = orphans
				.slice(0, 5)
				.map((p) => p.slice(p.lastIndexOf("/") + 1))
				.join("、");
			const more = orphans.length > 5 ? ` 等 ${orphans.length} 个` : "";
			new ConfirmModal(
				this.app,
				"清理孤儿附件",
				`发现 ${orphans.length} 个无卡片引用的附件文件（${preview}${more}），` +
					"可能是删卡中断的残留。删除后不可恢复，且无法从库内找回。",
				async () => {
					const removed = await removeOrphanAttachments(this, orphans);
					new Notice(`已清理 ${removed} 个孤儿附件`);
				},
			).open();
		} catch (err) {
			console.warn("[MarinMind] 附件对账失败", err);
		}
	}

	/**
	 * 加载设置并解析数据/备份目录定位（onload 最先执行）。
	 * 数据目录设置值不可用时（如移动端读到桌面绝对路径的同步 data.json）
	 * 回退默认 vault 内目录——插件保持可用，用户可在设置页修正。
	 */
	private async initStorage(): Promise<void> {
		this.settings = await loadSettings(this);
		setLocale(this.settings.language); // 148 i18n：语言在一切视图渲染前装配
		// 124 剪藏迁移：旧 webclipFolder 字段已退役（loadSettings 不再产出），
		// 此处从原始记录提取供 initStore 的存量迁移定位旧目录
		this.legacyWebclipFolder = extractLegacyWebclipFolder(await this.loadData());
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
			// 123 布局 v2 迁移摘要（幂等；有搬迁才打扰用户）
			this.notifyLayoutMigration();
			// 124 存量剪藏迁移（vault 旧 WebClips/ 等 → 数据根 clips/；幂等，
			// 串行 await 保证此后打开的剪藏文档键已同步）
			await migrateLegacyWebclips(this, this.legacyWebclipFolder);
			this.legacyWebclipFolder = null;
			this.registerVaultFileSync();
			// 103-C 累计复习口径统一：一次性基线迁移（幂等，见方法注释）
			this.migrateReviewStatsBaseline();
			// ㊳ 库外文档观察首同步（记录集就绪；无库外记录时是空操作）
			this.externalWatcher?.sync();
			const stats = this.store!.stats();
			console.info(
				`[MarinMind] 数据层就绪（md 格式 v${this.store!.formatVersion}）：` +
					`文档 ${stats.documents}，卡片 ${stats.cards}，` +
					`待复习 ${this.reviews.dueCount()}，脑图 ${stats.mindmaps}（${stats.nodes} 节点）`,
			);
			// 84-E 附件仓对账（fire-and-forget）：静默路径，
			// 发现孤儿才弹确认清理；失败仅 console 不打扰启动
			void this.auditAttachments(true);
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
	 * 123 布局 v2 迁移摘要 Notice（store.open 内已执行迁移，此处仅播报统计）：
	 * 书 md → books/、脑图/ → mindmaps/。迁移发生在 registerVaultFileSync 注册
	 * 监听之前（onload 首开路径），无 vault 事件双处理；搬迁采用 copy+delete，
	 * 迟到的 create/delete 事件按未知路径兜底为无动作。
	 */
	private notifyLayoutMigration(): void {
		const mig = this.store?.lastLayoutMigration;
		if (!mig || (mig.booksMoved === 0 && mig.mapsMoved === 0 && mig.conflictsSkipped === 0)) {
			return;
		}
		const parts: string[] = [];
		if (mig.booksMoved > 0) parts.push(`书文件 ×${mig.booksMoved} → books/`);
		if (mig.mapsMoved > 0) parts.push(`脑图 ×${mig.mapsMoved} → mindmaps/`);
		if (parts.length > 0) {
			new Notice(`MarinMind：数据目录布局已升级（${parts.join("，")}）`, 8000);
		}
		if (mig.conflictsSkipped > 0) {
			new Notice(
				`MarinMind：布局迁移有 ${mig.conflictsSkipped} 个同名冲突文件未搬迁` +
					"（原位置保留可照常使用，可手动整理）",
				8000,
			);
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
		this.reviews = new ReviewRepository(this.store, () => this.settings.scheduler);
		this.mindmaps = new MindmapRepository(this.store);
		this.bookmarks = new BookmarkRepository(this.store);
	}

	/**
	 * 累计复习口径统一（103-C，一次性迁移）：复习日志上线前的历史次数无法从
	 * SM-2 聚合字段回补出日期，故把 max(0, SM-2 聚合 − 日志已记总数) 定格到
	 * 设置 reviewStatsBaseline——此后统计面板「累计复习」= 基线 + 日志总和，
	 * 与今日/连续/热力图完全同源。null 哨兵 = 未迁移；迁移后即使删卡/清日志
	 * 也不重算（基线是历史事实，日志侧的增减由日志自身反映）。
	 */
	private migrateReviewStatsBaseline(): void {
		if (this.settings.reviewStatsBaseline != null) {
			return;
		}
		const store = this.store;
		if (!store) {
			return;
		}
		const approx = totalReviewsApprox(store.reviews.values());
		const logged = loggedReviewTotal(store.getReviewLog());
		const baseline = Math.max(0, approx - logged);
		this.settings.reviewStatsBaseline = baseline;
		void this.saveData({ ...this.settings });
		console.info(
			`[MarinMind] 复习统计基线迁移：历史 ${baseline} 次（SM-2 近似 ${approx} − 日志已记 ${logged}）`,
		);
	}

	/**
	 * 全局文件事件同步（rename 分流 + 数据根内 md 的 modify/delete 回灌）：
	 * - rename：数据根内 md → 存储引擎回灌（标题/图名跟随新文件名；移出数据根视同删除）；
	 *   数据根内 clips/ 剪藏 md → documents.file_path 业务键同步（124：剪藏不归
	 *   store 管理，改名不断卡片回链）；数据根外 → 同样的业务键同步（库内任何
	 *   TFile 改名都要跟上，否则卡片回链失联。目录移动时 Obsidian 对每个 TFile
	 *   逐个发事件，只处理 TFile 即覆盖）。
	 * - modify/delete：仅数据根内 md 且非 clips/（用户手编即权威，见
	 *   store.handleExternalChange；插件自写经 lastWritten 回声过滤）——clip md
	 *   内容不进 store，静默跳过（防未知文件认领告警）。
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
						if (oldRel.startsWith(`${CLIPS_SUBDIR}/`)) {
							// 124 剪藏 md 改名：业务键跟随（store 数据不受影响）
							this.documents.renamePath(oldPath, file.path);
							return;
						}
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
				if (rel !== null && !rel.startsWith(`${CLIPS_SUBDIR}/`)) {
					void this.applyExternalChange(rel, file);
				}
			}),
		);
		this.registerEvent(
			this.app.vault.on("delete", (file) => {
				if (!(file instanceof TFile) || file.extension !== "md") return;
				const rel = this.dataRootRelPath(file.path);
				if (rel !== null && !rel.startsWith(`${CLIPS_SUBDIR}/`)) {
					void this.applyExternalChange(rel, null);
				}
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

	/**
	 * 文档路径 → 数据根 clips/ 相对路径（124；非剪藏文档返回 null）。
	 * 两种数据根形态统一判定：vault 相对路径剥数据根前缀、fs 绝对路径
	 * （桌面）归一正斜杠后剥根前缀——阅读器 docKind 分流与 clip 读取共用。
	 */
	clipRelPath(filePath: string): string | null {
		const loc = this.dataLoc;
		if (loc.kind === "vault") {
			const rel = this.dataRootRelPath(filePath);
			return rel !== null && rel.startsWith(`${CLIPS_SUBDIR}/`) ? rel : null;
		}
		const normalized = filePath.replace(/\\/g, "/");
		const prefix = `${loc.rootDir.replace(/[\\/]+$/, "")}/`;
		if (!normalized.startsWith(prefix)) return null;
		const rel = normalized.slice(prefix.length);
		return rel.startsWith(`${CLIPS_SUBDIR}/`) ? rel : null;
	}

	/**
	 * 剪藏 md 的数据根相对路径 → 打开/登记用的目标路径（124）：
	 * vault 数据根 → vault 相对路径（openInReader(TFile) 与文档业务键形态）；
	 * fs 数据根 → 本机绝对路径（openInReader 字符串分支，桌面）。
	 */
	clipOpenTarget(rel: string): string {
		const loc = this.dataLoc;
		return loc.kind === "fs"
			? `${loc.rootDir.replace(/[\\/]+$/, "")}/${rel}`
			: joinRel(loc.rootDir, rel);
	}

	/**
	 * 打开剪藏笔记（124：saveWebclip / webclip-migrate 的产物入口）。
	 * vault 数据根经 TFile（文件由 vault.createBinary 落盘，索引即时可解析）；
	 * fs 数据根转绝对路径走库外文档分支。
	 */
	async openClip(rel: string): Promise<void> {
		if (this.dataLoc.kind === "vault") {
			const file = this.app.vault.getAbstractFileByPath(joinRel(this.dataLoc.rootDir, rel));
			if (file instanceof TFile) {
				await this.openInReader(file);
				return;
			}
			new Notice(`剪藏文件不存在：${rel}`);
			return;
		}
		await this.openInReader(this.clipOpenTarget(rel));
	}

	/** 数据根内 md 的外部变更回灌：读盘 → store 合并 → removed 发事件、warning 聚合 Notice */
	private async applyExternalChange(rel: string, file: TFile | null): Promise<void> {
		if (!this.store) return;
		let content: string | null = null;
		if (file) {
			try {
				content = new TextDecoder().decode(
					await this.app.vault.adapter.readBinary(file.path),
				);
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
			pending.count > 1 ? `已自动转为闪卡：${pending.count} 张` : "已自动转为闪卡",
			2500,
		);
	}

	/**
	 * AI 用量累计（96，P0 基础设施）：ai-service 的 onUsage 回调最终都汇集到这——
	 * 内存累加 settings.aiUsage + 3s 防抖落盘（对话面板流式高频回调不逐次写盘，
	 * 镜像 store 脏 scope 防抖思想）。设置页实时读内存值，落盘只为跨会话留存。
	 */
	public addAiUsage(usage: AiUsage): void {
		this.settings.aiUsage = {
			requests: this.settings.aiUsage.requests + usage.requests,
			promptTokens: this.settings.aiUsage.promptTokens + usage.promptTokens,
			completionTokens: this.settings.aiUsage.completionTokens + usage.completionTokens,
		};
		if (this.aiUsageFlushTimer !== null) {
			return;
		}
		this.aiUsageFlushTimer = window.setTimeout(() => {
			this.aiUsageFlushTimer = null;
			void this.saveData({ ...this.settings });
		}, 3000);
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

	/**
	 * 截图命令入口（114）：抓全部显示器全屏位图 → 覆盖窗直选（118）→ PNG 写
	 * 系统剪贴板；覆盖窗不可用降级 114 裁剪弹窗。macOS 无屏幕录制权限/
	 * 环境不支持分别给专用提示。
	 */
	private async captureScreen(): Promise<void> {
		await this.captureWith(async () => captureAllScreens());
	}

	/**
	 * 外截命令入口（117）：隐藏本窗口（最小化 → 500ms 动画余量 → 拍摄 →
	 * finally 恢复+聚焦）——目标内容被 Obsidian 挡住时的互补路径。118 起
	 * beforeRestore 钩子先把冻结画面盖满全屏再恢复主窗（恢复动作藏在覆盖
	 * 窗底下，无活画面闪现），直选在钩子内完成。
	 */
	private async captureScreenOutside(): Promise<void> {
		await this.captureWith((hooks) => captureOutside({ beforeRestore: hooks.beforeRestore }));
	}

	/**
	 * 截图共用尾段（118 重构）：抓屏（方式由 fetcher 决定，可收 beforeRestore
	 * 钩子）→ 覆盖窗直选 → 确认即物理裁剪 + PNG 写系统剪贴板 → 取消静默；
	 * 覆盖窗不可用（{ok:false}）降级 114 裁剪弹窗。外截模式把直选放进
	 * beforeRestore（restore 藏于覆盖窗下），直选已完成的标志是 overlayOutcome
	 * 非空——此时不再重复直选。
	 */
	private async captureWith(
		fetcher: (hooks: {
			beforeRestore?: (screens: CapturedScreen[]) => Promise<void> | void;
		}) => Promise<CapturedScreen[]>,
	): Promise<void> {
		// 外截模式在 beforeRestore 内完成的直选结局（null = 尚未直选）
		let overlayOutcome: OverlayOutcome | null = null;
		let screens: CapturedScreen[];
		try {
			screens = await fetcher({
				beforeRestore: async (shot) => {
					overlayOutcome = await selectScreenRegion(shot, { actions: ["copy"] });
				},
			});
		} catch (err) {
			new Notice(err instanceof Error ? err.message : String(err), 6000);
			return;
		}
		if (overlayOutcome) {
			// 外截模式：直选已在恢复窗口前完成（含降级弹窗——弹窗在恢复后的前台打开）
			await this.finishOverlayOutcome(screens, overlayOutcome);
			return;
		}
		if (screens.length === 0) {
			new Notice("当前环境不支持屏幕截图", 4000);
			return;
		}
		const outcome = await selectScreenRegion(screens, { actions: ["copy"] });
		await this.finishOverlayOutcome(screens, outcome);
	}

	/** 覆盖窗直选结局分流：确认→复制；取消→静默；不可用→降级 114 弹窗 */
	private async finishOverlayOutcome(
		screens: CapturedScreen[],
		outcome: OverlayOutcome,
	): Promise<void> {
		if (outcome.ok) {
			if (outcome.result) {
				// 复制后回 Obsidian 前台：Notice 可见 + 阅读器内 Ctrl+V 即可粘贴成卡
				focusOwnWindow();
				await this.copyScreenSelection(screens, outcome.result);
			}
			return; // 取消（Esc/右键/Win+D）：静默退出
		}
		// 降级：114 裁剪弹窗（覆盖窗环境不可用；reason 编号 D1-D5 便于回报定位）
		focusOwnWindow();
		new Notice(`当前环境不支持屏幕直选（${outcome.reason}），已回退裁剪弹窗`, 6000);
		new ScreenshotCropModal(this.app, screens).open();
	}

	/**
	 * 覆盖窗选区 → 物理像素裁剪（共用 image-crop）→ PNG 写系统剪贴板。
	 * 不落任何文件；失败给中文 Notice（119 屏幕剪藏复用同一裁剪入口）。
	 */
	private async copyScreenSelection(
		screens: CapturedScreen[],
		result: ScreenSelectResult,
	): Promise<void> {
		const screen = screens[result.screenIndex];
		if (!screen) {
			return;
		}
		try {
			const crop = await cropScreenRegion(screen, result.sel, result.dispW, result.dispH);
			if (!crop) {
				throw new Error("PNG 编码失败（环境异常）");
			}
			const ok = await writePngToClipboard(crop.blob, crop.dataUrl);
			if (!ok) {
				throw new Error("写入剪贴板失败（浏览器与系统通道均不可用）");
			}
			new Notice("截图已复制到剪贴板；在阅读器中按 Ctrl+V 可保存为图片卡", 5000);
		} catch (err) {
			new Notice(err instanceof Error ? err.message : String(err), 5000);
			console.error("[MarinMind] 截图复制失败", err);
		}
	}

	/**
	 * 屏幕截图动作统一入口（119 公开：命令 / 全局热键 / 120 托盘共用）。
	 * copy = 截图框选复制（captureWith 同链路）；note = 剪藏屏幕区域为笔记
	 * ——覆盖窗工具条双动作（「存为笔记」主按钮 +「复制」），所选即所得。
	 * Obsidian 挡住目标时用「截图其他窗口」后再 Ctrl+V。
	 */
	async runScreenCaptureAction(action: OverlayAction): Promise<void> {
		if (action === "copy") {
			await this.captureWith(async () => captureAllScreens());
			return;
		}
		// note：抓屏（不隐藏——用户此刻多半在浏览器，Obsidian 在后台）→
		// 覆盖窗双动作直选 → 按用户所选分流
		let screens: CapturedScreen[];
		try {
			screens = await captureAllScreens();
		} catch (err) {
			new Notice(err instanceof Error ? err.message : String(err), 6000);
			return;
		}
		if (screens.length === 0) {
			new Notice("当前环境不支持屏幕截图", 4000);
			return;
		}
		const outcome = await selectScreenRegion(screens, { actions: ["note", "copy"] });
		if (!outcome.ok) {
			// 降级：114 弹窗仅复制 + 说明（弹窗无「存为笔记」按钮；reason 编号定位）
			new Notice(
				`当前环境不支持屏幕直选（${outcome.reason}），已回退裁剪弹窗（仅复制截图）`,
				6000,
			);
			focusOwnWindow();
			new ScreenshotCropModal(this.app, screens).open();
			return;
		}
		if (!outcome.result) {
			return; // 取消静默
		}
		const result = outcome.result;
		const screen = screens[result.screenIndex];
		if (!screen) {
			return;
		}
		focusOwnWindow();
		if (result.action === "copy") {
			await this.copyScreenSelection(screens, result);
			return;
		}
		// note：物理裁剪（WebP 优先落库，回退 PNG）→ OCR（可选）→ 剪藏笔记
		//（screen-clip 内含 Notice/打开）；copy 分支走 copyScreenSelection 保持 PNG 剪贴板
		const crop = await cropScreenRegion(screen, result.sel, result.dispW, result.dispH, {
			preferWebp: true,
		});
		if (!crop) {
			new Notice("屏幕剪藏失败：图片编码异常", 5000);
			return;
		}
		await clipScreenRegionToNote(this, crop);
	}

	/**
	 * 应用截图全局热键设置（117）：注销旧 → 校验新值 → registerGlobalHotkey
	 * （isRegistered 核验，冲突时 register 可能静默不生效）→ 失败中文 Notice。
	 * onload / 设置页变更 / unload 三处调用；非桌面静默跳过。
	 */
	applyCaptureGlobalHotkey(): void {
		if (!Platform.isDesktopApp) {
			return;
		}
		if (this.captureHotkeyRegistered) {
			unregisterGlobalHotkey(this.captureHotkeyRegistered);
			this.captureHotkeyRegistered = "";
		}
		const accel = this.settings.captureGlobalHotkey.trim();
		if (!accel || !validateAccelerator(accel)) {
			return; // 空 = 关闭；非法值 loadSettings 已挡，此处防御
		}
		if (!registerGlobalHotkey(accel, () => void this.onCaptureHotkey())) {
			new Notice(`截图热键「${accel}」注册失败，可能被其他应用占用`, 6000);
			return;
		}
		this.captureHotkeyRegistered = accel;
	}

	/**
	 * 应用截图托盘设置（120）：销毁旧 → 设置开启且桌面时 createCaptureTray
	 * （环境不可用内部静默——托盘只是入口聚合，命令/热键入口不受影响）。
	 * onload / 设置页变更 / unload 三处调用；非桌面静默跳过。
	 */
	applyCaptureTray(): void {
		if (!Platform.isDesktopApp) {
			return;
		}
		if (this.captureTray) {
			destroyCaptureTray(this.captureTray);
			this.captureTray = null;
		}
		if (!this.settings.showCaptureTray) {
			return;
		}
		this.captureTray = createCaptureTray(this);
	}

	/**
	 * 托盘右键「退出」（125）：销毁托盘图标并置空——设置开关 showCaptureTray
	 * 不动（区别于设置关闭：用户只是临时收起，重载插件 / 重新应用设置即恢复）。
	 */
	exitCaptureTray(): void {
		destroyCaptureTray(this.captureTray);
		this.captureTray = null;
	}

	/**
	 * 全局热键回调（117→118）：用户此刻在其他应用——直接抓屏（目标就在屏幕
	 * 上，不隐藏；Obsidian 若挡住目标请用「截图其他窗口」命令）→ 覆盖窗
	 * 直选（不抢 Obsidian 前台，直选确认/取消后再 focusOwnWindow）。
	 */
	private async onCaptureHotkey(): Promise<void> {
		await this.captureWith(async () => captureAllScreens());
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

	/**
	 * 打开 AI 助手对话面板（98）：优先右停靠侧栏（首个打开落右栏；已在主标签
	 * 区打开的复用原叶）；面板内每次发送时现找激活阅读视图取上下文——
	 * 打开位置与文档无关，切书自动跟随。
	 */
	async openAiChat(): Promise<void> {
		let leaf = this.app.workspace.getLeavesOfType(AI_CHAT_VIEW_TYPE)[0];
		if (!leaf) {
			leaf = this.app.workspace.getRightLeaf(false) ?? this.newTabLeaf();
			await leaf.setViewState({ type: AI_CHAT_VIEW_TYPE });
		}
		// 101 修：右侧栏收起时 setActiveLeaf 不展开侧栏——面板在折叠侧栏里
		// 已加载但界面看似毫无反应；revealLeaf 负责展开侧栏/切换标签页再聚焦
		this.app.workspace.revealLeaf(leaf);
		this.app.workspace.setActiveLeaf(leaf, { focus: true });
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
	 * 居中平移 + 闪烁（79-2 折叠隐藏自动展开后定位）。loadMap 是同步内存读取，
	 * await 后即可定位；卡片不在图中（已移出）locateCard 返 false → Notice 提示。
	 */
	async openMindmapAtCard(mapId: string, cardId: string): Promise<void> {
		await this.openMindmap(mapId);
		const leaf = this.app.workspace.getLeavesOfType(MINDMAP_VIEW_TYPE)[0];
		const view = leaf?.view;
		if (view instanceof MarinMindMindmapView && !view.locateCard(cardId)) {
			new Notice("该卡片不在图中（可能已被移出）");
		}
	}

	/**
	 * 打开复习：复用已有复习标签页则激活并重启会话，否则新开标签页。
	 * public——阅读器工具行与脑图 header 的「复习」入口按钮也走这里（㉑）。
	 * docId（㊷）：传入 = 只复习该书（阅读器/脑图入口按书过滤）；缺省 = 全部书籍
	 * （命令面板/主页入口）。
	 */
	async openReview(docId?: string): Promise<void> {
		// undefined 归一 null：显式传参语义（null = 清范围为全部书籍）与入口缺省一致
		await this.focusReviewView(docId != null ? { kind: "book", docId } : null);
	}

	/**
	 * 阅读窗格当前文档 id（91 批）：激活标签是阅读器取之，否则回退第一个阅读标签
	 * （联动单阅读窗格语义，同 ensureMindmapPane 的取叶策略）；无阅读器/未加载为 null。
	 * 脑图复习入口的「本书」回退源——主题图无绑定文档时跟当前阅读的书。
	 * 147 注：带激活标签位置语义的查询不收敛注册表（其迭代序非工作区标签序），保持 leaf 扫描。
	 */
	activeReaderDocId(): string | null {
		const readers = this.app.workspace.getLeavesOfType(READER_VIEW_TYPE);
		const leaf = readers.find((l) => l === this.app.workspace.activeLeaf) ?? readers[0];
		return leaf?.view instanceof MarinMindReaderView ? leaf.view.docId : null;
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
	 * 109 已开同文件标签就地定位（reuseOpenReaderLeaf），未开/异文件走新开路径。
	 */
	async openCardSource(card: Card): Promise<void> {
		const doc = card.documentId ? this.documents.get(card.documentId) : undefined;
		if (!doc) {
			return;
		}
		// 109 复用已开标签：阅读窗格正显示本文档时不新开，直接激活 + 精确定位
		if (await this.reuseOpenReaderLeaf(doc.filePath, card)) {
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
	 * 109 跳原文复用已开标签：已有阅读标签正显示该文件时激活它，并同文件
	 * setViewState 就地精确定位（reader setState 同文件只定位不重载，⑨-A——
	 * 页码 + cardId 矩形滚动 + 闪烁）。此前每次跳原文都新开标签再定位
	 * （用户反馈）。仅同文件复用——阅读窗格显示其他文档时不夺屏换文件
	 * （异文件仍走新开路径）；state.file 与视图实况不符的竞态兜底返回
	 * false，由调用方回落新开。leaf 匹配按 state.file 字符串比较，
	 * 库内/库外两种路径形态天然兼容（与 revealCardInReader 同款）。
	 */
	private async reuseOpenReaderLeaf(filePath: string, card: Card): Promise<boolean> {
		const ws = this.app.workspace;
		const leaf = ws
			.getLeavesOfType(READER_VIEW_TYPE)
			.find((l) => ((l.getViewState().state ?? {}) as { file?: string }).file === filePath);
		if (!leaf) {
			return false;
		}
		ws.setActiveLeaf(leaf, { focus: false });
		await leaf.loadIfDeferred();
		if (!(leaf.view instanceof MarinMindReaderView) || leaf.view.filePath !== filePath) {
			return false;
		}
		const state: Record<string, unknown> = { file: filePath, cardId: card.id };
		if (card.page != null) {
			state.page = card.page;
		}
		await leaf.setViewState({ type: READER_VIEW_TYPE, state });
		return true;
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

	// ---------- 多窗格工作区（139-H 布局编排下沉 ui/workspace-layout.ts，此处留事件接线） ----------

	/** 深度复习布局判定（79-5）：阅读/脑图/复习三视图标签齐备（布局推导，同 getViewMode 哲学） */
	private isDeepReviewLayout(): boolean {
		const ws = this.app.workspace;
		return (
			ws.getLeavesOfType(READER_VIEW_TYPE).length > 0 &&
			ws.getLeavesOfType(MINDMAP_VIEW_TYPE).length > 0 &&
			ws.getLeavesOfType(REVIEW_VIEW_TYPE).length > 0
		);
	}

	/**
	 * 深度复习导航（79-5）：复习当前卡 → 阅读侧滚动定位 + 脑图侧定位/切图。
	 * 仅三窗格齐备且复习窗格为激活标签时驱动——cardBus 外部改卡也会触发复习
	 * 重渲染，此时复习在后台，不打扰用户当前阅读位置；lastDeepCardId 翻面去重。
	 * 显式导航不受 linkDirection 门控（R9：深度复习命令属显式编排）。
	 * 当前图无此卡时按卡→图映射切图：直接改脑图 leaf 视图状态再定位，不走
	 * openMindmap——其 setActiveLeaf 会抢走复习窗格焦点致键盘评分失效（R2）。
	 * suppress（91 批）：浏览导航（◀ ▶ / 卡组列表跳转）只换卡不同步原文——
	 * 更新 lastDeepCardId 去重基点后直接返回（后续翻面/评分不补跳本卡）。
	 */
	async deepNavigateToCard(
		card: Card,
		fromLeaf: WorkspaceLeaf,
		opts: { suppress?: boolean } = {},
	): Promise<void> {
		const ws = this.app.workspace;
		if (!this.isDeepReviewLayout() || ws.activeLeaf !== fromLeaf) {
			return;
		}
		if (this.lastDeepCardId === card.id) {
			return;
		}
		this.lastDeepCardId = card.id;
		if (opts.suppress) {
			return;
		}
		await this.revealCardInReader(card, { explicit: true });
		if (this.locateCardInMindmaps(card.id, { explicit: true })) {
			return;
		}
		// 当前图无此卡：卡→图映射取第一张现存图切换脑图侧（不抢焦点）
		const hit = this.mindmaps.nodesByCard(card.id)[0];
		const mapLeaf = ws.getLeavesOfType(MINDMAP_VIEW_TYPE)[0];
		if (!hit || !mapLeaf) {
			return; // 不在任何图中/脑图缺失：阅读侧定位已足够
		}
		await mapLeaf.setViewState({ type: MINDMAP_VIEW_TYPE, state: { mapId: hit.mapId } });
		await mapLeaf.loadIfDeferred();
		if (mapLeaf.view instanceof MarinMindMindmapView) {
			// 新视图 onOpen 先消费 state.mapId；显式 loadMap 幂等兜底（㊿-A 同源）
			mapLeaf.view.loadMap(hit.mapId);
			mapLeaf.view.locateCard(card.id);
		}
	}

	// ---------- 视图模式切换（单文档 / 单脑图 / 联动·文档左 / 联动·脑图左，⑰ + 93） ----------

	/**
	 * 当前视图模式：由工作区实际存在的阅读器/脑图标签推导——
	 * 手动关标签 = 隐式切换；重启后 Obsidian 恢复的布局即上次的模式。
	 * 93 批四档：两侧齐备时按实际左右方位区分 linked（文档左）/ linked-swapped
	 * （脑图左）。
	 */
	getViewMode(): ViewMode {
		const readers = this.app.workspace.getLeavesOfType(READER_VIEW_TYPE);
		const maps = this.app.workspace.getLeavesOfType(MINDMAP_VIEW_TYPE);
		if (readers.length > 0 && maps.length > 0) {
			return readerIsLeft(readers[0], maps[0]) ? "linked" : "linked-swapped";
		}
		if (readers.length > 0) {
			return "doc";
		}
		if (maps.length > 0) {
			return "map";
		}
		return "linked"; // 两侧皆无：默认联动（首次点开依次补齐两侧）
	}

	/** 93 批：当前是否处于任一联动意图（文档左 / 脑图左）——自动跟随与一对一编排的门控 */
	private isLinkedIntent(): boolean {
		return this.viewModeIntent === "linked" || this.viewModeIntent === "linked-swapped";
	}

	/** 订阅视图模式变化（切换条激活态同步）；返回退订函数 */
	onViewModeChange(cb: (mode: ViewMode) => void): () => void {
		this.viewModeListeners.add(cb);
		return () => {
			this.viewModeListeners.delete(cb);
		};
	}

	/** 视图模式变化通知（public 中间态：下沉的 ui/workspace-layout.ts setViewMode finally 调用） */
	public notifyViewMode(): void {
		const mode = this.getViewMode();
		for (const cb of this.viewModeListeners) {
			cb(mode);
		}
	}

	/**
	 * 切换到目标视图模式（薄包装，139-H）：布局编排下沉 ui/workspace-layout.ts，
	 * 此处保留公开 API 形态（view-mode-bar / 命令调用 plugin.setViewMode）。
	 */
	async setViewMode(mode: ViewMode): Promise<void> {
		await setViewModeLayout(this, mode);
	}

	/**
	 * 联动方向是否放行（79-1 四档开关）：双向/对应单向档放行，其余拒绝；
	 * explicit = 显式编排（工作区命令/视图切换条/深度复习导航）直通——
	 * 用户主动触发的布局编排不受 linkDirection 约束，只有自动跟随与
	 * 点击定位（视图层常规事件）走门控。
	 */
	private linkAllows(dir: "docToMap" | "mapToDoc", explicit = false): boolean {
		if (explicit) {
			return true;
		}
		const d = this.settings.linkDirection;
		return d === "both" || d === dir;
	}

	/**
	 * 联动一对一同步（㊿）：激活阅读文档的目标图 → 脑图侧显示的图与之对齐。
	 * 仅在用户显式表达联动意图（93 批起 isLinkedIntent：点过「左文档右脑图」/
	 * 「左脑图右文档」/ 研究模式）后自动跟随——并排浏览（主页开图 + 打开文档）
	 * 不被打扰。
	 * 接线点：applyViewMode linked 分支 / reader loadFromPath 尾部（联动下
	 * 切文档自动跟随新书）/ setCollectTarget（主动切换目标图立即反映）/
	 * 研究模式 ensureSidePane。目标图拿不到（文档加载中）静默返回。
	 * 79-1 门控：自动调用受 settings.linkDirection 约束（off/mapToDoc 档不跟随）；
	 * 显式编排（工作区命令/切换条）传 { explicit: true } 绕过——研究模式
	 * 「自动定位当前书的目标图」主流程不受开关影响。
	 */
	public async syncLinkedMindmap(opts: { explicit?: boolean } = {}): Promise<void> {
		if (!this.linkAllows("docToMap", opts.explicit)) {
			return;
		}
		if (!this.isLinkedIntent() || !this.store) {
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
			await splitMindmapPane(this, reader); // 补建（splitMindmapPane 内部同源选图）
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
	 * 79-1：off 档（两窗格完全独立）停用互关。
	 */
	public linkedCloseMindmap(filePath: string | null): void {
		if (this.settings.linkDirection === "off") {
			return;
		}
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
		if (this.settings.linkDirection === "off") {
			return; // 79-1 off 档：两窗格完全独立，互关停用
		}
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

	/**
	 * 隐藏阅读侧缓存读取（79-3）：内存 lastReaderState 优先，重启后回退
	 * data.json 持久化的 workspaceHidden.reader；两侧皆无返回 null。
	 */
	public hiddenReaderState(): { file: string; page: number | null } | null {
		return this.lastReaderState ?? this.settings.workspaceHidden?.reader ?? null;
	}

	/**
	 * lastMapId 可恢复则返回：内存（本会话）优先，79-3 起重启后回退设置持久
	 * 缓存；图已不存在（被删）时探活失败返回 null。
	 */
	public restoreMapId(): string | null {
		const id = this.lastMapId ?? this.settings.workspaceHidden?.mapId ?? null;
		return id && this.mindmaps.get(id) ? id : null;
	}

	/**
	 * 当前阅读文档的摘录目标图 id（㊴ 视图切换自动定位）：见 bookTargetByFilePath。
	 * 阅读窗格缺失/未登记文档返回 null（调用方回退 lastMapId/等待联动 sync）。
	 */
	public bookTargetMapId(reader: WorkspaceLeaf | undefined): string | null {
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
	public async pickRestoredPdf(): Promise<TFile | string | null> {
		// 79-3：内存缓存优先，重启后回退设置持久化的隐藏阅读侧
		const cached = this.hiddenReaderState()?.file;
		if (cached) {
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
	public pickPdfFile(): Promise<TFile | string | null> {
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
	 * 79-1：自动调用受 linkDirection 门控（off/docToMap 档不跳），显式编排传 explicit。
	 */
	async revealCardInReader(card: Card, opts: { explicit?: boolean } = {}): Promise<void> {
		if (!this.linkAllows("mapToDoc", opts.explicit)) {
			return;
		}
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

	/** 联动定位（文档→脑图）：阅读器点高亮时让打开着的脑图平移到对应节点并闪烁（79-1 受门控） */
	locateCardInMindmaps(cardId: string, opts: { explicit?: boolean } = {}): boolean {
		if (!this.linkAllows("docToMap", opts.explicit)) {
			return false;
		}
		return locateCardInActiveMindmaps(cardId);
	}

	/** 书签跨阅读标签同步（㊳）：同文档的全部阅读视图刷新侧栏（侧栏未开 no-op；147 起走通用视图注册表广播） */
	refreshReaderBookmarks(docId: string): void {
		broadcastToViews<MarinMindReaderView>(READER_VIEW_TYPE, (view) => {
			if (view.docId === docId) {
				view.refreshBookmarks();
			}
		});
	}

	/**
	 * 库外文档改名跟随分发（㊳ fs watcher）：打开中的阅读视图更新内存路径键。
	 * 补齐 vault rename 监听覆盖不到的库外绝对路径；不重载内容（字节同源，
	 * pdf-cache 键与文档记录均指向新路径）。147 起走通用视图注册表广播。
	 */
	applyExternalRename(oldPath: string, newPath: string): void {
		broadcastToViews<MarinMindReaderView>(READER_VIEW_TYPE, (view) => {
			view.followExternalRename(oldPath, newPath);
		});
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
