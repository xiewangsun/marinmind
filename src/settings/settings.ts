import type { Plugin } from "obsidian";
import { DEFAULT_BACKUP_DIR, DEFAULT_DATA_DIR } from "../constants";
import { DEFAULT_OCR_LANGS, isOcrLangs } from "../ocr/ocr-text";
import { validateWebclipFolder } from "../webclip/clip-url";
import { validateAccelerator } from "../capture/screen-capture";
import {
	DEFAULT_TRANSLATE_TARGET,
	isTranslateEngineId,
	type TranslateEngineId,
} from "../translate/translate-engine";
import { isHighlightColor, type HighlightColorValue } from "../reader/highlight-colors";
import {
	isLinkDirection,
	isLineStyle,
	isSrsScheduler,
	type LineStyle,
	type LinkDirection,
	type SrsScheduler,
} from "../types";
import { isAbsoluteFsPath, normalizeFsDir, normalizeVaultDir } from "../storage/paths";
import {
	EMPTY_AI_USAGE,
	sanitizeAiCustomPrompts,
	sanitizeAiPresets,
	sanitizeAiUsage,
	type AiCustomPrompt,
	type AiPreset,
	type AiUsage,
} from "../ai/ai-provider";

/**
 * 隐藏侧缓存（79-3）：单窗格模式切走（detach）的一侧状态，随 data.json
 * 持久化跨会话保留——重启后切回联动/对侧模式可恢复。读取时内存缓存
 * （main.lastReaderState/lastMapId）优先，此处为重启后的回退源。
 */
export interface WorkspaceHiddenState {
	/** 被隐藏的阅读窗格：文档路径（vault 相对/库外绝对）+ 页码 */
	reader?: { file: string; page: number | null };
	/** 被隐藏的脑图 id */
	mapId?: string;
}

/** 四类摘录工具的当前色系键（㊹ MN3 式：点击已激活的工具按钮循环切色） */
export type ExcerptColorTool = "text" | "area" | "lasso" | "blank";

/**
 * MarinMind 设置（存 .obsidian/plugins/marinmind/data.json，经 Plugin.loadData/saveData）。
 * 兼容策略：合并式加载（缺失字段取默认值、未知字段透传），不引入版本号字段——
 * 各字段均为独立标量，未来新增字段给默认值即可前向兼容。
 */
