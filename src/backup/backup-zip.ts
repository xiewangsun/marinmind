import { strFromU8, strToU8, unzipSync, zipSync } from "fflate";

/** 备份格式标识（manifest.format 校验用） */
export const BACKUP_FORMAT = "marinmind-marginpkg";

/**
 * 备份格式版本（结构变化时递增）：
 * - v1：SQLite 库（marinmind.db 条目）+ documents/ + assets/（129 批起不再支持导入）
 * - v2：Markdown 数据（notes/ 树 = 数据根 md 相对路径）+ documents/ + assets/
 */
export const BACKUP_VERSION = 2;

/** 备份清单：包内 manifest.json 的结构 */
export interface BackupManifest {
	format: string;
	version: number;
	/** v2：存储形态（"markdown"；v1 包无此字段 = sqlite） */
	storage?: "markdown";
	appVersion: string;
	exportedAt: string;
	documentCount: number;
	cardCount: number;
	assetCount: number;
}

/** 解包后的备份内容（v2） */
export interface BackupContent {
	manifest: BackupManifest;
	/** 数据根的 md 文件树（path 为数据根相对路径，如 "books/书名.md"、"mindmaps/图名.md"） */
	notes: { path: string; bytes: Uint8Array }[];
	/** path 为 vault 相对路径 */
	documents: { path: string; bytes: Uint8Array }[];
	/** path 相对 assets/ */
	assets: { path: string; bytes: Uint8Array }[];
}

/** 条目归类的前缀 */
type EntryPrefix = "notes/" | "documents/" | "assets/";

/**
 * 组装 v2 备份 zip：
 * manifest.json 压缩存储；md / PDF / 媒体文件本身已压缩或体积小，level 0 直存（store）
 * 避免二次压缩浪费时间。
 */
export function buildBackupZip(
	content: Omit<BackupContent, "manifest">,
	manifest: BackupManifest,
): Uint8Array {
	const entries: Record<string, [Uint8Array, { level: 0 | 6 }]> = {
		"manifest.json": [strToU8(JSON.stringify(manifest, null, 2)), { level: 6 }],
	};
	for (const note of content.notes) {
		entries[`notes/${note.path}`] = [note.bytes, { level: 0 }];
	}
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
 * - 必须含 manifest.json，且 manifest.format / version 合法；
 * - v1 包（SQLite 形态）永久不再支持导入（129 批随 sql.js 一并移除转换通道）；
 * - 条目路径防 zip-slip：拒绝 `..` 段、绝对路径与前缀不符的条目；
 * - manifest.version 高于当前版本时拒绝（备份来自更新版本的插件）。
 */
export function parseBackupZip(bytes: Uint8Array): BackupContent {
	const unzipped = unzipSync(bytes);

	const manifestRaw = unzipped["manifest.json"];
	if (!manifestRaw) {
		throw new Error("备份包缺少 manifest.json，不是有效的 MarinMind 备份");
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
	if (manifest.version > BACKUP_VERSION) {
		throw new Error(
			`备份来自更新版本的插件（v${manifest.version} > 当前 v${BACKUP_VERSION}），请先升级插件`,
		);
	}
	if (manifest.version < 2 || unzipped["marinmind.db"]) {
		throw new Error(
			"该备份来自 SQLite 存储的旧版本（v1），当前版本已不再支持导入 v1 备份，请改用新版本插件导出的 v2 备份",
		);
	}

	const notes: BackupContent["notes"] = [];
	const documents: BackupContent["documents"] = [];
	const assets: BackupContent["assets"] = [];
	for (const [entry, data] of Object.entries(unzipped)) {
		if (entry === "manifest.json") continue;
		const noteRel = splitEntry(entry, "notes/");
		if (noteRel !== null) {
			notes.push({ path: noteRel, bytes: data });
			continue;
		}
		const docRel = splitEntry(entry, "documents/");
		if (docRel !== null) {
			documents.push({ path: docRel, bytes: data });
			continue;
		}
		const assetRel = splitEntry(entry, "assets/");
		if (assetRel !== null) {
			assets.push({ path: assetRel, bytes: data });
			continue;
		}
		throw new Error(`备份包含意外条目：${entry}`);
	}

	return { manifest, notes, documents, assets };
}

/**
 * 校验并拆出指定前缀下的条目相对路径；前缀不符或路径非法（zip-slip）返回 null。
 * entry 形如 "notes/mindmaps/图名.md" → "mindmaps/图名.md"。
 */
function splitEntry(entry: string, prefix: EntryPrefix): string | null {
	if (!entry.startsWith(prefix)) return null;
	const rel = entry.slice(prefix.length);
	if (rel === "") return null;
	const segs = rel.split("/");
	// 拒绝 `..` 段、空段（连续 //）、绝对路径与盘符（防 zip-slip 逃逸）
	if (segs.some((s) => s === "" || s === "." || s === "..")) return null;
	if (rel.startsWith("/") || /^[a-zA-Z]:/.test(rel)) return null;
	return rel;
}
