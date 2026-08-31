import { describe, expect, it } from "vitest";
import type { MediaStorageAdapter } from "../../src/attachments/attachment-store";
import { AttachmentStore } from "../../src/attachments/attachment-store";
import { ASSETS_SUBDIR } from "../../src/constants";

/** 内存适配器（含 remove；模拟 Obsidian DataAdapter 的行为面） */
class MemoryAdapter implements MediaStorageAdapter {
	files = new Map<string, ArrayBuffer>();
	dirs = new Set<string>();
	removed: string[] = [];

	exists(path: string): Promise<boolean> {
		return Promise.resolve(this.files.has(path) || this.dirs.has(path));
	}
	mkdir(path: string): Promise<void> {
		this.dirs.add(path);
		return Promise.resolve();
	}
	readBinary(path: string): Promise<ArrayBuffer> {
		const data = this.files.get(path);
		if (!data) {
			return Promise.reject(new Error(`文件不存在: ${path}`));
		}
		return Promise.resolve(data);
	}
	writeBinary(path: string, data: ArrayBuffer): Promise<void> {
		this.files.set(path, data);
		return Promise.resolve();
	}
	remove(path: string): Promise<void> {
		this.files.delete(path);
		this.removed.push(path);
		return Promise.resolve();
	}
}

function bytesOf(len: number): ArrayBuffer {
	return new ArrayBuffer(len);
}

describe("附件仓 AttachmentStore", () => {
	it("save 返回 assets 下的 uid 根相对路径，read 逐字节还原", async () => {
		const store = new AttachmentStore(new MemoryAdapter());
		const data = new Uint8Array([1, 2, 3, 255]).buffer;
		const path = await store.save(data, "png");

		expect(path.startsWith(`${ASSETS_SUBDIR}/`)).toBe(true);
		expect(path.endsWith(".png")).toBe(true);
		const back = new Uint8Array(await store.read(path));
		expect(Array.from(back)).toEqual([1, 2, 3, 255]);
	});

	it("read/remove 兼容旧版完整 vault 路径的 excerptRef（.marinmind/assets/...）", async () => {
		const adapter = new MemoryAdapter();
		const store = new AttachmentStore(adapter);
		// 旧版 excerptRef 存完整 vault 路径；适配器视角下文件在数据根的 assets/ 内
		adapter.files.set("assets/legacy-uid.png", new Uint8Array([9, 9]).buffer);
		adapter.dirs.add("assets");

		const back = new Uint8Array(await store.read(".marinmind/assets/legacy-uid.png"));
		expect(Array.from(back)).toEqual([9, 9]);
		await expect(store.remove(".marinmind/assets/legacy-uid.png")).resolves.toBeUndefined();
		expect(adapter.files.has("assets/legacy-uid.png")).toBe(false);
	});

	it("两次 save 路径不同（uid 唯一命名 ⇒ 一卡一附件可直接删）", async () => {
		const store = new AttachmentStore(new MemoryAdapter());
		const p1 = await store.save(bytesOf(10), "webm");
		const p2 = await store.save(bytesOf(10), "webm");
		expect(p1).not.toBe(p2);
	});

	it("超过 20MB 上限时抛错且不落盘", async () => {
		const adapter = new MemoryAdapter();
		const store = new AttachmentStore(adapter);
		await expect(store.save(bytesOf(20 * 1024 * 1024 + 1), "png")).rejects.toThrow(
			/20MB/,
		);
		expect(adapter.files.size).toBe(0);
	});

	it("remove 删除已存在的附件", async () => {
		const adapter = new MemoryAdapter();
		const store = new AttachmentStore(adapter);
		const path = await store.save(bytesOf(4), "m4a");
		await store.remove(path);
		await expect(store.read(path)).rejects.toThrow();
	});

	it("remove 不存在的路径静默通过（删除卡无附件时不抛）", async () => {
		const store = new AttachmentStore(new MemoryAdapter());
		await expect(
			store.remove(`${ASSETS_SUBDIR}/不存在的附件.webm`),
		).resolves.toBeUndefined();
	});
});