export interface MarinMindSettings {
	/**
	 * 数据目录：vault 相对路径（如 .marinmind），或桌面端本机绝对路径（如 D:\MarinMindData）。
	 * 数据库 marinmind.db、附件 assets/、导入前快照均落于此；更改经显式迁移流程生效。
	 */
	dataDir: string;
	/** 备份导出目录：规则同 dataDir；只影响后续导出落点，历史备份文件不搬移 */
	backupDir: string;
	/** 翻译目标语言代码（㉔ 高亮菜单「翻译」的默认值；弹窗内切换会写回），见 TRANSLATE_LANGUAGES */
	translateTarget: string;
	/**
	 * 翻译引擎（83 备选引擎）："google"（默认，免密钥）/ "baidu"（国内直连，
	 * 需 appid+密钥）/ "youdao"（85-B 国内直连，需应用ID+密钥）/ "deepl"
	 * （需 Auth-Key）；凭据见下方字段，明文存 data.json（Obsidian 插件通行
	 * 做法，设置页 desc 有提示）。
	 */
	translateEngine: TranslateEngineId;
	translateBaiduAppid: string;
	translateBaiduSecret: string;
	translateYoudaoAppid: string;
	translateYoudaoAppSecret: string;
	translateDeeplKey: string;
	/**
	 * OCR 识别语言组合（83 语言可选）：OCR_LANGUAGES 表内值（"+" 连接 tesseract
	 * 语言串，默认中英混排）；切换后首次识别联网下载对应语言包。
	 */
	ocrLangs: string;
	/**
	 * 拖框即识（83，默认关）：区域摘录工具框选松开即自动 OCR（免去二次点菜单）。
	 * 默认关的原因：首次触发会静默联网下载引擎（10-20MB）+ 连续摘录被逐框识别等待打断。
	 */
	ocrOnAreaExcerpt: boolean;
	/**
	 * 识别后自动翻译（83，默认关）：OCR 识别成功后自动翻译识别文字并存为原文
	 * 下方留白卡（目标语言与引擎跟随翻译设置）；翻译失败不影响识别结果。
	 */
	ocrAutoTranslate: boolean;
	/**
	 * 照片入库压缩（84-E，默认开）：超 300KB 的照片入库前缩放到最长边 2560px
	 * 并转 WebP（q0.85 肉眼无损）；GIF/SVG 与小图原样保留。关闭则原图存档。
	 */
	photoCompress: boolean;
	/** 摘录自动入图总开关（㉗，默认开）：新摘录自动加入脑图——固定根节点优先，否则该书的默认脑图 */
	autoAddToMindmap: boolean;
	/**
	 * 主页外观（㊲ 起，㊸ 三态）："dark" Linear 深色（默认）/
	 * "light" Linear 浅色（㊸ 变量镜像组）/"auto" 跟随 Obsidian 主题（走全局变量）。
	 */
	homeTheme: "dark" | "light" | "auto";
	/** 主页文档页展示模式（㊵）："list" 列表（默认，旧行为）/"grid" 窗格（PDF 封面书架）；页内切换即时写回 */
	homeDocsView: "list" | "grid";
	/**
	 * 主页文档页左列文件夹栏收起态（㊸，默认展开）——镜像 homeDocsView 先例：
	 * 页内切换即时写回即主界面，设置页刻意不加开关。
	 */
	homeFoldersHidden: boolean;
	/**
	 * 主页卡片页左列卡组树栏收起态（73，默认展开）——镜像 homeFoldersHidden：
	 * 卡组树与文档页文件夹栏同为左列结构，收起态各自独立记忆。
	 */
	homeCardsFoldersHidden: boolean;
	/**
	 * 四类摘录工具的当前色系（㊹ MN3 式）：点击已激活的工具按钮循环切换
	 * 黄→绿→蓝→红，每工具独立记忆；后续该形态的建卡默认落此色
	 * （AI 正文/翻译留白分别跟随文字/留白工具色）。
	 */
	excerptColors: Record<ExcerptColorTool, HighlightColorValue>;
	/**
	 * 每日新卡上限（68 新卡混排）：0 = 不限（默认），>0 = 每天最多引入这么多
	 * phase="new" 的新闪卡（到期复习卡不占名额，配额按当日复习日志已考新卡数扣减）。
	 */
	reviewNewPerDay: number;
	/** 每批复习张数（68 due 分批）：到期复习卡的每次拉取上限（新卡不占此限） */
	reviewBatchSize: number;
	/**
	 * 间隔重复调度算法（103，默认 sm2）："sm2" Anki 简化版 / "fsrs" FSRS-4.5。
	 * 切换即时生效（下次评分走新算法）；SM-2 存量卡切 fsrs 后首次评分惰性迁移
	 * 记忆状态（stability/difficulty），切回 sm2 同样零迁移成本——双向可退。
	 */
	scheduler: SrsScheduler;
	/**
	 * 累计复习基线（103 口径统一，null = 未迁移）：一次性迁移时把
	 * max(0, SM-2 聚合 − 复习日志已记总数) 定格于此，此后「累计复习」 =
	 * 基线 + 日志总和（与今日/连续/热力图同源，两口径合一）。
	 */
	reviewStatsBaseline: number | null;
	/**
	 * 划选工具栏（75，默认开）：text 工具下划选文字弹出浮动工具栏
	 * （四色点摘录/翻译/复制/书签/搜索）；关闭后恢复 75 之前的
	 * 「划选松开即直接建卡」旧路径。
	 */
	selectionToolbar: boolean;
	/**
	 * 文字摘录线型（77，默认下划线）：text 形态高亮的形态——下划线/波浪线/删除线；
	 * 划选工具栏线型钮与设置页下拉双入口写回，仅影响新建卡（存量卡走高亮菜单单改）
	 */
	excerptLineStyle: LineStyle;
	/**
	 * 联动方向（79-1，默认双向）：文档↔脑图联动的门控档位——双向 / 仅文档→脑图 /
	 * 仅脑图→文档 / 关闭（两窗格完全独立：自动跟随、点击定位、联动互关全停）。
	 * 显式编排（工作区命令/视图切换条）不受此开关约束。
	 */
	linkDirection: LinkDirection;
	/**
	 * 隐藏侧缓存（79-3，默认 null = 无隐藏记录）：单窗格模式切走的一侧状态。
	 * 由 applyViewMode 隐藏分支在 detach 后写回（选择器取消路径不写），
	 * 形状守卫见 loadSettings——损坏子字段弃用，不入脏值。
	 */
	workspaceHidden: WorkspaceHiddenState | null;
	/**
	 * AI 模型预设列表（96）：每项 Base URL + API Key + 模型名（OpenAI 兼容
	 * 端点：DeepSeek / 智谱 / OpenAI / oneapi 系中转站等），可配多个在设置页
	 * 切换启用。凭据明文存 data.json（与翻译凭据同惯例，设置页 desc 有提示）。
	 */
	aiPresets: AiPreset[];
	/** 当前启用的预设 id（96）：空串 = 未启用（AI 功能入口统一守卫提示先配置） */
	aiActivePresetId: string;
	/** 采样温度（96，默认 0.3，钳 0-2）：制卡/整理等结构化输出场景偏低更稳 */
	aiTemperature: number;
	/** 流式输出（96）："auto"（默认）fetch+SSE 流式、CORS 失败自动降级非流式；"off" 强制非流式 */
	aiStream: "auto" | "off";
	/**
	 * 单次请求上下文 token 预算（96，默认 24000，钳 2000-200000）：文档问答/
	 * 摘要的分块裁剪上限（估算值——CJK 字符 ×1 + 其余 ÷4）。
	 */
	aiMaxContextTokens: number;
	/** AI 制卡自动转闪卡（96，默认开）：生成的卡片直接 enable 进入复习队列 */
	aiAutoFlashcard: boolean;
	/** 划选 AI 操作的自定义项（96）：label 进划选 AI 菜单、prompt 为指令模板 */
	aiCustomPrompts: AiCustomPrompt[];
	/** 累计用量（96）：请求次数与 token 数（流式为估算值），设置页展示 + 可清零 */
	aiUsage: AiUsage;
	/**
	 * 剪藏时下载正文图片到本地（113，默认开；关闭则全部保留远程链接）。
	 * 124 起剪藏落点固定数据根 clips/（webclipFolder 设置退役，旧值由
	 * extractLegacyWebclipFolder 提取供存量迁移检测）。
	 */
	webclipDownloadImages: boolean;
	/**
	 * 截图全局热键（117，默认空 = 关闭）：Electron accelerator 形态（如
	 * Ctrl+Shift+S），任何应用内按下即截全屏进裁剪弹窗；仅桌面生效。存档守卫
	 * 与设置页校验双闸：非法词形回空（validateAccelerator）。
	 */
	captureGlobalHotkey: string;
	/**
	 * 屏幕剪藏 OCR（119，默认开）：「剪藏屏幕区域为笔记」对选中区域做文字
	 * 识别，识别文字进笔记正文与标题；关闭或识别失败只存图。首次识别需联网
	 * 下载语言包（与既有 OCR 设置共用 ocrLangs）。
	 */
	screenClipOcr: boolean;
	/**
	 * 截图托盘常驻（120，默认开，仅桌面生效）：系统托盘聚合截图/屏幕剪藏
	 * 入口（左键=截图框选复制，右键菜单=剪藏为笔记/打开设置）。环境不支持
	 * 时静默不建（命令/热键入口不受影响）。
	 */
	showCaptureTray: boolean;
}

