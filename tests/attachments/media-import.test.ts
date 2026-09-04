import { describe, expect, it, vi } from "vitest";
// obsidian 运行时依赖仅 Notice（importPhotoCard 容错提示），纯函数测试 mock 掉
vi.mock("obsidian", () => ({ Notice: class {} }));
import { imageExtOf, preparePhotoBytes } from "../../src/attachments/media-import";

// pickImageFiles / importPhotoCard 与 DOM/插件耦合（隐藏 input、附件仓、cards），
// 按项目门禁不进单测——实机目检覆盖（84-F 清单③）。

describe("84-C imageExtOf MIME → 扩展名映射", () => {
	it("常见 MIME 映射到对应扩展名", () => {
		expect(imageExtOf("image/png")).toBe("png");
		expect(imageExtOf("image/jpeg")).toBe("jpg");
		expect(imageExtOf("image/webp")).toBe("webp");
		expect(imageExtOf("image/gif")).toBe("gif");
		expect(imageExtOf("image/svg+xml")).toBe("svg");
		expect(imageExtOf("image/bmp")).toBe("bmp");
	});

	it("未知 MIME 兜底 png", () => {
		expect(imageExtOf("image/avif")).toBe("png");
		expect(imageExtOf("application/octet-stream")).toBe("png");
		expect(imageExtOf("")).toBe("png");
	});

	it("带 charset 后缀的 MIME 不在映射表内（精确匹配，按兜底走）", () => {
		// jpeg + charset → 兜底 png（而非 jpg）：附件仓按容器嗅探，扩展名仅辅助
		expect(imageExtOf("image/jpeg;charset=utf-8")).toBe("png");
	});
});

describe("84-C preparePhotoBytes 入库前处理接缝", () => {
	it("84-C 直通：原样返回同一字节引用与扩展名（84-E 在此注入压缩）", async () => {
		const bytes = new ArrayBuffer(8);
		const out = await preparePhotoBytes(bytes, "jpg", true);
		expect(out.bytes).toBe(bytes);
		expect(out.ext).toBe("jpg");
	});
});
