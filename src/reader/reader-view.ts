import { TFile, ItemView, Menu, Notice, Platform, debounce, setIcon } from "obsidian";
import type { ViewStateResult, WorkspaceLeaf } from "obsidian";
import type MarinMindPlugin from "../main";
import { resolveIcon, setIconSafe } from "../ui/icon-resolve";
import { imageExtOf, pickImageFiles, preparePhotoBytes } from "../attachments/media-import";
import { promptCardEdit, promptCardAiComment, promptCardGen } from "../home/card-actions";
import { canCardAiComment } from "../ai/ai-prompts";
import { MindmapPickerModal } from "../mindmap/mindmap-picker-modal";
import { ConfirmModal } from "../mindmap/confirm-modal";
import { collectTargetOf, fixedRootDocOf } from "../mindmap/auto-collect";
import { suggestRootPosition } from "../mindmap/mindmap-graph";
import { isOcrEngineReady, ocrCanvasPageLines, ocrCanvasRegions } from "../ocr/ocr-service";
import { ocrFailNotice, ocrStartNotice } from "../ocr/ocr-text";
import { docExtOf, fsBasename, isAbsoluteFsPath, isMobiExt } from "../storage/paths";
import { readExternalBinary } from "../storage/external-file";
import { localizeClipImageRefs } from "../webclip/clip-md";
import type { Card, DocRect, LineStyle, NormPoint } from "../types";
import { LINE_STYLES, LINE_STYLE_LABELS } from "../types";
import { AudioRecorder, audioDurationSec, formatDurSec } from "./audio-recorder";
import { AutoExcerptModal } from "./auto-excerpt-modal";
import {
	epubChapterTitleOf,
	entryText,
	epubOutline,
	parseEpub,
	type EpubBook,
} from "./epub-document";
import { EpubSession, type EpubLinkTarget } from "./epub-session";
import { parseMobi } from "./mobi-document";
import { RecordingBar } from "./recording-bar";
import { ExcerptLayer, flashEl, type ExcerptTool, type ReaderTool } from "./excerpt-layer";
import { HandwriteLayer } from "./handwrite-layer";
import {
	HIGHLIGHT_COLORS,
	highlightLineStyle,
	LINE_STYLE_ICONS,
	type HighlightColorValue,
} from "./highlight-colors";
import { HighlightColorModal } from "./highlight-color-modal";
import { MediaPreviewModal } from "./media-preview-modal";
import { MdDocument } from "./md-document";
import { outlineFromDom } from "./md-outline";
import { TextPromptModal } from "./note-edit-modal";
import { parseZoomInput } from "./zoom-input";
import { PageView, type PageSize } from "./page-view";
import { pdfLinesFromSpecs, type DocSearchHit, type PdfSearchLine } from "./doc-search";
import { DocSearchModal, collectBlockEls, type DocSearchHost } from "./doc-search-modal";
import { PdfDocument, type OutlineEntry } from "./pdf-document";
import { acquirePdf, pdfCacheKey, retainPdf, type PdfHandle } from "./pdf-cache";
import { SelectionToolbar, type SelectionSnapshot } from "./selection-toolbar";
import { jumpAnchorY, rectsRelativeToPage, type ViewportRect } from "./rect-utils";
import {
	attributeBoxesToPages,
	collectSelectionLines,
	trimRangeToBounds,
	type SelectionLine,
} from "./selection-geometry";
import { registerActiveView, unregisterActiveView } from "../events/view-registry";
import { t } from "../i18n/i18n";
import { mergeTextOcclusions, snapOcclusionToLines } from "./occlusion-snap";
import {
	DEFAULT_TRANSLATE_TARGET,
	MAX_TRANSLATE_CHARS,
	TRANSLATE_LANGUAGES,
	isTranslateLangCode,
	resolveEngineCall,
	translateLangLabel,
	translationAnchor,
	type EngineCall,
} from "../translate/translate-engine";
import { translateText } from "../translate/translate-service";
import { TranslateModal } from "../translate/translate-modal";
import { AiActionModal } from "../ai/ai-action-modal";
import { AiCardgenModal } from "../ai/ai-cardgen-modal";
import { AiOutlineModal } from "../ai/ai-outline-modal";
import { aiActionTitle, buildAiActionMessages, type AiMenuAction } from "../ai/ai-prompts";
import { AiSummaryModal } from "../ai/ai-summary-modal";
import { createViewModeBar } from "../ui/view-mode-bar";
import { mapLimit } from "../utils";

/** 阅读视图的 viewType（不与内置 'pdf' 冲突，不接管默认打开方式） */
export const READER_VIEW_TYPE = "marinmind-reader";

/** 缩放边界 */
const MIN_ZOOM = 0.2;
const MAX_ZOOM = 5;
/** 缩放按钮步长倍率 */
const ZOOM_STEP = 1.25;
/** 89 Ctrl+滚轮缩放灵敏度（指数曲线系数，镜像脑图 ZOOM_SENSITIVITY=0.0015） */
const WHEEL_ZOOM_SENSITIVITY = 0.0015;
/** 缩放快捷预设档（菜单直达；勾选态按当前 scale 现读，0.005 容差防浮点误差） */
const ZOOM_PRESETS = [1, 1.5, 2] as const;
/** fit-width 计算预留的滚动容器水平内边距（与 CSS padding 12px×2 对应） */
const SCROLL_PADDING_X = 24;

/** ㊻-B md 文档阅读栏宽上限（scale=1 基准宽；实际显示 = min(栏宽, 窗格宽)） */
const MD_COLUMN_WIDTH = 820;
/** ㊻-B md 单页占位高度（渲染前撑起滚动条，渲染完成后由内容实际高度接管） */
const MD_PLACEHOLDER_HEIGHT = 1000;

/**
 * 文档形态（㊼ 三态化：取代 ㊻-B 的 isMdDoc 布尔）：
 * - pdf：pdf.js 位图渲染（懒渲染/尺寸巡检/缩放/手写/AI 摘录/OCR 全量能力）
 * - md：库内 Markdown 单页长文（㊻-B，MarkdownRenderer）
 * - epub：EPUB 章节流（㊼，章=页，EpubSession 懒渲染）；㊽ MOBI 家族
 *   （mobi/azw3/azw/prc）经 parseMobi 转「虚拟 EPUB」后搭同一班车
 * - clip：数据根 clips/ 下的剪藏 md（124）——读取走数据根 adapter、图片
 *   assets/ 引用渲染前换 blob（clip-md.ts），排版/摘录全链路与 md 同构
 * md/epub/clip 合称「可重排文档」（isReflowDoc）：共享无位图/固定栏宽/页语义务复用分支
 */
type DocKind = "pdf" | "md" | "epub" | "clip";

/** ㊼ 按扩展名判定文档形态（库内/库外路径通吃；未知扩展名按 pdf 走 pdf.js 报错兜底） */
function docKindOf(filePath: string): DocKind {
	const ext = docExtOf(filePath);
	if (ext === "md" && !isAbsoluteFsPath(filePath)) {
		return "md"; // 库外 md 不支持（无 TFile 供 MarkdownRenderer 渲染上下文）
	}
	if (ext === "epub" || isMobiExt(ext)) {
		return "epub"; // ㊽ MOBI 家族按 epub 别名搭车（章=页模型同构）
	}
	return "pdf";
}

/** ㊳ 首屏同步建的骨架页数（其余分批异步补齐，防千页文档整卷同步循环卡首屏） */
const FIRST_SYNC_PAGES = 40;
/** ㊳ 异步补建骨架的批大小（每批之间让出主线程） */
const SKELETON_BATCH_PAGES = 120;
/** ㊳ 后台尺寸巡检：每批页数 × 取尺寸并发 */
const PATROL_BATCH_PAGES = 24;
const PATROL_CONCURRENCY = 4;

/** 80 阅读位置记忆：滚动静止多久后采集页码写库（store 另有 2s 防抖落盘） */
const LAST_PAGE_FLUSH_MS = 500;

// 139-D：选区几何（collectSelectionLines / trimRangeToBounds / SelectionLine /
// MAX_MEASURE_CHARS 等）下沉 src/reader/selection-geometry.ts 纯模块（可测）。

/**
 * 阅读器工具行定义：手型（只读平移）+ 选择（纯文本选择，㉖）+ MarginNote 四类摘录工具。
 * icon 均已对照 Obsidian 图标注册表（obsidian.asar "name":[[ 模式）验证有效——
 * 无效名不报错但渲染空白按钮。90 批起不确定的新名走 resolveIcon 兜底链
 * （ui/icon-resolve，getIcon 判空降级），矩形摘录 box-select 为首个消费者。
 */
/** 90 批 MN3 对照：「加入脑图」语义图标——network 节点连线图（git-fork 像版本控制）；
 * 低版本 Obsidian 缺名时依次降级 share-2 → git-fork */
const ADD_TO_MINDMAP_ICON = resolveIcon(["network", "share-2", "git-fork"]);

const TOOLBAR_TOOLS: ReadonlyArray<{
	tool: ReaderTool;
	icon: string;
	title: string;
	hint: string;
}> = [
	{ tool: "hand", icon: "hand", title: t("手型"), hint: "只读浏览，拖拽平移页面" },
	{
		tool: "select",
		icon: "text-cursor-input",
		title: t("选择"),
		hint: "划选文字以复制（不生成卡片）",
	},
	{ tool: "text", icon: "highlighter", title: t("文字"), hint: "划选文字生成卡片（默认）" },
	// 90 批 MN3 对照：矩形摘录=虚线选框（box-select）；square-dashed/square 为缺名兜底
	{
		tool: "area",
		icon: resolveIcon(["box-select", "square-dashed", "square"]),
		title: t("矩形"),
		hint: "拖拽框选规则区域",
	},
	{ tool: "lasso", icon: "lasso", title: t("套索"), hint: "自由圈选不规则区域" },
	{ tool: "blank", icon: "sticky-note", title: t("留白"), hint: "点击页面空白处添加备注" },
];

/** ㊹ 四类摘录工具判定：这四类有色系记忆（excerptColors）与按钮循环切色语义 */
function isExcerptTool(tool: ReaderTool): tool is ExcerptTool {
	return tool === "text" || tool === "area" || tool === "lasso" || tool === "blank";
}

/** 照片/语音/手写/套索/留白的菜单标签（㊼ 页/章措辞由 reader 实例决定，参数传入） */
function mediaCardLabel(card: Card, pageWord: string): string {
	const page = card.page != null ? ` · 第 ${card.page} ${pageWord}` : "";
	if (card.excerptType === "audio") {
		// 84-B 时长标签：dur 落库为权威（webm 容器无时长元数据时 <audio> 显示 NaN）
		const dur =
			typeof card.durationSec === "number" && card.durationSec > 0
				? ` · ${formatDurSec(card.durationSec)}`
				: "";
		return `语音摘录${dur}${page}`;
	}
	if (card.excerptType === "handwriting") {
		return `手写摘录${page}`;
	}
	if (card.excerptType === "lasso") {
		return `套索摘录${page}`;
	}
	if (card.excerptType === "blank") {
		return `留白备注${page}`;
	}
	return `照片摘录${page}`;
}

/**
 * MarinMind 阅读视图：PDF 连续滚动渲染 + 区域/文字摘录 + 高亮回显。
 *
 * 生命周期约定（㉞ 起 extends ItemView——库外绝对路径文档无 TFile，FileView 无法承载）：
 * - setState 可能先于 onOpen（新标签/工作区恢复/deferred 标签）：state.file 暂存
 *   pendingFile 由 onOpen 消费（镜像 mindmap-view pendingMapId 模式）；
 *   视图已开时 setState 直接驱动 openPath——ItemView 没有 FileView 的
 *   "同文件不重跑加载"机制，必须显式判重
 * - openPath 可能重入（快速切换/会话恢复），以 loadToken 代际守卫，
 *   每次 await 后校验，旧代际立即销毁其新建资源
 * - onClose 走 cleanupContent（幂等）
 */
export class MarinMindReaderView extends ItemView implements DocSearchHost {
	private readonly plugin: MarinMindPlugin;

	private pdf: PdfDocument | null = null;
	/** ㊳ 共享缓存句柄：pdf 的生命周期改由 pdf-cache 引用计数管理（release 归零才销毁） */
	private pdfHandle: PdfHandle | null = null;
	/** 页码 → PageView（㊳ 分块建页后 O(1) 直查取代数组 find；只含已建骨架的页） */
	private readonly pageViewByNumber = new Map<number, PageView>();
	/** 已建骨架的页数（分块建页进度游标，骨架按 1..builtPages 连续） */
	private builtPages = 0;
	/** 文档总页数（分块建页/巡检的边界） */
	private totalPages = 0;
	/** 第 1 页基准尺寸（分块建页的占位/列宽参照） */
	private firstSize: PageSize | null = null;
	/** 未建页的卡片回显暂存：页码 → 待 setCards 的卡列表（buildPage 时消费，㊳） */
	private readonly echoCardsByPage = new Map<number, Card[]>();
	private readonly excerptLayers = new Map<number, ExcerptLayer>();
	private readonly handwriteLayers = new Map<number, HandwriteLayer>();
	/** 页容器 → PageView 反查（IO 回调 O(1) 替代全量 find；openPath 重建时重填） */
	private readonly pageByEl = new WeakMap<Element, PageView>();
	/** 当前处于 IO 预渲染区内的页码（getCurrentPage 的小候选集，替代全页 gBCR 扫描） */
	private readonly visiblePages = new Set<number>();
	/** 存在待回填内容快照（area/lasso 无 excerptRef）的页码——backfill 的页级预判 */
	private readonly pagesNeedingBackfill = new Set<number>();
	private io: IntersectionObserver | null = null;
	/** 加载代际：onLoadFile 重入时旧流程作废 */
	private loadToken = 0;

	private scrollEl: HTMLElement | null = null;
	/** 80 阅读位置记忆：scroll-idle 计时器句柄（cleanupContent 清防换文档误写） */
	private lastPageTimer: number | null = null;
	/** 80 阅读位置记忆：已落库页码基准（页 1 归一 null）——与之相同零写，静读不打扰。
	 *  82 起程序化定位（回放/跳原文/工作区恢复）后经 syncLastPageBaseline 对齐
	 *  当前视口——定位位移不算阅读进度，跳转落点不覆盖真实阅读位置 */
	private lastPersistedPage: number | null = null;
	/** 待跳转的页码（setState 暂存，加载完成后滚动定位） */
	private pendingPage: number | null = null;
	/** 待定位的卡片（setState 暂存，滚到页后精滚到矩形并闪烁高亮） */
	private pendingCardId: string | null = null;
	/** 待恢复的缩放（setState 暂存，㊳ 仅 fixed 档持久化回放） */
	private pendingZoom: number | null = null;
	/** 待恢复的页内滚动偏移（setState 暂存，跳页后叠加，㊳） */
	private pendingOff: number | null = null;
	/** fit 模式基准页宽（取第 1 页 scale=1 宽度） */
	private basePageWidth = 0;
	private scale = 1;
	private zoomMode: "fit" | "fixed" = "fit";
	/** 当前阅读工具（工具行单选：手型/选择/文字/矩形/套索/留白；text 为默认） */
	private activeTool: ReaderTool = "text";
	private handwriteMode = false;
	private currentDocId: string | null = null;
	private currentFilePath: string | null = null;
	/** setState 暂存的待开文档路径（setState 先于 onOpen 时由 onOpen 消费） */
	private pendingFile: string | null = null;
	/** onOpen 已执行标记（setState 据此分流：未开暂存 / 已开就地加载） */
	private viewOpened = false;

	/** photo/audio 卡按页分组（页角徽标数据源，运行期增删维护） */
	private readonly mediaCardsByPage = new Map<number, Card[]>();
	private readonly mediaBadges = new Map<number, HTMLElement>();
	/** 录音状态条（84-B 组件化：自含计时/波形刷新定时器）与录音器 */
	private recorder: AudioRecorder | null = null;
	private recBar: RecordingBar | null = null;
	/** 互斥模式的工具栏按钮（状态同步用） */
	private handwriteBtn: HTMLElement | null = null;
	/** 84-A 手写工具条（手写模式激活期间悬浮底部居中；撤销/橡皮擦/清空） */
	private handwriteToolbar: HTMLElement | null = null;
	/** 84-A 最近落笔/擦除/清空页（Ctrl+Z 与工具条撤销的目标层） */
	private lastInkPage: number | null = null;
	/** 84-A 橡皮擦开关（作用于全部手写层，随模式关闭复位） */
	private handwriteEraser = false;
	/** 工具行按钮（tool → 按钮 DOM，状态同步用） */
	private readonly toolBtns = new Map<ReaderTool, HTMLElement>();
	/** 目录侧栏（㉓）：打开时非空；面板挂 contentEl（absolute 覆盖层） */
	private tocPanel: HTMLElement | null = null;
	/** 目录开关按钮（工具行；is-active 同步用） */
	private tocBtn: HTMLElement | null = null;
	/** ⋯ 溢出菜单按钮（89）：手型/选择/AI 摘录/缩放/脑图目标/闪卡折叠于此；
	 *  当前工具藏在菜单里（hand/select）时点亮提示非默认态 */
	private overflowBtn: HTMLElement | null = null;
	/** 89-D 文档内搜索：PDF 聚行缓存（扫描期填充、reveal 定位消费；随 cleanupContent 清空） */
	private readonly pdfSearchLines = new Map<number, readonly PdfSearchLine[]>();
	/** 遮挡编辑目标卡（㊷）：非空时进入画遮挡模式（Esc/切工具退出） */
	private occlusionEditTarget: Card | null = null;
	/** 文字遮罩目标卡（74）：非空时进入划选文字即遮罩模式（Esc/切工具退出；与拖框遮挡互斥） */
	private occlusionTextTarget: Card | null = null;
	/** 照片重定位目标卡（84-D 瞬态模式）：非空时拖框改该卡 rects 展示框（Esc/切工具退出） */
	private photoRelocateTarget: Card | null = null;
	/** 遮挡预览开关（㊷，会话态不持久化）：true 时遮挡块实心覆盖模拟复习观感 */
	private occlusionPreview = false;
	/** 71 遮挡行吸附开关（会话态不持久化，默认开）：text 卡拖遮挡时垂直吸附到整行 */
	private occlusionSnapLines = true;
	/** 划选工具栏（75）：text 工具划选松开弹出；惰性建（ensureSelectionToolbar），
	 * cleanupContent 销毁（DOM 随 contentEl.empty 消亡，监听显式移除） */
	private selectionToolbar: SelectionToolbar | null = null;
	/** 当前文档的内嵌大纲（md/epub 加载即就绪；pdf 懒解析后填充，见 ensureOutline） */
	private outlineEntries: OutlineEntry[] = [];
	/** P2 目录懒解析：大纲是否已解析完成（含失败——失败视同无大纲，防反复重试） */
	private outlineLoaded = false;
	/** P2 目录懒解析：在途解析 Promise（单飞防重复触发） */
	private outlineLoading: Promise<void> | null = null;
	/** P1 巡检推迟：首屏位图就绪信号——IO 渲染回调首张位图 resolve，巡检等它再起跑 */
	private firstBitmapDone: Promise<void> = Promise.resolve();
	private firstBitmapResolve: (() => void) | null = null;
	/** 文档形态（㊼ 三态，docKindOf 判定；默认 pdf） */
	private docKind: DocKind = "pdf";
	/** ㊼ epub 书籍结构（parseEpub 产物；非 epub 文档为 null） */
	private epub: EpubBook | null = null;
	/** ㊼ epub 章节渲染会话（图片 blob URL/净化渲染/链接委托；cleanup 时 close） */
	private epubSession: EpubSession | null = null;
	/** ㊻-B md 文档文本（loadFromPath 读入，renderMdIntoPage 消费后即弃） */
	private mdText: string | null = null;
	/** 124 clip 图片 blob URL（渲染期持有；cleanupContent 统一 revoke） */
	private clipBlobUrls: string[] = [];
	/** 90 批文件名标题元素（原生标题行隐藏后并入工具行行首；随工具行重建） */
	private readerTitleEl: HTMLElement | null = null;
	/** 侧栏当前分页（㉙ 目录/书签 + 83-E 翻译；视图生命周期内保持，重渲染不丢） */
	private tocTab: "outline" | "bookmarks" | "translate" = "outline";
	/** 83-E 翻译页签：最近划选快照（null = 空态提示；换文档时 cleanup 清空） */
	private translateSnap: SelectionSnapshot | null = null;
	/** 83-E 翻译页签：快照序号（每次推送递增——同文重选也强制刷新） */
	private ttSeq = 0;
	/** 83-E 翻译页签：已渲染的快照序号（书签增删等无关刷新不重建不重译） */
	private ttRenderedSeq = -1;
	/** 83-E 翻译页签：当前译文（null = 无可用结果，存留白/复制禁用） */
	private ttTranslation: string | null = null;
	/** 83-E 翻译页签：译文区元素包（重译/重试复用同一组 DOM；随 sec.empty 失效） */
	private ttEls: {
		detect: HTMLElement;
		result: HTMLElement;
		save: HTMLButtonElement;
		copy: HTMLButtonElement;
	} | null = null;
	/** 83-E 翻译页签：划选自动刷新防抖句柄（百度 QPS=1 的第一道闸；cleanup 清） */
	private ttTimer: number | null = null;
	/** 83-E 翻译页签：在途翻译请求序号（语言切换/换快照丢弃过期响应） */
	private ttToken = 0;
	/** 用户手动折叠过的目录条目 key（㉙：`标题|页码`——防抖重渲染不丢手动展开/折叠状态） */
	private readonly tocCollapsedKeys = new Set<string>();
	/** 手型工具的平移状态（拖拽中非空） */
	private pan: {
		pointerId: number;
		x: number;
		y: number;
		left: number;
		top: number;
	} | null = null;
	/** 卡片变更事件退订器（onClose 统一退订防泄漏） */
	private cardBusOffs: Array<() => void> = [];
	/** 视图模式切换条退订器（buildToolRow 重建 / onClose 时退订防泄漏） */
	private viewModeOff: (() => void) | null = null;

	/** 滚动离开手写页后延迟提交（防抖） */
	private readonly commitOffscreenSoon: () => void;

	private readonly rerenderSoon: () => void;

	/** 可重排文档（md/epub）：无位图/固定栏宽/共享降级分支的统一判据（㊼） */
	private get isReflowDoc(): boolean {
		return this.docKind !== "pdf";
	}

	/** ㊼ 页/章量词（epub 章=页模型，文案用） */
	private get pageWord(): string {
		return this.docKind === "epub" ? "章" : "页";
	}

	/**
	 * 文档级事件宿主（bindDocEvents 记录，unbindDocEvents 解绑用；
	 * popout 迁移随 contentEl.ownerDocument 切换——85-A 模式）
	 */
	private docEventsDoc: Document | null = null;
	/** 文档级事件处理器（箭头字段持有 this 绑定，绑/解同一引用） */
	private readonly onDocEsc = (evt: KeyboardEvent): void => this.handleEsc(evt);
	private readonly onDocUndo = (evt: KeyboardEvent): void => this.handleUndoShortcut(evt);
	private readonly onDocPaste = (evt: ClipboardEvent): void => this.onPaste(evt);