export const DEFAULT_SETTINGS: MarinMindSettings = {
	dataDir: DEFAULT_DATA_DIR,
	backupDir: DEFAULT_BACKUP_DIR,
	translateTarget: DEFAULT_TRANSLATE_TARGET,
	translateEngine: "google",
	translateBaiduAppid: "",
	translateBaiduSecret: "",
	translateYoudaoAppid: "",
	translateYoudaoAppSecret: "",
	translateDeeplKey: "",
	ocrLangs: DEFAULT_OCR_LANGS,
	ocrOnAreaExcerpt: false,
	ocrAutoTranslate: false,
	photoCompress: true,
	autoAddToMindmap: true,
	homeTheme: "dark",
	homeDocsView: "list",
	homeFoldersHidden: false,
	homeCardsFoldersHidden: false,
	excerptColors: { text: "yellow", area: "yellow", lasso: "yellow", blank: "yellow" },
	reviewNewPerDay: 0,
	reviewBatchSize: 20,
	scheduler: "sm2",
	reviewStatsBaseline: null,
	selectionToolbar: true,
	excerptLineStyle: "underline",
	linkDirection: "both",
	workspaceHidden: null,
	aiPresets: [],
	aiActivePresetId: "",
	aiTemperature: 0.3,
	aiStream: "auto",
	aiMaxContextTokens: 24000,
	aiAutoFlashcard: true,
	aiCustomPrompts: [],
	aiUsage: EMPTY_AI_USAGE,
	webclipDownloadImages: true,
	captureGlobalHotkey: "",
	screenClipOcr: true,
	showCaptureTray: true,
};

