import { Notice, Platform, TFile, TFolder } from "obsidian";
import type { App } from "obsidian";
import { ASSETS_SUBDIR, SNAPSHOT_DIR, SNAPSHOT_PREFIX } from "../constants";
import { ConfirmModal } from "../mindmap/confirm-modal";
import type MarinMindPlugin from "../main";
import type { ListableStorageAdapter } from "../storage/vault-rooted-adapter";
import { isAbsoluteFsPath } from "../storage/paths";
import {
	BACKUP_FORMAT,
	BACKUP_VERSION,
	buildBackupZip,
	parseBackupZip,
	type BackupContent,
	type BackupManifest,
} from "./backup-zip";
import { normalizeBackupNotePath } from "../store/layout-migrate";

/**
 * 导出备份（㉚ md 存储版）：数据根 md 树 + 全部文档 PDF + 媒体附件 → 单个 .marginpkg（zip）。
 * 先 flush 确保磁盘为内存最新，再从数据根读文件组包。大库同步打包会短暂阻塞 UI
 * （fflate 同步 API），先出 Notice 预告。落点为插件设置"备份目录"。
 */
export async function exportBackup(plugin: MarinMindPlugin): Promise<void> {
	await plugin.whenReady();
	if (!plugin.store) {
		new Notice("MarinMind：数据层未就绪，无法导出");
		return;
	}
	// P3-1 时长档：进度类 0 手动关
	const notice = new Notice("MarinMind：正在打包备份…（大库可能卡顿数秒）", 0);
	try {
		await plugin.store.flush(); // 磁盘对齐内存权威（防抖窗口内可能有未写变更）
		const dataAdapter = plugin.dataLoc.adapter;
		const documents = plugin.documents.list();
		const stats = plugin.store.stats();

		// 文档 PDF 按路径形态分流：库内 vault 读取入包；库外绝对路径（㉞）刻意不打包
		// ——仅保留记录（md 书文件内的 file_path），跨机器导入后显示失联走重关联
		const docEntries: { path: string; bytes: Uint8Array }[] = [];
		let missing = 0;
		let externalSkipped = 0;
		for (const doc of documents) {
			if (isAbsoluteFsPath(doc.filePath)) {
				externalSkipped++;
				continue;
			}
			if (plugin.app.vault.getAbstractFileByPath(doc.filePath) instanceof TFile) {
				docEntries.push({
					path: doc.filePath,
					bytes: new Uint8Array(await plugin.app.vault.adapter.readBinary(doc.filePath)),
				});
			} else {
				missing++;
			}
		}
		const noteEntries = await collectNoteEntries(dataAdapter);
		const assetEntries = await collectAssetEntries(dataAdapter);

		const manifest: BackupManifest = {
			format: BACKUP_FORMAT,
			version: BACKUP_VERSION,
			storage: "markdown",
			appVersion: plugin.manifest.version,
			exportedAt: new Date().toISOString(),
			documentCount: documents.length,
			cardCount: stats.cards,
			assetCount: assetEntries.length,
		};
		const zipped = buildBackupZip(
			{ notes: noteEntries, documents: docEntries, assets: assetEntries },
			manifest,
		);

		// 写入备份目录（适配器 writeBinary 自建父目录；vault 内与桌面绝对路径统一处理）
		const target = `marinmind-${timestampStamp()}.marginpkg`;
		await plugin.backupLoc.adapter.writeBinary(target, toBuffer(zipped));
		const shown = `${plugin.backupLoc.rootDir}/${target}`;

		new Notice(
			`MarinMind：备份已导出：${shown}` +
				(missing > 0 ? `（${missing} 个文档文件已不在库中，未打包）` : "") +
				(externalSkipped > 0
					? `；库外文档 ${externalSkipped} 个未打包，请自行备份原文件`
					: ""),
			6000,
		);
	} catch (err) {
		console.error("[MarinMind] 备份导出失败", err);
		new Notice(`MarinMind：备份导出失败：${err instanceof Error ? err.message : String(err)}`);
	} finally {
		notice.hide();
	}
}

/** 导入入口：弹系统文件选择器（可选 vault 外文件）→ 读字节 → 校验并确认 */
export function promptImportBackup(plugin: MarinMindPlugin): void {
	const input = document.createElement("input");
	input.type = "file";
	input.accept = ".marginpkg";
	input.hidden = true; // P3-3：隐藏 file input 用 hidden 属性（UA 规则对 inline-block 生效）
	input.addEventListener("change", () => {
		const file = input.files?.[0];
		input.remove();
		if (!file) return;
		void file
			.arrayBuffer()
			.then((bytes) => importBackupFromBytes(plugin, bytes))
			.catch((err) => {
				console.error("[MarinMind] 备份文件读取失败", err);
				new Notice("MarinMind：备份文件读取失败");
			});
	});
	// 选完/取消后移除节点，避免残留
	input.addEventListener("cancel", () => input.remove());
	document.body.appendChild(input);
	input.click();
}

