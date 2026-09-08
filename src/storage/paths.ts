/**
 * 纯路径工具（零 obsidian / node 依赖，vitest 直接覆盖）
 *
 * 路径语义约定：
 * - "vault 相对路径"：POSIX 风格正斜杠、相对 vault 根（Obsidian 惯例）
 * - "根相对路径"：相对数据根目录（如 marinmind.db、assets/x.png）
 * - "本机绝对路径"：Windows 盘符 / UNC / POSIX 根，仅桌面端数据目录可用
 */

/** 判断是否为本机文件系统绝对路径：盘符（大小写均可、正反斜杠）、UNC（\\server）、POSIX 根（/mnt） */
export function isAbsoluteFsPath(p: string): boolean {
	return /^(?:[a-zA-Z]:[\\/]|\\\\|\/)/.test(p);
}

/**
 * 取路径末段并去扩展名（两种分隔符 \ 与 / 通吃——vault 相对路径与库外绝对路径共用）。
 * 镜像 TFile.basename 语义：点号在首位的隐藏文件（.gitignore）不去点，
 * 多点文件名（a.b.c.pdf）只去最后一段扩展名；无扩展名原样返回。
 */
export function fsBasename(p: string): string {
	const name = p.slice(Math.max(p.lastIndexOf("\\"), p.lastIndexOf("/")) + 1);
	const dot = name.lastIndexOf(".");
	return dot > 0 ? name.slice(0, dot) : name;
}

/**
 * 文档扩展名（㊼ EPUB；㊽ MOBI 家族）：小写、不带点（"pdf" | "md" | "epub" |
 * "mobi" | …），无扩展名返回空串。vault 相对路径与库外绝对路径共用（分隔符
 * 通吃）——阅读器分流/视觉消费方短路/文案「页/章」判定的统一判定点。
 */
export function docExtOf(p: string): string {
	const name = p.slice(Math.max(p.lastIndexOf("\\"), p.lastIndexOf("/")) + 1);
	const dot = name.lastIndexOf(".");
	return dot > 0 ? name.slice(dot + 1).toLowerCase() : "";
}

/** MOBI 家族扩展名（㊽）：四者结构相同（PDB 容器），同一套解析器收编 */
export const MOBI_EXTS = ["mobi", "azw3", "azw", "prc"] as const;

/** 是否 MOBI 家族扩展名（㊽）：docKind 按 epub 别名搭车（章=页模型同构） */
export function isMobiExt(ext: string): boolean {
	return (MOBI_EXTS as readonly string[]).includes(ext);
}

/** 页码量词（㊼；㊽ MOBI 家族同章=页）：epub/mobi 家族显示「章」，其余「页」——各视图文案共用 */
export function pageWordOf(filePath: string): string {
	const ext = docExtOf(filePath);
	return ext === "epub" || isMobiExt(ext) ? "章" : "页";
}

/** 规范化 vault 相对目录：trim、折叠多余斜杠、去 "." 段与首尾斜杠；非法输入抛错（调用方转 UI 错误） */
export function normalizeVaultDir(p: string): string {
	const raw = p.trim();
	if (!raw) {
		throw new Error("目录不能为空");
	}
	if (isAbsoluteFsPath(raw)) {
		throw new Error("检测到绝对路径，vault 内目录请填写相对路径");
	}
	if (raw.includes("\\")) {
		throw new Error("请使用正斜杠 / 作为路径分隔符");
	}
	const segs = raw.split("/").filter((s) => s.length > 0 && s !== ".");
	if (segs.some((s) => s === "..")) {
		throw new Error("路径中不允许使用 ..");
	}
	const normalized = segs.join("/");
	if (normalized === ".obsidian" || normalized.startsWith(".obsidian/")) {
		throw new Error("不允许将数据放进 .obsidian 配置目录");
	}
	return normalized;
}

/**
 * vault 目录是否为隐藏目录（任一路径段以 . 开头，如旧版数据根 .marinmind）。
 * Obsidian 的库索引完全跳过点开头目录（任意层级）——里面的笔记无法被搜索/
 * 阅读，指向它们的 wikilink 链接与嵌入一律解析失败（㊻-A-2 卡片链接修复的根源）。
 */
export function isHiddenVaultDir(dir: string): boolean {
	if (!dir) return false;
	return dir.split("/").some((seg) => seg.startsWith("."));
}

/** 规范化本机绝对路径：trim、去尾随分隔符（盘符根 "D:\" 保留单个分隔符） */
export function normalizeFsDir(p: string): string {
	const raw = p.trim();
	if (!raw) {
		throw new Error("目录不能为空");
	}
	if (!isAbsoluteFsPath(raw)) {
		throw new Error("不是有效的本机绝对路径（形如 D:\\MarinMindData 或 /home/user/data）");
	}
	// 盘符根（"D:\"、"D:////"）归一为 "D:\"；UNC/POSIX 根同理去重复尾分隔符
	const driveRoot = /^([a-zA-Z]:)[\\/]+$/.exec(raw);
	if (driveRoot) {
		return `${driveRoot[1]}\\`;
	}
	if (/^\\\\[^\\]*[\\/]*$/.test(raw) || raw === "/") {
		// UNC 服务器段或 POSIX 根：不在此强行归一（罕见场景），交由 node path.resolve 处理
		return raw;
	}
	return raw.replace(/[\\/]+$/, "");
}

/** POSIX 风格拼接（vault 相对 / 根相对路径专用；空段直接透传另一侧） */
export function joinRel(base: string, rel: string): string {
	if (!base) return rel;
	if (!rel) return base;
	return `${base}/${rel}`;
}

/** 拆出逐层 mkdir 需要的前缀目录序列："a/b/c" → ["a", "a/b", "a/b/c"]；空串返回空数组 */
export function dirSegments(dir: string): string[] {
	const segs = dir.split("/").filter((s) => s.length > 0);
	return segs.map((_, i) => segs.slice(0, i + 1).join("/"));
}

/** 旧版数据目录前缀（excerptRef 历史格式兼容用） */
const LEGACY_DATA_DIR_PREFIX = ".marinmind/";

/**
 * 兼容旧 excerptRef：历史行存完整 vault 路径（.marinmind/assets/x.png），
 * 归一为数据根相对路径（assets/x.png）；新格式原样透传，非本目录路径不误剥。
 */
export function normalizeAssetRef(ref: string): string {
	if (ref.startsWith(`${LEGACY_DATA_DIR_PREFIX}assets/`)) {
		return ref.slice(LEGACY_DATA_DIR_PREFIX.length);
	}
	return ref;
}