/**
 * 数值字段钳制（65）：非有限数/越界回默认——手编 data.json 或旧版本缺字段的
 * 防御，返回整数。min/max 与字段语义绑定（新卡上限 0-999，批次 5-200）。
 */
function clampInt(value: unknown, fallback: number, min: number, max: number): number {
	const n = typeof value === "number" ? value : Number(value);
	if (!Number.isFinite(n)) {
		return fallback;
	}
	return Math.min(max, Math.max(min, Math.round(n)));
}

/**
 * 浮点字段钳制（96 AI 温度）：语义同 clampInt 但不取整——温度 0.3 取整会变 0。
 */
function clampFloat(value: unknown, fallback: number, min: number, max: number): number {
	const n = typeof value === "number" ? value : Number(value);
	if (!Number.isFinite(n)) {
		return fallback;
	}
	return Math.min(max, Math.max(min, n));
}

/**
 * 读取 data.json 并与默认值合并（null/损坏文件回退全默认）。
 * ㊹ 嵌套对象 excerptColors 需显式逐键合并（顶层浅合并会整块覆盖丢默认值），
 * 非法值回默认浅黄；其余字段仍走浅合并、未知字段透传。
 */
export async function loadSettings(plugin: Plugin): Promise<MarinMindSettings> {
	let raw: Partial<MarinMindSettings> | null = null;
	try {
		raw = (await plugin.loadData()) as Partial<MarinMindSettings> | null;
	} catch (err) {
		console.error("[MarinMind] 设置读取失败，使用默认值", err);
	}
	const merged: MarinMindSettings = { ...DEFAULT_SETTINGS, ...(raw ?? {}) };
	const rawColors = (raw as { excerptColors?: Partial<Record<ExcerptColorTool, string>> } | null)
		?.excerptColors;
	const colors = { ...DEFAULT_SETTINGS.excerptColors };
	for (const key of ["text", "area", "lasso", "blank"] as const) {
		const value = rawColors?.[key];
		if (typeof value === "string" && isHighlightColor(value)) {
			colors[key] = value;
		}
	}
	merged.excerptColors = colors;
	// 65 复习设置两个标量：浅合并天然兼容，钳制防手编 data.json 越界值
	merged.reviewNewPerDay = clampInt(
		merged.reviewNewPerDay,
		DEFAULT_SETTINGS.reviewNewPerDay,
		0,
		999,
	);
	merged.reviewBatchSize = clampInt(
		merged.reviewBatchSize,
		DEFAULT_SETTINGS.reviewBatchSize,
		5,
		200,
	);
	// 103 调度算法：枚举外值回默认 sm2；累计基线 null = 未迁移（数字负值按 0 收）
	merged.scheduler = isSrsScheduler((raw as { scheduler?: unknown } | null)?.scheduler)
		? merged.scheduler
		: "sm2";
	const rawBaseline = (raw as { reviewStatsBaseline?: unknown } | null)?.reviewStatsBaseline;
	merged.reviewStatsBaseline =
		typeof rawBaseline === "number" && Number.isFinite(rawBaseline)
			? Math.max(0, Math.round(rawBaseline))
			: null;
	// 77 线型标量：手编 data.json 非法值回默认下划线（防脏值流进 dataset/CSS）
	merged.excerptLineStyle = isLineStyle(
		(raw as { excerptLineStyle?: unknown } | null)?.excerptLineStyle,
	)
		? merged.excerptLineStyle
		: "underline";
	// 79-1 联动方向：非法值回默认双向（镜像线型守卫）
	merged.linkDirection = isLinkDirection(
		(raw as { linkDirection?: unknown } | null)?.linkDirection,
	)
		? merged.linkDirection
		: "both";
	// 83 OCR 三标量：语言表外值回默认中英混排、布尔脏值回默认关（镜像既有守卫风格）
	merged.ocrLangs = isOcrLangs((raw as { ocrLangs?: unknown } | null)?.ocrLangs)
		? merged.ocrLangs
		: DEFAULT_OCR_LANGS;
	const rawOcrFlags = raw as { ocrOnAreaExcerpt?: unknown; ocrAutoTranslate?: unknown } | null;
	merged.ocrOnAreaExcerpt =
		typeof rawOcrFlags?.ocrOnAreaExcerpt === "boolean" ? merged.ocrOnAreaExcerpt : false;
	merged.ocrAutoTranslate =
		typeof rawOcrFlags?.ocrAutoTranslate === "boolean" ? merged.ocrAutoTranslate : false;
	// 84-E 照片压缩：非布尔脏值回默认开（镜像 ocrOnAreaExcerpt 写法，默认值不同）
	merged.photoCompress =
		typeof (raw as { photoCompress?: unknown } | null)?.photoCompress === "boolean"
			? (raw as { photoCompress: boolean }).photoCompress
			: true;
	// 83 翻译引擎标量（85-B 增有道两凭据）：引擎脏值回 Google；凭据非字符串/
	// 空白归空串（trim 防首尾空白进签名）
	merged.translateEngine = isTranslateEngineId(
		(raw as { translateEngine?: unknown } | null)?.translateEngine,
	)
		? merged.translateEngine
		: "google";
	const rawCred = raw as {
		translateBaiduAppid?: unknown;
		translateBaiduSecret?: unknown;
		translateYoudaoAppid?: unknown;
		translateYoudaoAppSecret?: unknown;
		translateDeeplKey?: unknown;
	} | null;
	const trimStr = (v: unknown): string => (typeof v === "string" ? v.trim() : "");
	merged.translateBaiduAppid = trimStr(rawCred?.translateBaiduAppid);
	merged.translateBaiduSecret = trimStr(rawCred?.translateBaiduSecret);
	merged.translateYoudaoAppid = trimStr(rawCred?.translateYoudaoAppid);
	merged.translateYoudaoAppSecret = trimStr(rawCred?.translateYoudaoAppSecret);
	merged.translateDeeplKey = trimStr(rawCred?.translateDeeplKey);
	// 79-3 隐藏侧缓存：嵌套对象形状守卫（file 非空 string、page number|null、
	// mapId 非空 string），损坏子字段弃用、全空整体置 null
	merged.workspaceHidden = sanitizeWorkspaceHidden(
		(raw as { workspaceHidden?: unknown } | null)?.workspaceHidden,
	);
	// 96 AI 设置：预设/自定义 prompt 形状守卫（坏项丢弃）、标量钳制、
	// 枚举与布尔脏值回默认（镜像既有守卫风格）；启用 id 指向已丢坏项时
	// sanitizeAiPresets 后 find 落空，resolveAiPreset 会引导重新启用
	const rawAi = raw as {
		aiActivePresetId?: unknown;
		aiTemperature?: unknown;
		aiStream?: unknown;
		aiMaxContextTokens?: unknown;
		aiAutoFlashcard?: unknown;
		aiPresets?: unknown;
		aiCustomPrompts?: unknown;
		aiUsage?: unknown;
	} | null;
	merged.aiPresets = sanitizeAiPresets(rawAi?.aiPresets);
	merged.aiActivePresetId =
		typeof rawAi?.aiActivePresetId === "string" ? rawAi.aiActivePresetId.trim() : "";
	merged.aiTemperature = clampFloat(merged.aiTemperature, DEFAULT_SETTINGS.aiTemperature, 0, 2);
	merged.aiStream = rawAi?.aiStream === "off" ? "off" : "auto";
	merged.aiMaxContextTokens = clampInt(
		merged.aiMaxContextTokens,
		DEFAULT_SETTINGS.aiMaxContextTokens,
		2000,
		200000,
	);
	merged.aiAutoFlashcard =
		typeof rawAi?.aiAutoFlashcard === "boolean" ? rawAi.aiAutoFlashcard : true;
	merged.aiCustomPrompts = sanitizeAiCustomPrompts(rawAi?.aiCustomPrompts);
	merged.aiUsage = sanitizeAiUsage(rawAi?.aiUsage);
	// 124 网页剪藏：落点固定数据根 clips/，webclipFolder 字段退役（不再进设置对象）；
	// 布尔脏值回默认开（镜像 photoCompress 写法）
	const rawClip = raw as { webclipDownloadImages?: unknown } | null;
	merged.webclipDownloadImages =
		typeof rawClip?.webclipDownloadImages === "boolean" ? rawClip.webclipDownloadImages : true;
	// 117 截图热键：字符串 + validateAccelerator 双闸，非法（空/坏词形/手编脏值）回空关闭
	// 119 屏幕剪藏 OCR / 120 截图托盘：布尔守卫，脏值回默认开（镜像 webclipDownloadImages 写法）
	const rawCap = raw as {
		captureGlobalHotkey?: unknown;
		screenClipOcr?: unknown;
		showCaptureTray?: unknown;
	} | null;
	merged.captureGlobalHotkey =
		typeof rawCap?.captureGlobalHotkey === "string" &&
		validateAccelerator(rawCap.captureGlobalHotkey)
			? rawCap.captureGlobalHotkey.trim()
			: "";
	// 119 屏幕剪藏 OCR：布尔守卫，脏值回默认开（镜像 webclipDownloadImages 写法）
	merged.screenClipOcr = typeof rawCap?.screenClipOcr === "boolean" ? rawCap.screenClipOcr : true;
	// 120 截图托盘：布尔守卫，脏值回默认开
	merged.showCaptureTray =
		typeof rawCap?.showCaptureTray === "boolean" ? rawCap.showCaptureTray : true;
	return merged;
}

