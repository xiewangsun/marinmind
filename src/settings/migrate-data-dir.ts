import { Notice, Platform } from "obsidian";
import { ConfirmModal } from "../mindmap/confirm-modal";
import type MarinMindPlugin from "../main";
import { copyTree } from "../storage/copy-tree";
import { resolveDataLocation, type ResolvedLocation } from "../storage/data-location";
import type { ListableStorageAdapter } from "../storage/vault-rooted-adapter";
import { validateDirInput } from "./settings";
import { now } from "../utils";

/** 迁移写探针文件名（验证目标目录可写可删后即删除） */
const PROBE_FILE = ".marinmind-migrate-probe";

/** 冲突备份目录名前缀（目标已有 md 数据时改名保留到该子目录，不扫描不认领） */
const CONFLICT_DIR_PREFIX = "pre-migrate-";

/**
 * 数据目录迁移入口（设置页"应用并迁移"按钮调用；㉚ md 存储版）。
 * newDir 应已通过 validateDirInput 校验；任何失败都保证旧位置数据完好、插件回到可用状态。
 * 迁移是"复制"而非"移动"：旧位置数据保留（天然可回退），确认新版可用后由用户手动删除。
 */
export async function migrateDataDir(plugin: MarinMindPlugin, newDir: string): Promise<void> {
	await plugin.whenReady();
	if (!plugin.store) {
		new Notice("MarinMind：数据层未就绪，无法迁移");
		return;
	}

	const result = validateDirInput(newDir, Platform.isDesktopApp);
	if (!result.ok) {
		new Notice(`MarinMind：数据目录无效：${result.reason}`);
		return;
	}
	if (result.normalized === plugin.settings.dataDir) {
		new Notice("MarinMind：数据目录未变化");
		return;
	}

	// 解析目标（含建根目录）：失败即目标不可用（无权限/非法盘符等）
	let newLoc: ResolvedLocation;
	try {
		newLoc = await resolveDataLocation(plugin.app, result.normalized);
	} catch (err) {
		new Notice(
			`MarinMind：目标目录不可用：${err instanceof Error ? err.message : String(err)}`,
		);
		return;
	}

	// 写探针：验证可写可删（OneDrive/杀软锁定、只读卷在此暴露，早失败早退出）
	try {
		await newLoc.adapter.writeBinary(PROBE_FILE, new ArrayBuffer(0));
		await newLoc.adapter.remove(PROBE_FILE);
	} catch (err) {
		console.error("[MarinMind] 迁移探针失败", err);
		new Notice("MarinMind：目标目录不可写，已取消迁移");
		return;
	}

	// 目标已有 MarinMind md 数据：不静默覆盖（可能是另一台机器的完整库），默认取消
	if (await hasAnyMd(newLoc.adapter)) {
		new ConfirmModal(
			plugin.app,
			"目标目录已有 MarinMind 数据",
			`${result.normalized} 下已存在 MarinMind 的 md 数据文件。\n` +
				"继续将把已有文件移动保留到 pre-migrate-备份子目录后写入新数据（不会静默丢弃）。\n建议先确认该目录无需保留。继续？",
			() => void performMigration(plugin, newLoc, result.normalized, true),
		).open();
		return;
	}
	new ConfirmModal(
		plugin.app,
		"迁移数据目录",
		`将把数据（md 笔记 + 媒体附件 + 快照）从\n  ${plugin.settings.dataDir}\n复制到\n  ${result.normalized}\n` +
			"旧位置数据保留作为回退（确认新版可用后可手动删除）。\n完成后 Obsidian 将自动重载。继续？",
		() => void performMigration(plugin, newLoc, result.normalized, false),
	).open();
}

/** 递归探测目录下是否存在 md 文件（冲突检测） */
async function hasAnyMd(adapter: ListableStorageAdapter): Promise<boolean> {
	async function walk(dir: string): Promise<boolean> {
		const listed = await adapter.list(dir);
		if (listed.files.some((f) => f.endsWith(".md"))) return true;
		for (const sub of listed.folders) {
			if (await walk(sub)) return true;
		}
		return false;
	}
	return walk("");
}

/** 迁移核心：停写 → 复制 → 落盘设置 → 重载；失败回滚到旧位置（设置不落盘） */
async function performMigration(
	plugin: MarinMindPlugin,
	newLoc: ResolvedLocation,
	normalizedDir: string,
	moveExisting: boolean,
): Promise<void> {
	const oldLoc = plugin.dataLoc;
	// P3-1 时长档：进度类 0 手动关
	const notice = new Notice("MarinMind：正在迁移数据…", 0);
	try {
		// 目标旧数据搬家保留（仅冲突继续路径）：移入时间戳子目录，不被插件扫描认领
		if (moveExisting) {
			await stashExistingMd(newLoc.adapter, `${CONFLICT_DIR_PREFIX}${now()}`);
		}

		// 停写铁律（与备份导入 doImport 相同次序）：先 flush 把内存权威落到旧位置，
		// 再 close 终止防抖定时器，最后解除引用让视图判空守卫生效。
		// md 存储无单库文件快照——flush 后磁盘即权威，copyTree 整树复制即完整迁移
		await plugin.store!.flush();
		plugin.store!.close();
		plugin.store = undefined;

		// 复制整树：md 笔记 / assets 附件 / 既有快照 / 遗留的旧版 .db 一并过去
		await copyTree(oldLoc.adapter, newLoc.adapter, "");

		// 落盘设置（成功路径最后一步；此前任何失败都不写设置）
		plugin.settings.dataDir = normalizedDir;
		await plugin.saveData({ ...plugin.settings });

		notice.hide();
		new Notice(
			`MarinMind：迁移完成，正在重载。旧数据保留在 ${oldLoc.rootDir}，确认新版可用后可手动删除`,
			10000,
		);
		if (Platform.isDesktopApp) {
			// App 类型未公开 commands 字段，做最小形状断言（backup-service 同款先例）
			(
				plugin.app as unknown as {
					commands: { executeCommandById(id: string): unknown };
				}
			).commands.executeCommandById("app:reload");
		} else {
			// 移动端无 app:reload；不重启则旧会话可能覆盖新位置数据
			new Notice("MarinMind：请立即重启 Obsidian，否则数据可能被旧会话覆盖！", 10000);
		}
	} catch (err) {
		console.error("[MarinMind] 数据迁移失败", err);
		notice.hide();
		// 回滚：迁移是复制式，旧位置未动——重开旧库即恢复运行（设置从未落盘）
		try {
			await plugin.openAndWire(oldLoc);
			new Notice("MarinMind：迁移失败，已恢复原数据目录运行，可重试");
		} catch (reopenErr) {
			console.error("[MarinMind] 迁移回滚失败", reopenErr);
			new Notice("MarinMind：迁移失败且回滚异常，请重启 Obsidian（旧数据仍在原位置）", 10000);
		}
	}
}

/** 把数据根现有 md 树移动到 stashDir/（冲突保留：目标根 → stashDir，逐文件搬迁） */
async function stashExistingMd(adapter: ListableStorageAdapter, stashDir: string): Promise<void> {
	async function walk(dir: string): Promise<void> {
		const listed = await adapter.list(dir);
		for (const file of listed.files) {
			if (!file.endsWith(".md")) continue;
			const bytes = await adapter.readBinary(file);
			await adapter.writeBinary(`${stashDir}/${file}`, bytes.slice(0));
			await adapter.remove(file);
		}
		for (const sub of listed.folders) {
			await walk(sub);
		}
	}
	await walk("");
}
