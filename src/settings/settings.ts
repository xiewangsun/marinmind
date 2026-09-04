import type { Plugin } from "obsidian";
import { DEFAULT_BACKUP_DIR, DEFAULT_DATA_DIR } from "../constants";
import { DEFAULT_OCR_LANGS, isOcrLangs } from "../ocr/ocr-text";
import {
	DEFAULT_TRANSLATE_TARGET,
	isTranslateEngineId,
	type TranslateEngineId,
} from "../translate/translate-engine";
import { isHighlightColor, type HighlightColorValue } from "../reader/highlight-colors";
import { isLinkDirection, isLineStyle, type LineStyle, type LinkDirection } from "../types";
import { isAbsoluteFsPath, normalizeFsDir, normalizeVaultDir } from "../storage/paths";

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
	selectionToolbar: true,
	excerptLineStyle: "underline",
	linkDirection: "both",
	workspaceHidden: null,
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
	merged.reviewNewPerDay = clampInt(merged.reviewNewPerDay, DEFAULT_SETTINGS.reviewNewPerDay, 0, 999);
	merged.reviewBatchSize = clampInt(merged.reviewBatchSize, DEFAULT_SETTINGS.reviewBatchSize, 5, 200);
	// 77 线型标量：手编 data.json 非法值回默认下划线（防脏值流进 dataset/CSS）
	merged.excerptLineStyle = isLineStyle(
		(raw as { excerptLineStyle?: unknown } | null)?.excerptLineStyle,
	)
		? merged.excerptLineStyle
		: "underline";
	// 79-1 联动方向：非法值回默认双向（镜像线型守卫）
	merged.linkDirection = isLinkDirection((raw as { linkDirection?: unknown } | null)?.linkDirection)
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
	const rawCred = raw as
		| {
				translateBaiduAppid?: unknown;
				translateBaiduSecret?: unknown;
				translateYoudaoAppid?: unknown;
				translateYoudaoAppSecret?: unknown;
				translateDeeplKey?: unknown;
		  }
		| null;
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
	return merged;
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
export type DirValidation =
	| { ok: true; normalized: string }
	| { ok: false; reason: string };

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
