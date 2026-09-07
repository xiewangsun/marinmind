import type { DataAdapter } from "obsidian";
import type { StorageAdapter } from "./adapter";
import { dirSegments, joinRel } from "./paths";

/**
 * 可列举的存储适配器：迁移与备份需要目录遍历。
 * 结构上兼容 MediaStorageAdapter（AttachmentStore 可直接接收本接口实例）。
 */
export interface ListableStorageAdapter extends StorageAdapter {
	remove(path: string): Promise<void>;
	/** 列出目录的直接子项（files/folders 均为根相对路径）；目录不存在返回空 */
	list(dir: string): Promise<{ files: string[]; folders: string[] }>;
	/** 删除空目录（可选能力：123 布局迁移搬空旧「脑图/」目录用；不存在时静默） */
	rmdir?(path: string): Promise<void>;
}

/** vault 内数据根适配器：根相对路径 → vault 相对路径（加 rootDir 前缀）后委托 vault.adapter */
export class VaultRootedAdapter implements ListableStorageAdapter {
	constructor(
		private readonly vaultAdapter: DataAdapter,
		private readonly rootDir: string,
	) {}

	/** 根相对 → vault 相对（rel 为空串时即数据根本身） */
	private abs(rel: string): string {
		return joinRel(this.rootDir, rel);
	}

	async exists(rel: string): Promise<boolean> {
		return this.vaultAdapter.exists(this.abs(rel));
	}

	async mkdir(rel: string): Promise<void> {
		// vault.adapter.mkdir 非递归且目录已存在会抛错——对目标全路径逐层创建并容忍"已存在"
		for (const seg of dirSegments(this.abs(rel))) {
			if (!(await this.vaultAdapter.exists(seg))) {
				try {
					await this.vaultAdapter.mkdir(seg);
				} catch {
					// 并发下被抢先创建；若实际仍缺失，由后续写操作的失败暴露
				}
			}
		}
	}

	async readBinary(rel: string): Promise<ArrayBuffer> {
		return this.vaultAdapter.readBinary(this.abs(rel));
	}

	async writeBinary(rel: string, data: ArrayBuffer): Promise<void> {
		// DataAdapter.writeBinary 只创建文件，父目录需先行保证（传根相对路径给 mkdir，勿双重拼前缀）
		const i = rel.lastIndexOf("/");
		if (i > 0) {
			await this.mkdir(rel.slice(0, i));
		}
		await this.vaultAdapter.writeBinary(this.abs(rel), data);
	}

	async remove(rel: string): Promise<void> {
		try {
			await this.vaultAdapter.remove(this.abs(rel));
		} catch {
			// 不存在时静默（与 AttachmentStore.remove 既有语义一致）
		}
	}

	async list(rel: string): Promise<{ files: string[]; folders: string[] }> {
		const path = this.abs(rel);
		if (!(await this.vaultAdapter.exists(path))) {
			return { files: [], folders: [] };
		}
		const listed = await this.vaultAdapter.list(path);
		return {
			// vault.adapter.list 返回 vault 相对全路径，剥去 rootDir 前缀归一为根相对
			files: listed.files.map((f) => stripRoot(f, this.rootDir)),
			folders: listed.folders.map((f) => stripRoot(f, this.rootDir)),
		};
	}

	async rmdir(rel: string): Promise<void> {
		try {
			await this.vaultAdapter.rmdir(this.abs(rel), false);
		} catch {
			// 不存在 / 非空（有残留文件）时静默——调用方仅作尽力清理
		}
	}
}

/** 剥去路径的根前缀（无前缀时原样返回，防御 list 实现差异） */
function stripRoot(path: string, rootDir: string): string {
	const prefix = `${rootDir}/`;
	return path.startsWith(prefix) ? path.slice(prefix.length) : path;
}
