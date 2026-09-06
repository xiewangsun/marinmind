import { describe, expect, it, vi } from "vitest";
// 传递依赖 pdf-document 运行时引 obsidian（loadPdfJs）——纯函数测试 mock 掉
vi.mock("obsidian", () => ({ loadPdfJs: () => Promise.resolve(null) }));
import { canPageCrop, canPreferCrop } from "../../src/reader/excerpt-visual";

// renderExcerptVisual 渲染主体 DOM/pdf.js 耦合不进单测——只测 84-D 抽出的
// 纯守卫（photo 展示框绝不进页裁剪路径）与 108 的 preferCrop 适用面守卫。

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
		expect(canPageCrop({ documentId: null, page: 1, rects, excerptType: "text" })).toBe(false);
		expect(canPageCrop({ documentId: "doc1", page: null, rects, excerptType: "text" })).toBe(
			false,
		);
		expect(canPageCrop({ documentId: "doc1", page: 1, rects: [], excerptType: "text" })).toBe(
			false,
		);
	});
});

describe("108 canPreferCrop 页裁剪优先守卫（复习展示形态统一）", () => {
	it("area/lasso 传 preferCrop:true 时页裁剪优先", () => {
		expect(canPreferCrop({ excerptType: "area" }, true)).toBe(true);
		expect(canPreferCrop({ excerptType: "lasso" }, true)).toBe(true);
	});

	it("handwriting 不适用——笔迹不在 PDF 里，附件即全部内容", () => {
		expect(canPreferCrop({ excerptType: "handwriting" }, true)).toBe(false);
	});

	it("photo/text/blank 不受优先序影响（photo 与页裁剪互斥、text/blank 无附件）", () => {
		expect(canPreferCrop({ excerptType: "photo" }, true)).toBe(false);
		expect(canPreferCrop({ excerptType: "text" }, true)).toBe(false);
		expect(canPreferCrop({ excerptType: "blank" }, true)).toBe(false);
	});

	it("不传/传 false 一律不启用（守卫默认值；111 起全部调用方均传 true，此防线保护未来新调用方）", () => {
		expect(canPreferCrop({ excerptType: "area" })).toBe(false);
		expect(canPreferCrop({ excerptType: "area" }, false)).toBe(false);
	});
});