	constructor(leaf: WorkspaceLeaf, plugin: MarinMindPlugin) {
		super(leaf);
		this.plugin = plugin;
		// 卡片变更订阅（跨标签同步；回调只做 DOM/内存更新，禁止写库——契约见 card-bus.ts）
		this.cardBusOffs.push(
			plugin.cardBus.onCardChanged((card) => this.handleCardChanged(card)),
			plugin.cardBus.onCardRemoved((cardId, last) => this.handleCardRemoved(cardId, last)),
		);

		// 90 批顶栏合一：原头部 addAction 三枚（手写/插图/录音）迁入视图内工具行与
		// ⋯ 菜单（buildToolRow / openToolOverflowMenu）——原生标题行已由 CSS 隐藏，
		// 工具行成为唯一顶栏。四类摘录工具 + 手型/选择在 TOOLBAR_TOOLS

		this.rerenderSoon = debounce(() => this.handleResize(), 200, true);
		this.commitOffscreenSoon = debounce(() => this.commitOffscreenInk(), 400, true);

		// 划选文字摘录：鼠标松开 / Shift+方向键调整选区后尝试生成 text 卡片
		this.registerDomEvent(this.contentEl, "mouseup", () => this.handleSelectionEnd());
		this.registerDomEvent(this.contentEl, "keyup", (evt: KeyboardEvent) => {
			if (evt.key === "Shift" || evt.key.startsWith("Arrow")) {
				this.handleSelectionEnd();
			}
		});

		// 103-D 文档级键盘/粘贴事件（Esc 工具退出、Ctrl+Z 手写撤销、照片粘贴）：
		// 绑 contentEl.ownerDocument（onOpen 时 bindDocEvents）——85-A 同修法，
		// registerDomEvent(document,…) 绑死主窗口：popout 弹出窗口内不可用，
		// 且视图迁 popout 时 onClose→onOpen 重跑会累积重复处理器。
		// 各处理器的 activeLeaf/弹窗让位守卫语义不变（见 onEscKeydown 等方法）
		// 卸载兜底：popout 迁移等路径若漏调 onClose 的显式解绑，卸载时兜底清理
		this.register(() => this.unbindDocEvents());

		// 手型工具：拖拽平移滚动容器（只读浏览）。事件挂 contentEl 冒泡捕获——
		// overlay（hand-on 类）拦截指针后事件逐层冒泡到 scrollEl/contentEl；
		// setPointerCapture 到 scrollEl 后 move/up 也稳定路由到此处
		this.registerDomEvent(this.contentEl, "pointerdown", (evt: PointerEvent) => {
			if (this.activeTool !== "hand" || evt.button !== 0 || !this.scrollEl) {
				return;
			}
			if (!this.scrollEl.contains(evt.target as Node)) {
				return; // 点在工具行等滚动区外不启动平移
			}
			evt.preventDefault();
			this.pan = {
				pointerId: evt.pointerId,
				x: evt.clientX,
				y: evt.clientY,
				left: this.scrollEl.scrollLeft,
				top: this.scrollEl.scrollTop,
			};
			try {
				this.scrollEl.setPointerCapture(evt.pointerId);
			} catch {
				// 指针已释放等边缘情况，忽略
			}
			this.contentEl.classList.add("marinmind-panning");
		});
		this.registerDomEvent(this.contentEl, "pointermove", (evt: PointerEvent) => {
			const p = this.pan;
			if (!p || evt.pointerId !== p.pointerId || !this.scrollEl) {
				return;
			}
			this.scrollEl.scrollLeft = p.left - (evt.clientX - p.x);
			this.scrollEl.scrollTop = p.top - (evt.clientY - p.y);
		});
		const endPan = (evt: PointerEvent) => {
			if (!this.pan || evt.pointerId !== this.pan.pointerId) {
				return;
			}
			this.pan = null;
			this.contentEl.classList.remove("marinmind-panning");
		};
		this.registerDomEvent(this.contentEl, "pointerup", endPan);
		this.registerDomEvent(this.contentEl, "pointercancel", endPan);

		// 照片摘录三入口之二：拖入（粘贴入口在 bindDocEvents 绑 ownerDocument）
		this.registerDomEvent(this.contentEl, "dragover", (evt) => evt.preventDefault());
		this.registerDomEvent(this.contentEl, "drop", (evt) => this.onDrop(evt));

		// 89 Ctrl+滚轮缩放（镜像脑图 ZOOM_SENSITIVITY 指数曲线）：头部缩放按钮并入
		// 「⋯」菜单后的高频快捷路径。仅 PDF 生效（md/epub 栏宽自适应，滚轮不劫持）；
		// passive:false 才能 preventDefault（拦下浏览器的 Ctrl+滚轮整页缩放）。
		// 挂常驻 contentEl + contains 判定，避免随 scrollEl 重建堆积监听器
		this.registerDomEvent(
			this.contentEl,
			"wheel",
			(evt: WheelEvent) => {
				if (!evt.ctrlKey || this.docKind !== "pdf" || !this.scrollEl) {
					return;
				}
				if (!this.scrollEl.contains(evt.target as Node)) {
					return; // 工具行/侧栏上的 Ctrl+滚轮不劫持
				}
				evt.preventDefault();
				this.setZoom(this.scale * Math.exp(-evt.deltaY * WHEEL_ZOOM_SENSITIVITY));
			},
			{ passive: false },
		);

		// 文件重命名：oldPath 从 vault 事件取。DB 侧的 file_path 同步已上移 main.ts
		// 全局处理（覆盖库内全部文档，不限当前打开者），这里只维护视图自身的当前路径状态。
		// 库外（绝对路径）文档永不命中 vault 事件——㊳ 起 fs watcher 的自动跟随
		// 经 plugin.applyExternalRename → followExternalRename 补齐这条盲区
		this.registerEvent(
			this.app.vault.on("rename", (file, oldPath) => {
				if (
					file instanceof TFile &&
					oldPath === this.currentFilePath &&
					oldPath !== file.path
				) {
					this.currentFilePath = file.path;
					// 90 批：工具行行首文件名标题跟随
					this.readerTitleEl
						?.querySelector(".marinmind-reader-title-text")
						?.setText(file.basename);
				}
			}),
		);
		// 文件被删除：清空视图为提示态（卡片数据保留在库中，不级联删——
		// Obsidian 删除可经回收站撤销，若级联 documents.delete 会连带卡片/复习进度不可逆蒸发，
		// 失联记录由"文档管理"面板可控清理）
		this.registerEvent(
			this.app.vault.on("delete", (file) => {
				if (file instanceof TFile && file.path === this.currentFilePath) {
					this.cleanupContent();
					this.contentEl.empty();
					const tip = document.createElement("p");
					tip.textContent = "该文件已从库中删除。";
					tip.className = "marinmind-reader-tip";
					this.contentEl.appendChild(tip);
				}
			}),
		);
	}

	getViewType(): string {
		return READER_VIEW_TYPE;
	}

	/** 标题由当前路径派生（vault 相对与库外绝对路径两种形态 fsBasename 通吃） */
	getDisplayText(): string {
		return this.currentFilePath ? fsBasename(this.currentFilePath) : t("MarinMind 阅读器");
	}

	getIcon(): string {
		return "book-open";
	}

	/** 当前打开文档的路径（vault 相对或库外绝对；未加载为 null）——main.ts 状态判断用 */
	get filePath(): string | null {
		return this.currentFilePath;
	}

	/** 当前打开文档的 id（loadFromPath upsert 后设置）——main.ts 书签跨标签同步的匹配键（㊳） */
	get docId(): string | null {
		return this.currentDocId;
	}

	/**
	 * 库外路径改名跟随（㊳ fs watcher 经 plugin.applyExternalRename 分发）：
	 * 本视图正打开该路径时同步内存键；不重载内容（字节同源）。
	 */
	followExternalRename(oldPath: string, newPath: string): void {
		if (this.currentFilePath === oldPath) {
			this.currentFilePath = newPath;
			// 90 批：工具行行首文件名标题跟随（仅换文本节点，不动图标）
			this.readerTitleEl
				?.querySelector(".marinmind-reader-title-text")
				?.setText(fsBasename(newPath));
		}
	}

	/** 书签增删后刷新侧栏（侧栏未开 no-op）——经 plugin.refreshReaderBookmarks 跨标签分发（㊳） */
	refreshBookmarks(): void {
		if (this.tocPanel) {
			this.renderTocSections();
		}
	}

	async onOpen(): Promise<void> {
		// 103-D 文档级事件绑 contentEl.ownerDocument（popout 内可用；重复 onOpen
		// 幂等——bindDocEvents 先解后绑）。就绪标记先置（后续 setState 走就地加载
		// 分支）；数据层就绪检查在 loadFromPath 内
		registerActiveView(this); // 147 通用视图注册表（书签/改名广播目标）
		this.bindDocEvents();
		this.viewOpened = true;
		const pending = this.pendingFile;
		this.pendingFile = null;
		if (pending) {
			await this.openPath(pending);
			return;
		}
		// 无 pending（空 leaf）：保持空态，等待 setViewState/openInReader 携带 file。
		// 90 批原生标题行已隐藏，无标题可看——渲染最小空态提示防全白
		this.showTip("MarinMind 阅读器：等待打开文档");
	}

	/**
	 * 打开文档路径（vault 相对或库外绝对路径）。承接 FileView 时代 onLoadFile 的壳：
	 * 清场 → 取新代际 → 加载 → 尾部消费跳页 pending。
	 */
	private async openPath(filePath: string): Promise<void> {
		console.info("[MarinMind] openPath", filePath);
		// 80 阅读位置记忆：换文档前把在读书页码落库——必须先于 cleanupContent
		//（它清 scrollEl/currentDocId，之后无从采集）
		this.flushLastPage();
		// 顺序关键：cleanupContent 内部 ++loadToken 会作废在途流程——必须先清场再取新代，
		// 反之（先取 token 后清场）新流程会被自己的清场作废，表现为打开后静默空白
		this.cleanupContent();
		const token = ++this.loadToken;
		this.contentEl.empty();
		this.contentEl.classList.add("marinmind-reader");
		this.currentFilePath = filePath;
		try {
			await this.loadFromPath(filePath, token);
			// 加载完成后才消费跳页/跳卡 pending（旧流程在 setState 末尾应用，
			// 骨架未就绪时会被守卫丢弃——挪到加载尾部一并修掉该时序隐患）
			if (token === this.loadToken) {
				await this.applyPendingPage();
				// ㊳ 后台尺寸巡检（恢复定位之后启动——恢复先于巡检，
				// 巡检的布局修正由 anchorScroll 保持视口不动）
				void this.startSizePatrol();
			}
		} catch (err) {
			// 加载链路任何异常（读取/解析/装配）都可见化，杜绝"静默空白"难排查
			// ㊼ 起打开的不一定是 PDF（md/epub 同走本链路），文案改「文档」
			console.error("[MarinMind] 文档加载失败", err);
			if (token === this.loadToken) {
				this.showTip(`文档加载失败：${err instanceof Error ? err.message : String(err)}`);
			}
		}
	}

	/** openPath 主体（代际守卫沿用；异常由调用方统一捕获显示） */
	private async loadFromPath(filePath: string, token: number): Promise<void> {
		// 数据层就绪的等待刻意放在文档解析之后（见下方 upsertByPath 前）：
		// 字节读取 + getDocument 与全库 md 扫描本无依赖，启动后首次打开
		// （含工作区恢复标签）不再被 store 串行扫描阻塞——首开耗时 ≈ max 而非 sum。
		if (token !== this.loadToken) {
			return;
		}

		// ㊻-B/㊼ 文档分流（核心版）：md/epub/clip 无位图/无懒渲染/固定栏宽；
		// docKind 统一驱动后续全部分支（工具降级/目录/书签）。
		// 90 批：原头部按钮显隐（syncHeaderActions）随 addAction 迁移废除——
		// 手写按钮改为 buildToolRow 创建时就地按 isReflowDoc 判定（换文档必经重建）
		// 124 clip：数据根 clips/ 下的剪藏 md（vault 相对或 fs 绝对路径形态），
		// 单列 kind 走「数据根读取 + blob 图片」链路（clip-md.ts）
		const clipRel = this.plugin.clipRelPath(filePath);
		this.docKind = clipRel !== null ? "clip" : docKindOf(filePath);
		if (this.docKind === "md" && this.plugin.dataRootRelPath(filePath) !== null) {
			// 数据根防御：MarinMind/ 内 md 是插件笔记数据（选择器已排除，此处兜底
			// openInReader 直开等旁路入口）——双认领会撞书文件路径 + 事件双重路由
			//（clips/ 下 md 已在上面分流为 clip，不受本防御拦截）
			throw new Error("数据目录内的 md 是 MarinMind 笔记数据，不能作为文档打开");
		}

		// 读取内容：clip（数据根文本 + blob 图）/md（文本）/epub（zip 字节）/pdf（字节 → pdf.js）分流
		let title: string;
		if (this.docKind === "clip") {
			const buf = await this.plugin.dataLoc.adapter.readBinary(clipRel!);
			if (token !== this.loadToken) {
				return;
			}
			// 图片引用渲染前替换 blob：MarkdownRenderer 的相对解析对数据根内路径
			// 不可用（vault 场景错拼 clips/assets/；fs 场景无 vault 路径可解析）
			const localized = await localizeClipImageRefs(
				new TextDecoder().decode(buf),
				(ref) => this.plugin.attachments.read(ref),
				(bytes) => URL.createObjectURL(new Blob([bytes])),
			);
			if (token !== this.loadToken) {
				for (const url of localized.blobUrls) {
					URL.revokeObjectURL(url);
				}
				return;
			}
			this.clipBlobUrls.push(...localized.blobUrls);
			this.mdText = localized.text;
			title = fsBasename(filePath);
		} else if (this.docKind === "md") {
			const file = this.app.vault.getAbstractFileByPath(filePath);
			if (!(file instanceof TFile)) {
				throw new Error(`文件不在库中：${filePath}`);
			}
			this.mdText = await this.app.vault.cachedRead(file);
			title = file.basename;
		} else if (this.docKind === "epub") {
			const buf = await this.readDocBytes(filePath);
			if (token !== this.loadToken) {
				return;
			}
			const mobi = isMobiExt(docExtOf(filePath)); // ㊽ MOBI 家族走 parseMobi 虚拟 EPUB
			let book: EpubBook;
			try {
				book = mobi ? parseMobi(new Uint8Array(buf)) : parseEpub(new Uint8Array(buf));
			} catch (e) {
				throw new Error(
					`${mobi ? "MOBI" : "EPUB"} 解析失败：${e instanceof Error ? e.message : String(e)}`,
					{
						cause: e,
					},
				);
			}
			this.epub = book;
			this.epubSession = new EpubSession(book, (target, evt) =>
				this.handleEpubLink(target, evt),
			);
			title = book.title ?? fsBasename(filePath);
			this.outlineEntries = epubOutline(book);
		} else {
			// 读取并打开 PDF：库外绝对路径（桌面直读，㉞）与库内 vault 路径分流
			title = fsBasename(filePath);
			const buf = await this.readDocBytes(filePath);
			if (token !== this.loadToken) {
				return;
			}
			const handle = await acquirePdf(pdfCacheKey(filePath), buf);
			if (token !== this.loadToken) {
				handle.release();
				return;
			}
			this.pdf = handle.doc;
			this.pdfHandle = handle;
			// P2 目录懒解析：内嵌大纲（㉓）不再打开即取——大目录数千 worker 往返
			// 会与首屏渲染抢 pdf.js worker；改为首次打开目录侧栏时 ensureOutline 懒解析
			// （同 leaf 换文件且面板已开时在下方尾部触发）。
		}
		if (token !== this.loadToken) {
			return;
		}

		// 数据层就绪等待（会话恢复时视图可能先于数据层创建）：此刻文档已解析完毕，
		// 这里等的是文档登记/卡片回显所需的仓储。失败语义与旧版一致——提示后放弃加载
		//（不引入"PDF 可读但摘录功能半残"的中间态，建卡入口无判空守卫会崩）。
		await this.plugin.whenReady();
		if (!this.plugin.store) {
			this.showTip("MarinMind 数据层未就绪，无法加载摘录数据。");
			this.pdfHandle?.release();
			this.pdfHandle = null;
			this.pdf = null;
			return;
		}
		if (token !== this.loadToken) {
			return;
		}

		// 文档登记（以路径为业务键，重复打开复用记录；两种来源路径统一直通）
		const oldTitle = this.plugin.documents.getByPath(filePath)?.title;
		const doc = this.plugin.documents.upsertByPath(filePath, title);
		this.currentDocId = doc.id;
		// 80 阅读位置记忆：页码基准随文档登记初始化（与书文件存储值对齐，
		// 静读不产生写；回放由 openPath 尾部 applyPendingPage 消费）
		this.lastPersistedPage = doc.lastPage;
		// 摘录目标图就绪（㊴）：打开即建同名图 + 《书名》根节点（按书覆盖生效时
		// 不建同名图）；书名变化（重命名后重开）时图名/组卡文本跟随（手动改过的不动）
		this.plugin.ensureBookMindmapFor(doc.id);
		// 联动一对一同步（㊿）：联动意图下切文档/恢复布局后打开文档，脑图侧
		// 自动跟随本书目标图（含 splitMindmapPane 加载中未建成的补建）；fire-and-forget
		void this.plugin.syncLinkedMindmap();
		if (oldTitle && oldTitle !== doc.title) {
			this.plugin.followBookMindmapRename(doc.id, oldTitle, doc.title);
		}
		// ㊳ 库外文档：登记后同步 fs watcher 观察目录（新目录首次打开即挂上观察）
		if (isAbsoluteFsPath(filePath)) {
			this.plugin.externalWatcher?.sync();
		}

		// 滚动容器 + 各页骨架（先用第 1 页尺寸占位）
		if (this.docKind === "md" || this.docKind === "clip") {
			// ㊻-B md/clip 单页长文：栏宽 820 占位（渲染完成后高度由内容驱动），无真实页尺寸
			this.basePageWidth = MD_COLUMN_WIDTH;
			this.firstSize = { width: MD_COLUMN_WIDTH, height: MD_PLACEHOLDER_HEIGHT };
			this.totalPages = 1;
		} else if (this.docKind === "epub") {
			const book = this.epub!;
			// ㊼ epub 章=页模型：栏宽 820 与 md 一致；每章骨架高度由实测章高接管（见 ensureChapterRendered）
			this.basePageWidth = MD_COLUMN_WIDTH;
			this.firstSize = { width: MD_COLUMN_WIDTH, height: MD_PLACEHOLDER_HEIGHT };
			this.totalPages = book.spine.length;
		} else {
			const pdf = this.pdf;
			if (!pdf) {
				return; // 防御：PDF 分支必有句柄（上方 acquirePdf 失败早已 throw/return）
			}
			const first = await pdf.getPageSize(1);
			if (token !== this.loadToken) {
				return;
			}
			this.basePageWidth = first.width;
			this.firstSize = first;
			this.totalPages = pdf.numPages;
		}

		// 工具行：手型 + 四类摘录工具（单独一行，MarginNote 式；contentEl 每次
		// openPath 都会 empty，故随文档加载重建）
		this.buildToolRow();

		this.scrollEl = document.createElement("div");
		this.scrollEl.classList.add("marinmind-pdf-scroll");
		this.contentEl.appendChild(this.scrollEl);

		this.zoomMode = "fit";
		this.scale = this.computeFitScale();

		// 滚动监听：手写页滚离视口延迟提交（㉝ 目录联动高亮随 MkDocs 样式一并移除）
		this.registerDomEvent(this.scrollEl, "scroll", () => {
			if (this.handwriteMode) {
				this.commitOffscreenSoon();
			}
			// 75 划选工具栏滚动跟随：活 range 现算新位置（空矩形自动隐藏）
			this.selectionToolbar?.reposition();
			// 80 阅读位置记忆：滚动静止后采集页码（持续滚动只重置计时器不写库）
			this.scheduleLastPageFlush();
		});

		// 83 整页 OCR：PDF 页面右键 →「识别本页文字 (OCR)」（桌面专属——OCR 本就
		// 移动端禁用；命中页才拦截，页外放行浏览器默认菜单，与摘录右键互不干扰）
		if (this.docKind === "pdf" && !Platform.isMobile) {
			this.registerDomEvent(this.scrollEl, "contextmenu", (evt: MouseEvent) => {
				const pv = this.pageByPoint(evt.clientX, evt.clientY);
				if (!pv) {
					return;
				}
				evt.preventDefault();
				const menu = new Menu();
				menu.addItem((item) =>
					item
						.setTitle(t("识别本页文字 (OCR)"))
						.setIcon("scan-text")
						.onClick(() => void this.ocrPage(pv.pageNumber)),
				);
				menu.showAtMouseEvent(evt);
			});
		}

		// 回显已有卡片高亮（按页暂存；分块建页下由 buildPage 消费——晚建的页
		// 建好时才拿到自己的卡）；photo/audio 卡进页角徽标数据源。
		// 目录章节骨架卡不回显（62 md 框架带合成锚 rect——那是跳原文/归章数据，
		// 不是用户摘录；渲染成标题位置的细线高亮只会造成困扰）
		for (const card of this.plugin.cards.listByDocument(doc.id)) {
			if (card.page == null || card.outline) {
				continue;
			}
			const list = this.echoCardsByPage.get(card.page) ?? [];
			list.push(card);
			this.echoCardsByPage.set(card.page, list);
		}

		// ㊻-B/㊼ 分块建页：IO 实例先建（buildPage 内即时 observe）；同步只建首批骨架，
		// 其余分批异步补齐——首屏耗时与文档页数解耦
		this.setupLazyRender();
		this.buildNextPages(FIRST_SYNC_PAGES);
		this.scheduleRest();
		// ㊻-B md/124 clip：骨架建好后再渲染内容（MarkdownRenderer 异步分块，
		// loadToken 守卫丢弃换文档的过期渲染）+ 标题目录抽取
		if (this.docKind === "md" || this.docKind === "clip") {
			await this.renderMdIntoPage(token);
		} else if (this.docKind === "epub") {
			// ㊼ epub：大纲（epubOutline）已同步就绪，侧栏立刻刷新；章节走 IO 懒渲染
			if (this.tocPanel) {
				this.renderTocSections();
			}
		} else if (this.tocPanel) {
			// P2：同 leaf 换文件且侧栏已开（理论少见）——触发懒解析并立刻渲染；
			// 大纲未就绪先显示「正在解析目录…」，解析完成经 ensureOutline 回环重渲染
			this.ensureOutline();
			this.renderTocSections();
		}
		// ㊼ epub：单章懒渲染（IO 触发 ensureChapterRendered）；大纲已同步就绪（epubOutline）
		// 排障日志：走到这里 = 滚动容器与首批页骨架已建好（此后只差 canvas 懒渲染/章节懒渲染）
		console.info(
			`[MarinMind] 页面骨架启动（首批 ${this.builtPages}/${this.totalPages} 页，其余分批）`,
		);
	}

	/**
	 * 建第 n 页骨架（㊳ 分块建页的单元）：PageView/ExcerptLayer 两件套
	 * + 登记 + IO observe + 消费 echoCardsByPage 回显暂存
	 * （HandwriteLayer 惰性化不随建，见 ensureHandwriteLayer）。
	 */
	private buildPage(n: number): void {
		const scroll = this.scrollEl;
		const first = this.firstSize;
		if (!scroll || !first) {
			return;
		}
		const pv = new PageView(n, first);
		pv.layout(this.scale);
		scroll.appendChild(pv.el);
		const layer = new ExcerptLayer(pv, {
			onCreateAreaCard: (page, rect) => this.createAreaCard(page, rect),
			onCreateLassoCard: (page, polygon, bbox) => this.createLassoCard(page, polygon, bbox),
			onBlankPending: (point) => this.promptBlankNote(point),
			onCreateBlankCard: (page, anchor, note) => this.createBlankCard(page, anchor, note),
			onHighlightClick: (card, evt) => this.onHighlightClick(card, evt),
			onOcclusionDraw: (page, rect) => this.onOcclusionDraw(page, rect),
			onRelocateDraw: (page, rect) => this.onRelocateDraw(page, rect),
			onOcclusionClick: (card, index, evt) => this.onOcclusionClick(card, index, evt),
			// 101 留白胶囊拖动重摆：新锚点写库（cardBus changed → syncCard 整组重摆）
			onBlankMove: (cardId, rect) => {
				this.plugin.cards.update(cardId, { rects: [rect] });
			},
			readAttachment: (ref) => this.plugin.attachments.read(ref),
		});
		layer.setTool(this.activeTool);
		// ㊹ 晚建的页也拿到当前工具色（否则用默认黄画预览）
		if (isExcerptTool(this.activeTool)) {
			layer.setToolColor(this.plugin.settings.excerptColors[this.activeTool]);
		}
		this.excerptLayers.set(n, layer);
		// E3 手写层惰性化：不随骨架创建（每页省 canvas+ctx+4 监听+RO；epub/md 手写
		// 禁用照建是纯浪费，千页 PDF 常驻千层 canvas 也是内存大头）——改由
		// ensureHandwriteLayer 按需建（进手写模式/手写模式下页入预渲染区）
		this.pageByEl.set(pv.el, pv);
		this.pageViewByNumber.set(n, pv);
		this.io?.observe(pv.el);
		// 回显暂存消费：晚建的页在建好时拿到自己的卡（原整卷建完再回显的等价物）
		const echo = this.echoCardsByPage.get(n);
		if (echo) {
			this.echoCardsByPage.delete(n);
			layer.setCards(echo);
			const media = echo.filter(
				(c) => c.excerptType === "photo" || c.excerptType === "audio",
			);
			if (media.length > 0) {
				this.mediaCardsByPage.set(n, media);
				this.updateMediaBadge(n);
			}
			// 记录待回填快照的页：绝大多数页没有，backfill 位图就绪回调先查集合再决定
			// 是否走 listByDocument 全量查询（缩放/滚动重渲染每次都触发回调）
			if (echo.some((c) => this.needsRegionSnapshot(c))) {
				this.pagesNeedingBackfill.add(n);
			}
		}
	}

	/** 读取文档字节（pdf/epub 共用；md 走 cachedRead 不经过此处）——统一入口 */
	private async readDocBytes(filePath: string): Promise<ArrayBuffer> {
		if (isAbsoluteFsPath(filePath)) {
			return readExternalBinary(filePath);
		}
		const file = this.app.vault.getAbstractFileByPath(filePath);
		if (!(file instanceof TFile)) {
			throw new Error(`文件不在库中：${filePath}`);
		}
		return await this.app.vault.readBinary(file);
	}

	/**
	 * ㊻-B md 内容渲染：第 1 页骨架内挂内容容器（markdown-preview-view 排版）
	 * → MarkdownRenderer 异步渲染 → 标题目录抽取（page 恒 1 + anchor 锚点）。
	 * 高度由内容驱动（PageView md 态 layout 只定宽度）；侧栏已开就地刷新目录。
	 */
	private async renderMdIntoPage(token: number): Promise<void> {
		const pv = this.pageViewByNumber.get(1);
		const text = this.mdText;
		if (!pv || text == null || this.currentFilePath == null) {
			return;
		}
		// 124 clip：fs 数据根场景无 vault 路径作相对解析基准（图片已替换 blob，
		// 渲染不依赖 sourcePath；空串为 Obsidian 允许的「无源」形态）
		const sourcePath =
			this.docKind === "clip" && this.plugin.dataLoc.kind === "fs"
				? ""
				: this.currentFilePath;
		const content = document.createElement("div");
		content.className = "marinmind-md-doc markdown-preview-view";
		pv.setReflowContent(content, "md");
		pv.layout(this.scale);
		this.mdText = null; // 一次性消费（重开文档走 loadFromPath 重新读取）
		const doc = new MdDocument(this.app, sourcePath, this);
		await doc.renderInto(content, text);
		if (token !== this.loadToken) {
			return; // 换文档：旧 DOM 已随 contentEl.empty 移除，结果丢弃即可
		}
		this.outlineEntries = outlineFromDom(content);
		if (this.tocPanel) {
			this.renderTocSections();
		}
		// ㊽ md 回填点：md 无 IO、内容只渲染这一次，这里是唯一时机（失败只能重开文档重试）
		void this.backfillRegionSnapshots(pv);
	}

