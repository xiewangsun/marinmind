import { describe, expect, it, vi } from "vitest";
// 传递依赖 pdf-document 运行时引 obsidian（loadPdfJs）——纯函数测试 mock 掉
vi.mock("obsidian", () => ({ loadPdfJs: () => Promise.resolve(null) }));
import { canPageCrop } from "../../src/reader/excerpt-visual";

// renderExcerptVisual 渲染主体 DOM/pdf.js 耦合不进单测——只测 84-D 抽出的
// 纯守卫（photo 展示框绝不进页裁剪路径）。

describe("84-D canPageCrop 页裁剪守卫", () => {
	it("常规 text 卡（有文档/页码/矩形）可裁剪", () => {
		expect(
			canPageCrop({
				documentId: "doc1",
				page: 3,
				rects: [{ x: 0.1, y: 0.1, w: 0.2, h: 0.05 }],
				excerptType: "text",
			}),
		).toBe(true);
	});

	it("photo 卡即使 rects 非空（= 展示框）也不可裁剪——附件缺失走文本兜底", () => {
		expect(
			canPageCrop({
				documentId: "doc1",
				page: 3,
				rects: [{ x: 0.3, y: 0.4, w: 0.2, h: 0.1 }],
				excerptType: "photo",
			}),
		).toBe(false);
	});

	it("缺文档归属 / 缺页码 / 无矩形均不可裁剪", () => {
		const rects = [{ x: 0.1, y: 0.1, w: 0.2, h: 0.05 }];
		expect(
			canPageCrop({ documentId: null, page: 1, rects, excerptType: "text" }),
		).toBe(false);
		expect(
			canPageCrop({ documentId: "doc1", page: null, rects, excerptType: "text" }),
		).toBe(false);
		expect(
			canPageCrop({ documentId: "doc1", page: 1, rects: [], excerptType: "text" }),
		).toBe(false);
	});
});
