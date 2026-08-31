import { describe, expect, it } from "vitest";
import type { DataAdapter } from "obsidian";
import { VaultRootedAdapter } from "../../src/storage/vault-rooted-adapter";

/**
 * 内存版 vault DataAdapter：复刻 Obsidian 关键语义——
 * mkdir 非递归且已存在抛错、list 返回 vault 相对全路径、remove 不存在抛错。
 */
class FakeDataAdapter {
	files = new Map<string, ArrayBuffer>();
	folders = new Set<string>([""]);

	async exists(path: string): Promise<boolean> {
		return this.files.has(path) || this.folders.has(path);
	}
	async mkdir(path: string): Promise<void> {
		if (this.folders.has(path)) throw new Error("Folder already exists");
		this.folders.add(path);
	}
	async readBinary(path: string): Promise<ArrayBuffer> {
		const data = this.files.get(path);
		if (!data) throw new Error(`文件不存在: ${path}`);
		return data;
	}
	async writeBinary(path: string, data: ArrayBuffer): Promise<void> {
		this.files.set(path, data);
	}
	async remove(path: string): Promise<void> {
		if (!this.files.delete(path) && !this.folders.delete(path)) {
			throw new Error(`不存在: ${path}`);
		}
	}
	async list(path: string): Promise<{ files: string[]; folders: string[] }> {
		const prefix = path === "" ? "" : `${path}/`;
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

function makeAdapter(rootDir = ".marinmind"): {
	rooted: VaultRootedAdapter;
	fake: FakeDataAdapter;
} {
	const fake = new FakeDataAdapter();
	return { rooted: new VaultRootedAdapter(fake as unknown as DataAdapter, rootDir), fake };
}

describe("VaultRootedAdapter", () => {
	it("writeBinary 自动逐层创建父目录（vault mkdir 已存在幂等）", async () => {
		const { rooted, fake } = makeAdapter();
		await rooted.writeBinary("assets/a.png", new ArrayBuffer(8));
		expect(fake.folders.has(".marinmind")).toBe(true);
		expect(fake.folders.has(".marinmind/assets")).toBe(true);
		expect(fake.files.has(".marinmind/assets/a.png")).toBe(true);
		// 再写一层，已存在的父目录不重复创建也不抛错
		await rooted.writeBinary("assets/sub/b.png", new ArrayBuffer(4));
		expect(fake.folders.has(".marinmind/assets/sub")).toBe(true);
	});

	it("mkdir(rel) 对空 rel 保证数据根存在", async () => {
		const { rooted, fake } = makeAdapter("CustomData");
		await rooted.mkdir("");
		expect(fake.folders.has("CustomData")).toBe(true);
	});

	it("readBinary/exists/remove 走前缀拼接路径", async () => {
		const { rooted } = makeAdapter();
		const bytes = new ArrayBuffer(8);
		await rooted.writeBinary("assets/x.png", bytes);
		await expect(rooted.exists("assets/x.png")).resolves.toBe(true);
		await expect(rooted.exists("assets/nope.png")).resolves.toBe(false);
		await expect(rooted.readBinary("assets/x.png")).resolves.toBe(bytes);
		// remove 不存在时静默（吞 DataAdapter 抛错）
		await expect(rooted.remove("assets/nope.png")).resolves.toBeUndefined();
	});

	it("list 返回剥去 rootDir 前缀的根相对路径", async () => {
		const { rooted } = makeAdapter();
		await rooted.writeBinary("marinmind.db", new ArrayBuffer(4));
		await rooted.writeBinary("assets/a.png", new ArrayBuffer(4));
		await rooted.writeBinary("assets/sub/b.png", new ArrayBuffer(4));
		const rootList = await rooted.list("");
		expect(rootList.files).toEqual(["marinmind.db"]);
		expect(rootList.folders).toEqual(["assets"]);
		const assetList = await rooted.list("assets");
		expect(assetList.files).toEqual(["assets/a.png"]);
		expect(assetList.folders).toEqual(["assets/sub"]);
	});

	it("list 目录不存在返回空", async () => {
		const { rooted } = makeAdapter();
		const listed = await rooted.list("assets");
		expect(listed.files).toEqual([]);
		expect(listed.folders).toEqual([]);
	});
});