/** 校验备份包并弹确认框；真正落地在 doImport（v1 旧包在 parseBackupZip 一层即被拒） */
export function importBackupFromBytes(plugin: MarinMindPlugin, bytes: ArrayBuffer): void {
	const u8 = new Uint8Array(bytes);
	let content: BackupContent;
	try {
		content = parseBackupZip(u8);
	} catch (err) {
		new Notice(`MarinMind：导入失败：${err instanceof Error ? err.message : String(err)}`);
		return;
	}
	const m = content.manifest;
	new ConfirmModal(
		plugin.app,
		"导入备份",
		`将替换全部 MarinMind 数据（文档 ${m.documentCount} · 卡片 ${m.cardCount} · 导出于 ${m.exportedAt}）。\n` +
			"当前数据会先自动快照到数据目录；导入后 Obsidian 将重载（未保存的其他编辑会丢失）。\n继续？",
		() => void doImport(plugin, content),
	).open();
}

/** 导入落地（㉚）：快照旧 md 树 → 停写 → 清空现有 md → 写入备份 md 树 → 恢复文档与附件 → 重载 */
async function doImport(plugin: MarinMindPlugin, content: BackupContent): Promise<void> {
	const notice = new Notice("MarinMind：正在导入备份…", 0);
	try {
		const dataAdapter = plugin.dataLoc.adapter;

		// 1) 导入前安全快照（数据根下 SNAPSHOT_DIR 只保留最近一份），失败不阻断导入
		if (plugin.store) {
			try {
				await writeSnapshot(plugin, dataAdapter);
			} catch (err) {
				console.warn("[MarinMind] 导入前快照失败（忽略）", err);
			}
		}

		// 2) 顺序不可反：先 flush 落盘旧数据，再 close 终止防抖定时器——
		//    否则之后 reload 触发 onunload 的 flush 会用旧内存数据覆盖刚导入的新文件
		if (plugin.store) {
			await plugin.store.flush();
			plugin.store.close();
			plugin.store = undefined;
		}

		// 3) 清空数据根现有 md（整库替换语义；快照目录与其内文件豁免）
		for (const file of await collectMdFiles(dataAdapter, "")) {
			if (isSnapshotPath(file)) continue;
			await dataAdapter.remove(file);
		}

		// 4) 写入备份 md 树（parseBackupZip 已拷贝独立 buffer）。
		//    123 布局归一：旧 v2 包的平铺书 md → books/、「脑图/」前缀 → mindmaps/，
		//    新布局路径原样——旧包导入后无需等启动迁移即落规范位置
		for (const note of content.notes) {
			const target = normalizeBackupNotePath(note.path, note.bytes);
			await dataAdapter.writeBinary(target, note.bytes.slice().buffer as ArrayBuffer);
		}

		// 5) 恢复文档：库内已存在的文件（TFile）跳过，用户本地版本优先
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
				await plugin.app.vault.createBinary(
					doc.path,
					doc.bytes.slice().buffer as ArrayBuffer,
				);
				restored++;
			} catch (err) {
				console.warn(`[MarinMind] 恢复文档失败：${doc.path}`, err);
				skipped++;
			}
		}

		// 6) 恢复附件（数据根的 assets/ 子目录，适配器直接覆盖写）
		if (!(await dataAdapter.exists(ASSETS_SUBDIR))) {
			await dataAdapter.mkdir(ASSETS_SUBDIR); // 父目录（数据根）由目录定位解析时保证
		}
		for (const asset of content.assets) {
			await dataAdapter.writeBinary(
				`${ASSETS_SUBDIR}/${asset.path}`,
				asset.bytes.slice().buffer as ArrayBuffer,
			);
		}

		// 7) 内存中各视图仍持有旧数据快照，最干净的生效方式是整库重载
		notice.hide();
		if (Platform.isDesktopApp) {
			new Notice(
				`MarinMind：导入完成（恢复 ${restored} 个文档，跳过 ${skipped} 个），正在重载…`,
				6000,
			);
			// App 类型未公开 commands 字段，做最小形状断言
			(
				plugin.app as unknown as {
					commands: { executeCommandById(id: string): unknown };
				}
			).commands.executeCommandById("app:reload");
		} else {
			// 移动端无 app:reload；窗口期内继续操作会用旧内存库覆盖导入数据，必须立即重启
			new Notice(
				`MarinMind：导入完成（恢复 ${restored}，跳过 ${skipped}）。请立即重启 Obsidian，否则数据可能被旧会话覆盖！`,
				10000,
			);
		}
	} catch (err) {
		console.error("[MarinMind] 备份导入失败", err);
		notice.hide();
		new Notice(`MarinMind：备份导入失败：${err instanceof Error ? err.message : String(err)}`);
	}
}

