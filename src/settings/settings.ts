import type { Plugin } from "obsidian";
import { DEFAULT_BACKUP_DIR, DEFAULT_DATA_DIR } from "../constants";
import { DEFAULT_TRANSLATE_TARGET } from "../translate/translate-engine";
import { isHighlightColor, type HighlightColorValue } from "../reader/highlight-colors";
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
	 * 四类摘录工具的当前色系（㊹ MN3 式）：点击已激活的工具按钮循环切换
	 * 黄→绿→蓝→红，每工具独立记忆；后续该形态的建卡默认落此色
	 * （AI 正文/翻译留白分别跟随文字/留白工具色）。
	 */
	excerptColors: Record<ExcerptColorTool, HighlightColorValue>;
}

export const DEFAULT_SETTINGS: MarinMindSettings = {
	dataDir: DEFAULT_DATA_DIR,
	backupDir: DEFAULT_BACKUP_DIR,
	translateTarget: DEFAULT_TRANSLATE_TARGET,
	autoAddToMindmap: true,
	homeTheme: "dark",
	homeDocsView: "list",
	homeFoldersHidden: false,
	excerptColors: { text: "yellow", area: "yellow", lasso: "yellow", blank: "yellow" },
};

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
