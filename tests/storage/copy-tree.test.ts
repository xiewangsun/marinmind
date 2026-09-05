import { describe, expect, it } from "vitest";
import { copyTree } from "../../src/storage/copy-tree";
import type { ListableStorageAdapter } from "../../src/storage/vault-rooted-adapter";

/** 内存版可列举适配器：writeBinary 自动记父目录，list 返回根相对直接子项 */
class MemoryListableAdapter implements ListableStorageAdapter {
	files = new Map<string, ArrayBuffer>();
	folders = new Set<string>([""]);

	async exists(path: string): Promise<boolean> {
		return this.files.has(path) || this.folders.has(path);
	}
	async mkdir(path: string): Promise<void> {
		this.folders.add(path);
	}
	async readBinary(path: string): Promise<ArrayBuffer> {
		const data = this.files.get(path);
		if (!data) throw new Error(`文件不存在: ${path}`);
		return data;
	}
	async writeBinary(path: string, data: ArrayBuffer): Promise<void> {
		const i = path.lastIndexOf("/");
		if (i > 0) this.folders.add(path.slice(0, i));
		this.files.set(path, data);
	}
	async remove(path: string): Promise<void> {
		this.files.delete(path);
	}
	async list(dir: string): Promise<{ files: string[]; folders: string[] }> {
		const prefix = dir === "" ? "" : `${dir}/`;
		const files: string[] = [];
		const folders: string[] = [];
		for (const f of this.files.keys()) {
			const rest = f.startsWith(prefix) ? f.slice(prefix.length) : null;
			if (rest && !rest.includes("/")) files.push(f);
		}
		for (const d of this.folders) {
			if (d === "") continue;
			const rest = d.startsWith(prefix) ? d.slice(prefix.length) : null;
			if (rest && !rest.includes("/")) folders.push(d);
		}
		return { files, folders };
	}
}

/** 写入失败即抛错的适配器（注入故障用） */
class FailingWriteAdapter extends MemoryListableAdapter {
	failOn = "";
	override async writeBinary(path: string, data: ArrayBuffer): Promise<void> {
		if (path === this.failOn) throw new Error("磁盘已满");
		await super.writeBinary(path, data);
	}
}

function bytes(...arr: number[]): ArrayBuffer {
	return new Uint8Array(arr).buffer;
}

describe("copyTree", () => {
	it("整树复制：文件集合与字节一致，返回计数", async () => {
		const src = new MemoryListableAdapter();
		await src.writeBinary("marinmind.db", bytes(1, 2));
		await src.writeBinary("assets/a.png", bytes(3));
		await src.writeBinary("assets/sub/b.png", bytes(4, 5));
		const dst = new MemoryListableAdapter();

		const result = await copyTree(src, dst, "");

		expect(result.fileCount).toBe(3);
		expect([...dst.files.keys()].sort()).toEqual(
			["assets/a.png", "assets/sub/b.png", "marinmind.db"].sort(),
		);
		expect(
			Array.from(new Uint8Array((await dst.readBinary("marinmind.db")) as ArrayBuffer)),
		).toEqual([1, 2]);
	});

	it("只复制指定子树（relDir 非）", async () => {
		const src = new MemoryListableAdapter();
		await src.writeBinary("marinmind.db", bytes(1));
		await src.writeBinary("assets/a.png", bytes(2));
		const dst = new MemoryListableAdapter();

		const result = await copyTree(src, dst, "assets");

		expect(result.fileCount).toBe(1);
		expect(dst.files.has("assets/a.png")).toBe(true);
		expect(dst.files.has("marinmind.db")).toBe(false);
	});

	it("中途失败：异常上抛，源完好，目标残留部分文件（复制式语义）", async () => {
		const src = new MemoryListableAdapter();
		await src.writeBinary("marinmind.db", bytes(1));
		await src.writeBinary("assets/a.png", bytes(2));
		const dst = new FailingWriteAdapter();
		dst.failOn = "assets/a.png";

		await expect(copyTree(src, dst, "")).rejects.toThrow("磁盘已满");
		// 源完好
		expect(src.files.size).toBe(2);
		// 目标残留先复制的文件（无害，回退依据在源）
		expect(dst.files.has("marinmind.db")).toBe(true);
	});

	it("空数据根复制得零文件", async () => {
		const src = new MemoryListableAdapter();
		const dst = new MemoryListableAdapter();
		const result = await copyTree(src, dst, "");
		expect(result.fileCount).toBe(0);
	});
});
