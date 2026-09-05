import { Notice, Platform } from "obsidian";
import type MarinMindPlugin from "../main";
import { externalFileExists } from "../storage/external-file";
import { loadModule } from "../storage/node-fs-adapter";
import { isAbsoluteFsPath } from "../storage/paths";
import { externalBasename, externalParentDir, planExternalReconcile } from "./external-reconcile";

/** 事件防抖窗口（ms）：目录事件常成串到达（rename 触发多个事件），攒齐再对账 */
const RECONCILE_DEBOUNCE_MS = 500;

/**
 * 库外文档 fs watcher（㊳，仅桌面）：对全部库外记录的父目录建非递归 fs.watch，
 * 文件被改名/移动时自动跟随记录（决策见 external-reconcile 纯函数）。
 *
 * - vault rename 事件覆盖不到库外绝对路径——本模块补齐这一盲区
 * - 尽力而为的增强路径：任何失败只 Notice/console，绝不阻塞阅读
 * - 快照语义：before = 上次对账（或建观察）时的目录内容；"新增" = 两次对账之间
 *   出现且不属于任何记录的 pdf——无关新文件沉淀进快照后不再干扰配对
 */
export class ExternalDocWatcher {
	/** 目录 → fs.watch 句柄（键 = externalParentDir 同源） */
	private readonly watchers = new Map<string, { close(): void }>();
	/** 目录 → 上次对账时的 pdf 文件名集合（配对判定的"之前"基线） */
	private readonly before = new Map<string, Set<string>>();
	private timer: number | null = null;

	constructor(private readonly plugin: MarinMindPlugin) {}

	/**
	 * 重同步观察目录集合。记录集变化后调用（数据层就绪 / 打开库外文档 /
	 * 重关联 / 复制入库）。目录已消失的 watcher 关闭（失联由对账探活上报）。
	 */
	sync(): void {
		if (!Platform.isDesktopApp || typeof require !== "function") {
			return;
		}
		try {
			this.syncInner();
		} catch (err) {
			console.debug("[MarinMind] 库外文档观察同步失败（增强路径，忽略）", err);
		}
	}

	/** 停止观察并清定时器（插件 onunload） */
	close(): void {
		if (this.timer !== null) {
			window.clearTimeout(this.timer);
			this.timer = null;
		}
		for (const entry of this.watchers.values()) {
			try {
				entry.close();
			} catch {
				// 已关闭/句柄失效：忽略
			}
		}
		this.watchers.clear();
		this.before.clear();
	}

	// ---------- 内部实现 ----------

	private syncInner(): void {
		const fs = loadModule<typeof import("fs")>("fs");
		const records = this.plugin.store
			? this.plugin.documents.list().filter((d) => isAbsoluteFsPath(d.filePath))
			: [];
		const dirs = new Set<string>();
		for (const dir of records.map((r) => externalParentDir(r.filePath))) {
			if (dir !== "") {
				dirs.add(dir);
			}
		}
		// 关闭不再需要的 watcher（记录清空 / 目录已消失）
		for (const [dir, entry] of [...this.watchers]) {
			if (!dirs.has(dir)) {
				try {
					entry.close();
				} catch {
					// 忽略
				}
				this.watchers.delete(dir);
				this.before.delete(dir);
			}
		}
		// 新目录挂观察（目录不存在的 fs.watch 会抛——跳过，失联由对账探活上报）
		for (const dir of dirs) {
			if (this.watchers.has(dir)) {
				continue;
			}
			try {
				const w = fs.watch(dir, { persistent: false }, () => this.schedule());
				// 目录被删等错误：关闭句柄等下次 sync 重建（对账探活自会报失联）
				w.on("error", () => {
					try {
						w.close();
					} catch {
						// 忽略
					}
					if (this.watchers.get(dir) === w) {
						this.watchers.delete(dir);
					}
				});
				this.watchers.set(dir, w);
				this.before.set(dir, this.listDocs(fs, dir));
			} catch {
				// 目录缺失/无权限：不观察该目录
			}
		}
	}

	/** 防抖触发对账（事件成串到达，攒齐一次算） */
	private schedule(): void {
		if (this.timer !== null) {
			window.clearTimeout(this.timer);
		}
		this.timer = window.setTimeout(() => {
			this.timer = null;
			void this.reconcile().catch((err) => {
				console.debug("[MarinMind] 库外文档对账失败（增强路径，忽略）", err);
			});
		}, RECONCILE_DEBOUNCE_MS);
	}

	private async reconcile(): Promise<void> {
		const fs = loadModule<typeof import("fs")>("fs");
		const records = this.plugin.store
			? this.plugin.documents.list().filter((d) => isAbsoluteFsPath(d.filePath))
			: [];
		if (records.length === 0) {
			return;
		}
		// 探活 + 各目录当前内容（并行）
		const dirs = [...new Set(records.map((r) => externalParentDir(r.filePath)))].filter(
			(d) => d !== "",
		);
		const [dirFiles, exists] = await Promise.all([
			(async () => {
				const map = new Map<string, Set<string>>();
				for (const dir of dirs) {
					map.set(dir, this.listDocs(fs, dir));
				}
				return map;
			})(),
			Promise.all(records.map((r) => externalFileExists(r.filePath))),
		]);
		const decisions = planExternalReconcile({
			records,
			exists,
			dirFiles,
			dirFilesBefore: this.before,
		});
		for (const d of decisions) {
			const rec = records[d.index];
			if (d.kind === "follow") {
				const ok = this.plugin.documents.renamePath(rec.filePath, d.newPath);
				if (!ok) {
					new Notice(
						`MarinMind：库外文档改名跟随失败（新路径已被其他记录占用），请手动重关联 → ${d.newPath}`,
						6000,
					);
					continue;
				}
				new Notice(
					`MarinMind：库外文档已移动，记录已自动跟随 → ${externalBasename(d.newPath)}`,
					3000,
				);
				this.plugin.applyExternalRename(rec.filePath, d.newPath);
			} else if (d.kind === "missing") {
				new Notice(
					`MarinMind：库外文档失联（可能已移动或删除），可在文档管理中重关联：${externalBasename(rec.filePath)}`,
					6000,
				);
			} else if (d.kind === "ambiguous") {
				new Notice(
					`MarinMind：库外文档失联且无法确定归属（${d.reason}），请手动重关联：${externalBasename(rec.filePath)}`,
					10000,
				);
			}
		}
		// 快照推进：把 before 更新为当前内容（无关新文件沉淀进基线，不再干扰后续配对）；
		// 有跟随决策时记录集已变，sync 会顺带重建快照
		if (decisions.some((d) => d.kind === "follow")) {
			this.sync();
		} else {
			for (const [dir, names] of dirFiles) {
				this.before.set(dir, names);
			}
		}
	}

	/** 目录内文档文件名集合（㊼ 起 .pdf/.epub；失败/空目录返回空集合；保留原名，比较在纯函数内小写归一） */
	private listDocs(fs: typeof import("fs"), dir: string): Set<string> {
		const names = new Set<string>();
		try {
			// readdir 同步版：目录内容小、调用点低频（建观察/对账），不值得引入异步链；
			// 无 withFileTypes 选项返回 string[]
			for (const name of fs.readdirSync(dir)) {
				const lower = name.toLowerCase();
				if (lower.endsWith(".pdf") || lower.endsWith(".epub")) {
					names.add(name);
				}
			}
		} catch {
			// 目录消失/无权限：空集合（对账探活另行报失联）
		}
		return names;
	}
}
