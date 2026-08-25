import { Notice, Platform, TFile, TFolder } from "obsidian";
import type { App, DataAdapter } from "obsidian";
import { DB_PATH, ASSETS_DIR } from "../constants";
import { SCHEMA_VERSION } from "../db/schema";
import { ConfirmModal } from "../mindmap/confirm-modal";
import type MarinMindPlugin from "../main";
import {
	BACKUP_FORMAT,
	BACKUP_VERSION,
	buildBackupZip,
	parseBackupZip,
	type BackupContent,
	type BackupManifest,
} from "./backup-zip";

/** 备份导出目录（vault 内可见路径，便于用户拷走/同步） */
export const BACKUP_DIR = "Backups/MarinMind";

/** 导入前安全快照文件名前缀（存于 .marinmind/，只保留最近一份） */
const SNAPSHOT_PREFIX = "pre-import-snapshot-";

/**
 * 导出备份：SQLite 库 + 全部文档 PDF + 媒体附件 → 单个 .marginpkg（zip）。
 * 大库同步打包会短暂阻塞 UI（fflate 同步 API），先出 Notice 预告。
 */
export async function exportBackup(plugin: MarinMindPlugin): Promise<void> {
	await plugin.whenReady();
	if (!plugin.db) {
		new Notice("MarinMind：数据库未就绪，无法导出");
		return;
	}
	const notice = new Notice("正在打包备份…（大库可能卡顿数秒）", 0);
	try {
		const adapter = plugin.app.vault.adapter;
		const documents = plugin.documents.list();
		const cards = plugin.cards;

		// 文档逐个读取；库内已缺失的跳过并计数提示
		const docEntries: { path: string; bytes: Uint8Array }[] = [];
		let missing = 0;
		for (const doc of documents) {
			if (plugin.app.vault.getAbstractFileByPath(doc.filePath) instanceof TFile) {
				docEntries.push({
					path: doc.filePath,
					bytes: new Uint8Array(await adapter.readBinary(doc.filePath)),
				});
			} else {
				missing++;
			}
		}
		const assetEntries = await collectAssetEntries(adapter);

		const manifest: BackupManifest = {
			format: BACKUP_FORMAT,
			version: BACKUP_VERSION,
			schemaVersion: SCHEMA_VERSION,
			appVersion: plugin.manifest.version,
			exportedAt: new Date().toISOString(),
			documentCount: documents.length,
			cardCount: cards.count(),
			assetCount: assetEntries.length,
		};
		const zipped = buildBackupZip(
			{ dbBytes: new Uint8Array(plugin.db.exportBytes()), documents: docEntries, assets: assetEntries },
			manifest,
		);

		const vault = plugin.app.vault;
		if (!(await adapter.exists(BACKUP_DIR))) {
			await vault.createFolder(BACKUP_DIR);
		}
		const target = `${BACKUP_DIR}/marinmind-${timestampStamp()}.marginpkg`;
		await vault.createBinary(target, toBuffer(zipped));

		new Notice(
			`备份已导出：${target}` +
				(missing > 0 ? `（${missing} 个文档文件已不在库中，未打包）` : ""),
			8000,
		);
	} catch (err) {
		console.error("[MarinMind] 备份导出失败", err);
		new Notice(`备份导出失败：${err instanceof Error ? err.message : String(err)}`);
	} finally {
		notice.hide();
	}
}

/** 导入入口：弹系统文件选择器（可选 vault 外文件）→ 读字节 → 校验并确认 */
export function promptImportBackup(plugin: MarinMindPlugin): void {
	const input = document.createElement("input");
	input.type = "file";
	input.accept = ".marginpkg";
	input.style.display = "none";
	input.addEventListener("change", () => {
		const file = input.files?.[0];
		input.remove();
		if (!file) return;
		void file
			.arrayBuffer()
			.then((bytes) => importBackupFromBytes(plugin, bytes))
			.catch((err) => {
				console.error("[MarinMind] 备份文件读取失败", err);
				new Notice("备份文件读取失败");
			});
	});
	// 选完/取消后移除节点，避免残留
	input.addEventListener("cancel", () => input.remove());
	document.body.appendChild(input);
	input.click();
}

/** 校验备份包并弹确认框；真正落地在 doImport */
export function importBackupFromBytes(plugin: MarinMindPlugin, bytes: ArrayBuffer): void {
	let content: BackupContent;
	try {
		content = parseBackupZip(new Uint8Array(bytes), SCHEMA_VERSION);
	} catch (err) {
		new Notice(`导入失败：${err instanceof Error ? err.message : String(err)}`);
		return;
	}
	const m = content.manifest;
	new ConfirmModal(
		plugin.app,
		"导入备份",
		`将替换全部 MarinMind 数据（文档 ${m.documentCount} · 卡片 ${m.cardCount} · 导出于 ${m.exportedAt}）。\n` +
			"当前数据会先自动快照到 .marinmind/；导入后 Obsidian 将重载（未保存的其他编辑会丢失）。\n继续？",
		() => void doImport(plugin, content),
	).open();
}

