import type { ListableStorageAdapter } from "./vault-rooted-adapter";

/**
 * 桌面端 node fs 适配器：数据根为本机绝对路径，操作经 path.resolve 锁定在根内。
 *
 * node 模块加载铁律（违反会破坏移动端或构建）：
 * - builtin-modules 不含 "fs/promises"，必须 require("fs") 后取 .promises
 * - 只能在方法体内守卫式 require（esbuild external 约定下 CJS 产物原样保留；
 *   顶层静态 import 在移动端加载期即崩）
 * - 移动端不得实例化本类（调用点一律 Platform.isDesktopApp 守卫）；
 *   vitest（ESM 无 require）由测试文件注入 globalThis.require
 */
export class NodeFsAdapter implements ListableStorageAdapter {
	/** 模块级缓存：require 是同步开销极低的本地调用，缓存仅避免重复查找 */
	private static fsMod?: typeof import("fs");
	private static pathMod?: typeof import("path");

	/** 规范化后的根绝对路径（构造即解析，越界检查的基准） */
	private readonly rootAbs: string;

	constructor(rootDir: string) {
		this.rootAbs = this.path().resolve(rootDir);
	}

	/** 懒加载 node:fs（typeof 守卫下裸 require 在 CJS / 注入 globalThis.require 的 ESM 中均可用） */
	private fs(): typeof import("fs") {
		NodeFsAdapter.fsMod ??= loadModule<typeof import("fs")>("fs");
		return NodeFsAdapter.fsMod;
	}

	/** 懒加载 node:path */
	private path(): typeof import("path") {
		NodeFsAdapter.pathMod ??= loadModule<typeof import("path")>("path");
		return NodeFsAdapter.pathMod;
	}

	async exists(rel: string): Promise<boolean> {
		try {
			await this.fs().promises.stat(this.abs(rel));
			return true;
		} catch (err) {
			if ((err as NodeJS.ErrnoException).code === "ENOENT") return false;
			throw err;
		}
	}

	async mkdir(rel: string): Promise<void> {
		// rel 为空串时即数据根本身；recursive 幂等，已存在不报错
		await this.fs().promises.mkdir(this.abs(rel), { recursive: true });
	}

	async readBinary(rel: string): Promise<ArrayBuffer> {
		const buf = await this.fs().promises.readFile(this.abs(rel));
		// 复制独立 buffer，避免与 node 内部池化内存共享
		return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
	}

	async writeBinary(rel: string, data: ArrayBuffer): Promise<void> {
		const abs = this.abs(rel);
		// 先保证父目录存在再写文件
		const parent = this.path().dirname(abs);
		await this.fs().promises.mkdir(parent, { recursive: true });
		await this.fs().promises.writeFile(abs, new Uint8Array(data));
	}

	async remove(rel: string): Promise<void> {
		// force：不存在时静默（与 AttachmentStore.remove 既有语义一致）
		await this.fs().promises.rm(this.abs(rel), { recursive: true, force: true });
	}

	async rmdir(rel: string): Promise<void> {
		try {
			// 仅删空目录（recursive:false）；不存在 / 非空静默——调用方仅作尽力清理
			await this.fs().promises.rmdir(this.abs(rel));
		} catch {
			// ENOENT / ENOTEMPTY 均视为无需处理
		}
	}

	async list(rel: string): Promise<{ files: string[]; folders: string[] }> {
		if (!(await this.exists(rel))) {
			return { files: [], folders: [] };
		}
		const entries = await this.fs().promises.readdir(this.abs(rel), {
			withFileTypes: true,
		});
		const files: string[] = [];
		const folders: string[] = [];
		for (const entry of entries) {
			// 归一为根相对路径（正斜杠，与 vault 侧约定一致）
			const child = rel ? `${rel}/${entry.name}` : entry.name;
			if (entry.isDirectory()) {
				folders.push(child);
			} else {
				files.push(child);
			}
		}
		return { files, folders };
	}

	/** 相对路径 → 绝对路径：path.resolve 归一并拒绝越出数据根的输入 */
	private abs(rel: string): string {
		const abs = this.path().resolve(this.rootAbs, rel);
		if (abs !== this.rootAbs && !abs.startsWith(this.rootAbs + this.path().sep)) {
			throw new Error(`路径越出数据根目录：${rel}`);
		}
		return abs;
	}
}

/**
 * 守卫式加载 node 内置模块：移动端 / 未注入的测试环境给出明确错误而非 ReferenceError。
 * 导出公共守卫加载器——NodeFsAdapter 与 external-file（库外文件直读）单点收敛同一铁律。
 */
export function loadModule<T>(id: string): T {
	if (typeof require !== "function") {
		throw new Error(`node 模块 ${id} 仅桌面端可用`);
	}
	// CJS 产物中 require 由运行时提供；测试环境解析到注入的 globalThis.require
	return (require as (moduleId: string) => T)(id);
}
