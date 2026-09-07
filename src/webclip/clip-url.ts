import { isAbsoluteFsPath, isHiddenVaultDir, normalizeVaultDir } from "../storage/paths";

/**
 * 网页剪藏纯函数层（113-A）：URL 规范化与剪藏目录校验。
 * 零 obsidian / DOM 依赖，vitest 直接覆盖；服务层（webclip-service）与
 * 设置守卫（settings.loadSettings）共用。
 */

/** 剪藏目录校验结果（结构与 settings.DirValidation 同形，本域独立定义避免反向依赖） */
export type ClipFolderValidation = { ok: true; normalized: string } | { ok: false; reason: string };

/**
 * 规范化剪藏 URL：trim、无协议前缀时补 https://、仅接受 http(s)。
 * 输出 new URL().href（已绝对化、去片段）；非法输入返回中文 reason（调用方转 UI 错误）。
 */
export function normalizeClipUrl(
	raw: string,
): { ok: true; url: string } | { ok: false; reason: string } {
	const input = raw.trim();
	if (!input) {
		return { ok: false, reason: "请输入网址" };
	}
	// 无 scheme（不以 "xxx:" 形态开头）一律按域名补 https://——"example.com/a" 场景远多于
	// 端口误写；带 scheme 的输入交 URL 解析判定协议白名单
	const withScheme = /^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(input) ? input : `https://${input}`;
	let parsed: URL;
	try {
		parsed = new URL(withScheme);
	} catch {
		return { ok: false, reason: "不是有效的网址" };
	}
	if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
		return { ok: false, reason: "仅支持 http/https 网址" };
	}
	if (!parsed.hostname.includes(".")) {
		return { ok: false, reason: "不是有效的网址" };
	}
	// 去片段（#anchor 对抓取无意义，还会污染文件名与 source 记录）
	parsed.hash = "";
	return { ok: true, url: parsed.href };
}

/**
 * 剪藏目录校验（纯函数）：必须是 vault 相对目录（normalizeVaultDir 全部规则：
 * 拒绝 ../反斜杠/.obsidian），且额外两条剪藏特有规则——
 * - 不允许隐藏目录（点开头段：Obsidian 索引跳过，剪藏 md 将无法被搜索/嵌入）；
 * - 不允许与数据目录（vault 相对形态时）相同或互相包含。
 * 124 起剪藏落点固定数据根 clips/、设置字段退役，本校验仅存续于存量迁移
 * 的旧设置值提取（settings.extractLegacyWebclipFolder）——新剪藏不再调用。
 * @param folder 用户输入的剪藏目录
 * @param dataDir 设置中的数据目录（vault 相对或桌面绝对路径）
 */
export function validateWebclipFolder(folder: string, dataDir: string): ClipFolderValidation {
	let normalized: string;
	try {
		normalized = normalizeVaultDir(folder);
	} catch (err) {
		return { ok: false, reason: err instanceof Error ? err.message : String(err) };
	}
	if (isHiddenVaultDir(normalized)) {
		return {
			ok: false,
			reason: "剪藏目录不能是点开头的隐藏目录（Obsidian 不索引，笔记将无法阅读）",
		};
	}
	if (!isAbsoluteFsPath(dataDir)) {
		// 数据目录同为 vault 相对：规范化失败（历史脏值）时不阻断剪藏校验，跳过包含判定
		try {
			const dataNorm = normalizeVaultDir(dataDir);
			const contains = (a: string, b: string) => a === b || a.startsWith(`${b}/`);
			if (contains(normalized, dataNorm) || contains(dataNorm, normalized)) {
				return { ok: false, reason: "剪藏目录不能与数据目录相同或互相包含" };
			}
		} catch {
			// 数据目录脏值交由其自身校验处理
		}
	}
	return { ok: true, normalized };
}