/** 导入落地：快照旧库 → 关闭内存库 → 覆盖 db 文件 → 恢复文档与附件 → 重载 */
async function doImport(plugin: MarinMindPlugin, content: BackupContent): Promise<void> {
	const notice = new Notice("正在导入备份…", 0);
	try {
		const adapter = plugin.app.vault.adapter;

		// 1) 导入前安全快照（只保留最近一份），失败不阻断导入
		if (plugin.db) {
			try {
				await writeSnapshot(plugin, adapter);
			} catch (err) {
				console.warn("[MarinMind] 导入前快照失败（忽略）", err);
			}
		}

		// 2) 顺序不可反：先 flush 落盘旧数据，再 close 终止定时器——
		//    否则之后 reload 触发 onunload 的 flush 会用旧内存库覆盖刚写入的新库
		if (plugin.db) {
			await plugin.db.flush();
			plugin.db.close();
		}

		// 3) 覆盖数据库文件（parseBackupZip 已拷贝独立 buffer）
		await adapter.writeBinary(DB_PATH, content.dbBytes.slice().buffer as ArrayBuffer);

		// 4) 恢复文档：库内已存在的文件（TFile）跳过，用户本地版本优先
		let restored = 0;
		let skipped = 0;
		for (const doc of content.documents) {
			const existing = plugin.app.vault.getAbstractFileByPath(doc.path);
			if (existing) {
				skipped++; // TFile=已存在跳过；TFolder=同名目录冲突，同样跳过
				continue;
			}
			try {
				await ensureParentFolder(plugin.app, doc.path);
				await plugin.app.vault.createBinary(doc.path, doc.bytes.slice().buffer as ArrayBuffer);
				restored++;
			} catch (err) {
				console.warn(`[MarinMind] 恢复文档失败：${doc.path}`, err);
				skipped++;
			}
		}

		// 5) 恢复附件（.marinmind/ 隐藏目录，直接 adapter 覆盖写）
		if (!(await adapter.exists(ASSETS_DIR))) {
			await adapter.mkdir(ASSETS_DIR); // 父目录 .marinmind 由数据库打开时保证
		}
		for (const asset of content.assets) {
			await adapter.writeBinary(
				`${ASSETS_DIR}/${asset.path}`,
				asset.bytes.slice().buffer as ArrayBuffer,
			);
		}

		// 6) 内存中各视图仍持有旧库快照，最干净的生效方式是整库重载
		notice.hide();
		if (Platform.isDesktopApp) {
			new Notice(`导入完成（恢复 ${restored} 个文档，跳过 ${skipped} 个），正在重载…`, 6000);
			// App 类型未公开 commands 字段，做最小形状断言
			(plugin.app as unknown as {
				commands: { executeCommandById(id: string): unknown };
			}).commands.executeCommandById("app:reload");
		} else {
			// 移动端无 app:reload；窗口期内继续操作会用旧内存库覆盖导入数据，必须立即重启
			new Notice(
				`导入完成（恢复 ${restored}，跳过 ${skipped}）。请立即重启 Obsidian，否则数据可能被旧会话覆盖！`,
				15000,
			);
		}
	} catch (err) {
		console.error("[MarinMind] 备份导入失败", err);
		notice.hide();
		new Notice(`备份导入失败：${err instanceof Error ? err.message : String(err)}`);
	}
}

/** 递归收集附件目录下全部文件，返回（相对 ASSETS_DIR 的路径, 字节） */
async function collectAssetEntries(
	adapter: DataAdapter,
): Promise<{ path: string; bytes: Uint8Array }[]> {
	const files = await collectFiles(adapter, ASSETS_DIR);
	const entries: { path: string; bytes: Uint8Array }[] = [];
	for (const full of files) {
		const rel = full.startsWith(`${ASSETS_DIR}/`) ? full.slice(ASSETS_DIR.length + 1) : full;
		entries.push({ path: rel, bytes: new Uint8Array(await adapter.readBinary(full)) });
	}
	return entries;
}

/** 递归列出目录下全部文件（vault 相对全路径）；目录不存在返回空 */
async function collectFiles(adapter: DataAdapter, dir: string): Promise<string[]> {
	if (!(await adapter.exists(dir))) return [];
	const listed = await adapter.list(dir);
	const files = [...listed.files];
	for (const sub of listed.folders) {
		files.push(...(await collectFiles(adapter, sub)));
	}
	return files;
}

/** 写导入前快照并清理更旧的（.marinmind/ 下只留最近一份） */
async function writeSnapshot(plugin: MarinMindPlugin, adapter: DataAdapter): Promise<void> {
	const bytes = plugin.db!.exportBytes();
	const stamp = timestampStamp();
	await adapter.writeBinary(`.marinmind/${SNAPSHOT_PREFIX}${stamp}.db`, bytes);
	for (const old of (await collectFiles(adapter, ".marinmind"))) {
		const name = old.slice(".marinmind/".length);
		if (name.startsWith(SNAPSHOT_PREFIX) && !name.includes(stamp)) {
			await adapter.remove(old);
		}
	}
}

/** 保证文件路径的父目录存在（vault.createFolder 递归建，已存在会抛错需吞掉） */
async function ensureParentFolder(app: App, filePath: string): Promise<void> {
	const i = filePath.lastIndexOf("/");
	if (i <= 0) return;
	const parent = filePath.slice(0, i);
	if (app.vault.getAbstractFileByPath(parent) instanceof TFolder) return;
	try {
		await app.vault.createFolder(parent);
	} catch {
		// 并发/竞态下已存在则忽略；后续 createBinary 失败会被调用方计数
	}
}

/** Uint8Array → 独立 ArrayBuffer（fflate / sql.js 返回值可能共享或带偏移） */
function toBuffer(data: Uint8Array): ArrayBuffer {
	return data.slice().buffer as ArrayBuffer;
}

/** 本地时间戳戳记：YYYYMMDD-HHmmss */
function timestampStamp(): string {
	const d = new Date();
	const p = (n: number) => String(n).padStart(2, "0");
	return (
		`${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}` +
		`-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`
	);
}
