import { describe, expect, it } from "vitest";
import {
	COMPRESS_MAX_EDGE,
	COMPRESS_MIN_BYTES,
	shouldCompressImage,
} from "../../src/attachments/image-compress";

// compressImageBytes 走 createImageBitmap + canvas（DOM 图像编码），不进单测；
// 压缩策略由 shouldCompressImage 纯函数锁死，转码质量归实机目检（84-F 清单⑤）。

describe("84-E shouldCompressImage 压缩门槛", () => {
	it("超 300KB 的位图可压缩", () => {
		expect(shouldCompressImage(COMPRESS_MIN_BYTES, "jpg")).toBe(true);
		expect(shouldCompressImage(8 * 1024 * 1024, "png")).toBe(true);
		expect(shouldCompressImage(COMPRESS_MIN_BYTES + 1, "webp")).toBe(true);
	});

	it("恰好 300KB 是下界（含），299KB 不折腾", () => {
		expect(shouldCompressImage(COMPRESS_MIN_BYTES - 1, "jpg")).toBe(false);
		expect(shouldCompressImage(1024, "png")).toBe(false);
	});

	it("GIF（动图）/ SVG（矢量）原样保留，不论大小", () => {
		expect(shouldCompressImage(8 * 1024 * 1024, "gif")).toBe(false);
		expect(shouldCompressImage(8 * 1024 * 1024, "svg")).toBe(false);
	});

	it("扩展名大小写不敏感；未知扩展名放行不压缩", () => {
		expect(shouldCompressImage(COMPRESS_MIN_BYTES, "JPG")).toBe(true);
		expect(shouldCompressImage(COMPRESS_MIN_BYTES, "JPEG")).toBe(true);
		expect(shouldCompressImage(COMPRESS_MIN_BYTES, "avif")).toBe(false);
	});

	it("常量锚定：最长边 2560、阈值 300KB（设置页文案与实现一致性）", () => {
		expect(COMPRESS_MAX_EDGE).toBe(2560);
		expect(COMPRESS_MIN_BYTES).toBe(300 * 1024);
	});
});
