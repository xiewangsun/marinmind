import type { ListableStorageAdapter } from "../../src/storage/vault-rooted-adapter";

/**
 * 内存版可列举适配器（㉚ md 存储测试共用）：模拟 vault.adapter，
 * 并按路径统计写次数（零写契约 / 防写放大断言用）。
 */
export class MemoryAdapter implements ListableStorageAdapter {
	files = new Map<string, ArrayBuffer>();
	writeCounts = new Map<string, number>();

	exists(path: string): Promise<boolean> {
		if (this.files.has(path)) return Promise.resolve(true);
		// 目录形态：有任意子文件即视为存在（真实适配器对目录的语义）
		const prefix = `${path}/`;
		for (const p of this.files.keys()) {
			if (p.startsWith(prefix)) return Promise.resolve(true);
		}
		return Promise.resolve(false);
	}
	mkdir(): Promise<void> {
		return Promise.resolve();
	}
	readBinary(path: string): Promise<ArrayBuffer> {
		const data = this.files.get(path);
		if (!data) return Promise.reject(new Error(`文件不存在: ${path}`));
		return Promise.resolve(data);
	}
	writeBinary(path: string, data: ArrayBuffer): Promise<void> {
		this.writeCounts.set(path, (this.writeCounts.get(path) ?? 0) + 1);
		this.files.set(path, data);
		return Promise.resolve();
	}
	remove(path: string): Promise<void> {
		this.files.delete(path);
		return Promise.resolve();
	}
	list(dir: string): Promise<{ files: string[]; folders: string[] }> {
		const prefix = dir ? `${dir}/` : "";
		const files: string[] = [];
		const folders: string[] = [];
		for (const p of this.files.keys()) {
			if (!p.startsWith(prefix)) continue;
			const rest = p.slice(prefix.length);
			const slash = rest.indexOf("/");
			if (slash >= 0) {
				const folder = prefix + rest.slice(0, slash);
				if (!folders.includes(folder)) folders.push(folder);
			} else {
				files.push(p);
			}
		}
		return Promise.resolve({ files, folders });
	}

	/** 删空目录（124 webclip-migrate 用）：目录本身不单独跟踪，仅当无内容时成功 */
	rmdir(path: string): Promise<void> {
		for (const p of this.files.keys()) {
			if (p.startsWith(`${path}/`)) {
				return Promise.reject(new Error("目录非空"));
			}
		}
		return Promise.resolve();
	}
}

/** 读出适配器内文件文本 */
export function textOf(adapter: MemoryAdapter, path: string): string {
	const data = adapter.files.get(path);
	if (!data) throw new Error(`文件不存在: ${path}`);
	return new TextDecoder().decode(data);
}

/** 向适配器写入文本（模拟外部手编） */
export function writeText(adapter: MemoryAdapter, path: string, text: string): void {
	adapter.files.set(path, new TextEncoder().encode(text).buffer as ArrayBuffer);
}

/**
 * 偷看 store 的脏 scope 集合（防写放大断言：无命中操作不应标脏）。
 * dirtyScopes 为私有字段——测试以最小形状断言访问，不进生产 API。
 */
export function dirtyScopeCount(store: { markDirty(scope: string): void }): number {
	const scopes = (store as unknown as { dirtyScopes?: Set<string> }).dirtyScopes;
	return scopes ? scopes.size : 0;
}
