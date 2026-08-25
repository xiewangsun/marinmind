import { strFromU8, strToU8, unzipSync, zipSync } from "fflate";

/** 备份格式标识（manifest.format 校验用） */
export const BACKUP_FORMAT = "marinmind-marginpkg";

/** 备份格式版本（结构变化时递增） */
export const BACKUP_VERSION = 1;

/** 备份包内 SQLite 库的固定条目名 */
const DB_ENTRY = "marinmind.db";

/** 备份清单：包内 manifest.json 的结构 */
export interface BackupManifest {
	format: string;
	version: number;
	/** 导出方数据库 schema 版本（高于当前版本时拒绝导入） */
	schemaVersion: number;
	appVersion: string;
	exportedAt: string;
	documentCount: number;
	cardCount: number;
	assetCount: number;
}

/** 解包后的备份内容 */
export interface BackupContent {
	manifest: BackupManifest;
	dbBytes: Uint8Array;
	/** path 为 vault 相对路径 */
	documents: { path: string; bytes: Uint8Array }[];
	/** path 相对 .marinmind/assets/ */
	assets: { path: string; bytes: Uint8Array }[];
}

/**
 * 组装备份 zip：
 * manifest.json + marinmind.db 压缩存储；PDF / 媒体文件本身已压缩，level 0 直存（store）
 * 避免二次压缩浪费时间。
 */
export function buildBackupZip(
	content: Omit<BackupContent, "manifest">,
	manifest: BackupManifest,
): Uint8Array {
	const entries: Record<string, [Uint8Array, { level: 0 | 6 }]> = {
		"manifest.json": [strToU8(JSON.stringify(manifest, null, 2)), { level: 6 }],
		[DB_ENTRY]: [content.dbBytes, { level: 6 }],
	};
	for (const doc of content.documents) {
		entries[`documents/${doc.path}`] = [doc.bytes, { level: 0 }];
	}
	for (const asset of content.assets) {
		entries[`assets/${asset.path}`] = [asset.bytes, { level: 0 }];
	}
	return zipSync(entries);
}

/**
 * 解包并校验备份 zip。任何校验失败抛中文 Error（调用方 Notice 展示）：
 * - 必须含 manifest.json 与 marinmind.db，且 manifest.format / version 合法；
 * - 条目路径防 zip-slip：拒绝 `..` 段、绝对路径与前缀不符的条目；
 * - manifest.schemaVersion 高于当前版本时拒绝（备份来自更新版本的插件）；
 *   更低则放行（打开时的迁移链会自然升级）。
 */
export function parseBackupZip(
	bytes: Uint8Array,
	currentSchemaVersion: number,
): BackupContent {
	const unzipped = unzipSync(bytes);

	const manifestRaw = unzipped["manifest.json"];
	const dbRaw = unzipped[DB_ENTRY];
	if (!manifestRaw || !dbRaw) {
		throw new Error("备份包缺少 manifest.json 或 marinmind.db，不是有效的 MarinMind 备份");
	}

	let manifest: BackupManifest;
	try {
		manifest = JSON.parse(strFromU8(manifestRaw)) as BackupManifest;
	} catch {
		throw new Error("备份清单解析失败，文件可能已损坏");
	}
	if (manifest.format !== BACKUP_FORMAT) {
		throw new Error(`未知的备份格式：${manifest.format ?? "(空)"}`);
	}
	if (manifest.schemaVersion > currentSchemaVersion) {
		throw new Error(
			`备份来自更新版本的插件（schema v${manifest.schemaVersion} > 当前 v${currentSchemaVersion}），请先升级插件`,
		);
	}

	const documents: BackupContent["documents"] = [];
	const assets: BackupContent["assets"] = [];
	for (const [entry, data] of Object.entries(unzipped)) {
		if (entry === "manifest.json" || entry === DB_ENTRY) continue;
		const rel = splitEntry(entry, "documents/");
		if (rel !== null) {
			documents.push({ path: rel, bytes: data });
			continue;
		}
		const assetRel = splitEntry(entry, "assets/");
		if (assetRel !== null) {
			assets.push({ path: assetRel, bytes: data });
			continue;
		}
		throw new Error(`备份包含意外条目：${entry}`);
	}

	return {
		manifest,
		// 独立拷贝，摆脱对解包视图（可能带 byteOffset）的生命周期依赖
		dbBytes: dbRaw.slice(),
		documents,
		assets,
	};
}

/**
 * 校验并拆出指定前缀下的条目相对路径；前缀不符或路径非法（zip-slip）返回 null。
 * entry 形如 "documents/书/xx.pdf" → "书/xx.pdf"。
 */
function splitEntry(entry: string, prefix: "documents/" | "assets/"): string | null {
	if (!entry.startsWith(prefix)) return null;
	const rel = entry.slice(prefix.length);
	if (rel === "") return null;
	const segs = rel.split("/");
	// 拒绝 `..` 段、空段（连续 //）、绝对路径与盘符（防 zip-slip 逃逸）
	if (segs.some((s) => s === "" || s === "." || s === "..")) return null;
	if (rel.startsWith("/") || /^[a-zA-Z]:/.test(rel)) return null;
	return rel;
}
