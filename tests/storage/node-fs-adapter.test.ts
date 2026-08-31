import { afterAll, beforeAll, describe, expect, it } from "vitest";
// vitest 为 ESM 环境，无全局 require——注入 createRequire 产物，
// 使 NodeFsAdapter 的守卫式 require（解析到 globalThis.require）可用
import { createRequire } from "module";
(globalThis as { require?: unknown }).require ??= createRequire(import.meta.url);

import { mkdtemp, mkdir, rm } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { NodeFsAdapter } from "../../src/storage/node-fs-adapter";

let root = "";
let adapter: NodeFsAdapter;

beforeAll(async () => {
	root = await mkdtemp(join(tmpdir(), "marinmind-test-"));
	adapter = new NodeFsAdapter(root);
});

afterAll(async () => {
	await rm(root, { recursive: true, force: true });
});

describe("NodeFsAdapter", () => {
	it("writeBinary 自动建父目录，readBinary 字节往返一致", async () => {
		const data = new Uint8Array([1, 2, 3, 4]).buffer;
		await adapter.writeBinary("assets/x.png", data);
		await expect(adapter.exists("assets/x.png")).resolves.toBe(true);
		const back = new Uint8Array(await adapter.readBinary("assets/x.png"));
		expect(Array.from(back)).toEqual([1, 2, 3, 4]);
	});

	it("mkdir recursive（多层一次建成，重复不抛错）", async () => {
		await adapter.mkdir("a/b/c");
		await adapter.mkdir("a/b/c");
		await expect(adapter.exists("a/b/c")).resolves.toBe(true);
	});

	it("list 返回根相对路径（正斜杠），目录不存在返回空", async () => {
		await adapter.writeBinary("assets/y.png", new ArrayBuffer(2));
		const listed = await adapter.list("assets");
		expect(listed.files).toContain("assets/x.png");
		expect(listed.files).toContain("assets/y.png");
		const empty = await adapter.list("no-such-dir");
		expect(empty.files).toEqual([]);
	});

	it("remove 后不存在（force 语义：再次删除静默）", async () => {
		await adapter.remove("assets/y.png");
		await expect(adapter.exists("assets/y.png")).resolves.toBe(false);
		await expect(adapter.remove("assets/y.png")).resolves.toBeUndefined();
	});

	it("越出数据根的相对路径被拒绝", async () => {
		await expect(adapter.readBinary("../escape.txt")).rejects.toThrow("越出");
		await expect(adapter.writeBinary("../escape.txt", new ArrayBuffer(1))).rejects.toThrow(
			"越出",
		);
		// "." 与 "" 指向根本身，应放行（list 根场景）
		await expect(adapter.list("")).resolves.toBeTruthy();
	});

	it("外部创建的真实目录对 exists 可见（跨进程互认）", async () => {
		await mkdir(join(root, "outside-made"), { recursive: true });
		await expect(adapter.exists("outside-made")).resolves.toBe(true);
	});
});
