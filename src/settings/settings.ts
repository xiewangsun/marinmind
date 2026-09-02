import type { Plugin } from "obsidian";
import { DEFAULT_BACKUP_DIR, DEFAULT_DATA_DIR } from "../constants";
import { DEFAULT_TRANSLATE_TARGET } from "../translate/translate-engine";
import { isHighlightColor, type HighlightColorValue } from "../reader/highlight-colors";
import { isLineStyle, type LineStyle } from "../types";
import { isAbsoluteFsPath, normalizeFsDir, normalizeVaultDir } from "../storage/paths";

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
}

export const DEFAULT_SETTINGS: MarinMindSettings = {
	dataDir: DEFAULT_DATA_DIR,
	backupDir: DEFAULT_BACKUP_DIR,
	translateTarget: DEFAULT_TRANSLATE_TARGET,
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
	return merged;
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
