import { Platform } from "obsidian";
import type { App } from "obsidian";
import { isAbsoluteFsPath, normalizeFsDir, normalizeVaultDir } from "./paths";
import { NodeFsAdapter } from "./node-fs-adapter";
import { VaultRootedAdapter, type ListableStorageAdapter } from "./vault-rooted-adapter";

/** 解析后的存储定位：kind 决定 rootDir 的语义与用户可见的路径展示方式 */
export interface ResolvedLocation {
	kind: "vault" | "fs";
	/** vault 相对根（如 .marinmind）或本机绝对根（如 D:\MarinMindData） */
	rootDir: string;
	/** 以 rootDir 为基准、收根相对路径的适配器（DB / 附件 / 备份共用） */
	adapter: ListableStorageAdapter;
}

/**
 * 解析数据目录设置值（应已通过 validateDirInput 校验）为定位对象，顺带确保根目录存在。
 * 双保险：移动端读到绝对路径（vault 经同步盘共享桌面端的 data.json）时抛错，
 * 由 initDatabase 的 catch 走既有 Notice 降级路径，插件不崩、数据不动。
 */
export async function resolveDataLocation(app: App, rawDir: string): Promise<ResolvedLocation> {
	return resolveLocation(app, rawDir);
}

/** 解析备份目录设置值（规则同数据目录；目录不存在时由导出写操作自建，这里顺手确保） */
export async function resolveBackupLocation(
	app: App,
	rawDir: string,
): Promise<ResolvedLocation> {
	return resolveLocation(app, rawDir);
}

async function resolveLocation(app: App, rawDir: string): Promise<ResolvedLocation> {
	if (isAbsoluteFsPath(rawDir)) {
		if (!Platform.isDesktopApp) {
			throw new Error(`移动端不支持本机绝对路径：${rawDir}（请改为 vault 内相对路径）`);
		}
		const rootDir = normalizeFsDir(rawDir);
		const adapter = new NodeFsAdapter(rootDir);
		await adapter.mkdir("");
		return { kind: "fs", rootDir, adapter };
	}
	const rootDir = normalizeVaultDir(rawDir);
	const adapter = new VaultRootedAdapter(app.vault.adapter, rootDir);
	await adapter.mkdir("");
	return { kind: "vault", rootDir, adapter };
}