/** 收集数据根的 md 文件树（快照目录豁免）：books/ 书、mindmaps/ 脑图、根层系统文件全部进备份 */
async function collectNoteEntries(
	adapter: ListableStorageAdapter,
): Promise<{ path: string; bytes: Uint8Array }[]> {
	const entries: { path: string; bytes: Uint8Array }[] = [];
	for (const file of await collectMdFiles(adapter, "")) {
		if (isSnapshotPath(file)) continue; // 导入前快照不入包
		entries.push({ path: file, bytes: new Uint8Array(await adapter.readBinary(file)) });
	}
	return entries;
}

/** 递归收集 md 文件（根相对路径）；目录不存在返回空 */
async function collectMdFiles(adapter: ListableStorageAdapter, dir: string): Promise<string[]> {
	const listed = await adapter.list(dir);
	const files = listed.files.filter((f) => f.endsWith(".md"));
	for (const sub of listed.folders) {
		files.push(...(await collectMdFiles(adapter, sub)));
	}
	return files;
}

/** 递归收集附件目录下全部文件，返回（相对 assets/ 的路径, 字节） */
async function collectAssetEntries(
	adapter: ListableStorageAdapter,
): Promise<{ path: string; bytes: Uint8Array }[]> {
	const files = await collectFiles(adapter, ASSETS_SUBDIR);
	const entries: { path: string; bytes: Uint8Array }[] = [];
	for (const full of files) {
		const rel = full.startsWith(`${ASSETS_SUBDIR}/`)
			? full.slice(ASSETS_SUBDIR.length + 1)
			: full;
		entries.push({ path: rel, bytes: new Uint8Array(await adapter.readBinary(full)) });
	}
	return entries;
}

/** 递归列出目录下全部文件（根相对路径）；目录不存在返回空 */
async function collectFiles(adapter: ListableStorageAdapter, dir: string): Promise<string[]> {
	if (!(await adapter.exists(dir))) return [];
	const listed = await adapter.list(dir);
	const files = [...listed.files];
	for (const sub of listed.folders) {
		files.push(...(await collectFiles(adapter, sub)));
	}
	return files;
}

/** 是否导入前快照路径（SNAPSHOT_DIR 目录内 或 旧版 .db 快照文件） */
function isSnapshotPath(relPath: string): boolean {
	if (relPath === SNAPSHOT_DIR || relPath.startsWith(`${SNAPSHOT_DIR}/`)) return true;
	const name = relPath.slice(relPath.lastIndexOf("/") + 1);
	return name.startsWith(SNAPSHOT_PREFIX);
}

/**
 * 写导入前快照：现有 md 树复制到 SNAPSHOT_DIR/（只保留最近一份），
 * 并清理更旧的快照（含旧版 .db 快照文件）。
 */
async function writeSnapshot(
	plugin: MarinMindPlugin,
	adapter: ListableStorageAdapter,
): Promise<void> {
	// 旧快照清理（目录 + 旧版 .db 文件）
	if (await adapter.exists(SNAPSHOT_DIR)) {
		for (const file of await collectFiles(adapter, SNAPSHOT_DIR)) {
			await adapter.remove(file);
		}
	}
	for (const old of await collectFiles(adapter, "")) {
		const name = old.slice(old.lastIndexOf("/") + 1);
		if (name.startsWith(SNAPSHOT_PREFIX) && name.endsWith(".db")) {
			await adapter.remove(old);
		}
	}
	// 复制现有 md（含快照目录自身豁免——正常不存在）
	for (const file of await collectMdFiles(adapter, "")) {
		if (isSnapshotPath(file)) continue;
		const target = `${SNAPSHOT_DIR}/${file}`;
		const bytes = await adapter.readBinary(file);
		await adapter.writeBinary(target, bytes.slice(0));
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

/** Uint8Array → 独立 ArrayBuffer（fflate 返回值可能共享或带偏移） */
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