/**
 * 提取已退役的 webclipFolder 旧设置值（124，供存量剪藏迁移定位旧目录）：
 * 原始 data.json 记录里存在且校验通过 → 返回规范化 vault 相对目录；否则 null
 * （迁移模块会另行扫描默认 WebClips/，两者互补不重不漏）。
 */
export function extractLegacyWebclipFolder(raw: unknown): string | null {
	const value = (raw as { webclipFolder?: unknown } | null)?.webclipFolder;
	if (typeof value !== "string" || !value.trim()) {
		return null;
	}
	const dataDir =
		typeof (raw as { dataDir?: unknown } | null)?.dataDir === "string"
			? (raw as { dataDir: string }).dataDir
			: DEFAULT_DATA_DIR;
	const check = validateWebclipFolder(value, dataDir);
	return check.ok ? check.normalized : null;
}

/**
 * 隐藏侧缓存形状守卫（79-3 纯函数）：reader.file 必须非空 string、page 收窄
 * number|null（非法归 null）、mapId 必须非空 string——任一损坏只弃对应子字段，
 * 结果无任何键则返回 null（手编 data.json / 旧版本字段污染防御）。
 */
function sanitizeWorkspaceHidden(value: unknown): WorkspaceHiddenState | null {
	if (typeof value !== "object" || value === null) {
		return null;
	}
	const raw = value as { reader?: unknown; mapId?: unknown };
	const out: WorkspaceHiddenState = {};
	if (typeof raw.reader === "object" && raw.reader !== null) {
		const r = raw.reader as { file?: unknown; page?: unknown };
		if (typeof r.file === "string" && r.file.length > 0) {
			out.reader = {
				file: r.file,
				page: typeof r.page === "number" ? r.page : null,
			};
		}
	}
	if (typeof raw.mapId === "string" && raw.mapId.length > 0) {
		out.mapId = raw.mapId;
	}
	return Object.keys(out).length > 0 ? out : null;
}

/** 目录输入校验结果 */
export type DirValidation = { ok: true; normalized: string } | { ok: false; reason: string };

/**
 * 目录设置输入校验（纯函数）：
 * 空值拒绝；绝对路径仅桌面可用（移动端无 node fs）；相对路径规范化并拒绝 ../反斜杠/.obsidian。
 */
export function validateDirInput(raw: string, isDesktop: boolean): DirValidation {
	try {
		if (isAbsoluteFsPath(raw)) {
			if (!isDesktop) {
				return { ok: false, reason: "移动端仅支持 vault 内相对路径" };
			}
			return { ok: true, normalized: normalizeFsDir(raw) };
		}
		return { ok: true, normalized: normalizeVaultDir(raw) };
	} catch (err) {
		return { ok: false, reason: err instanceof Error ? err.message : String(err) };
	}
}