	/** 从 builtPages 起同步续建至多 count 页骨架（游标只前进） */
	private buildNextPages(count: number): void {
		const end = Math.min(this.totalPages, this.builtPages + count);
		for (let n = this.builtPages + 1; n <= end; n++) {
			this.buildPage(n);
			this.builtPages = n;
		}
	}

	/** 其余页骨架分批异步建（每批 SKELETON_BATCH_PAGES 页；loadToken 守卫换文档即停） */
	private scheduleRest(): void {
		const token = this.loadToken;
		const step = () => {
			if (token !== this.loadToken || !this.scrollEl) {
				return; // 已切换文档 / 关闭视图：停建（新建流程自带自己的 scheduleRest）
			}
			this.buildNextPages(SKELETON_BATCH_PAGES);
			if (this.builtPages < this.totalPages) {
				window.setTimeout(step, 0);
			}
		};
		if (this.builtPages < this.totalPages) {
			window.setTimeout(step, 0);
		}
	}

	/** 同步补齐骨架至第 n 页（跳页目标页必须有 DOM 才能定位；n 超总页数自然钳制） */
	private ensurePagesUpTo(n: number): void {
		if (n > this.builtPages) {
			this.buildNextPages(n - this.builtPages);
		}
	}

	/**
	 * 文件路径/页码/卡片经 setViewState state 传入（openInReader / 跳转原文 / 重启恢复）。
	 * ItemView 没有 FileView 的文件解析与"同文件不重载"机制：state.file 由本方法消费——
	 * setState 可能先于 onOpen（新标签/工作区恢复/deferred 标签）：暂存 pendingFile
	 * 由 onOpen 消费；视图已开时异文件重载、同文件只定位（历史导航恢复不得重置滚动）；
	 * state 无 page 时清空 pending。㊳ 增补 zoom/off：缩放与页内偏移随 state 暂存回放。
	 */
	async setState(
		state: {
			file?: string;
			page?: number;
			cardId?: string;
			zoom?: number;
			off?: number;
		} & Record<string, unknown>,
		result: ViewStateResult,
	): Promise<void> {
		this.pendingPage = typeof state.page === "number" ? state.page : null;
		this.pendingCardId = typeof state.cardId === "string" ? state.cardId : null;
		// ㊳ 缩放钳到边界（历史数据/手编 state 防御）；偏移负值无意义丢弃
		this.pendingZoom =
			typeof state.zoom === "number"
				? Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, state.zoom))
				: null;
		this.pendingOff = typeof state.off === "number" && state.off > 0 ? state.off : null;
		const file = typeof state.file === "string" ? state.file : null;
		await super.setState(state, result);
		if (!this.viewOpened) {
			this.pendingFile = file; // 由 onOpen 消费（骨架就绪后加载）
			return;
		}
		if (file && file !== this.currentFilePath) {
			await this.openPath(file); // 异文件：重载（openPath 尾部应用 pending）
			return;
		}
		await this.applyPendingPage(); // 同文件/无 file：只定位，不重载
	}

	/**
	 * 持久化文件路径、当前页码与阅读位置：工作区恢复 / 视图模式切换（detach 后重开）
	 * 都能回到原位。ItemView 化后 file 由本方法自管（不再依赖 FileView 内建）；
	 * 未加载完成时不写入（getCurrentPage 会兜底返回 1）。
	 * ㊳ zoom 仅 fixed 档写入（fit 档随窗格宽度变化，恢复到变窄的窗格会溢出裁切）；
	 * off = 当前页页顶距视口顶的距离（gBCR 差值；页中部重启/切回不再回弹到页顶）。
	 */
	getState(): Record<string, unknown> {
		const state: Record<string, unknown> = {};
		if (this.currentFilePath) {
			state.file = this.currentFilePath; // vault 相对或库外绝对路径
		}
		if ((this.pdf || this.isReflowDoc) && this.scrollEl) {
			const page = this.getCurrentPage();
			state.page = page;
			if (this.zoomMode === "fixed") {
				state.zoom = this.scale;
			}
			const pv = this.pageViewByNumber.get(page);
			if (pv) {
				const delta =
					pv.el.getBoundingClientRect().top - this.scrollEl.getBoundingClientRect().top;
				state.off = Math.max(0, Math.round(delta));
			}
		}
		return state;
	}

	/**
	 * 标签页「更多选项」/ 右键菜单：ItemView 没有 FileView 的内建文件菜单——
	 * vault 文件复刻默认行为（trigger file-menu 由核心补齐重命名/删除/显示于文件列表等）；
	 * 库外文档给「复制完整路径」；空态走基类。
	 */
	onPaneMenu(menu: Menu, source: string): void {
		const path = this.currentFilePath;
		if (path && isAbsoluteFsPath(path)) {
			menu.addItem((item) =>
				item
					.setTitle(t("复制完整路径"))
					.setIcon("copy")
					.onClick(async () => {
						await navigator.clipboard.writeText(path);
						new Notice("路径已复制");
					}),
			);
			return;
		}
		if (path) {
			const file = this.app.vault.getAbstractFileByPath(path);
			if (file instanceof TFile) {
				this.app.workspace.trigger("file-menu", menu, file, source);
				return;
			}
		}
		super.onPaneMenu(menu, source);
	}

	protected async onClose(): Promise<void> {
		unregisterActiveView(this); // 147 通用视图注册表
		this.unbindDocEvents(); // 文档级事件显式解绑（幂等）
		// 80 阅读位置记忆：关标签前落库当前页（先于 cleanupContent，理由同 openPath）
		this.flushLastPage();
		// 联动互关（㊿）：先于 cleanupContent 捕获路径（防御性——当前实现不清
		// currentFilePath，但清理顺序不应成为联动关闭的隐式依赖）
		const linkedFilePath = this.currentFilePath;
		for (const off of this.cardBusOffs) {
			off();
		}
		this.cardBusOffs = [];
		this.viewModeOff?.();
		this.viewModeOff = null;
		this.cleanupContent();
		this.contentEl.empty();
		// 关闭显示本书目标图的脑图标签（模式切换的 detach 由 suppress 拦截）
		this.plugin.linkedCloseMindmap(linkedFilePath);
	}

	// ---------- 卡片变更事件（跨标签同步，⑨-B） ----------

	/**
	 * 卡片创建/更新：本视图打开的文档才处理。
	 * photo/audio 走页角徽标数据；其余走摘录层——已登记只更新缓存
	 * （本标签写库的回环），未登记则回显（另一标签页新建的摘录）。
	 */
	private handleCardChanged(card: Card): void {
		if (card.documentId !== this.currentDocId || card.page == null) {
			return;
		}
		if (card.excerptType === "photo" || card.excerptType === "audio") {
			const list = this.mediaCardsByPage.get(card.page);
			const i = list?.findIndex((c) => c.id === card.id) ?? -1;
			if (list && i >= 0) {
				list[i] = card;
			} else {
				this.addMediaCard(card.page, card);
			}
			// 84-D photo 展示框：定位/取消定位（rects 变化）经摘录层重摆回显
			if (card.excerptType === "photo") {
				this.excerptLayers.get(card.page)?.syncCard(card);
			}
			return;
		}
		this.excerptLayers.get(card.page)?.syncCard(card);
		// 跨标签新建的无快照区域/套索卡：本标签页面渲染就绪后也要回填
		if (this.needsRegionSnapshot(card)) {
			this.pagesNeedingBackfill.add(card.page);
		}
	}

	/** 卡片删除：移除高亮与徽标数据（cleanup 后各 Map 已清空，天然 no-op） */
	private handleCardRemoved(_cardId: string, last: Card): void {
		if (last.documentId !== this.currentDocId || last.page == null) {
			return;
		}
		this.excerptLayers.get(last.page)?.removeHighlight(last.id);
		this.removeMediaCard(last);
	}

	onResize(): void {
		this.rerenderSoon();
	}

	// ---------- 内部实现 ----------

	/** 建立懒渲染：进入视口上方/下方各一屏的预渲染区才渲染，远离则卸载 canvas */
	private setupLazyRender(): void {
		const root = this.scrollEl;
		if (!root || this.docKind === "md") {
			return; // ㊻-B md 单页内容永不卸载（unrender 会剥掉渲染内容），无懒渲染需求
			// ㊼ epub 仍需 IO：getCurrentPage 快路径依赖 visiblePages + 章节懒渲染触发
		}
		const token = this.loadToken;
		const isEpub = this.docKind === "epub";
		this.io = new IntersectionObserver(
			(entries) => {
				for (const entry of entries) {
					// WeakMap 反查替代全量 find：整卷快速滚动时 IO 条目多，O(N²) 累计可感
					const pv = this.pageByEl.get(entry.target);
					if (!pv) {
						continue;
					}
					// 维护预渲染区页码集合：getCurrentPage 的小候选集（getState 高频调用）
					if (entry.isIntersecting) {
						this.visiblePages.add(pv.pageNumber);
						// E3 手写层惰性化：手写模式下页入预渲染区补建层（epub/md 内部守卫早退）
						if (this.handwriteMode) {
							this.ensureHandwriteLayer(pv.pageNumber);
						}
						// ㊼ epub：进入预渲染区即渲染章内容（离开不卸载——见 else 分支）
						if (isEpub) {
							this.ensureChapterRendered(pv.pageNumber);
							// ㊽ epub 回填点：章内容渲染完成后为本页无快照的区域/套索卡补图
							// （自带 pagesNeedingBackfill 预判早退；滚回重进 IO 重发=失败重试）
							void this.backfillRegionSnapshots(pv);
							continue;
						}
						// ㊳ 尺寸巡检/上次进入已取过真实尺寸：跳过 getPageSize 直接渲染
						if (pv.hasExactSize()) {
							const pdfNow = this.pdf;
							if (pdfNow) {
								pv.render(pdfNow, this.scale, () => this.onPageBitmapReady(pv));
							}
							continue;
						}
						void this.pdf
							?.getPageSize(pv.pageNumber)
							.then((size) => {
								if (token !== this.loadToken || !this.pdf) {
									return;
								}
								pv.setExactSize(size);
								pv.layout(this.scale);
								pv.render(this.pdf, this.scale, () => this.onPageBitmapReady(pv));
							})
							.catch(() => undefined);
					} else {
						this.visiblePages.delete(pv.pageNumber);
						// E3 手写层惰性销毁：滚出预渲染区的层提交笔迹后销毁——
						// 手写模式长滚不累积 canvas 内存（commit 同步快照后 destroy 安全，
						// 既有契约见 handwrite-layer 头注释）；视口内/邻近页不受影响
						const hw = this.handwriteLayers.get(pv.pageNumber);
						if (hw) {
							if (hw.hasInk()) {
								this.commitHandwrite(pv.pageNumber);
							}
							hw.destroy();
							this.handwriteLayers.delete(pv.pageNumber);
						}
						// ㊼ epub 章内容永不卸载（unrender 只卸位图，但重渲染净化 DOM 成本高
						// 且丢图片已加载状态——内存由 content-visibility:auto 折叠承担）
						if (!isEpub) {
							pv.unrender();
						}
					}
				}
			},
			{ root, rootMargin: "100% 0px", threshold: 0 },
		);
		// observe 不在此循环：㊳ 分块建页下逐页在 buildPage 内即时 observe
	}

	/**
	 * ㊼ epub：渲染第 n 章内容进页骨架（幂等；IO 进入预渲染区 / jumpToPage 深跳
	 * 调用）。渲染后同步实测章高内联锚定 contain-intrinsic-size——
	 * 离屏折叠占位即真实高度，滚动条稳定。
	 * E1 滚动补偿：渲染只改本页高度——本页整体位于视口上方（bottom ≤ 视口顶）
	 * 时增长/收缩会把视口内容顶走，按页 bottom 前后差值等量补 scrollTop 保持
	 * 视口内容不动；页跨视口顶或在其下时视口内容本就不动，不补偿。
	 * 与 DOM 变更同帧同步完成（IO 回调单任务内变更→布局读→scrollTop 赋值，
	 * 无中间帧闪烁）；不用 anchorScroll/getCurrentPage——IO 首批回调里
	 * visiblePages 可能只含正在渲染的章自身，锚点选错会漏补偿。
	 */
	private ensureChapterRendered(n: number): void {
		const session = this.epubSession;
		const pv = this.pageViewByNumber.get(n);
		if (!session || !pv || n < 1 || n > this.totalPages || session.isRendered(n - 1)) {
			return;
		}
		const scroll = this.scrollEl;
		const viewportTop = scroll ? scroll.getBoundingClientRect().top : null;
		const before = viewportTop != null ? pv.el.getBoundingClientRect().bottom : null;
		const host = document.createElement("div");
		pv.setReflowContent(host, "epub");
		session.renderChapterInto(n - 1, host);
		pv.setIntrinsicHeight(host.offsetHeight);
		pv.layout(this.scale);
		if (scroll && viewportTop != null && before != null && before <= viewportTop) {
			const delta = pv.el.getBoundingClientRect().bottom - before;
			if (delta !== 0) {
				scroll.scrollTop += delta;
			}
		}
	}

	/** 重建首屏位图信号（cleanupContent 每次清场调用——每份文档一份新信号） */
	private resetFirstBitmapSignal(): void {
		this.firstBitmapDone = new Promise<void>((resolve) => {
			this.firstBitmapResolve = resolve;
		});
	}

	/** 位图就绪回调：首张 resolve 巡检等待信号（once），并保留原有快照回填 */
	private onPageBitmapReady(pv: PageView): void {
		this.firstBitmapResolve?.();
		this.firstBitmapResolve = null;
		void this.backfillRegionSnapshots(pv);
	}

	/**
	 * 后台尺寸巡检（㊳ 混合页尺寸）：升序分批取真实页尺寸并 setExactSize+layout，
	 * 锚定当前页防滚动跳动。统一尺寸 PDF 校正后 layout 输出逐值不变（零视觉扰动）；
	 * 混合尺寸文档借此把远处页的占位高度换成真实值（滚动条/跳页不再大头偏差）。
	 * openPath 尾部调用（恢复定位之后）——恢复先于巡检，巡检修正由 anchorScroll 兜住。
	 * P1 巡检推迟：起跑前等首屏位图就绪（或 1.5s 兜底）——千页文档的 N 个
	 * getPageSize worker 消息不再与首屏渲染抢同一 pdf.js worker 的吞吐。
	 */
	private async startSizePatrol(): Promise<void> {
		const pdf = this.pdf;
		const token = this.loadToken;
		if (!pdf || this.totalPages <= 0) {
			return;
		}
		await Promise.race([
			this.firstBitmapDone,
			new Promise<void>((r) => window.setTimeout(r, 1500)),
		]);
		if (token !== this.loadToken) {
			return; // 等待期间换文档/关闭：停巡
		}
		for (let from = 1; from <= this.totalPages; from += PATROL_BATCH_PAGES) {
			if (token !== this.loadToken) {
				return; // 换文档/关闭：停巡
			}
			const nums: number[] = [];
			for (let n = from; n <= Math.min(this.totalPages, from + PATROL_BATCH_PAGES - 1); n++) {
				nums.push(n);
			}
			const sizes = await mapLimit(nums, PATROL_CONCURRENCY, async (n) => {
				try {
					return await pdf.getPageSize(n);
				} catch {
					return null; // 单页失败不阻塞整批（该页留给 IO 预渲染路径自取）
				}
			});
			if (token !== this.loadToken) {
				return;
			}
			this.anchorScroll(() => {
				sizes.forEach((size, i) => {
					if (!size) {
						return;
					}
					const pv = this.pageViewByNumber.get(nums[i]);
					if (pv && !pv.hasExactSize()) {
						pv.setExactSize(size);
						pv.layout(this.scale);
					}
				});
			});
			// 批间让出主线程（渲染/交互优先；巡检是后台增强）
			await new Promise<void>((r) => window.setTimeout(r, 0));
		}
	}

	/**
	 * 布局变更时保持当前页视口位置不动（㊳）：记录当前页容器应用前后的
	 * gBCR.top 差值，等量补偿 scrollTop——尺寸巡检校正与滚动偏移恢复的公共机制。
	 */
	private anchorScroll(mutate: () => void): void {
		const scroll = this.scrollEl;
		if (!scroll) {
			mutate();
			return;
		}
		const anchor = this.pageViewByNumber.get(this.getCurrentPage());
		const before = anchor?.el.getBoundingClientRect().top ?? null;
		mutate();
		if (!anchor || before === null) {
			return;
		}
		const delta = anchor.el.getBoundingClientRect().top - before;
		if (delta !== 0) {
			scroll.scrollTop += delta;
		}
	}

	/**
	 * 滚动定位到 pending 页（跳转原文入口；加载失败分支静默丢弃），再精确定位卡片。
	 * ㊳ 消费顺序硬约束：缩放先于跳页（页高随 scale 变化，先定缩放再定位才准）→
	 * 跳页 → cardId 精确定位优先（带矩形锚点的跳转比 off 更准）→ 页内偏移叠加。
	 */
	private async applyPendingPage(): Promise<void> {
		const page = this.pendingPage;
		const cardId = this.pendingCardId;
		const zoom = this.pendingZoom;
		const off = this.pendingOff;
		this.pendingPage = null;
		this.pendingCardId = null;
		this.pendingZoom = null;
		this.pendingOff = null;
		if (zoom != null && this.scrollEl) {
			this.setZoom(zoom);
		}
		if (page == null) {
			// 80 阅读位置记忆：无显式页码（主页/命令/管理面板打开）时回放本书
			// 上次阅读页。带 cardId 的跳转（openCardSource 流式卡 page=null）
			// 不回退 lastPage——维持原样直接返回（现状本就丢弃，定位意图由
			// 显式 page 路径的 locateCard 承担）。显式 page（工作区恢复/
			// ensureReaderPane/跳原文）不进本分支，优先级天然更高。
			if (cardId == null) {
				const lp =
					this.currentDocId != null
						? this.plugin.documents.get(this.currentDocId)?.lastPage
						: null;
				if (lp != null && this.scrollEl) {
					await this.jumpToPage(lp); // 越界页由内部守卫自然丢弃
					// 82：回放落点同步采集基准——占位尺寸 ±1 漂移不再回写，回放完全静默
					this.syncLastPageBaseline();
				}
			}
			return;
		}
		this.ensurePagesUpTo(page); // ㊳ 分块建页：目标页骨架可能尚未建，先同步补齐
		const pv = this.pageViewByNumber.get(page);
		const scroll = this.scrollEl;
		if (!pv || !scroll) {
			return;
		}
		await this.jumpToPage(page);
		if (cardId && this.scrollEl) {
			this.locateCard(cardId, pv, this.scrollEl); // 矩形锚点定位已精确到卡片，off 不再叠加
		} else if (off != null) {
			// 页内偏移恢复（scrollTop 超界由浏览器自然钳制）；目标页渲染交给 IO
			scroll.scrollTop += off;
		}
		// 82：显式定位（跳原文/工作区恢复/ensureReaderPane）的位移不算阅读进度——
		// 落点同步基准后 scroll-idle 回写读到同值零写，跳转落点（常为深处卡片页）
		// 不再覆盖真实阅读位置（此前跳原文 + 500ms idle 曾把深页写库，重开总回到
		// 最深处）；定位后的真实滚动与关闭兜底照常采集（在落点继续读则从落点续记）
		this.syncLastPageBaseline();
	}

	/** 80 阅读位置记忆：重置 scroll-idle 计时器（持续滚动只重置不采集） */
	private scheduleLastPageFlush(): void {
		if (this.lastPageTimer != null) {
			window.clearTimeout(this.lastPageTimer);
		}
		this.lastPageTimer = window.setTimeout(() => {
			this.lastPageTimer = null;
			this.flushLastPage();
		}, LAST_PAGE_FLUSH_MS);
	}

	/**
	 * 80 阅读位置记忆采集：当前页码写库。页 1 归一 null（未翻页不落行，md 恒
	 * 1 页天然永不写）；与 lastPersistedPage 基准相同零写（静读不落盘）。docId
	 * 开头同步捕获防中途换文档写串门；lastPage-only 更新不动 updatedAt（不打乱
	 * 主页「最近」排序），store 2s 防抖 + 字节比对兜住写放大。openPath/onClose
	 * 在 cleanupContent 之前兜底直调（换文档/关标签时最后位置不丢）。
	 */
	private flushLastPage(): void {
		const docId = this.currentDocId; // 同步捕获：防计时器跨文档触发写串门
		if (!docId || !this.scrollEl || (!this.pdf && !this.isReflowDoc)) {
			return;
		}
		const page = this.getCurrentPage();
		const normalized = page > 1 ? page : null;
		if (normalized === this.lastPersistedPage) {
			return;
		}
		this.plugin.documents.update(docId, { lastPage: normalized });
		this.lastPersistedPage = normalized;
	}

	/**
	 * 82 阅读位置记忆基准同步：把采集基准对齐到当前视口页（与 flushLastPage
	 * 同款归一读取）。用于程序化定位（lastPage 回放/跳原文/工作区恢复）之后——
	 * 定位造成的位移不算阅读进度，基准同步后 scroll-idle 与关闭兜底回写读到
	 * 同值零写，跳转落点不覆盖 lastPage（修复「重开总回到读过的最深处」：
	 * 跳原文深处卡片页 + 500ms scroll-idle / 关闭兜底曾把深页写库）。
	 * 定位后的真实滚动照常采集——在落点继续阅读则从落点续记。
	 */
	private syncLastPageBaseline(): void {
		const page = this.getCurrentPage();
		this.lastPersistedPage = page > 1 ? page : null;
	}

	/**
	 * 滚动到指定页（目录/书签跳转与 pending 页定位共用，㉓ 抽出）：
	 * 目标页可能仍是第 1 页占位尺寸——先校正再滚，消除大头偏差；
	 * getBoundingClientRect 差值定位（offsetTop 的 offsetParent 链不含 scrollEl，不可靠）。
	 * ㊼ fragment：epub 章内锚点 id（目录精定位）——章渲染后 querySelector 解析，
	 * 找不到停在章顶（宁拒不赌）。
	 */
	private async jumpToPage(page: number, fragment?: string | null): Promise<void> {
		this.ensurePagesUpTo(page); // ㊳ 分块建页：跳页目标先保证骨架存在
		const pv = this.pageViewByNumber.get(page);
		const pdf = this.pdf;
		const scroll = this.scrollEl;
		if (!pv || !scroll || (!pdf && !this.isReflowDoc)) {
			return; // ㊻-B md/㊼ epub 无 pdf 句柄但允许跳页（仅滚动定位）
		}
		const token = this.loadToken;
		if (pdf) {
			try {
				pv.setExactSize(await pdf.getPageSize(page));
			} catch {
				return; // 文档已销毁 / 页码越界：丢弃
			}
			if (token !== this.loadToken) {
				return;
			}
		}
		// ㊼ epub 深跳（E1 去全前缀）：只同步渲染目标章——恢复到第 N 章不再渲染
		// 1..N 全部前置章（定位/fragment 查询/实测章高都只依赖目标章在场）；
		// 前置/后置章由 IO 预渲染区渐进补齐，渲染引发的上方高度变化由
		// ensureChapterRendered 内建的滚动补偿保持视口内容稳定
		if (this.docKind === "epub") {
			this.ensureChapterRendered(page);
		}
		pv.layout(this.scale);
		const rootTop = scroll.getBoundingClientRect().top;
		// ㊼ epub 章内锚点：命中则精滚到锚点（gBCR 差值），找不到停在章顶
		if (this.docKind === "epub" && fragment) {
			const anchor = pv.el.querySelector(`[id="${CSS.escape(fragment)}"]`);
			if (anchor) {
				scroll.scrollTop += anchor.getBoundingClientRect().top - rootTop - 12;
				return;
			}
		}
		const pageTop = pv.el.getBoundingClientRect().top;
		scroll.scrollTop += pageTop - rootTop - 12; // 12px 顶部留白（对应容器 padding）
	}

	/** ㊼ epub 章内链接三分类消费（EpubSession host 级点击委托回调） */
	private handleEpubLink(target: EpubLinkTarget, evt: MouseEvent): void {
		void evt;
		if (target.kind === "spine") {
			void this.jumpToPage(target.spineIndex + 1, target.fragment);
			return;
		}
		if (target.kind === "external") {
			window.open(target.url, "_blank");
			return;
		}
		new Notice("链接目标不在书中章节内，暂不支持打开");
	}

	/**
	 * 精确定位卡片：滚动到矩形上方约 1/4 视口处并闪烁高亮。
	 * photo/audio 卡（无矩形）降级为闪烁页角徽标；卡片不属于当前文档时只滚到页。
	 */
	private locateCard(cardId: string, pv: PageView, scroll: HTMLElement): void {
		const card = this.plugin.cards.get(cardId);
		if (!card || card.documentId !== this.currentDocId) {
			return;
		}
		const anchor = jumpAnchorY(card.rects);
		if (anchor == null) {
			// 无矩形（照片/语音卡）：闪页角徽标作为视觉锚点
			if (card.page != null) {
				this.flashMediaBadge(card.page);
			}
			return;
		}
		// 锚点 = 页内归一化 y × 页高（layout 后的实测高度），目标让它落在视口上部约 1/4 处
		const anchorPx = pv.el.clientHeight * anchor;
		const current = pv.el.getBoundingClientRect().top - scroll.getBoundingClientRect().top;
		const target = Math.max(0, anchorPx - scroll.clientHeight * 0.25);
		scroll.scrollTop += current + target;
		this.excerptLayers.get(pv.pageNumber)?.flashHighlights(cardId);
	}

	/** 页角媒体徽标闪烁（photo/audio 卡跳转降级锚点） */
	private flashMediaBadge(page: number): void {
		const badge = this.mediaBadges.get(page);
		if (!badge) {
			return;
		}
		flashEl(badge);
	}

	/** fit 模式的目标缩放（容器宽度不可用时保持当前值，等 onResize 再算） */
	private computeFitScale(): number {
		const cw = this.scrollEl?.clientWidth ?? 0;
		if (!cw || !this.basePageWidth) {
			return this.scale || 1;
		}
		const fit = Math.max(MIN_ZOOM, (cw - SCROLL_PADDING_X) / this.basePageWidth);
		// ㊻-B md 文档：栏宽只收不放（窄窗格收缩防裁切，宽窗格不再放大——
		// 文本排版 820px 列宽即最优，放大会拉长行宽伤可读性）
		return this.isReflowDoc ? Math.min(1, fit) : fit;
	}

	private fitWidth(): void {
		this.zoomMode = "fit";
		this.applyScale(this.computeFitScale());
	}

	private setZoom(scale: number): void {
		this.zoomMode = "fixed";
		this.applyScale(Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, scale)));
	}

	private applyScale(scale: number): void {
		this.scale = scale;
		// ㊳ 分块建页：未建的页在 buildPage 内按 this.scale 布局，此处只管已建的
		for (const pv of this.pageViewByNumber.values()) {
			pv.layout(scale);
		}
		// IO 不会对"已可见"的页重触发，手动重渲染当前已渲染的页
		const pdf = this.pdf;
		if (pdf) {
			for (const pv of this.pageViewByNumber.values()) {
				if (pv.isRendered()) {
					pv.render(pdf, scale, () => void this.backfillRegionSnapshots(pv));
				}
			}
		}
	}

	private handleResize(): void {
		if (this.zoomMode === "fit") {
			this.applyScale(this.computeFitScale());
		}
	}

	/**
	 * 构建工具行（89 MN3 式精简；90 批起为唯一顶栏）：文件名标题 + 单行 icon-only
	 * ——目录 + 四类摘录工具 + 手写（PDF 专属）+ 复习 + 视图循环钮 + ⋯。图标即按钮
	 * （title/aria-label 悬停提示与读屏兜底，图标名均已对照 obsidian.asar 注册表
	 * 验证或走 setIconSafe 兜底链，见 TOOLBAR_TOOLS 注释）；手型/选择/AI 摘录/缩放/
	 * 插入图片·录音/脑图目标/闪卡折叠进 ⋯ 溢出菜单（openToolOverflowMenu，
	 * 图标+文字+状态勾选）。分隔线分语义组（标题 / 导航 / 摘录 / 复习）。
	 */
	private buildToolRow(): void {
		this.toolBtns.clear();
		// onLoadFile 每次 empty 后重建工具行：先退订上一条切换条的监听防泄漏
		this.viewModeOff?.();
		this.viewModeOff = null;
		const row = document.createElement("div");
		row.className = "marinmind-tool-row";
		// 90 批文件名标题：原生标题行隐藏后行首展示（book-open 小图标 + 文件名）
		const title = row.createEl("span", { cls: "marinmind-reader-title" });
		setIcon(title, "book-open");
		title.createEl("span", {
			cls: "marinmind-reader-title-text",
			text: this.getDisplayText(),
		});
		this.readerTitleEl = title;
		row.createEl("div", { cls: "marinmind-tool-sep" });
		// 目录/书签侧栏开关（㉓）：导航类，独立于摘录工具组
		this.tocBtn = row.createEl("button", {
			cls: "marinmind-tool-btn",
			attr: {
				type: "button",
				"aria-label": t("目录与书签"),
				title: t("目录与书签"),
			},
		});
		setIcon(this.tocBtn, "list");
		this.tocBtn.addEventListener("click", () => this.toggleToc());
		row.createEl("div", { cls: "marinmind-tool-sep" });
		// 四类摘录工具（89 起行内只留摘录组；手型/选择进 ⋯ 菜单）
		for (const def of TOOLBAR_TOOLS) {
			if (!isExcerptTool(def.tool)) {
				continue;
			}
			const btn = row.createEl("button", {
				cls: "marinmind-tool-btn",
				attr: { type: "button", "aria-label": def.hint, title: def.hint },
			});
			setIcon(btn, def.icon);
			// ㊹ 四类摘录工具加色点（显示当前色系）+ 点击已激活的工具 = 循环切色（MN3 式）
			btn.createEl("span", { cls: "marinmind-tool-color-dot" });
			btn.classList.toggle("is-active", def.tool === this.activeTool);
			btn.addEventListener("click", () => {
				if (def.tool === this.activeTool && isExcerptTool(def.tool)) {
					this.cycleExcerptColor(def.tool);
					return;
				}
				this.setReaderTool(def.tool);
			});
			this.toolBtns.set(def.tool, btn);
			this.syncToolColorUI(def.tool);
		}
		// 90 批手写批注迁入工具行（原头部 addAction）：PDF 专属——md/epub 无手写层，
		// 按钮连前置逻辑都不建（is-active 由 setHandwriteMode 2669 行同步；换文档
		// 重建工具行时按当前 handwriteMode 现值恢复点亮）
		if (!this.isReflowDoc) {
			this.handwriteBtn = row.createEl("button", {
				cls: "marinmind-tool-btn",
				attr: {
					type: "button",
					"aria-label": t("手写批注模式"),
					title: t("手写批注模式"),
				},
			});
			setIconSafe(this.handwriteBtn, "pencil", "pencil-line");
			this.handwriteBtn.classList.toggle("is-active", this.handwriteMode);
			this.handwriteBtn.addEventListener("click", () => {
				this.setHandwriteMode(!this.handwriteMode);
			});
		} else {
			this.handwriteBtn = null;
		}
		// 89 AI 摘录 / 摘录目标脑图（㊴）/ 自动转闪卡（㊷）折叠进 ⋯ 菜单——
		// 菜单项每次打开现读状态（目标图名/开关勾选），无需行内按钮同步
		row.createEl("div", { cls: "marinmind-tool-sep" });
		// 复习入口（㉑，MN4 学习集「复习」按钮）：打开/复用复习窗格并开始到期会话
		const reviewBtn = row.createEl("button", {
			cls: "marinmind-tool-btn",
			attr: {
				type: "button",
				"aria-label": t("复习本书到期闪卡"),
				title: t("复习本书到期闪卡（进入后可切全部书籍）"),
			},
		});
		// 90 批 MN3 对照：复习=学习语义 graduation-cap（原 swords 像对战；与脑图
		// header/节点编辑器/主页入口四处对齐，语义沿革见评估报告 E-19 与 P2-1 表）
		setIcon(reviewBtn, "graduation-cap");
		// ㊷ 阅读器入口默认只复习当前书（复习界面徽标可切全部书籍）
		reviewBtn.addEventListener(
			"click",
			() => void this.plugin.openReview(this.docId ?? undefined),
		);
		// 文档内搜索（89-D，MN3 搜索一级入口）：当前文档全文检索，点击结果跳页定位
		const searchBtn = row.createEl("button", {
			cls: "marinmind-tool-btn",
			attr: {
				type: "button",
				"aria-label": t("搜索文档"),
				title: t("搜索文档（全文检索，点击结果跳转定位）"),
			},
		});
		setIcon(searchBtn, "search");
		searchBtn.addEventListener("click", () => this.openDocSearch());
		// 三态视图模式切换条 [文档|脑图|联动] 靠右（MarginNote 学习集同款）
		row.createEl("div", { cls: "marinmind-tool-spacer" });
		const modeBar = createViewModeBar(this.plugin);
		this.viewModeOff = modeBar.off;
		row.appendChild(modeBar.el);
		// ⋯ 溢出菜单（89）：低频工具折叠收纳，菜单项每次打开现读状态
		this.overflowBtn = row.createEl("button", {
			cls: "marinmind-tool-btn",
			attr: {
				type: "button",
				"aria-label": t("更多工具"),
				title: t(
					"更多工具（手型 / 选择 / 插入图片·录音 / AI 摘录 / 缩放 / 摘录目标脑图 / 自动转闪卡）",
				),
			},
		});
		setIcon(this.overflowBtn, "more-horizontal");
		this.overflowBtn.addEventListener("click", (evt) => this.openToolOverflowMenu(evt));
		this.syncOverflowActive();
		this.contentEl.appendChild(row);
	}

	/**
	 * ⋯ 溢出菜单（89；90 批新增「插入」组）：手型/选择（勾选反映当前工具）、
	 * 插入图片·录音摘录（原头部 addAction 迁入，勾选反映录音中）、AI 摘录与缩放
	 * （PDF 专属）、摘录目标脑图（title 带当前目标图名，开二段菜单）、自动转闪卡
	 * （勾选态）。Menu 即开即建，状态每次打开现读，无需持久同步。
	 */
	private openToolOverflowMenu(evt: MouseEvent): void {
		const menu = new Menu();
		// 工具组：手型/选择（行内只留摘录组后的浏览/复制工具归置地）
		for (const def of TOOLBAR_TOOLS) {
			if (isExcerptTool(def.tool)) {
				continue;
			}
			menu.addItem((mi) =>
				mi
					.setTitle(def.title)
					.setIcon(def.icon)
					.setChecked(def.tool === this.activeTool)
					.onClick(() => this.setReaderTool(def.tool)),
			);
		}
		// 90 批插入组：图片/录音摘录（原头部 addAction 迁入；录音勾选态现读）
		menu.addSeparator();
		menu.addItem((mi) =>
			mi
				.setTitle(t("插入图片摘录…"))
				.setIcon("image-plus")
				.onClick(() => this.pickImages()),
		);
		menu.addItem((mi) =>
			mi
				.setTitle(this.isRecording ? "结束录音" : "录音摘录")
				.setIcon("mic")
				.setChecked(this.isRecording)
				.onClick(() => void this.toggleRecording()),
		);
		// AI 一键摘录（㉓）与缩放：PDF 专属（㊻-B md/epub 无版面几何/固定栏宽）
		if (!this.isReflowDoc) {
			menu.addSeparator();
			menu.addItem((mi) =>
				mi
					.setTitle(t("AI 摘录"))
					.setIcon("wand-2")
					.onClick(() => this.openAutoExcerpt()),
			);
			menu.addItem((mi) =>
				mi
					.setTitle(t("缩放…"))
					.setIcon("zoom-in")
					.onClick(() => this.showZoomMenu(evt)),
			);
		}
		// 摘录目标脑图（㊴）+ 自动转闪卡开关（㊷）：仅在文档就绪时提供
		const docId = this.currentDocId;
		const doc =
			docId != null && this.plugin.store ? this.plugin.documents.get(docId) : undefined;
		if (doc) {
			menu.addSeparator();
			const target = collectTargetOf(this.collectHost(), doc.id);
			const nameBrief =
				target && target.map.name.length > 12
					? `${target.map.name.slice(0, 12)}…`
					: (target?.map.name ?? "");
			const where = target
				? `${target.overridden ? "" : "同名（默认）"}《${nameBrief}》`
				: "同名脑图（默认）";
			menu.addItem((mi) =>
				mi
					.setTitle(`摘录目标脑图：${where}`)
					.setIcon(ADD_TO_MINDMAP_ICON)
					.onClick(() => this.openMapTargetMenu(evt)),
			);
			menu.addItem((mi) =>
				mi
					.setTitle(t("自动转闪卡"))
					.setIcon("zap")
					.setChecked(doc.autoFlashcard)
					.onClick(() => this.toggleAutoFlashcard()),
			);
		}
		// AI 组（98）：文档级 AI——助手面板（右停靠，三形态通用）与摘要（留白卡）。
		// 守卫与文档搜索同口径（docSearchKind 非空 = 骨架就绪有可提取文本）
		if (this.docSearchKind() != null) {
			menu.addSeparator();
			menu.addItem((mi) =>
				mi
					.setTitle(t("AI 助手…"))
					.setIcon("sparkles")
					.onClick(() => {
						void this.plugin.openAiChat();
					}),
			);
			menu.addItem((mi) =>
				mi
					.setTitle(t("AI 摘要…"))
					.setIcon("scroll-text")
					.onClick(() => {
						new AiSummaryModal(this.app, this.plugin, this).open();
					}),
			);
			// 100 AI 大纲建框架：全文 → LLM 层级大纲 → 建入摘录目标图（归章语义同目录建框架）
			menu.addItem((mi) =>
				mi
					.setTitle(t("AI 大纲建框架…"))
					.setIcon("list-tree")
					.onClick(() => {
						new AiOutlineModal(this.app, this.plugin, this).open();
					}),
			);
		}
		menu.showAtMouseEvent(evt);
	}

	/** 缩放二段菜单（89：原头部 放大/缩小/适应宽度 三枚并入；104-A 加预设档与
	 * 精确输入）：百分比信息项 + 快捷预设 + 输入比例… + 三档操作 */
	private showZoomMenu(evt: MouseEvent): void {
		const menu = new Menu();
		menu.addItem((mi) =>
			mi
				.setTitle(`当前 ${Math.round(this.scale * 100)}%`)
				.setIcon("info")
				.setDisabled(true),
		);
		menu.addSeparator();
		// 快捷预设档：一次点击直达（勾选态现读，0.005 容差防 1.5×÷1.25 浮点误差）
		for (const preset of ZOOM_PRESETS) {
			menu.addItem((mi) =>
				mi
					.setTitle(`${Math.round(preset * 100)}%`)
					.setChecked(Math.abs(this.scale - preset) < 0.005)
					.onClick(() => this.setZoom(preset)),
			);
		}
		menu.addItem((mi) =>
			mi
				.setTitle(t("输入缩放比例…"))
				.setIcon(resolveIcon(["text-cursor-input", "pencil"]))
				.onClick(() => this.promptZoomInput()),
		);
		menu.addSeparator();
		menu.addItem((mi) =>
			mi
				.setTitle(t("放大"))
				.setIcon("zoom-in")
				.onClick(() => this.setZoom(this.scale * ZOOM_STEP)),
		);
		menu.addItem((mi) =>
			mi
				.setTitle(t("缩小"))
				.setIcon("zoom-out")
				.onClick(() => this.setZoom(this.scale / ZOOM_STEP)),
		);
		menu.addItem((mi) =>
			mi
				.setTitle(t("适应宽度"))
				.setIcon("stretch-horizontal")
				.onClick(() => this.fitWidth()),
		);
		menu.showAtMouseEvent(evt);
	}

	/**
	 * 精确缩放输入（104-A）：弹小窗输入百分比（20-500，支持 "150" / "150%" /
	 * 全角 ％），回车或保存应用；越界钳到边界并 Notice 告知实际值。
	 * 钳制双保险：此处提示 + setZoom 内统一钳制。
	 */
	private promptZoomInput(): void {
		new TextPromptModal(
			this.app,
			{
				title: t("缩放比例"),
				placeholder: t("输入百分比（20-500，如 150 或 150%）"),
				initialText: String(Math.round(this.scale * 100)),
				multiline: false,
				enterSubmit: true,
			},
			(text) => {
				// TextPromptModal trim 后空串转 null——空输入视作取消不提示
				if (text == null) {
					return;
				}
				const value = parseZoomInput(text);
				if (value == null) {
					new Notice("请输入 20-500 之间的比例值（如 150 或 150%）");
					return;
				}
				const pct = value * 100;
				if (pct < MIN_ZOOM * 100 || pct > MAX_ZOOM * 100) {
					const clamped = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, value));
					new Notice(`已超出 20%-500% 范围，应用为 ${Math.round(clamped * 100)}%`);
					this.setZoom(clamped);
					return;
				}
				this.setZoom(value);
			},
		).open();
	}

	/** ⋯ 按钮点亮同步（89）：当前工具折叠在菜单里（hand/select）时点亮，提示非默认态 */
	private syncOverflowActive(): void {
		this.overflowBtn?.classList.toggle(
			"is-active",
			this.activeTool === "hand" || this.activeTool === "select",
		);
	}

	// ---------- 文档内搜索（89-D） ----------

	/** 打开文档内搜索（MN3 搜索一级入口对齐）：未加载文档时 Notice 兜底 */
	private openDocSearch(): void {
		if (this.docSearchKind() == null) {
			new Notice("当前没有打开的文档");
			return;
		}
		new DocSearchModal(this.app, this).open();
	}

	docSearchKind(): "pdf" | "epub" | "md" | "clip" | null {
		// 滚动容器在 = 文档骨架已就绪（cleanupContent 后 docKind 复位且 scrollEl 清空）；
		// 124 clip 与 md 同走 DOM 文本搜索（doc-search-modal 的兜底分支）
		return this.scrollEl ? this.docKind : null;
	}

	docSearchPdfPageCount(): number {
		return this.pdf?.numPages ?? this.totalPages;
	}

	docSearchPdfLines(page: number): Promise<readonly PdfSearchLine[] | null> {
		const pdf = this.pdf;
		if (!pdf) {
			return Promise.resolve(null);
		}
		// buildTextLayer(page, 1) 顺带预热 spec 缓存（P5）；聚行结果缓存供 reveal 定位
		return pdf
			.buildTextLayer(page, 1)
			.then((specs) => {
				const lines = pdfLinesFromSpecs(specs);
				this.pdfSearchLines.set(page, lines);
				return lines;
			})
			.catch(() => null); // 页损坏/worker 已断：跳过该页不阻塞扫描
	}

	docSearchEpubChapterCount(): number {
		return this.epub?.spine.length ?? 0;
	}

	docSearchEpubBlocks(chapter: number): string[] {
		const book = this.epub;
		const item = book?.spine[chapter - 1];
		if (!book || !item) {
			return [];
		}
		// 源解析而非渲染后 DOM——未渲染章也能搜（text/html 容错解析仅取文本，
		// 不需要 EpubSession 的 XHTML 两级解析精度）
		const text = entryText(book, item.href);
		if (text == null) {
			return [];
		}
		const body = new DOMParser().parseFromString(text, "text/html").body;
		return collectBlockEls(body).map((el) => el.textContent ?? "");
	}

	docSearchMdBlocks(): string[] {
		// ㊻-B md：源文本渲染后即弃，唯一可搜形态是活 DOM
		const pv = this.pageViewByNumber.get(1);
		return pv ? collectBlockEls(pv.el).map((el) => el.textContent ?? "") : [];
	}

	docSearchHitLabel(hit: DocSearchHit): string {
		if (this.docKind === "epub") {
			return `第 ${hit.page} 章`;
		}
		if (this.docKind === "md") {
			return `第 ${hit.lineIndex + 1} 段`;
		}
		return `第 ${hit.page} 页`;
	}

	docSearchReveal(hit: DocSearchHit, query: string): void {
		if (this.docKind === "pdf") {
			void this.revealPdfHit(hit);
		} else {
			void this.revealReflowHit(hit, query);
		}
		this.syncLastPageBaseline(); // 82：定位位移不算阅读进度
	}

	/**
	 * 页级跳转（98 AI 助手页引用 chip）：pdf 跳页 / epub 跳章（内含章骨架
	 * 渲染）；md 单页无动作。公开给 ai-chat-view（点击时刻现找阅读器调用）。
	 */
	async revealPage(page: number): Promise<void> {
		if (!this.scrollEl || this.docKind === "md") {
			return;
		}
		await this.jumpToPage(page);
		this.syncLastPageBaseline(); // 82：定位位移不算阅读进度
	}

	/**
	 * PDF 命中定位：jumpToPage 骨架/尺寸就绪 → 滚到行（落视口上部约 1/4，
	 * 与 locateCard 同款数学）→ 页容器叠 absolute 闪烁框（不动 DOM 文本锚点）。
	 */
	private async revealPdfHit(hit: DocSearchHit): Promise<void> {
		await this.jumpToPage(hit.page);
		const pv = this.pageViewByNumber.get(hit.page);
		const scroll = this.scrollEl;
		if (!pv || !scroll) {
			return;
		}
		const line = this.pdfSearchLines.get(hit.page)?.[hit.lineIndex];
		if (!line) {
			return; // 缓存被清（防御）：已跳到目标页，不再精定位
		}
		// 混合页尺寸（㉳）：spec@1 的坐标按本页有效缩放换算（镜像 PageView.render 的 eff）
		const eff = (this.basePageWidth * this.scale) / pv.baseSize.width;
		const pvTop = pv.el.getBoundingClientRect().top - scroll.getBoundingClientRect().top;
		scroll.scrollTop += pvTop + Math.max(0, line.top * eff - scroll.clientHeight * 0.25);
		const box = pv.el.createEl("div", { cls: "marinmind-search-flash" });
		box.setCssStyles({ left: `${Math.max(0, line.left * eff - 4)}px` });
		box.setCssStyles({ top: `${Math.max(0, line.top * eff - 2)}px` });
		box.setCssStyles({ height: `${Math.max(12, line.fontSize * eff * 1.3)}px` });
		box.setCssStyles({ width: `${Math.max(120, pv.el.clientWidth - line.left * eff)}px` });
		window.setTimeout(() => box.remove(), 1600);
	}

	/**
	 * 可重排文档（md/epub）命中定位：epub 先 jumpToPage 保证章骨架与渲染，
	 * 再按块序取元素（epub 源解析序 vs 渲染序有偏差风险，文本兜底复扫），
	 * scrollIntoView 居中 + 复用 flashEl 闪烁。
	 */
	private async revealReflowHit(hit: DocSearchHit, query: string): Promise<void> {
		if (this.docKind === "epub") {
			await this.jumpToPage(hit.page); // 内含 ensureChapterRendered
		}
		const pv = this.pageViewByNumber.get(hit.page);
		if (!pv) {
			return;
		}
		const blocks = collectBlockEls(pv.el);
		const byIndex = blocks[hit.lineIndex];
		const q = query.toLowerCase();
		const el =
			byIndex && (byIndex.textContent ?? "").toLowerCase().includes(q)
				? byIndex
				: (blocks.find((b) => (b.textContent ?? "").toLowerCase().includes(q)) ?? null);
		if (!el) {
			return; // 章已跳转（兜底效果），元素找不到（净化丢块等边缘）不再闪
		}
		el.scrollIntoView({ block: "center" });
		flashEl(el);
	}

	// ---------- 摘录目标脑图（㊴） ----------

	/**
	 * 摘录目标解析用的宿主三件套（plugin 即 AutoCollectHost 的结构子集，
	 * 这里收窄传入避免视图直接依赖插件全量类型）
	 */
	private collectHost() {
		return {
			documents: this.plugin.documents,
			cards: this.plugin.cards,
			mindmaps: this.plugin.mindmaps,
		};
	}

	// ---------- 自动转闪卡（㊷） ----------

	/** 切换本书自动转闪卡开关（写书文件 frontmatter，重启保持） */
	private toggleAutoFlashcard(): void {
		const docId = this.currentDocId;
		if (!docId || !this.plugin.store) {
			return;
		}
		const doc = this.plugin.documents.get(docId);
		if (!doc) {
			return;
		}
		const next = !doc.autoFlashcard;
		this.plugin.documents.update(docId, { autoFlashcard: next });
		new Notice(next ? "本书新摘录将自动转为闪卡" : "本书新摘录不再自动转为闪卡");
	}

	/** 摘录目标脑图菜单：当前目标 + 切回默认 + 选择其他图（每本书独立记住） */
	private openMapTargetMenu(evt: MouseEvent): void {
		const docId = this.currentDocId;
		const doc =
			docId != null && this.plugin.store ? this.plugin.documents.get(docId) : undefined;
		if (!doc) {
			return;
		}
		const target = collectTargetOf(this.collectHost(), doc.id);
		const menu = new Menu();
		// R2（E2-06）：图名 30 字截断（同高亮菜单 E2-05 基线），长图名菜单爆宽
		const nameBrief =
			target && target.map.name.length > 30
				? `${target.map.name.slice(0, 30)}…`
				: target?.map.name;
		const current = target
			? target.overridden
				? `当前目标：《${nameBrief}》`
				: `当前目标：📖 同名脑图《${nameBrief}》（默认）`
			: "当前目标：同名脑图（默认）";
		menu.addItem((mi) => mi.setTitle(current).setIcon("info").setDisabled(true));
		// 80 固定根按文档门控显示：无归属主题图 = 跨文档收拢；归属本书 = 本书收拢；
		// 归属他书 = 本书实际走上方「当前目标」路径，固定根让位不提示
		const fixed = this.plugin.mindmaps.fixedRoot();
		if (fixed) {
			const fixedDoc = fixedRootDocOf(this.collectHost(), fixed);
			if (fixedDoc == null || fixedDoc === doc.id) {
				menu.addItem((mi) =>
					mi
						.setTitle(
							fixedDoc == null
								? "固定根节点生效中，所有书的摘录优先进入该节点"
								: "固定根节点生效中，本书摘录优先进入该节点",
						)
						.setIcon("pin")
						.setDisabled(true),
				);
			}
		}
		menu.addSeparator();
		if (target?.overridden) {
			menu.addItem((mi) =>
				mi
					.setTitle(t("切回同名脑图（默认）"))
					.setIcon("book-open")
					.onClick(() => this.setCollectTarget(null)),
			);
		}
		menu.addItem((mi) =>
			mi
				.setTitle(t("选择其他脑图…"))
				.setIcon("share-2")
				.onClick(() => {
					new MindmapPickerModal(this.app, this.plugin, (map) => {
						// 选到本书同名图 = 等价回默认（存 null：frontmatter 省略该行，
						// 与"同名图是默认值"的语义一致，改名跟随逻辑也统一）
						this.setCollectTarget(map.documentId === doc.id ? null : map.id, map.name);
					}).open();
				}),
		);
		menu.showAtMouseEvent(evt);
	}

	/** 写入按书目标覆盖并反馈；null = 切回同名默认图 */
	private setCollectTarget(mapId: string | null, name?: string): void {
		const docId = this.currentDocId;
		if (docId == null || !this.plugin.store) {
			return;
		}
		this.plugin.documents.update(docId, { collectMapId: mapId });
		if (mapId == null) {
			// 回默认：立即确保同名图就绪（覆盖期间可能从未建过默认图）
			this.plugin.ensureBookMindmapFor(docId);
			const title = this.plugin.documents.get(docId)?.title ?? "";
			new Notice(`本书摘录将进入同名脑图《${title}》`);
		} else {
			new Notice(`本书摘录将进入《${name ?? "所选脑图"}》`);
		}
		// 主动切换目标图立即反映到联动脑图侧（㊿ 一对一，"除非主动切换"的闭环）
		// 89 目标图状态由 ⋯ 菜单打开时现读，无需按钮同步刷新
		void this.plugin.syncLinkedMindmap();
	}

	// ---------- 目录/书签侧栏（㉓） ----------

	/**
	 * 侧栏开关：absolute 覆盖层挂在 contentEl 上（不扰动滚动容器/平移状态机，
	 * 也无需改页骨架布局）。顶部「目录 / 书签 / 翻译」胶囊分页切换（㉙；83-E
	 * 翻译页签三分页），各页占全高。
	 */
	private toggleToc(): void {
		if (this.tocPanel) {
			this.tocPanel.remove();
			this.tocPanel = null;
			this.tocBtn?.classList.remove("is-active");
			return;
		}
		this.tocBtn?.classList.add("is-active");
		const panel = this.contentEl.createDiv({ cls: "marinmind-toc-panel" });
		const head = panel.createDiv({ cls: "marinmind-toc-head" });
		head.createSpan({ cls: "marinmind-toc-title", text: t("目录 · 书签 · 翻译") });
		const closeBtn = head.createEl("button", {
			cls: "marinmind-toc-close",
			attr: { type: "button", "aria-label": t("收起侧栏"), title: t("收起侧栏") },
		});
		setIcon(closeBtn, "x");
		closeBtn.addEventListener("click", () => this.toggleToc());
		// 分页切换条（㉙）：目录（PDF 内嵌大纲，只读）/ 书签（用户添加，入库）/
		// 翻译（83-E 划选即时翻译，MN4「研究→翻译侧栏」语义）
		// P2-2：形态由 .marinmind-segmented 共享配方承担；toc-tabs 只留布局差异
		const tabs = panel.createDiv({ cls: "marinmind-segmented marinmind-toc-tabs" });
		const tabLabel: Record<"outline" | "bookmarks" | "translate", string> = {
			outline: "目录",
			bookmarks: "书签",
			translate: "翻译",
		};
		for (const tab of ["outline", "bookmarks", "translate"] as const) {
			const btn = tabs.createEl("button", {
				cls: "marinmind-segmented-btn marinmind-toc-tab",
				text: tabLabel[tab],
				attr: { type: "button", "data-tab": tab },
			});
			btn.addEventListener("click", () => {
				if (this.tocTab === tab) {
					return;
				}
				this.tocTab = tab;
				this.syncTocTabs();
			});
		}
		panel.createDiv({ cls: "marinmind-toc-sec", attr: { "data-sec": "bookmarks" } });
		panel.createDiv({ cls: "marinmind-toc-sec", attr: { "data-sec": "outline" } });
		panel.createDiv({ cls: "marinmind-toc-sec", attr: { "data-sec": "translate" } });
		this.tocPanel = panel;
		// P2 目录懒解析：侧栏真正打开才解析 pdf 大纲（打开前不占 worker）
		this.ensureOutline();
		this.renderTocSections();
	}

	/** 按当前 tocTab 同步 tab 激活态与各页显隐（重渲染后调用于恢复分页） */
	private syncTocTabs(): void {
		const panel = this.tocPanel;
		if (!panel) {
			return;
		}
		panel.querySelectorAll<HTMLElement>(".marinmind-toc-tab").forEach((btn) => {
			btn.classList.toggle("is-active", btn.dataset.tab === this.tocTab);
		});
		panel.querySelectorAll<HTMLElement>(".marinmind-toc-sec").forEach((sec) => {
			sec.hidden = sec.dataset.sec !== this.tocTab;
		});
	}

	/** 重渲染侧栏各区块（打开 / 书签增删 / 大纲异步就绪 / 新划选推送时） */
	private renderTocSections(): void {
		const panel = this.tocPanel;
		if (!panel) {
			return;
		}
		this.renderBookmarksInto(panel.querySelector<HTMLElement>('[data-sec="bookmarks"]'));
		this.renderOutlineInto(panel.querySelector<HTMLElement>('[data-sec="outline"]'));
		this.renderTranslateInto(panel.querySelector<HTMLElement>('[data-sec="translate"]'));
		this.syncTocTabs();
	}

	/** 书签页：顶部动作行（＋ 当前页）+ 列表（点击跳页；× 删除后重渲染；行内页码右列） */
	private renderBookmarksInto(sec: HTMLElement | null): void {
		if (!sec) {
			return;
		}
		sec.empty();
		if (this.docKind === "md") {
			// ㊻-B md 单页长文无页码概念：书签停用（目录页的标题导航才是粒度）；
			// ㊼ epub 章=页模型，书签照常启用（章级）
			sec.createDiv({
				cls: "marinmind-toc-empty",
				text: t("Markdown 文档为单页长文，请用「目录」页的标题导航"),
			});
			return;
		}
		const docId = this.currentDocId;
		const actions = sec.createDiv({ cls: "marinmind-toc-bm-actions" });
		const addBtn = actions.createEl("button", {
			cls: "marinmind-toc-add",
			text: this.docKind === "epub" ? "＋ 当前章" : "＋ 当前页",
			attr: { type: "button", title: t("把当前阅读位置加为书签") },
		});
		if (!docId) {
			addBtn.disabled = true;
			return;
		}
		addBtn.addEventListener("click", () => this.promptAddBookmark());
		const list = sec.createDiv({ cls: "marinmind-toc-list" });
		const bookmarks = this.plugin.bookmarks.listByDocument(docId);
		if (bookmarks.length === 0) {
			list.createDiv({
				cls: "marinmind-toc-empty",
				text: t("暂无书签——点「＋ 当前页」标记阅读位置"),
			});
			return;
		}
		for (const bm of bookmarks) {
			const row = list.createDiv({ cls: "marinmind-toc-bm" });
			// 与目录条目一致用 div（button 的 flex 居中/默认盒样式问题），见 renderOutlineEntry
			const label = row.createDiv({
				cls: "marinmind-toc-link",
				text: bm.label,
				attr: { title: `跳到第 ${bm.page} ${this.pageWord}` },
			});
			label.addEventListener("click", () => {
				void this.jumpToPage(bm.page);
			});
			row.createSpan({ cls: "marinmind-toc-pageno", text: String(bm.page) });
			const del = row.createEl("button", {
				cls: "marinmind-toc-del",
				attr: { type: "button", "aria-label": t("删除书签"), title: t("删除书签") },
			});
			setIcon(del, "x");
			del.addEventListener("click", () => {
				this.plugin.bookmarks.remove(bm.id);
				// ㊳ 跨标签：同文档的全部阅读视图侧栏一起刷新（含本视图）
				if (docId) {
					this.plugin.refreshReaderBookmarks(docId);
				}
			});
		}
	}

	/**
	 * 翻译页签（83-E）：划选即时翻译——原文块 + 目标语言下拉（切换即写设置重译）+
	 * 译文三态（加载/错误+重试/结果）+ 动作行（存为留白/复制）。观感类直接复用
	 * 翻译弹窗的 marinmind-tr-*；ttSeq 守卫跳过无关刷新（书签增删不重译）。
	 */
	private renderTranslateInto(sec: HTMLElement | null): void {
		if (!sec) {
			return;
		}
		const snap = this.translateSnap;
		if (!snap) {
			sec.empty();
			this.ttEls = null;
			this.ttRenderedSeq = -1;
			sec.createDiv({
				cls: "marinmind-toc-empty",
				text: t(
					"划选文字后点工具栏「翻译」，译文会送到这里即时对照（也可停在本页签，划选自动刷新）",
				),
			});
			return;
		}
		if (this.ttRenderedSeq === this.ttSeq && sec.childElementCount > 0) {
			return; // 同一快照已渲染：无关刷新不重建不重译（省一次网络请求）
		}
		this.ttRenderedSeq = this.ttSeq;
		sec.empty();
		// 头部：目标语言下拉（镜像翻译弹窗）+ 源语言检测结果
		const head = sec.createDiv({ cls: "marinmind-tr-head marinmind-tt-head" });
		// R3（W-04）：select 无关联 label，补可访问名（镜像翻译弹窗）
		const selectEl = head.createEl("select", {
			cls: "marinmind-tt-lang",
			attr: { "aria-label": t("目标语言") },
		});
		for (const lang of TRANSLATE_LANGUAGES) {
			const option = selectEl.createEl("option", { text: lang.label });
			option.value = lang.code;
		}
		const current = this.plugin.settings.translateTarget;
		selectEl.value = isTranslateLangCode(current) ? current : DEFAULT_TRANSLATE_TARGET;
		selectEl.addEventListener("change", () => {
			if (!isTranslateLangCode(selectEl.value)) {
				return;
			}
			// 弹窗同款语义：切换即持久化并重译
			this.plugin.settings.translateTarget = selectEl.value;
			void this.plugin.saveData({ ...this.plugin.settings });
			void this.runSidebarTranslate();
		});
		const detectEl = head.createSpan({ cls: "marinmind-tr-detect" });

		sec.createDiv({ cls: "marinmind-tr-label", text: t("原文") });
		sec.createDiv({ cls: "marinmind-tr-text marinmind-tr-source", text: snap.text });

		sec.createDiv({ cls: "marinmind-tr-label", text: t("译文") });
		const resultEl = sec.createDiv({
			cls: "marinmind-tr-text marinmind-tr-result",
			// R3（W-03）：异步译文完成/出错时屏幕阅读器可感知（镜像翻译弹窗）
			attr: { "aria-live": "polite" },
		});

		// 动作行：存为留白（锚点选区正下方）/ 复制译文
		const actions = sec.createDiv({ cls: "marinmind-tr-actions" });
		const saveBtn = actions.createEl("button", {
			cls: "marinmind-tt-btn is-cta",
			text: t("存为留白"),
			attr: { type: "button" },
		});
		saveBtn.addEventListener("click", () => {
			if (!this.ttTranslation || !this.translateSnap) {
				return;
			}
			// 换文档时 cleanup 已清快照，此处 docId 必为原选区所在文档
			const docId = this.currentDocId;
			if (docId) {
				this.saveTranslationFromSelection(docId, this.translateSnap, this.ttTranslation);
			}
		});
		const copyBtn = actions.createEl("button", {
			cls: "marinmind-tt-btn",
			text: t("复制译文"),
			attr: { type: "button" },
		});
		copyBtn.addEventListener("click", () => {
			void (async () => {
				if (!this.ttTranslation) {
					return;
				}
				try {
					await navigator.clipboard.writeText(this.ttTranslation);
					new Notice("译文已复制到剪贴板");
				} catch (err) {
					console.error("[MarinMind] 复制译文失败", err);
					new Notice("复制失败（剪贴板不可用）");
				}
			})();
		});
		this.ttEls = { detect: detectEl, result: resultEl, save: saveBtn, copy: copyBtn };
		void this.runSidebarTranslate();
	}

	/**
	 * 侧栏翻译执行（83-E）：token + isConnected 双守卫丢弃过期响应；凭据缺失/
	 * 引擎不支持目标语言/网络失败渲染错误态 + 重试（镜像弹窗 run 的三态）。
	 */
	private async runSidebarTranslate(): Promise<void> {
		const els = this.ttEls;
		const snap = this.translateSnap;
		if (!els || !snap || !els.result.isConnected) {
			return;
		}
		if (snap.text.length > MAX_TRANSLATE_CHARS) {
			this.renderSidebarTranslateError(
				`文本过长（${snap.text.length} 字符，上限 ${MAX_TRANSLATE_CHARS}），请拆分后再译`,
			);
			return;
		}
		const token = ++this.ttToken;
		this.ttTranslation = null;
		els.save.disabled = true;
		els.copy.disabled = true;
		els.detect.setText(t(""));
		els.result.empty();
		els.result.addClass("is-loading");
		els.result.removeClass("marinmind-tr-error");
		els.result.setText(t("翻译中…"));
		try {
			// 凭据缺失在此抛出 → 错误态展示（侧栏常驻，比一闪而过的 Notice 合适）
			const call = resolveEngineCall(this.plugin.settings);
			const out = await translateText(snap.text, this.plugin.settings.translateTarget, call);
			if (token !== this.ttToken || !els.result.isConnected) {
				return;
			}
			this.ttTranslation = out.text;
			els.detect.setText(`源语言：${translateLangLabel(out.from)}`);
			els.result.empty();
			els.result.removeClass("is-loading", "marinmind-tr-error");
			els.result.setText(out.text);
			els.save.disabled = false;
			els.copy.disabled = false;
		} catch (err) {
			if (token !== this.ttToken || !els.result.isConnected) {
				return;
			}
			this.renderSidebarTranslateError(err instanceof Error ? err.message : String(err));
		}
	}

	/** 侧栏译文错误态：错误文案 + 重试钮（runSidebarTranslate 的失败尾部） */
	private renderSidebarTranslateError(message: string): void {
		const els = this.ttEls;
		if (!els || !els.result.isConnected) {
			return;
		}
		this.ttTranslation = null;
		els.save.disabled = true;
		els.copy.disabled = true;
		els.result.empty();
		els.result.removeClass("is-loading");
		els.result.addClass("marinmind-tr-error");
		els.result.createDiv({ text: message });
		const retry = els.result.createDiv({ cls: "marinmind-tr-retry" }).createEl("button", {
			cls: "marinmind-tt-btn",
			text: t("重试"),
			attr: { type: "button" },
		});
		retry.addEventListener("click", () => void this.runSidebarTranslate());
	}

	/**
	 * 翻译页签公共入口（83-E）：存快照并切到翻译页签；toggleOpen 时未开侧栏先开
	 * （工具栏「翻译」钮语义——划选→侧栏即时不建卡，与高亮菜单弹窗双入口分离）。
	 */
	private pushTranslateToSidebar(snap: SelectionSnapshot, opts?: { toggleOpen?: boolean }): void {
		if (opts?.toggleOpen && !this.tocPanel) {
			this.toggleToc();
		}
		this.translateSnap = snap;
		++this.ttSeq;
		if (this.tocPanel) {
			this.tocTab = "translate";
			this.renderTocSections();
		}
	}

	/**
	 * 划选自动刷新（83-E）：侧栏开着且停在翻译页签时，新划选 500ms 防抖后推送
	 * 刷新（防抖 = 百度 QPS 1 次/秒的第一道闸；timer 在 cleanup 清防误挂）。
	 */
	private scheduleSidebarTranslate(snap: SelectionSnapshot): void {
		if (this.ttTimer != null) {
			window.clearTimeout(this.ttTimer);
		}
		this.ttTimer = window.setTimeout(() => {
			this.ttTimer = null;
			if (!this.tocPanel || this.tocTab !== "translate") {
				return; // 防抖窗口内侧栏被关/切走页签：只弃不刷
			}
			this.translateSnap = snap;
			++this.ttSeq;
			this.renderTocSections();
		}, 500);
	}

	/**
	 * P2 目录懒解析：pdf 内嵌大纲只在侧栏需要时才解析（单飞 + 完成标记）。
	 * 解析失败置 loaded 视同"无大纲"（沿用旧语义：大纲损坏不阻塞阅读）；
	 * loadToken 守卫丢弃换文档的过期结果。md/epub 目录同步就绪不经此路径。
	 */
	private ensureOutline(): void {
		const pdf = this.pdf;
		if (!pdf || this.outlineLoaded || this.outlineLoading) {
			return;
		}
		const token = this.loadToken;
		this.outlineLoading = pdf
			.outline()
			.then((entries) => {
				if (token !== this.loadToken) {
					return;
				}
				this.outlineEntries = entries;
				this.outlineLoaded = true;
				if (this.tocPanel) {
					this.renderTocSections();
				}
			})
			.catch(() => {
				if (token === this.loadToken) {
					this.outlineLoaded = true; // 显示"没有内嵌目录"空态
				}
			});
	}

	/** 目录页：内嵌大纲树（有子级可折叠；顶层默认展开、深层默认收起；tab 已标识无需区块头） */
	private renderOutlineInto(sec: HTMLElement | null): void {
		if (!sec) {
			return;
		}
		sec.empty();
		// P2 懒解析中间态：pdf 大纲尚未就绪（侧栏打开触发解析中）——区分"解析中"与"无大纲"
		if (this.docKind === "pdf" && !this.outlineLoaded) {
			sec.createDiv({ cls: "marinmind-toc-empty", text: t("正在解析目录…") });
			return;
		}
		if (this.outlineEntries.length === 0) {
			sec.createDiv({
				cls: "marinmind-toc-empty",
				text: t("本文档没有内嵌目录——可切到「书签」自行标记位置"),
			});
			return;
		}
		for (const entry of this.outlineEntries) {
			this.renderOutlineEntry(sec, entry, 0);
		}
	}

	/**
	 * 单条大纲条目（㉝ 回归 Obsidian 默认 PDF 大纲样式：折叠钮 + 标题，无附加列）
	 * + 子级容器递归。层级缩进由子级容器累计承担（非行内 paddingLeft）、
	 * chevron 折叠、用户手动折叠状态记入 tocCollapsedKeys（重渲染不丢）。
	 * 页码解析失败的条目置灰不可点。**条目用 div 非 button**——Obsidian/主题对
	 * button 的 flex 居中默认样式会把文字节点居中、且带默认盒样式（方框）。
	 */
	private renderOutlineEntry(container: HTMLElement, entry: OutlineEntry, depth: number): void {
		const key = `${entry.title}|${entry.page ?? ""}`;
		const open = depth < 1 && !this.tocCollapsedKeys.has(key);
		const row = container.createDiv({ cls: "marinmind-toc-item" });
		if (entry.children.length > 0) {
			const chev = row.createDiv({
				cls: "marinmind-toc-chev",
				attr: { "aria-label": t("展开/折叠"), title: t("展开/折叠子目录") },
			});
			setIcon(chev, open ? "chevron-down" : "chevron-right");
			const kids = container.createDiv({ cls: "marinmind-toc-kids" });
			kids.classList.toggle("is-collapsed", !open);
			// 超深层级不再累计缩进（防极端大纲把标题挤出面板）
			kids.classList.toggle("is-max", depth >= 6);
			chev.addEventListener("click", () => {
				const collapsed = kids.classList.toggle("is-collapsed");
				setIcon(chev, collapsed ? "chevron-right" : "chevron-down");
				if (collapsed) {
					this.tocCollapsedKeys.add(key);
				} else {
					this.tocCollapsedKeys.delete(key);
				}
			});
			for (const child of entry.children) {
				this.renderOutlineEntry(kids, child, depth + 1);
			}
		} else {
			row.createSpan({ cls: "marinmind-toc-chev is-leaf" }); // 占位保持标题列对齐
		}
		const btn = row.createDiv({ cls: "marinmind-toc-link", text: entry.title });
		if (entry.page == null) {
			btn.classList.add("is-dead");
			return;
		}
		const page = entry.page;
		btn.addEventListener("click", () => {
			// ㊻-B md 文档：标题锚点直接滚到标题（单页长文，标题才是导航粒度）
			const scroll = this.scrollEl;
			const anchor = entry.anchor;
			if (anchor && scroll) {
				scroll.scrollTop +=
					anchor.getBoundingClientRect().top - scroll.getBoundingClientRect().top - 12;
				return;
			}
			// ㊼ epub：fragment 章内精定位（jumpToPage 内解析，找不到停章顶）
			void this.jumpToPage(page, entry.fragment);
		});
	}

	/** 添加书签：弹输入框（默认"第 N 页/章"，可改章节名）；docId 同步捕获防跨文档误挂 */
	private promptAddBookmark(): void {
		const docId = this.currentDocId;
		if (!docId) {
			return;
		}
		const page = this.getCurrentPage();
		// ㊼ epub：默认标题取目录中 ≤ 当前章的最近节点标题（无 toc 回退「第 N 章」）
		const defaultLabel =
			this.docKind === "epub" && this.epub
				? (epubChapterTitleOf(this.epub, page - 1) ?? `第 ${page} 章`)
				: `第 ${page} 页`;
		new TextPromptModal(
			this.app,
			{
				title: `添加书签（第 ${page} ${this.pageWord}）`,
				initialText: defaultLabel,
				placeholder: t("书签名称（如章节名，留空用默认）"),
			},
			(label: string | null) => {
				const text = label?.trim() || defaultLabel;
				this.plugin.bookmarks.add(docId, page, text);
				// ㊳ 跨标签：同文档的全部阅读视图侧栏一起刷新（含本视图）
				this.plugin.refreshReaderBookmarks(docId);
				new Notice(`书签已添加（第 ${page} ${this.pageWord}）`);
			},
		).open();
	}

	// ---------- AI 一键摘录（㉓） ----------

	/** AI 摘录入口：当前文档/页带入弹窗（版面识别 + 预览勾选 + 批量建卡） */
	private openAutoExcerpt(): void {
		if (!this.pdf || !this.currentDocId || !this.currentFilePath) {
			return;
		}
		// ㊳ 共享缓存：借一份引用给弹窗——阅读器中途关标签，弹窗内的识别/预览不受影响
		const handle = retainPdf(pdfCacheKey(this.currentFilePath));
		if (!handle) {
			return; // 缓存条目已不在（异常时序，如文件被替换重建的窗口期）：本批不支持
		}
		new AutoExcerptModal(this.app, this.plugin, {
			pdf: handle.doc,
			pdfHandle: handle,
			documentId: this.currentDocId,
			currentPage: this.getCurrentPage(),
			numPages: handle.doc.numPages,
		}).open();
	}

	/**
	 * 切换阅读工具（工具行单选；选定后保持激活可连续摘录）。
	 * text 为默认（overlay 穿透，划选文字即成卡）；select 同为穿透但划选仅供复制
	 * （㉖，划选建卡守卫 activeTool === "text" 天然拦截）；选其他工具先退出手写模式
	 * （关闭分支会提交笔迹）。手型=只读平移，指针处理见构造器注册的 pan 监听。
	 */
	private setReaderTool(tool: ReaderTool): void {
		if (tool === this.activeTool) {
			return; // 幂等（重复点击同一工具不动作）
		}
		this.activeTool = tool;
		if (this.handwriteMode) {
			this.setHandwriteMode(false);
		}
		// 显式切工具结束遮挡编辑（㊷；层内 setTool 也会清各自的 target）
		if (this.occlusionEditTarget) {
			this.occlusionEditTarget = null;
		}
		// 文字遮罩同为瞬态模式（74）：切工具即失效（层内 setTool 同步清）
		if (this.occlusionTextTarget) {
			this.occlusionTextTarget = null;
		}
		// 照片重定位同为瞬态模式（84-D）：切工具即失效（层内 setTool 同步清）
		if (this.photoRelocateTarget) {
			this.photoRelocateTarget = null;
		}
		// 75 划选工具栏随工具切换隐藏（选区保留，动作不再可用）
		this.selectionToolbar?.hide();
		for (const layer of this.excerptLayers.values()) {
			layer.setTool(tool);
			// ㊹ 每工具独立记忆色系：切换时把该工具当前色推给预览（拖框/套索着色）
			if (isExcerptTool(tool)) {
				layer.setToolColor(this.plugin.settings.excerptColors[tool]);
			}
		}
		for (const [t, btn] of this.toolBtns) {
			btn.classList.toggle("is-active", t === tool);
		}
		// 89 ⋯ 点亮同步：当前工具折叠在菜单里（hand/select）时提示非默认态
		this.syncOverflowActive();
	}

	/**
	 * 循环切换该工具的摘录色系（㊹ MN3 式：点击已激活的工具按钮切色）。
	 * 名单顺序 黄→绿→蓝→红 循环；写回 settings 持久化，后续建卡落新色。
	 */
	private cycleExcerptColor(tool: ExcerptTool): void {
		const colors = this.plugin.settings.excerptColors;
		const idx = HIGHLIGHT_COLORS.findIndex((c) => c.value === colors[tool]);
		const next = HIGHLIGHT_COLORS[(idx + 1) % HIGHLIGHT_COLORS.length];
		colors[tool] = next.value;
		void this.plugin.saveData({ ...this.plugin.settings });
		this.syncToolColorUI(tool);
		const def = TOOLBAR_TOOLS.find((t) => t.tool === tool);
		new Notice(`${def?.title ?? ""}摘录颜色：${next.label}`);
	}

	/** 同步工具按钮的色点/title + 把当前色推给各页预览（建行时与每次切色后调用） */
	private syncToolColorUI(tool: ExcerptTool): void {
		const value = this.plugin.settings.excerptColors[tool];
		const colorDef = HIGHLIGHT_COLORS.find((c) => c.value === value) ?? HIGHLIGHT_COLORS[0];
		const btn = this.toolBtns.get(tool);
		if (btn) {
			const dot = btn.querySelector<HTMLElement>(".marinmind-tool-color-dot");
			if (dot) {
				dot.dataset.color = colorDef.value;
			}
			const def = TOOLBAR_TOOLS.find((t) => t.tool === tool);
			if (def) {
				btn.title = `${def.hint}（再次点击切换颜色：${colorDef.label}）`;
			}
		}
		for (const layer of this.excerptLayers.values()) {
			layer.setToolColor(colorDef.value);
		}
	}

	/**
	 * E3 手写层惰性创建：仅 pdf 文档、按需建层（已存在幂等早退）。
	 * 必须读持久布尔 this.handwriteMode 建层——cleanupContent 不重置该布尔，
	 * 手写模式跨文档存续是现状行为（换文档后新页照常可写）。
	 */
	private ensureHandwriteLayer(n: number): void {
		if (this.isReflowDoc || this.handwriteLayers.has(n)) {
			return;
		}
		const pv = this.pageViewByNumber.get(n);
		if (!pv) {
			return;
		}
		const hw = new HandwriteLayer(pv);
		hw.setHandwriteMode(this.handwriteMode);
		hw.setEraser(this.handwriteEraser); // 84-A：模式存续期间新建层沿用当前工具态
		hw.onInk = () => {
			this.lastInkPage = n; // 84-A：撤销目标页跟随最近操作
		};
		this.handwriteLayers.set(n, hw);
	}

	/**
	 * 手写模式开关（与摘录工具互斥；关闭时提交全部未提交笔迹）。
	 * E3 惰性化：开启时只为预渲染区内的页建层（visiblePages 小候选集），
	 * 后续页由 IO 进入回调补建；关闭时逐层提交后销毁清空（canvas 不常驻）。
	 */
	private setHandwriteMode(on: boolean): void {
		if (on === this.handwriteMode) {
			return; // 幂等 + 防互斥递归
		}
		if (on && this.isReflowDoc) {
			return; // ㊻-B md 文档无手写层（超高画布不可行），按钮已隐藏此处防御
		}
		if (on) {
			// 101 修：先退摘录工具**再**置位——此前先置 handwriteMode=true 再调
			// setReaderTool，当前非 text 工具时其互斥出口（handwriteMode → 关模式）
			// 会递归把模式关回：按钮点亮、工具条出现，但建层时模式已是 false，
			// 画布 pointer-events:none 完全穿透，表现为"手写不生效"
			this.setReaderTool("text"); // 已是 text 时幂等跳过
		}
		this.handwriteMode = on;
		if (on) {
			for (const n of this.visiblePages) {
				this.ensureHandwriteLayer(n);
			}
			this.buildHandwriteToolbar(); // 84-A：模式激活期间显示手写工具条
		} else {
			for (const [page, layer] of this.handwriteLayers) {
				if (layer.hasInk()) {
					this.commitHandwrite(page);
				}
				layer.destroy();
			}
			this.handwriteLayers.clear();
			this.destroyHandwriteToolbar(); // 84-A
			this.handwriteEraser = false;
			this.lastInkPage = null;
		}
		this.handwriteBtn?.classList.toggle("is-active", on);
	}

	/** 84-A 手写工具条：撤销 / 橡皮擦（toggle）/ 清空（悬浮底部居中，随模式开关增删） */
	private buildHandwriteToolbar(): void {
		if (this.handwriteToolbar) {
			return;
		}
		const bar = document.createElement("div");
		bar.className = "marinmind-handwrite-toolbar";
		const undoBtn = document.createElement("button");
		setIcon(undoBtn, "undo-2");
		undoBtn.title = "撤销上一笔（Ctrl+Z）";
		undoBtn.addEventListener("click", (evt) => {
			evt.stopPropagation();
			this.undoHandwrite();
		});
		const eraserBtn = document.createElement("button");
		setIcon(eraserBtn, "eraser");
		eraserBtn.title = "橡皮擦（整笔删除）";
		eraserBtn.addEventListener("click", (evt) => {
			evt.stopPropagation();
			this.handwriteEraser = !this.handwriteEraser;
			eraserBtn.classList.toggle("is-active", this.handwriteEraser);
			for (const layer of this.handwriteLayers.values()) {
				layer.setEraser(this.handwriteEraser);
			}
		});
		const clearBtn = document.createElement("button");
		setIcon(clearBtn, "trash-2");
		clearBtn.title = "清空全部未提交笔迹（可撤销）";
		clearBtn.addEventListener("click", (evt) => {
			evt.stopPropagation();
			for (const layer of this.handwriteLayers.values()) {
				layer.clearInk();
			}
		});
		bar.append(undoBtn, eraserBtn, clearBtn);
		this.contentEl.appendChild(bar);
		this.handwriteToolbar = bar;
	}

	private destroyHandwriteToolbar(): void {
		this.handwriteToolbar?.remove();
		this.handwriteToolbar = null;
	}

	/** 84-A 撤销最近一次手写操作：优先最近操作页，否则取首个仍有历史的层 */
	private undoHandwrite(): void {
		const target =
			(this.lastInkPage != null ? this.handwriteLayers.get(this.lastInkPage) : undefined) ??
			[...this.handwriteLayers.values()].find((layer) => layer.canUndo());
		target?.undo();
	}

	/** 滚动离开的带笔迹页：整页移出视口即提交（还在视口内的保留继续画） */
	private commitOffscreenInk(): void {
		const scroll = this.scrollEl;
		if (!scroll) {
			return;
		}
		const box = scroll.getBoundingClientRect();
		for (const [page, layer] of this.handwriteLayers) {
			if (!layer.hasInk()) {
				continue;
			}
			const pb = this.pageViewByNumber.get(page)?.el.getBoundingClientRect();
			// 页面与滚动视口完全不相交 → 已滚离，提交
			if (pb && (pb.bottom < box.top || pb.top > box.bottom)) {
				this.commitHandwrite(page);
			}
		}
	}

	/** 提交某页手写层：落库建卡 + img 高亮回显（docId 在异步前同步捕获） */
	private commitHandwrite(page: number): void {
		const layer = this.handwriteLayers.get(page);
		const docId = this.currentDocId;
		if (!layer || !layer.hasInk() || !docId) {
			return;
		}
		void layer
			.commit()
			.then(async (result) => {
				if (!result || !docId) {
					return;
				}
				// WebP 优先落库（手写专档 q0.9），环境不支持回退 PNG——ext 跟随实际格式
				const ref = await this.plugin.attachments.save(result.bytes, result.ext);
				this.plugin.cards.create({
					documentId: docId,
					page,
					rects: [result.bbox],
					excerptType: "handwriting",
					excerptRef: ref,
					color: "green",
				});
				// 回显由 cardBus 事件回环完成（cleanup 后 excerptLayers 已清空则跳过，
				// 重开文档自然回显）
			})
			.catch((err) => {
				console.error("[MarinMind] 手写提交失败", err);
				new Notice("手写摘录保存失败");
			});
	}

	/** 视口中心所在页（照片/音频锚定用；占位尺寸下可能偏差 ±1 页，可接受） */
	getCurrentPage(): number {
		const scroll = this.scrollEl;
		if (!scroll || this.pageViewByNumber.size === 0) {
			return 1;
		}
		const cy = scroll.getBoundingClientRect().top + scroll.clientHeight / 2;
		// 快路径：视口中心必然落在 IO 预渲染区（±1 屏）内的某页——只对这几页
		// 读 gBCR。getState（保存工作区/切标签）高频调本方法，全页扫描在大文档
		// 上是周期性卡顿来源；集合意外未覆盖时回退全扫兜底。
		const candidates = [...this.visiblePages].sort((a, b) => a - b);
		if (candidates.length > 0) {
			let best: PageView | null = null;
			let bestDist = Infinity;
			for (const page of candidates) {
				const pv = this.pageViewByNumber.get(page);
				if (!pv || pv.pageNumber !== page) {
					continue; // 校验防御结构变化
				}
				const b = pv.el.getBoundingClientRect();
				if (cy >= b.top && cy < b.bottom) {
					return pv.pageNumber;
				}
				const d = Math.abs(b.top + b.height / 2 - cy);
				if (d < bestDist) {
					bestDist = d;
					best = pv;
				}
			}
			if (best) {
				return best.pageNumber;
			}
		}
		for (const pv of this.pageViewByNumber.values()) {
			const b = pv.el.getBoundingClientRect();
			if (cy >= b.top && cy < b.bottom) {
				return pv.pageNumber;
			}
		}
		// 落在页间隙：回退最近页
		let best: PageView | undefined;
		let bestDist = Infinity;
		for (const pv of this.pageViewByNumber.values()) {
			const b = pv.el.getBoundingClientRect();
			const d = Math.abs(b.top + b.height / 2 - cy);
			if (d < bestDist) {
				bestDist = d;
				best = pv;
			}
		}
		return best?.pageNumber ?? 1;
	}

	// ---------- 文档级事件（103-D：Esc / Ctrl+Z / 粘贴，绑 ownerDocument） ----------

	/** 绑定文档级事件（onOpen 调用；先解后绑保证重复 onOpen 幂等） */
	private bindDocEvents(): void {
		this.unbindDocEvents();
		const doc = this.contentEl.ownerDocument;
		doc.addEventListener("keydown", this.onDocEsc);
		doc.addEventListener("keydown", this.onDocUndo);
		doc.addEventListener("paste", this.onDocPaste);
		this.docEventsDoc = doc;
	}

	/** 解绑文档级事件（onClose 调用；this.register 兜底防泄漏） */
	private unbindDocEvents(): void {
		if (this.docEventsDoc) {
			this.docEventsDoc.removeEventListener("keydown", this.onDocEsc);
			this.docEventsDoc.removeEventListener("keydown", this.onDocUndo);
			this.docEventsDoc.removeEventListener("paste", this.onDocPaste);
			this.docEventsDoc = null;
		}
	}

	/**
	 * Esc 快速退出当前工具（回到文字摘录）/ 手写模式。
	 * 仅本视图是激活 leaf 时响应；弹窗/菜单/输入态打开时让位（它们自己消费 Esc）；
	 * 瞬态模式（划选工具栏/文字遮罩/遮挡编辑/照片重定位）优先逐级退出。
	 */
	private handleEsc(evt: KeyboardEvent): void {
		if (evt.key !== "Escape" || evt.ctrlKey || evt.metaKey || evt.altKey || evt.shiftKey) {
			return;
		}
		if (this.app.workspace.activeLeaf !== this.leaf) {
			return;
		}
		const target = evt.target as HTMLElement | null;
		if (target?.closest?.(".modal-container, .menu, input, textarea, [contenteditable]")) {
			return;
		}
		// 划选工具栏最先退出（75）：Esc 只关工具栏不清选区（选区可继续用于复制等）
		if (this.selectionToolbar?.visible) {
			this.selectionToolbar.hide();
			return;
		}
		// 文字遮罩模式优先退出（74）：瞬态模式，先于拖框遮挡处理
		if (this.occlusionTextTarget) {
			this.stopOcclusionTextEdit();
			return;
		}
		// 遮挡编辑模式优先退出（㊷）：瞬态模式，Esc 先退出它再考虑工具切换
		if (this.occlusionEditTarget) {
			this.stopOcclusionEdit();
			return;
		}
		// 照片重定位模式（84-D）：同为瞬态拖框模式，同级退出
		if (this.photoRelocateTarget) {
			this.stopPhotoRelocate();
			return;
		}
		if (this.activeTool !== "text") {
			this.setReaderTool("text");
		} else if (this.handwriteMode) {
			this.setHandwriteMode(false);
		}
	}

	/**
	 * 84-A 手写撤销快捷键：Ctrl/Cmd+Z 仅在手写模式 + 本视图激活时拦截，否则让位
	 * Obsidian 自身撤销；弹窗/菜单/输入态同样让位（与 Esc 链同一套守卫）。
	 */
	private handleUndoShortcut(evt: KeyboardEvent): void {
		if (evt.key !== "z" || !(evt.ctrlKey || evt.metaKey) || evt.shiftKey || evt.altKey) {
			return;
		}
		if (!this.handwriteMode || this.app.workspace.activeLeaf !== this.leaf) {
			return;
		}
		const target = evt.target as HTMLElement | null;
		if (target?.closest?.(".modal-container, .menu, input, textarea, [contenteditable]")) {
			return;
		}
		evt.preventDefault();
		this.undoHandwrite();
	}

	// ---------- 照片摘录（粘贴 / 拖入 / 按钮选图） ----------

	private onPaste(evt: ClipboardEvent): void {
		// 挂文档（103-D 起 ownerDocument）：必须限定本视图激活，否则别的标签复制图片也会被吞
		if (this.app.workspace.activeLeaf !== this.leaf) {
			return;
		}
		this.handleImageFiles(Array.from(evt.clipboardData?.files ?? []));
	}

	private onDrop(evt: DragEvent): void {
		// dragover 已 preventDefault，这里也必须阻止默认（浏览器直接打开文件）
		evt.preventDefault();
		this.handleImageFiles(Array.from(evt.dataTransfer?.files ?? []));
	}

	/** 工具栏按钮选图（共享件 Promise 化：取消返回 []，移动端同样可用） */
	private pickImages(): void {
		void pickImageFiles(true).then((files) => this.handleImageFiles(files));
	}

	/** 图片文件 → 附件 → photo 卡（锚定当前页；入库前处理接缝见 preparePhotoBytes） */
	private handleImageFiles(files: File[]): void {
		const docId = this.currentDocId;
		if (files.filter((f) => f.type.startsWith("image/")).length === 0) {
			return;
		}
		if (!docId) {
			new Notice("请先在阅读器打开文档，再插入图片摘录");
			return;
		}
		const page = this.getCurrentPage();
		for (const file of files.filter((f) => f.type.startsWith("image/"))) {
			void file
				.arrayBuffer()
				.then(async (raw) => {
					// 84-C/84-E：入库前处理接缝（压缩开关来自设置，GIF/SVG/小图在接缝内放行）
					const { bytes, ext } = await preparePhotoBytes(
						raw,
						imageExtOf(file.type),
						this.plugin.settings.photoCompress,
					);
					const ref = await this.plugin.attachments.save(bytes, ext);
					// 徽标回显由 cardBus 事件回环完成（本标签或另一标签打开同文档均生效）
					this.plugin.cards.create({
						documentId: docId,
						page,
						rects: [],
						excerptType: "photo",
						excerptRef: ref,
						color: "red", // ㊹ 四色化：照片/语音统一浅红（无页面矩形，仅脑图色条可见）
					});
				})
				.catch((err) => {
					console.error("[MarinMind] 图片保存失败", err);
					new Notice("图片保存失败");
				});
		}
	}

	// ---------- 录音摘录 ----------

	/** 是否正在录音（84-B：main.ts 全局录音命令启动前的互斥检查用） */
	get isRecording(): boolean {
		return this.recorder?.active ?? false;
	}

	private async toggleRecording(): Promise<void> {
		if (this.recorder?.active) {
			await this.stopAndSaveRecording();
			return;
		}
		// 84-C 防重：全局录音条在录时不抢（麦克风独占，两条录音条并存只会分不清保存哪条）
		if (this.plugin.globalRecordingActive) {
			new Notice("全局录音进行中，请先在命令面板保存或丢弃");
			return;
		}
		if (!this.currentDocId) {
			new Notice("请先在阅读器打开文档，再录音");
			return;
		}
		try {
			this.recorder ??= new AudioRecorder();
			await this.recorder.start();
			this.showRecBar();
		} catch (err) {
			console.warn("[MarinMind] 麦克风不可用", err);
			new Notice("无法访问麦克风：请在系统设置中允许 Obsidian 使用麦克风");
			this.recorder = null;
		}
	}

	/** 停止录音并保存为 audio 卡（docId/page 在异步前同步捕获） */
	private async stopAndSaveRecording(): Promise<void> {
		const rec = this.recorder;
		if (!rec?.active) {
			return;
		}
		const docId = this.currentDocId;
		const page = this.getCurrentPage();
		this.removeRecBar();
		try {
			const { bytes, ext, durationMs } = await rec.stop();
			if (!docId) {
				new Notice("录音已丢弃（未打开文档）");
				return;
			}
			if (bytes.byteLength === 0) {
				new Notice("录音为空，已忽略");
				return;
			}
			const ref = await this.plugin.attachments.save(bytes, ext);
			// 徽标回显由 cardBus 事件回环完成
			this.plugin.cards.create({
				documentId: docId,
				page,
				rects: [],
				excerptType: "audio",
				excerptRef: ref,
				color: "red", // ㊹ 四色化：照片/语音统一浅红
				durationSec: audioDurationSec(durationMs), // 84-B 时长落库
			});
			new Notice(`语音摘录已保存（第 ${page} ${this.pageWord}）`);
		} catch (err) {
			console.error("[MarinMind] 录音保存失败", err);
			new Notice("录音保存失败");
		}
	}

	/** 录音状态条（84-B 组件化）：红点 + 波形 + 计时 + 保存/丢弃 */
	private showRecBar(): void {
		this.removeRecBar();
		const recorder = this.recorder;
		if (!recorder) {
			return;
		}
		this.recBar = new RecordingBar({
			app: this.app,
			host: this.contentEl,
			recorder,
			onSave: () => void this.stopAndSaveRecording(),
			onDiscard: () => {
				this.removeRecBar();
				recorder.discard();
				new Notice("已丢弃录音");
			},
		});
	}

	private removeRecBar(): void {
		this.recBar?.destroy();
		this.recBar = null;
	}

	// ---------- photo/audio 页角徽标 ----------

	private addMediaCard(page: number, card: Card): void {
		const list = this.mediaCardsByPage.get(page) ?? [];
		list.push(card);
		this.mediaCardsByPage.set(page, list);
		this.updateMediaBadge(page);
	}

	private removeMediaCard(card: Card): void {
		if (card.page == null) {
			return;
		}
		const list = this.mediaCardsByPage.get(card.page);
		if (!list) {
			return;
		}
		const next = list.filter((c) => c.id !== card.id);
		if (next.length > 0) {
			this.mediaCardsByPage.set(card.page, next);
		} else {
			this.mediaCardsByPage.delete(card.page);
		}
		this.updateMediaBadge(card.page);
	}

	/** 维护页角徽标 DOM（有媒体卡显示并计数，无则移除） */
	private updateMediaBadge(page: number): void {
		const cards = this.mediaCardsByPage.get(page) ?? [];
		let badge = this.mediaBadges.get(page);
		if (cards.length === 0) {
			badge?.remove();
			this.mediaBadges.delete(page);
			return;
		}
		if (!badge) {
			const pv = this.pageViewByNumber.get(page);
			if (!pv) {
				return;
			}
			badge = pv.el.createDiv({ cls: "marinmind-media-badge" });
			badge.addEventListener("click", (evt) => {
				evt.stopPropagation();
				this.onMediaBadgeClick(page, evt);
			});
			this.mediaBadges.set(page, badge);
		}
		badge.setText(`${cards.length} 个媒体摘录`);
	}

	/** 页角徽标点击：列出该页媒体卡（点击查看与管理） */
	private onMediaBadgeClick(page: number, evt: MouseEvent): void {
		const cards = this.mediaCardsByPage.get(page) ?? [];
		if (cards.length === 0) {
			return;
		}
		const menu = new Menu();
		for (const card of cards) {
			const label = mediaCardLabel(card, this.pageWord);
			menu.addItem((item) =>
				item
					.setTitle(card.note ? `${label} · ${card.note.slice(0, 24)}` : label)
					.setIcon(card.excerptType === "audio" ? "mic" : "image")
					.onClick(() => {
						new MediaPreviewModal(this.app, this.plugin, card, {
							// 批注/闪卡变更经 cardBus 事件同步；删除需发起方清附件
							onDelete: (victim) => this.deleteCard(victim),
							// 84-B 重录：删旧卡（含附件级联）后立即在当前页开新录音
							onRerecord: (victim) => this.rerecordAudio(victim),
							// 84-D 照片定位：关弹窗进重定位模式（目标卡所在页拖框）
							onRelocate: (victim) => this.startPhotoRelocate(victim),
						}).open();
					}),
			);
		}
		menu.showAtMouseEvent(evt);
	}

	/**
	 * 拖拽框选完成：裁剪区域内容快照（⑳）后创建 area 卡片——
	 * 快照失败（页未渲染等罕见时序）不阻塞建卡，留待回填路径补齐
	 */
	private createAreaCard(pageNumber: number, rect: DocRect): void {
		if (!this.currentDocId) {
			return;
		}
		const docId = this.currentDocId;
		// 高亮回显由 cardBus 事件回环完成
		void this.snapshotForCard(pageNumber, rect, null).then((ref) => {
			const card = this.plugin.cards.create({
				documentId: docId,
				page: pageNumber,
				rects: [rect],
				excerptType: "area",
				// ㊹ 建卡色跟随该工具当前色系（按钮循环切换，持久化记忆）
				color: this.plugin.settings.excerptColors.area,
				excerptRef: ref,
			});
			// 83 拖框即识：开关开启时建卡即自动识别（新卡无摘录文字，天然不触发
			// 覆盖确认；引擎层串行队列保证连续拖框依次识别互不串进度）
			if (this.plugin.settings.ocrOnAreaExcerpt && !Platform.isMobile && !this.isReflowDoc) {
				void this.ocrCard(card);
			}
		});
	}

	/** 套索完成：创建 lasso 卡片（polygon = 原始轮廓原样保存；rects 存包围盒供跳转定位） */
	private createLassoCard(pageNumber: number, polygon: NormPoint[], bbox: DocRect): void {
		if (!this.currentDocId || polygon.length === 0) {
			return;
		}
		const docId = this.currentDocId;
		void this.snapshotForCard(pageNumber, bbox, polygon).then((ref) => {
			this.plugin.cards.create({
				documentId: docId,
				page: pageNumber,
				rects: [bbox],
				polygon,
				excerptType: "lasso",
				color: this.plugin.settings.excerptColors.lasso, // ㊹ 跟随套索工具当前色系
				excerptRef: ref,
			});
		});
	}

	/**
	 * 区域快照公共路径：从页 canvas 裁剪图片（㉛ 起优先 WebP，环境不支持回退 PNG）
	 * 存附件，返回 excerptRef；页未渲染/裁剪失败/存储失败均返回 null
	 * （调用方按"无快照"降级，回填路径会补）
	 */
	private async snapshotForCard(
		pageNumber: number,
		rect: DocRect,
		polygon: NormPoint[] | null,
	): Promise<string | null> {
		const pv = this.pageViewByNumber.get(pageNumber);
		if (!pv) {
			return null;
		}
		try {
			const img = await pv.snapshotRegion(rect, polygon);
			if (!img) {
				return null;
			}
			return await this.plugin.attachments.save(img.bytes, img.ext);
		} catch (err) {
			console.warn("[MarinMind] 区域快照保存失败（卡片仍会创建，稍后回填）", err);
			return null;
		}
	}

	/**
	 * 存量区域/套索卡回填（⑳）：页位图就绪时，为本页尚无 excerptRef 的
	 * area/lasso 卡补快照——旧数据自动升级，无需重新摘录；
	 * cards.update 发 changed 事件，脑图/复习节点随之显示区域图片
	 */
	/** 区域/套索卡缺内容快照（存量旧卡 / 建卡时快照失败）——页面位图就绪后回填 */
	private needsRegionSnapshot(card: Card): boolean {
		return (
			(card.excerptType === "area" || card.excerptType === "lasso") &&
			!card.excerptRef &&
			card.rects.length > 0
		);
	}

	private async backfillRegionSnapshots(pv: PageView): Promise<void> {
		// 页集合预判：未命中直接返回，免去 listByDocument 全量查询（每次缩放/滚动
		// 重渲染都会走到这里，绝大多数时候是空手而归）。
		// 集合在回显与跨标签 syncCard 时维护；误漏的兜底 = 重开文档重建集合。
		if (!this.pagesNeedingBackfill.has(pv.pageNumber)) {
			return;
		}
		// 入口校验：触发位图的页视图仍属于当前文档（换文档瞬间的旧位图不得
		// 回填到新文档的卡上）；后续 await 期间换文档也无害——docId 与 pv 同源
		if (this.pageViewByNumber.get(pv.pageNumber) !== pv) {
			return;
		}
		const docId = this.currentDocId;
		if (!docId) {
			return;
		}
		try {
			const cards = await this.plugin.cards.listByDocument(docId);
			const pending = cards.filter(
				(c) => c.page === pv.pageNumber && this.needsRegionSnapshot(c),
			);
			let allOk = true;
			for (const card of pending) {
				const ref = await this.snapshotForCard(pv.pageNumber, card.rects[0], card.polygon);
				if (ref) {
					this.plugin.cards.update(card.id, { excerptRef: ref });
				} else {
					allOk = false; // 保留页条目，下次渲染重试
				}
			}
			// 全部成功或本就无 pending（卡可能已被删）→ 页条目使命完成
			if (allOk) {
				this.pagesNeedingBackfill.delete(pv.pageNumber);
			}
		} catch (err) {
			// 回填是尽力而为的增强路径，失败静默（下次渲染重试）
			console.debug("[MarinMind] 区域快照回填跳过", err);
		}
	}

	/** 留白确认：创建 blank 卡片（最小锚点矩形供定位，笔记文字写入 excerptText） */
	private createBlankCard(pageNumber: number, anchor: DocRect, note: string): void {
		if (!this.currentDocId) {
			return;
		}
		this.plugin.cards.create({
			documentId: this.currentDocId,
			page: pageNumber,
			rects: [anchor],
			excerptType: "blank",
			excerptText: note,
			color: this.plugin.settings.excerptColors.blank, // ㊹ 跟随留白工具当前色系
		});
	}

	/** 留白点击回调：弹 TextPromptModal 收集文字，确认后落卡 */
	private promptBlankNote(point: { page: number; localX: number; localY: number }): void {
		new TextPromptModal(
			this.app,
			{
				title: t("留白备注"),
				initialText: "",
				placeholder: t("输入留白备注文字…"),
			},
			(note: string | null) => {
				const text = note?.trim();
				if (!text || this.activeTool !== "blank" || !this.currentDocId) {
					return;
				}
				// 用 6x6px 的最小锚点矩形（避免空 rects 无法精确定位）
				const pv = this.pageViewByNumber.get(point.page);
				if (!pv) {
					return;
				}
				const pageW = pv.displayWidth;
				const pageH = pv.displayHeight;
				const half = 3;
				const cx = Math.min(pageW - half, Math.max(half, point.localX));
				const cy = Math.min(pageH - half, Math.max(half, point.localY));
				const anchor: DocRect = {
					x: (cx - half) / Math.max(1, pageW),
					y: (cy - half) / Math.max(1, pageH),
					w: (2 * half) / Math.max(1, pageW),
					h: (2 * half) / Math.max(1, pageH),
				};
				this.createBlankCard(point.page, anchor, text);
				new Notice("留白备注已保存");
				// 工具保持激活（MarginNote 式连续摘录），可继续点击添加下一条留白备注
			},
		).open();
	}

	/**
	 * 划选文字 → text 卡片闭环：
	 * 逐字符测量并按行聚类（collectSelectionLines），每行收缩到首/末非空白字符——
	 * 行矩形与行文本都不再包含每行行尾的成段空白（只修剪整体首尾的旧实现
	 * 治不了"中间各行"的行尾空白）。行盒按中心点归属页；跨页选区拦截提示分次选择。
	 */
	private handleSelectionEnd(): void {
		// 文字遮罩模式（74）优先接管：划选即遮罩（不建卡），互斥于下方建卡路径
		if (this.occlusionTextTarget) {
			this.handleOcclusionTextSelection();
			return;
		}
		if (this.activeTool !== "text" || this.handwriteMode || !this.currentDocId) {
			return; // 仅文字摘录工具激活时划选成卡（捕获型工具接管 overlay，本无选区；防御性守卫）
		}
		// 工具栏按钮点击链的 mouseup（75）：抑制旗标短路，不重建快照不重弹
		if (this.selectionToolbar?.takeSuppressSelectionEnd()) {
			return;
		}
		const sel = window.getSelection();
		if (!sel || sel.isCollapsed || sel.rangeCount === 0) {
			return;
		}
		const range = sel.getRangeAt(0);
		// 选区可能来自应用其他区域（键盘残留），限定在本视图内才处理
		if (!this.contentEl.contains(range.commonAncestorContainer)) {
			return;
		}
		// 75 划选工具栏（默认开）：弹工具栏由按钮动作建卡；设置关闭恢复旧版直接建卡
		if (this.plugin.settings.selectionToolbar) {
			const snap = this.buildSelectionSnapshot(range);
			if (snap) {
				this.ensureSelectionToolbar();
				this.selectionToolbar!.show(range, snap);
				// 83-E 侧栏开着且停在翻译页签：划选自动刷新（500ms 防抖限频）
				if (this.tocPanel && this.tocTab === "translate") {
					this.scheduleSidebarTranslate(snap);
				}
			}
			return;
		}
		const lines = collectSelectionLines(range);
		if (lines === null) {
			// 超大选区退回老路径：只修剪整体首尾空白再量矩形（行中行尾空白保留）
			if (!trimRangeToBounds(range)) {
				sel.removeAllRanges();
				return;
			}
			const text = range.toString().trim();
			if (!text) {
				return;
			}
			this.finishTextCard(this.rectsByPageFromRange(range), text, sel);
			return;
		}
		const text = lines.map((l) => l.text).join("\n");
		if (!text) {
			sel.removeAllRanges();
			return;
		}
		// 行盒按中心点归属页（与文字遮罩共用同一归页单源，见 lineBoxesByPage）
		this.finishTextCard(this.lineBoxesByPage(lines), text, sel);
	}

	/**
	 * 文字遮罩划选闭环（74）：选中文字的逐行矩形（collectSelectionLines，精确到
	 * 首末非空白字符）追加为文字遮罩目标的遮挡块——与建卡同源管线，复习正面
	 * 遮挡块位置天然对齐。宁拒不赌：目标卡已删/超大选区/跨页/异页/重复段落
	 * 均拒绝不改库；遮挡块回显走 cardBus changed → syncOcclusionEls（静默）。
	 */
	private handleOcclusionTextSelection(): void {
		const target = this.occlusionTextTarget;
		if (!target || !this.plugin.store) {
			return;
		}
		const sel = window.getSelection();
		if (!sel || sel.isCollapsed || sel.rangeCount === 0) {
			return;
		}
		const range = sel.getRangeAt(0);
		// 选区可能来自应用其他区域（键盘残留），限定在本视图内才处理
		if (!this.contentEl.contains(range.commonAncestorContainer)) {
			return;
		}
		// 目标卡可能已被外部删除（另一标签删卡/复习会话删卡）：即时校验退出
		const latest = this.plugin.cards.get(target.id);
		if (!latest) {
			new Notice("目标卡片已被删除，文字遮罩已退出");
			this.stopOcclusionTextEdit();
			return;
		}
		const lines = collectSelectionLines(range);
		if (lines === null) {
			// 不走建卡的 3000 字回退路径——遮大段文字无意义，宁拒不赌
			new Notice("选区过大，无法生成文字遮罩，请分段划选");
			return;
		}
		const rectsByPage = this.lineBoxesByPage(lines);
		if (rectsByPage.size === 0) {
			return;
		}
		const [page, boxes] = [...rectsByPage.entries()][0];
		if (rectsByPage.size > 1 || page !== latest.page) {
			// 遮挡矩形相对 card.page 所在页归一化，异页写入即错位（选区保留可调整重试）
			new Notice(`选区须与卡片同页（第 ${latest.page} ${this.pageWord}）`);
			return;
		}
		const pageBox = this.pageViewByNumber.get(page)!.el.getBoundingClientRect();
		const merged = mergeTextOcclusions(latest.occlusions, rectsRelativeToPage(boxes, pageBox));
		if (merged.length === latest.occlusions.length) {
			new Notice("该段文字已遮罩");
			return;
		}
		const next = this.plugin.cards.update(latest.id, { occlusions: merged });
		if (next) {
			this.occlusionTextTarget = next; // 同步本地快照，连续划选正确叠加
		}
		sel.removeAllRanges();
	}

	/** 行盒按中心点归属页（文本行的中心必落在渲染该文本的页面内；划选建卡与文字遮罩共用） */
	private lineBoxesByPage(lines: readonly SelectionLine[]): Map<number, ViewportRect[]> {
		return attributeBoxesToPages(
			lines.map((l) => l.box),
			(cx, cy) => this.pageByPoint(cx, cy)?.pageNumber ?? null,
		);
	}

	/** 行矩形归页校验后建 text 卡（跨页拦截；pageBox 归一化入库；回显走 cardBus） */
	private finishTextCard(
		rectsByPage: Map<number, ViewportRect[]>,
		text: string,
		sel: Selection,
	): void {
		if (rectsByPage.size === 0) {
			return;
		}
		if (rectsByPage.size > 1) {
			new Notice("跨页摘录请分次选择");
			return;
		}
		const [page, rects] = [...rectsByPage.entries()][0];
		const pageBox = this.pageViewByNumber.get(page)!.el.getBoundingClientRect();
		// 高亮回显由 cardBus 事件回环完成
		this.plugin.cards.create({
			documentId: this.currentDocId!,
			page,
			rects: rectsRelativeToPage(rects, pageBox),
			excerptType: "text",
			excerptText: text,
			color: this.plugin.settings.excerptColors.text, // ㊹ 跟随文字工具当前色系
			// 77 线型跟随全局设置（underline 归一 null：序列化省键 + 内存规范形）
			lineStyle:
				this.plugin.settings.excerptLineStyle !== "underline"
					? this.plugin.settings.excerptLineStyle
					: null,
		});
		sel.removeAllRanges();
	}

	/**
	 * 构建划选快照（75 工具栏路径）：复刻旧直接建卡管线的行聚类/归页/跨页拦截，
	 * 差异只在产出——show 时刻即归一化为**页相对坐标**（视口矩形随滚动失效，
	 * 页相对坐标不会），按钮动作在任何滚动位置都正确；选区保持（Esc/点外关闭
	 * 后仍可复用，动作收尾才统一清）。返回 null = 不弹工具栏（空文本/归页失败
	 * 静默；跨页沿用旧 Notice 且选区保留可重选）。
	 */
	private buildSelectionSnapshot(range: Range): SelectionSnapshot | null {
		const lines = collectSelectionLines(range);
		let rectsByPage: Map<number, ViewportRect[]>;
		let text: string;
		if (lines === null) {
			// 超大选区退回老路径：只修剪整体首尾空白再量矩形（与直接建卡一致）
			if (!trimRangeToBounds(range)) {
				return null;
			}
			text = range.toString().trim();
			if (!text) {
				return null;
			}
			rectsByPage = this.rectsByPageFromRange(range);
		} else {
			text = lines.map((l) => l.text).join("\n");
			if (!text) {
				return null;
			}
			// 行盒按中心点归属页（与直接建卡/文字遮罩共用同一归页单源，见 lineBoxesByPage）
			rectsByPage = this.lineBoxesByPage(lines);
		}
		if (rectsByPage.size === 0) {
			return null;
		}
		if (rectsByPage.size > 1) {
			new Notice("跨页摘录请分次选择");
			return null;
		}
		const [page, rects] = [...rectsByPage.entries()][0];
		const pageBox = this.pageViewByNumber.get(page)!.el.getBoundingClientRect();
		return { text, page, rects: rectsRelativeToPage(rects, pageBox) };
	}

	/**
	 * 惰性建划选工具栏（75）：首次划选时创建（此刻 docKind 已就绪——书签钮按
	 * 文档形态显隐）；cleanupContent 销毁后换文档自动重建。回调全部以点击时刻
	 * 快照为参（收尾 hide/清选区由工具栏统一做），点击时直读设置保证取值新鲜。
	 */
	private ensureSelectionToolbar(): void {
		if (this.selectionToolbar) {
			return;
		}
		this.selectionToolbar = new SelectionToolbar(this.contentEl, {
			// md 文档书签停用（㊻-B）：书签钮不显示（pdf 页码/epub 章号均可）
			showBookmark: this.docKind !== "md",
			// 77 线型：菜单打开/刷新 title 时刻取值（设置变化即时反映）
			currentLineStyle: () => this.plugin.settings.excerptLineStyle,
			// 97 AI：自定义指令菜单打开时刻取值（设置弹窗增删即时反映）
			customAiPrompts: () => this.plugin.settings.aiCustomPrompts,
			actions: {
				onExcerpt: (snap: SelectionSnapshot, color?: HighlightColorValue) => {
					// 色点 = 该点颜色；摘录钮（color 缺省）= 当前文字工具色
					this.plugin.cards.create({
						documentId: this.currentDocId!,
						page: snap.page,
						rects: snap.rects,
						excerptType: "text",
						excerptText: snap.text,
						color: color ?? this.plugin.settings.excerptColors.text,
						// 77 线型跟随全局设置（underline 归一 null：序列化省键 + 内存规范形）
						lineStyle:
							this.plugin.settings.excerptLineStyle !== "underline"
								? this.plugin.settings.excerptLineStyle
								: null,
					});
					// 回显走 cardBus 事件回环（无 Notice——高亮即反馈，与旧直接建卡一致；
					// 自动入图/自动闪卡 Notice 由 main.ts 既有订阅承接）
				},
				onPickLineStyle: (style: LineStyle) => {
					// 镜像 cycleExcerptColor 即时写回样板：改设置 → saveData → 刷新钮 → Notice
					this.plugin.settings.excerptLineStyle = style;
					void this.plugin.saveData({ ...this.plugin.settings });
					this.selectionToolbar?.syncLineStyle();
					new Notice(`文字摘录线型：${LINE_STYLE_LABELS[style]}`);
				},
				onTranslate: (snap: SelectionSnapshot) => {
					// 83-E 划选改译入侧栏（即时对照不建卡；引擎/凭据问题在侧栏内
					// 展示错误态）；点已有高亮的 openTranslate 仍走弹窗——双入口分离
					this.pushTranslateToSidebar(snap, { toggleOpen: true });
				},
				onAiAction: (snap: SelectionSnapshot, action: AiMenuAction) => {
					// 97 划选 AI 操作（解释/总结/改写/自定义）：结果弹窗流式展示，
					// 可转为卡片（原文下方留白）——docId 在打开时刻捕获（弹窗内
					// 换文档不误挂，镜像 75 批 onTranslate 的捕获语义）
					this.openAiAction(snap, action);
				},
				onAiCardgen: (snap: SelectionSnapshot) => {
					// 99 划选 AI 制卡：材料=划选文本，锚点=选区页相对矩形——
					// 生成的卡继承回链（自动入图归章 + 跳原文）。docId 打开时刻
					// 捕获（镜像 onAiAction）
					const docId = this.currentDocId;
					if (!docId) {
						return;
					}
					new AiCardgenModal(this.app, this.plugin, {
						sourceText: snap.text,
						anchor: { documentId: docId, page: snap.page, rects: snap.rects },
					}).open();
				},
				onCopy: (text: string) => {
					void (async () => {
						try {
							await navigator.clipboard.writeText(text);
							new Notice("已复制选中文字");
						} catch (err) {
							console.error("[MarinMind] 复制选中文字失败", err);
							new Notice("复制失败（剪贴板不可用）");
						}
					})();
				},
				onBookmark: (snap: SelectionSnapshot) => {
					const docId = this.currentDocId;
					if (!docId) {
						return;
					}
					// 书签名 = 选中文本截断 30 字（超长省略号）
					const label = snap.text.length > 30 ? `${snap.text.slice(0, 30)}…` : snap.text;
					this.plugin.bookmarks.add(docId, snap.page, label);
					// ㊳ 跨标签：同文档的全部阅读视图侧栏一起刷新（含本视图）
					this.plugin.refreshReaderBookmarks(docId);
					new Notice(`书签已添加（第 ${snap.page} ${this.pageWord}）`);
				},
				onSearch: (text: string) => {
					// Obsidian 全局搜索为内置插件：internalPlugins 私有 API 守卫窄化，
					// 未命中（旧版/被禁用）宁拒不赌（镜像 executeCommandById 先例的防御风格）
					const internalPlugins = (
						this.app as unknown as {
							internalPlugins?: {
								getPluginById?: (id: string) =>
									| {
											instance?: {
												openGlobalSearch?: (query: string) => void;
											};
									  }
									| undefined;
							};
						}
					).internalPlugins;
					const openGlobalSearch =
						internalPlugins?.getPluginById?.("global-search")?.instance
							?.openGlobalSearch;
					if (typeof openGlobalSearch === "function") {
						openGlobalSearch(text);
					} else {
						new Notice("未找到全局搜索插件");
					}
				},
			},
		});
	}

	/** 整段 Range 的 client rects 按中心点归属页（超大选区的老路径；归页单源见 selection-geometry） */
	private rectsByPageFromRange(range: Range): Map<number, ViewportRect[]> {
		const rects = Array.from(range.getClientRects())
			.filter((r) => r.width > 0 && r.height > 0)
			.map((r) => ({ left: r.left, top: r.top, width: r.width, height: r.height }));
		return attributeBoxesToPages(
			rects,
			(cx, cy) => this.pageByPoint(cx, cy)?.pageNumber ?? null,
		);
	}

	/** 视口坐标点落在哪页（选区归属判定；只查已建骨架的页——选区只可能来自它们） */
	private pageByPoint(cx: number, cy: number): PageView | null {
		for (const pv of this.pageViewByNumber.values()) {
			const box = pv.el.getBoundingClientRect();
			if (cx >= box.left && cx <= box.right && cy >= box.top && cy <= box.bottom) {
				return pv;
			}
		}
		return null;
	}

	/** 点击高亮：弹出卡片信息与操作菜单；联动定位打开着的脑图（文档→脑图） */
	private onHighlightClick(card: Card, evt: MouseEvent): void {
		// 该卡在某张打开的脑图中 → 画布平移到对应节点并闪烁；不在图中无动作
		this.plugin.locateCardInMindmaps(card.id);
		const info = card.note ?? card.excerptText ?? "区域摘录";
		// R2（E2-05）：菜单首项 30 字截断（镜像脑图节点菜单先例）——长摘录整段
		// 进 Menu title 会折行爆高数屏
		const infoBrief = info.length > 30 ? `${info.slice(0, 30)}…` : info;
		const menu = new Menu();
		menu.addItem((item) =>
			item
				.setTitle(`第 ${card.page} ${this.pageWord} · ${infoBrief}`)
				.setIcon("square-pen")
				.setDisabled(true),
		);
		// R4 D4-01: 阅读器高亮右键菜单分组
		// 定位组
		const isFlashcard = this.plugin.reviews.get(card.id)?.isFlashcard ?? false;
		menu.addItem((item) =>
			item
				.setTitle(isFlashcard ? "取消闪卡" : "转为闪卡")
				// P2-1：layers 语义已被主页「卡片」导航占用，闪卡对齐工具行 zap 图标
				.setIcon(isFlashcard ? "zap" : "graduation-cap")
				.onClick(() => {
					if (isFlashcard) {
						this.plugin.reviews.disable(card.id);
					} else {
						this.plugin.reviews.enable(card.id);
					}
				}),
		);
		// 编辑组
		menu.addItem((item) =>
			item
				.setTitle(t("编辑标题/批注"))
				.setIcon("pencil")
				.onClick(() => {
					// 78 统一标题/批注双字段（card-actions 单源，与脑图节点编辑器同源语义）；
					// 各视图同步由 cardBus 事件回环完成
					promptCardEdit(this.app, this.plugin, card);
				}),
		);
		// 颜色 + 线型（77）
		menu.addItem((item) =>
			item
				.setTitle(t("颜色…"))
				.setIcon("palette")
				.onClick(() => {
					// 多色高亮（㊳）：改色走 cards.update → cardBus changed → 各视图回环
					new HighlightColorModal(this.app, card.color ?? null, (color) => {
						this.plugin.cards.update(card.id, { color });
					}).open();
				}),
		);
		if (card.excerptType === "text") {
			menu.addItem((item) =>
				item
					.setTitle(t("线型…"))
					.setIcon("underline")
					.onClick((evt) => {
						const current = highlightLineStyle(card);
						const picker = new Menu();
						for (const style of LINE_STYLES) {
							picker.addItem((it) =>
								it
									.setTitle(LINE_STYLE_LABELS[style])
									.setIcon(LINE_STYLE_ICONS[style])
									.setChecked(style === current)
									.onClick(() => {
										// 改回下划线 = null（序列化省键，与 color null 同构）
										this.plugin.cards.update(card.id, {
											lineStyle: style === "underline" ? null : style,
										});
									}),
							);
						}
						// onClick 回调签名含 KeyboardEvent（键盘激活菜单项），无鼠标坐标时落屏幕中上
						if (evt instanceof MouseEvent) {
							picker.showAtMouseEvent(evt);
						} else {
							picker.showAtPosition({
								x: window.innerWidth / 2,
								y: window.innerHeight / 3,
							});
						}
					}),
			);
		}
		// 链接组
		menu.addItem((item) =>
			item
				.setTitle(t("复制卡片链接"))
				.setIcon("link")
				.onClick(() => void this.plugin.copyCardLink(card, "link")),
		);
		menu.addItem((item) =>
			item
				.setTitle(t("复制嵌入代码"))
				.setIcon("copy")
				.onClick(() => void this.plugin.copyCardLink(card, "embed")),
		);
		// 工具组
		menu.addSeparator();
		// OCR：区域/手写摘录有矩形才可识别（文字摘录已有文本，照片无矩形）；
		// ㊻-B md 文档无 pdf 位图可离屏渲染，不给入口
		if (
			!this.isReflowDoc &&
			(card.excerptType === "area" || card.excerptType === "handwriting") &&
			card.page != null &&
			card.rects.length > 0
		) {
			menu.addItem((item) =>
				item
					.setTitle(t("识别文字 (OCR)"))
					.setIcon("scan-text")
					.onClick(() => void this.ocrCard(card)),
			);
		}
		// 翻译 / AI 制卡：有摘录文字才可用（文字摘录 / OCR 过的区域、手写卡；
		// MN4 内置翻译对齐）——104-C 起与本项解耦，见下方 AI 补充解释
		if ((card.excerptText ?? "").trim().length > 0) {
			menu.addItem((item) =>
				item
					.setTitle(t("翻译"))
					.setIcon("languages")
					.onClick(() => this.openTranslate(card)),
			);
			// 99 AI 制卡：摘录文字为材料出 QA/填空卡，继承本文档锚点（自动入图归章）
			menu.addItem((item) =>
				item
					.setTitle(t("AI 制卡…"))
					.setIcon("list-checks")
					.onClick(() => promptCardGen(this.app, this.plugin, card)),
			);
		}
		// 104-C AI 评论扩全摘录类型：有文字 / 图片类摘录（vision 直发快照）/
		// audio 有批注均可解释（canCardAiComment 单源——卡片预览 ⋯ 同款）；
		// 「填入批注」经人手确认后落库（card-actions 单源共享）
		if (canCardAiComment(card)) {
			menu.addItem((item) =>
				item
					.setTitle(t("AI 补充解释"))
					.setIcon("sparkles")
					.onClick(() => void promptCardAiComment(this.app, this.plugin, card)),
			);
		}
		// 84-D 照片重定位：把照片以虚线展示框锚定到当前页某处（MN 式"贴"到页面）；
		// 已定位可取消（rects 清空回页角徽标锚定，跳转降级路径随之恢复）
		if (card.excerptType === "photo" && card.page != null) {
			menu.addItem((item) =>
				item
					.setTitle(t("定位到页面…"))
					.setIcon("crosshair")
					.onClick(() => this.startPhotoRelocate(card)),
			);
			if (card.rects.length > 0) {
				menu.addItem((item) =>
					item
						.setTitle(t("取消定位"))
						.setIcon("locate-off")
						.onClick(() => {
							this.plugin.cards.update(card.id, { rects: [] });
						}),
				);
			}
		}
		// 遮挡（㊷）：有页矩形的卡支持划遮挡区域（photo/audio 无矩形不给入口；
		// 84-D photo 定位后 rects 是展示框不是摘录区域，同样不给——photo 遮挡走
		// 预览弹窗的图内坐标编辑）；复习正面遮住遮挡区（可揭开），阅读器只画虚线标记不遮内容
		if (card.rects.length > 0 && card.page != null && card.excerptType !== "photo") {
			menu.addItem((item) =>
				item
					.setTitle(t("遮挡区域…"))
					.setIcon("eye-off")
					.onClick(() => this.startOcclusionEdit(card)),
			);
			// 文字遮罩（74）：划选文字即遮罩——逐行矩形精确到选中字符（cloze 语义，
			// 与拖框遮挡互斥的瞬态模式）；入口与遮挡区域同守卫（photo/audio 无矩形不给）
			menu.addItem((item) =>
				item
					.setTitle(t("文字遮罩…"))
					.setIcon("text-select")
					.onClick(() => this.startOcclusionTextEdit(card)),
			);
			// 71 行吸附开关（会话态）：text 卡拖框时垂直吸附整行，防半行残字
			menu.addItem((item) =>
				item
					.setTitle(
						this.occlusionSnapLines
							? "遮挡行吸附（当前开，点击关）"
							: "遮挡行吸附（拖框吸附整文字行）",
					)
					.setIcon("magnet")
					.onClick(() => {
						this.occlusionSnapLines = !this.occlusionSnapLines;
						new Notice(this.occlusionSnapLines ? "遮挡行吸附：开" : "遮挡行吸附：关");
					}),
			);
			if (card.occlusions.length > 0) {
				menu.addItem((item) =>
					item
						.setTitle(t("清除遮挡"))
						.setIcon("eraser")
						.onClick(() => {
							this.plugin.cards.update(card.id, { occlusions: [] });
						}),
				);
				menu.addItem((item) =>
					item
						.setTitle(
							this.occlusionPreview
								? "遮挡预览（当前开，点击关）"
								: "遮挡预览（模拟复习遮挡）",
						)
						.setIcon("eye")
						.onClick(() => this.toggleOcclusionPreview()),
				);
			}
		}
		// 脑图组
		menu.addItem((item) =>
			item
				.setTitle(t("加入思维导图…"))
				.setIcon(ADD_TO_MINDMAP_ICON)
				.onClick(() => this.addToMindmap(card)),
		);
		// 危险操作
		menu.addSeparator();
		menu.addItem((item) =>
			item
				.setTitle(t("删除卡片"))
				.setIcon("trash-2")
				.onClick(() => this.deleteCard(card)),
		);
		menu.showAtMouseEvent(evt);
	}

	// ---------- 闪卡遮挡（㊷） ----------

	/** 进入遮挡编辑模式：目标卡所在页可拖框画遮挡（连续多个），Esc/切工具退出 */
	private startOcclusionEdit(card: Card): void {
		this.selectionToolbar?.hide(); // 75 瞬态模式互斥：工具栏先隐（选区保留）
		// 与文字遮罩模式互斥（74）：显式退出——两模式共用 Esc/切工具退出链，
		// 同时激活会让 overlay 类叠加语义混乱
		if (this.occlusionTextTarget) {
			this.stopOcclusionTextEdit();
		}
		this.occlusionEditTarget = card;
		for (const layer of this.excerptLayers.values()) {
			layer.setOcclusionTarget(card); // 层内按页号过滤，只有目标页真正接管
		}
		new Notice("拖拽框选遮挡区域（可连续多个），Esc 结束", 6000);
	}

	/** 退出遮挡编辑模式（Esc / 切换工具 / 关闭文档） */
	private stopOcclusionEdit(): void {
		this.occlusionEditTarget = null;
		for (const layer of this.excerptLayers.values()) {
			layer.setOcclusionTarget(null);
		}
	}

	/**
	 * 进入文字遮罩模式（74）：划选文字即把选中段落的逐行矩形追加为该卡遮挡——
	 * 与「遮挡区域…」拖框互斥的瞬态模式。overlay 必须保持穿透放行原生划选，
	 * 因此强制回到 text 工具（excerpt-on 的 user-select:none 会阻断选区；
	 * setReaderTool 同工具幂等早退不清瞬态模式/手写，互斥与退出显式做）。
	 * 被目标卡自身高亮（整行盒盖在文本上方）覆盖的文字，经层的
	 * marinmind-occlusion-text-on 类关掉高亮/遮挡块指针事件后可正常起笔选区。
	 */
	private startOcclusionTextEdit(card: Card): void {
		this.selectionToolbar?.hide(); // 75 瞬态模式互斥：工具栏先隐（选区保留）
		if (this.occlusionEditTarget) {
			this.stopOcclusionEdit(); // 互斥：退出拖框遮挡模式
		}
		if (this.handwriteMode) {
			this.setHandwriteMode(false);
		}
		if (this.activeTool !== "text") {
			this.setReaderTool("text"); // 内部清 occlusionEditTarget 并保证 overlay 穿透
		}
		this.occlusionTextTarget = card;
		for (const layer of this.excerptLayers.values()) {
			layer.setOcclusionTextTarget(card); // 层内按页号过滤，只有目标页真正接管
		}
		new Notice("划选文字即遮罩（可连续多段），Esc 结束", 6000);
	}

	/** 退出文字遮罩模式（Esc / 切换工具 / 关闭文档 / 目标卡被删） */
	private stopOcclusionTextEdit(): void {
		this.occlusionTextTarget = null;
		for (const layer of this.excerptLayers.values()) {
			layer.setOcclusionTextTarget(null);
		}
	}

	/**
	 * 遮挡拖框完成：追加给目标卡（changed 事件回环让遮挡块即时回显）。
	 * 71 行吸附：开关开且 text 卡时先 snapOcclusionToLines 吸附到整行——
	 * text 卡 rects 即逐行矩形（数据源 card 本身），垂直吸附整行防半行残字。
	 */
	private onOcclusionDraw(_page: number, rect: DocRect): void {
		const target = this.occlusionEditTarget;
		if (!target || !this.plugin.store) {
			return;
		}
		const snapped =
			this.occlusionSnapLines && target.excerptType === "text"
				? snapOcclusionToLines(rect, target.rects)
				: rect;
		const next = this.plugin.cards.update(target.id, {
			occlusions: [...target.occlusions, snapped],
		});
		if (next) {
			this.occlusionEditTarget = next; // 同步本地快照，连续绘制正确叠加
		}
	}

	/** 进入照片重定位模式（84-D）：目标卡所在页拖框即新展示框，Esc/切工具退出 */
	private startPhotoRelocate(card: Card): void {
		this.selectionToolbar?.hide(); // 75 瞬态模式互斥：工具栏先隐（选区保留）
		// 与遮挡编辑/文字遮罩互斥：共用 Esc/切工具退出链，同时激活语义混乱
		if (this.occlusionEditTarget) {
			this.stopOcclusionEdit();
		}
		if (this.occlusionTextTarget) {
			this.stopOcclusionTextEdit();
		}
		if (this.handwriteMode) {
			this.setHandwriteMode(false);
		}
		this.photoRelocateTarget = card;
		for (const layer of this.excerptLayers.values()) {
			layer.setRelocateTarget(card); // 层内按页号过滤，只有目标页真正接管
		}
		new Notice("拖拽框选照片展示位置，Esc 结束", 6000);
	}

	/** 退出照片重定位模式（Esc / 切换工具 / 关闭文档 / 目标卡被删） */
	private stopPhotoRelocate(): void {
		this.photoRelocateTarget = null;
		for (const layer of this.excerptLayers.values()) {
			layer.setRelocateTarget(null);
		}
	}

	/**
	 * 照片重定位拖框完成（84-D）：rects 整体替换为单一展示框——
	 * changed 回环走 handleCardChanged 的 photo syncCard 重建展示框。
	 */
	private onRelocateDraw(_page: number, rect: DocRect): void {
		const target = this.photoRelocateTarget;
		if (!target) {
			return;
		}
		const next = this.plugin.cards.update(target.id, { rects: [rect] });
		if (next) {
			this.photoRelocateTarget = next; // 同步本地快照，连续调整不写回旧值
		}
	}

	/** 点击遮挡块：删除该块 / 清除全部 / 预览开关 */
	private onOcclusionClick(card: Card, index: number, evt: MouseEvent): void {
		const menu = new Menu();
		menu.addItem((item) =>
			item
				.setTitle(t("删除此遮挡"))
				.setIcon("eraser")
				.onClick(() => {
					this.plugin.cards.update(card.id, {
						occlusions: card.occlusions.filter((_, i) => i !== index),
					});
				}),
		);
		if (card.occlusions.length > 1) {
			menu.addItem((item) =>
				item
					.setTitle(t("清除全部遮挡"))
					.setIcon("trash-2")
					.onClick(() => {
						this.plugin.cards.update(card.id, { occlusions: [] });
					}),
			);
		}
		menu.addItem((item) =>
			item
				.setTitle(
					this.occlusionPreview
						? "遮挡预览（当前开，点击关）"
						: "遮挡预览（模拟复习遮挡）",
				)
				.setIcon("eye")
				.onClick(() => this.toggleOcclusionPreview()),
		);
		menu.showAtMouseEvent(evt);
	}

	/** 遮挡预览开关：遮挡块虚线 ⇄ 实心覆盖（会话态，不持久化） */
	private toggleOcclusionPreview(): void {
		this.occlusionPreview = !this.occlusionPreview;
		for (const layer of this.excerptLayers.values()) {
			layer.setOcclusionPreview(this.occlusionPreview);
		}
	}

	/**
	 * OCR 专用离屏页渲染（83 抽公共，ocrCard/ocrPage 共用）：目标物理宽约
	 * 2200px 高清渲染，isolated 模式不打断显示渲染也不被打断；renderTo 内部
	 * 16M 像素钳制自动兜底。返回 null = 渲染期文档被销毁（done 静默返回），
	 * 调用方放弃本次识别。
	 */
	private async renderPageCanvas(page: number): Promise<HTMLCanvasElement | null> {
		const pdf = this.pdf;
		if (!pdf) {
			return null;
		}
		const size = await pdf.getPageSize(page);
		const cssScale = Math.max(1, 2200 / size.width);
		const canvas = document.createElement("canvas");
		await pdf.renderTo(canvas, page, cssScale, { isolated: true }).done;
		return canvas.width === 0 ? null : canvas;
	}

	/**
	 * 区域/手写卡 OCR：离屏高清渲染该页 → 逐矩形识别 → 写回 excerptText。
	 * 渲染用 isolated 模式（不打断显示渲染也不被打断）；已有文字时确认覆盖；
	 * 失败 Notice 明示首次需联网下载引擎。
	 */
	private async ocrCard(card: Card): Promise<void> {
		// tesseract 的 worker/WASM 在移动端 Obsidian 不可用，入口直接禁用
		if (Platform.isMobile) {
			new Notice("移动端暂不支持 OCR");
			return;
		}
		// 83 手写卡分流：识别对象是笔迹 PNG 附件而非 PDF 原页（老路径识到的是
		// 笔迹下方的原文——错位 bug 即在此）；分流后无需 pdf/page/rects 守卫
		if (card.excerptType === "handwriting" && card.excerptRef) {
			await this.ocrHandwritingCard(card);
			return;
		}
		const pdf = this.pdf;
		const page = card.page;
		if (!pdf || page == null || card.rects.length === 0) {
			return;
		}
		// 85-C 提示分流：引擎已就绪（本会话加载成功过）不再附"首次需联网下载"
		const notice = new Notice(
			ocrStartNotice("region", isOcrEngineReady(this.plugin.settings.ocrLangs)),
			0,
		);
		try {
			const canvas = await this.renderPageCanvas(page);
			if (!canvas) {
				return; // 渲染期文档被销毁：放弃本次识别
			}
			const text = await ocrCanvasRegions(canvas, card.rects, {
				// 83：识别语言跟随设置（引擎层按语言自动重建 worker）
				langs: this.plugin.settings.ocrLangs,
				onStatus: (u) => {
					if (u.progress != null && u.progress > 0 && u.progress < 1) {
						notice.setMessage(`正在识别文字… ${Math.round(u.progress * 100)}%`);
					}
				},
			});
			if (!text) {
				new Notice("未识别出文字（区域可能不含文本，或清晰度不足）");
				return;
			}
			this.applyOcrText(card, text);
		} catch (err) {
			console.error("[MarinMind] OCR 失败", err);
			// 85-C：未就绪时失败大概率是引擎下载未完成；已就绪给通用提示
			new Notice(ocrFailNotice(isOcrEngineReady(this.plugin.settings.ocrLangs)));
		} finally {
			notice.hide();
		}
	}

	/**
	 * OCR 结果写卡公共尾部（83 抽出，区域/手写两路共用）：已有文字时确认覆盖；
	 * 写入成功后按「识别后自动翻译」开关触发翻译流水线。
	 */
	private applyOcrText(card: Card, text: string): void {
		const apply = () => {
			// 各视图同步由 cardBus 事件回环完成
			this.plugin.cards.update(card.id, { excerptText: text });
			new Notice("已识别文字并写入卡片（复习/脑图自动显示该文本）");
			// 83 OCR→翻译流水线：fire-and-forget——翻译失败与识别成功完全解耦
			if (this.plugin.settings.ocrAutoTranslate) {
				void this.autoTranslateOcr(card, text);
			}
		};
		if (card.excerptText) {
			new ConfirmModal(
				this.app,
				"覆盖已有识别文字？",
				"该卡片已有摘录文字，OCR 结果将替换它。",
				apply,
			).open();
		} else {
			apply();
		}
	}

	/**
	 * OCR→翻译流水线（83，MN4「AI OCR 翻译」语义）：识别文字自动翻译并经
	 * saveTranslationAsBlank 存为原文正下方留白（锚点/色系/cardBus 全部复用）；
	 * 目标语言与引擎跟随翻译设置。任何失败只 Notice（明示识别文字已保存）。
	 */
	private async autoTranslateOcr(source: Card, text: string): Promise<void> {
		if (text.length > MAX_TRANSLATE_CHARS) {
			new Notice(
				`识别文字过长（${text.length} 字符，上限 ${MAX_TRANSLATE_CHARS}），已跳过自动翻译`,
			);
			return;
		}
		try {
			const call = resolveEngineCall(this.plugin.settings);
			const out = await translateText(text, this.plugin.settings.translateTarget, call);
			this.saveTranslationAsBlank(source, out.text);
			new Notice("已自动翻译并存为留白（原文正下方对照）");
		} catch (err) {
			console.warn("[MarinMind] OCR 自动翻译失败", err);
			new Notice(
				`自动翻译失败：${err instanceof Error ? err.message : String(err)}（识别文字已保存）`,
			);
		}
	}

	/**
	 * 手写卡 OCR（83 修复错位）：读笔迹 PNG 附件 → 合成**白底**画布（tesseract
	 * 对透明底识别率极低）+ 2× 放大（PNG 本身按 2× 页基准导出，合计 4× 有效
	 * 分辨率；16M 像素钳超限按 sqrt 保比例回缩）→ SPARSE_TEXT 识别散落笔迹。
	 * 老路径渲染 PDF 原页识别，识到的是笔迹**下方原文**而非笔迹本身——此路修复。
	 */
	private async ocrHandwritingCard(card: Card): Promise<void> {
		const notice = new Notice("正在识别手写笔迹…", 0);
		try {
			const bytes = await this.plugin.attachments.read(card.excerptRef!);
			const bitmap = await createImageBitmap(new Blob([bytes]));
			let scale = 2;
			if (bitmap.width * bitmap.height * scale * scale > 16_000_000) {
				scale = Math.max(1, Math.sqrt(16_000_000 / (bitmap.width * bitmap.height)));
			}
			const canvas = document.createElement("canvas");
			canvas.width = Math.max(1, Math.round(bitmap.width * scale));
			canvas.height = Math.max(1, Math.round(bitmap.height * scale));
			const ctx = canvas.getContext("2d");
			if (!ctx) {
				bitmap.close();
				return;
			}
			ctx.imageSmoothingEnabled = true;
			ctx.fillStyle = "#ffffff";
			ctx.fillRect(0, 0, canvas.width, canvas.height);
			ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
			bitmap.close();
			const text = await ocrCanvasRegions(canvas, [{ x: 0, y: 0, w: 1, h: 1 }], {
				langs: this.plugin.settings.ocrLangs,
				// 散落手写笔迹无版面结构：跳过版面分析（SINGLE 系会把多行当一行）
				psm: "11",
				onStatus: (u) => {
					if (u.progress != null && u.progress > 0 && u.progress < 1) {
						notice.setMessage(`正在识别手写笔迹… ${Math.round(u.progress * 100)}%`);
					}
				},
			});
			if (!text) {
				new Notice(
					"未识别出手写文字（tesseract 对自由手写识别率有限，较工整的字迹效果更好）",
				);
				return;
			}
			this.applyOcrText(card, text);
		} catch (err) {
			console.error("[MarinMind] 手写 OCR 失败", err);
			new Notice("手写 OCR 失败：附件读取或引擎初始化异常，请稍后重试");
		} finally {
			notice.hide();
		}
	}

	/**
	 * 整页 OCR（83，页面右键菜单入口）：整页一次识别（行级 blocks）→ 逐行
	 * rects 建 text 卡——复用现有多行下划线回显，跳原文/自动入图/转闪卡照常。
	 * 不走「识别后自动翻译」：整页长文触发大额翻译与留白洪水，语义不符
	 * （整页识别是批量建卡，不是单点摘录）。
	 */
	private async ocrPage(page: number): Promise<void> {
		if (Platform.isMobile) {
			new Notice("移动端暂不支持 OCR");
			return;
		}
		const docId = this.currentDocId; // await 前捕获，识别期换文档不误挂
		if (!this.pdf || this.isReflowDoc || !docId) {
			return;
		}
		// 85-C 提示分流：引擎已就绪不再附"首次需联网下载"（镜像区域识别）
		const notice = new Notice(
			ocrStartNotice("page", isOcrEngineReady(this.plugin.settings.ocrLangs)),
			0,
		);
		try {
			const canvas = await this.renderPageCanvas(page);
			if (!canvas) {
				return;
			}
			const { text, lines } = await ocrCanvasPageLines(canvas, {
				// 83：识别语言跟随设置（引擎层按语言自动重建 worker）
				langs: this.plugin.settings.ocrLangs,
				onStatus: (u) => {
					if (u.progress != null && u.progress > 0 && u.progress < 1) {
						notice.setMessage(`正在识别整页文字… ${Math.round(u.progress * 100)}%`);
					}
				},
			});
			if (lines.length === 0 || !text) {
				new Notice("未识别出文字（页面可能不含文本，或清晰度不足）");
				return;
			}
			// 高亮回显/自动入图/自动闪卡均由 cardBus 事件回环承接
			this.plugin.cards.create({
				documentId: docId,
				page,
				rects: lines.map((l) => l.rect),
				excerptType: "text",
				excerptText: text,
				color: this.plugin.settings.excerptColors.text,
				// 77 线型跟随全局设置（underline 归一 null：序列化省键 + 内存规范形）
				lineStyle:
					this.plugin.settings.excerptLineStyle !== "underline"
						? this.plugin.settings.excerptLineStyle
						: null,
			});
			new Notice(`已识别 ${lines.length} 行文字并创建文字摘录卡（跳原文/入图/转闪卡均可用）`);
		} catch (err) {
			console.error("[MarinMind] 整页 OCR 失败", err);
			// 85-C：失败提示按就绪态分流（镜像区域识别）
			new Notice(ocrFailNotice(isOcrEngineReady(this.plugin.settings.ocrLangs)));
		} finally {
			notice.hide();
		}
	}

	/**
	 * 翻译卡片摘录文字（㉔，MN4「翻译及保存译文」对齐）：弹窗内可切换
	 * 目标语言（13 种，切换即写回设置）；译文可复制或存为留白（原文下方并排对照）。
	 */
	private openTranslate(card: Card): void {
		const source = card.excerptText?.trim();
		if (!source) {
			return;
		}
		// 83 多引擎：设置切到百度/DeepL 而凭据未填时，入口直接提示不开弹窗
		let engineCall: EngineCall;
		try {
			engineCall = resolveEngineCall(this.plugin.settings);
		} catch (err) {
			new Notice(err instanceof Error ? err.message : String(err));
			return;
		}
		new TranslateModal(this.app, {
			sourceText: source,
			target: this.plugin.settings.translateTarget,
			engineCall,
			onTargetChange: (code) => {
				// 弹窗内切换即持久化，下次打开沿用
				this.plugin.settings.translateTarget = code;
				void this.plugin.saveData({ ...this.plugin.settings });
			},
			onSaveBlank: (translation) => this.saveTranslationAsBlank(card, translation),
		}).open();
	}

	/**
	 * 译文存为留白卡片：锚点取原文矩形正下方（并排对照），建卡走 cards.create——
	 * 高亮回显/多标签同步/自动收录均由 cardBus 事件回环承接，与手动留白零差异
	 */
	private saveTranslationAsBlank(source: Card, translation: string): void {
		if (source.page == null) {
			new Notice("该卡片没有页码定位，无法放置译文留白");
			return;
		}
		this.plugin.cards.create({
			documentId: source.documentId,
			page: source.page,
			rects: [translationAnchor(source.rects)],
			excerptType: "blank",
			excerptText: translation,
			// ㊹ 与手动留白同色：跟随留白工具当前色系（页面上直接显示译文的胶囊）
			color: this.plugin.settings.excerptColors.blank,
		});
		new Notice("译文已存为留白（原文下方）");
	}

	/**
	 * 划选工具栏译文落留白（75）：镜像 saveTranslationAsBlank——锚点取选区行矩形
	 * 正下方（translationAnchor，并排对照），色随留白工具当前色系；docId 在开弹窗
	 * 时刻由 onTranslate 捕获传入（弹窗内换文档不误挂）
	 */
	private saveTranslationFromSelection(
		docId: string,
		snap: SelectionSnapshot,
		translation: string,
	): void {
		this.plugin.cards.create({
			documentId: docId,
			page: snap.page,
			rects: [translationAnchor(snap.rects)],
			excerptType: "blank",
			excerptText: translation,
			color: this.plugin.settings.excerptColors.blank,
		});
		new Notice("译文已存为留白（原文下方）");
	}

	/**
	 * 划选 AI 操作（97）：结果弹窗流式展示，「转为卡片」把 AI 结果存为原文
	 * 正下方的留白卡（镜像 saveTranslationFromSelection 路径——自动入图/跨
	 * 标签同步由 cardBus 事件回环白赚）。docId 打开时刻捕获（弹窗内换文档
	 * 不误挂）；未配置预设由 sendChat 内 resolveAiPreset 抛中文错在弹窗展示。
	 */
	private openAiAction(snap: SelectionSnapshot, action: AiMenuAction): void {
		const docId = this.currentDocId;
		new AiActionModal(this.app, {
			title: aiActionTitle(action),
			sourceText: snap.text,
			messages: buildAiActionMessages(action, snap.text),
			settings: this.plugin.settings,
			onUsage: (usage) => this.plugin.addAiUsage(usage),
			apply: {
				label: t("转为卡片"),
				onApply: (text) => {
					if (!docId) {
						new Notice("原文文档已关闭，无法定位");
						return;
					}
					this.saveAiResultFromSelection(docId, snap, text);
				},
			},
		}).open();
	}

	/** AI 结果落留白（97）：锚点取选区行矩形正下方，色随留白工具当前色系 */
	private saveAiResultFromSelection(
		docId: string,
		snap: SelectionSnapshot,
		result: string,
	): void {
		this.plugin.cards.create({
			documentId: docId,
			page: snap.page,
			rects: [translationAnchor(snap.rects)],
			excerptType: "blank",
			excerptText: result,
			color: this.plugin.settings.excerptColors.blank,
		});
		new Notice("AI 结果已存为留白（原文下方）");
	}

	/** 把卡片加入脑图：选图器（可就地新建）→ 根节点区顺延落位为根节点 */
	private addToMindmap(card: Card): void {
		new MindmapPickerModal(this.app, this.plugin, (map) => {
			const roots = this.plugin.mindmaps
				.listNodes(map.id)
				.filter((n) => n.parentId === null)
				.map((n) => ({ x: n.x, y: n.y }));
			const pos = suggestRootPosition(roots);
			const added = this.plugin.mindmaps.addNode(map.id, card.id, null, pos.x, pos.y);
			new Notice(
				added ? `已加入脑图《${map.name}》（根节点区顺延落位）` : "该卡片已在此图中",
			);
		}).open();
	}

	private deleteCard(card: Card): void {
		// 高亮/徽标清理由 cardBus 事件回环完成（handleCardRemoved）
		this.plugin.cards.delete(card.id);
		// 附件随卡片级联删除：uid 唯一命名 ⇒ 一卡一附件（失败静默，下次清理兜底）
		if (card.excerptRef) {
			void this.plugin.attachments.remove(card.excerptRef).catch(() => undefined);
		}
	}

	/**
	 * 84-B 重录语音：删旧建新（范围决策——不做字节级裁剪）。取舍：旧卡标题/批注/
	 * 卡组/复习进度不迁移（语音卡通常无此负担）；新录音锚定当前页。
	 */
	private rerecordAudio(card: Card): void {
		this.deleteCard(card);
		void this.toggleRecording();
	}

	/** 释放全部资源（幂等；onLoadFile 开头 / onUnloadFile / onClose 均调用） */
	private cleanupContent(): void {
		++this.loadToken; // 使在途加载流程作废
		this.pan = null; // 平移中切文档/关视图：立即终止
		this.contentEl.classList.remove("marinmind-panning");
		this.toolBtns.clear(); // 工具行随 contentEl.empty 一并移除，引用同步清理
		// 90 批工具行迁移件：文件名标题与手写按钮随工具行一并移除，引用同步清理
		this.readerTitleEl = null;
		this.handwriteBtn = null;
		// 目录侧栏（㉓）：面板随 contentEl.empty 移除，引用与大纲数据同步清理
		this.tocPanel = null;
		this.tocBtn = null;
		this.overflowBtn = null; // ⋯ 溢出按钮（89）随工具行一并移除
		this.pdfSearchLines.clear(); // 89-D 搜索聚行缓存随文档清（换文档页坐标失效）
		this.occlusionEditTarget = null; // 遮挡编辑是瞬态模式，切文档即失效（㊷）
		this.occlusionTextTarget = null; // 文字遮罩同为瞬态模式（74），切文档即失效
		this.photoRelocateTarget = null; // 照片重定位同为瞬态模式（84-D），切文档即失效
		// 83-E 翻译页签：快照/译文/在途请求/防抖计时器随文档清（防旧译文误挂新文档）
		this.translateSnap = null;
		this.ttEls = null;
		this.ttTranslation = null;
		this.ttRenderedSeq = -1;
		++this.ttToken;
		if (this.ttTimer != null) {
			window.clearTimeout(this.ttTimer);
			this.ttTimer = null;
		}
		// 75 划选工具栏销毁（移除宿主捕获监听；DOM 随下方 empty 一并消亡）
		this.selectionToolbar?.destroy();
		this.selectionToolbar = null;
		this.outlineEntries = [];
		this.outlineLoaded = false; // P2 懒解析状态随文档重置
		this.outlineLoading = null;
		this.docKind = "pdf"; // ㊻-B 会话态复位（防残留到下一份 PDF）
		this.mdText = null;
		// 124 clip 图片 blob 释放（幂等；换文档/关视图均走此处）
		for (const url of this.clipBlobUrls) {
			URL.revokeObjectURL(url);
		}
		this.clipBlobUrls = [];
		// ㊼ epub：会话关闭（revoke 全部图片 blob URL + 摘除链接委托，幂等）后再清引用
		this.epubSession?.close();
		this.epubSession = null;
		this.epub = null;
		// 录音中：保存而非丢弃（误关标签不损失已录内容；docId/page 由函数内部同步捕获）
		void this.stopAndSaveRecording();
		// 手写层：先提交未落库笔迹（layer.commit 同步快照，destroy 不影响其异步完成）
		for (const [page, layer] of this.handwriteLayers) {
			if (layer.hasInk()) {
				this.commitHandwrite(page);
			}
			layer.destroy();
		}
		this.handwriteLayers.clear();
		// 84-A：工具条随会话清场（handwriteMode 布尔跨文档存续，重开后重建）
		this.destroyHandwriteToolbar();
		this.handwriteEraser = false;
		this.lastInkPage = null;
		this.io?.disconnect();
		this.io = null;
		this.visiblePages.clear(); // 旧文档的可见页集合随之失效
		this.pagesNeedingBackfill.clear();
		for (const layer of this.excerptLayers.values()) {
			layer.destroy();
		}
		this.excerptLayers.clear();
		for (const pv of this.pageViewByNumber.values()) {
			pv.unrender();
		}
		this.pageViewByNumber.clear();
		// ㊳ 分块建页/巡检状态（scheduleRest/startSizePatrol 靠 loadToken 守卫自停，无句柄可清）
		this.builtPages = 0;
		this.totalPages = 0;
		this.firstSize = null;
		this.resetFirstBitmapSignal(); // P1 巡检信号：每份文档一份新信号
		this.echoCardsByPage.clear();
		for (const badge of this.mediaBadges.values()) {
			badge.remove();
		}
		this.mediaBadges.clear();
		this.mediaCardsByPage.clear();
		// ㊳ 共享缓存：销毁改由 release 的引用计数管理——最后一个持有者归还才 destroy，
		// 其他标签页/AI 摘录弹窗/复习上下文仍持有的文档不受本视图关闭影响
		this.pdfHandle?.release();
		this.pdfHandle = null;
		this.pdf = null;
		this.scrollEl = null;
		this.currentDocId = null;
		// 80 阅读位置记忆：清 scroll-idle 计时器与基准（防换文档后触发把旧文档
		// 页码写进新文档；openPath/onClose 的兜底采集已在 cleanupContent 之前完成）
		if (this.lastPageTimer != null) {
			window.clearTimeout(this.lastPageTimer);
			this.lastPageTimer = null;
		}
		this.lastPersistedPage = null;
	}

	private showTip(text: string): void {
		this.contentEl.empty();
		const tip = document.createElement("p");
		tip.textContent = text;
		tip.className = "marinmind-reader-tip";
		this.contentEl.appendChild(tip);
	}
}
