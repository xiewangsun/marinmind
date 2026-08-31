import { afterAll, beforeAll, describe, expect, it } from "vitest";
// vitest 为 ESM 环境，无全局 require——注入 createRequire 产物，
// 使 external-file 的守卫式 require（解析到 globalThis.require）可用
import { createRequire } from "module";
(globalThis as { require?: unknown }).require ??= createRequire(import.meta.url);

import { mkdtemp, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";

import { externalFileExists, readExternalBinary } from "../../src/storage/external-file";

let dir: string;
let pdfPath: string;

beforeAll(async () => {
	// 真实临时目录：库外文件直读的端到端行为（对话框函数 obsidian/electron 耦合不在此覆盖）
	dir = await mkdtemp(join(tmpdir(), "marinmind-external-"));
	pdfPath = join(dir, "某书.pdf");
	await writeFile(pdfPath, new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x37])); // "%PDF-1.7" 魔数
});

afterAll(async () => {
	await rm(dir, { recursive: true, force: true });
});

describe("readExternalBinary", () => {
	it("读回真实文件字节一致", async () => {
		const buf = await readExternalBinary(pdfPath);
		expect(new Uint8Array(buf)).toEqual(new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x37]));
	});
	it("文件不存在时中文错误文案含路径", async () => {
		const missing = join(dir, "不存在.pdf");
		await expect(readExternalBinary(missing)).rejects.toThrow(missing);
		await expect(readExternalBinary(missing)).rejects.toThrow("库外文件不存在");
	});
});

describe("externalFileExists", () => {
	it("存在返回 true、缺失返回 false", async () => {
		expect(await externalFileExists(pdfPath)).toBe(true);
		expect(await externalFileExists(join(dir, "不存在.pdf"))).toBe(false);
	});
});
