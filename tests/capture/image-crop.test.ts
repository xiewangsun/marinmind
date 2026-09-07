/**
 * image-crop 纯函数单测（118）：dataUrlToBytes 解码链（Buffer 快路径，
 * 测试注入 globalThis.require 走桌面主路径；118 批起收 png|webp 两种格式
 * ——落库路径 WebP 优先回退 PNG）。canvas 裁剪（cropScreenRegion）依赖
 * DOM canvas 2d，jsdom 不支持——与 114 同约定，由桌面手动验收。
 */
import { describe, expect, it } from "vitest";
// vitest 为 ESM 环境，无全局 require——注入 createRequire 产物，
// 使 loadModule 守卫式 require（解析到 globalThis.require）走 Buffer 快路径
import { createRequire } from "module";
(globalThis as { require?: unknown }).require ??= createRequire(import.meta.url);

import { dataUrlToBytes } from "../../src/capture/image-crop";

/** 字节 → 指定格式 dataURL（构造输入用；png|webp 为本模块产物格式） */
const toDataUrl = (bytes: Uint8Array, mime: "image/png" | "image/webp" = "image/png"): string =>
	`data:${mime};base64,${Buffer.from(bytes).toString("base64")}`;

describe("dataUrlToBytes", () => {
	it("合法 PNG dataURL 往返（Buffer 快路径）", () => {
		const src = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 255]);
		expect(Array.from(dataUrlToBytes(toDataUrl(src))!)).toEqual(Array.from(src));
	});

	it("合法 WebP dataURL 往返（落库路径 WebP 优先的解码端）", () => {
		// WebP 文件头（RIFF....WEBP）
		const src = new Uint8Array([
			0x52, 0x49, 0x46, 0x46, 0x24, 0x00, 0x00, 0x00, 0x57, 0x45, 0x42, 0x50,
		]);
		expect(Array.from(dataUrlToBytes(toDataUrl(src, "image/webp"))!)).toEqual(Array.from(src));
	});

	it("非 png/webp dataURL 拒绝（jpeg / 裸文本）", () => {
		expect(dataUrlToBytes("data:image/jpeg;base64,AAAA")).toBeNull();
		expect(dataUrlToBytes("data:image/gif;base64,AAAA")).toBeNull();
		expect(dataUrlToBytes("https://example.com/a.png")).toBeNull();
		expect(dataUrlToBytes("")).toBeNull();
	});

	it("空 base64 段拒绝（不出空字节产物——坏 dataURL 会写出坏图片；png|webp 同规则）", () => {
		expect(dataUrlToBytes("data:image/png;base64,")).toBeNull();
		expect(dataUrlToBytes("data:image/webp;base64,")).toBeNull();
	});

	it("大字符串解码不失真（兆级 base64 往返）", () => {
		const big = new Uint8Array(1024 * 1024);
		for (let i = 0; i < big.length; i++) {
			big[i] = i & 0xff;
		}
		const out = dataUrlToBytes(toDataUrl(big))!;
		expect(out.length).toBe(big.length);
		expect(out[0]).toBe(0);
		expect(out[big.length - 1]).toBe(0xff);
	});
});
