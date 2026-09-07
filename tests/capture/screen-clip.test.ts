/**
 * screen-clip 纯函数单测（119）：正文组装 / 标题推导 / saveWebclip 入参
 * 组装（本地图片嵌入的 fetched-only 关键形态；ext 跟随裁剪实际编码格式
 * png|webp）。obsidian 的 Notice 以 vi.mock 替身（镜像 webclip-service.test
 * 先例）；OCR 画布与落盘属 obsidian 桌面运行时路径（canvas 2d / vault），
 * 不在此覆盖。
 */
import { describe, expect, it, vi } from "vitest";

vi.mock("obsidian", () => ({ Notice: vi.fn() }));

import {
	buildScreenClipMarkdown,
	buildScreenClipSaveInput,
	deriveScreenClipTitle,
} from "../../src/capture/screen-clip";

/** 固定测试时刻（标题兜底的本地时间格式断言用） */
const NOW = new Date(2026, 8, 7, 14, 5, 0); // 2026-09-07 14:05 本地时间

describe("buildScreenClipMarkdown", () => {
	it("有识别文字：图 embed 占位符 + 文字块", () => {
		const md = buildScreenClipMarkdown("第一行\n第二行");
		expect(md).toContain("![屏幕截图](__MMIMG_0__)");
		expect(md).toContain("第一行\n第二行");
		expect(md.indexOf("__MMIMG_0__")).toBeLessThan(md.indexOf("第一行")); // 图在前
	});

	it("空文字退化纯图（OCR 关/失败不残留空块）", () => {
		expect(buildScreenClipMarkdown("")).toBe("![屏幕截图](__MMIMG_0__)\n");
		expect(buildScreenClipMarkdown("   \n  ")).toBe("![屏幕截图](__MMIMG_0__)\n");
	});

	it("占位符符合 webclip 约定形态（fillImageRefs 回填目标）", () => {
		expect(buildScreenClipMarkdown("x")).toMatch(/__MMIMG_\d+__/);
	});
});

describe("deriveScreenClipTitle", () => {
	it("OCR 首个非空行为标题（跳过空行）", () => {
		expect(deriveScreenClipTitle("\n\n  核心观点：间隔重复  \n第二行", NOW)).toBe(
			"核心观点：间隔重复",
		);
	});

	it("超长首行截 40 字符加省略号；恰好 40 不加", () => {
		const long = "长".repeat(50);
		const title = deriveScreenClipTitle(long, NOW);
		expect(title.length).toBe(41); // 40 字 + …
		expect(title.endsWith("…")).toBe(true);
		const exact = "字".repeat(40);
		expect(deriveScreenClipTitle(exact, NOW)).toBe(exact);
	});

	it("无文字回退「屏幕剪藏 + 本地时间」", () => {
		expect(deriveScreenClipTitle("", NOW)).toBe("屏幕剪藏 2026-09-07 14:05");
		expect(deriveScreenClipTitle("  \n \n", NOW)).toBe("屏幕剪藏 2026-09-07 14:05");
	});
});

describe("buildScreenClipSaveInput", () => {
	it("本地图片嵌入形态：url=null + fetched 有数据（落盘判定只看 fetched；ext=png 存量语义透传）", () => {
		const bytes = new ArrayBuffer(8);
		const input = buildScreenClipSaveInput({
			ocrText: "标题行",
			bytes,
			ext: "png",
			capturedAt: NOW,
		});
		expect(input.title).toBe("标题行");
		expect(input.images).toHaveLength(1);
		expect(input.images[0]).toMatchObject({
			placeholder: "__MMIMG_0__",
			url: null, // 无远程源——不走 fetchImages、不被回退远程链接
			dataUri: null,
			alt: "屏幕截图",
		});
		expect(input.fetched).toEqual([{ bytes, ext: "png" }]); // 原样字节，绕过压缩
	});

	it("ext=webp 透传（落库路径 WebP 优先——assets/ 扩展名跟随实际格式）", () => {
		const bytes = new ArrayBuffer(8);
		const input = buildScreenClipSaveInput({
			ocrText: "",
			bytes,
			ext: "webp",
			capturedAt: NOW,
		});
		expect(input.fetched).toEqual([{ bytes, ext: "webp" }]);
	});

	it("sourceUrl 为 screen:// 伪协议 + ISO 时间戳", () => {
		const input = buildScreenClipSaveInput({
			ocrText: "",
			bytes: new ArrayBuffer(2),
			ext: "png",
			capturedAt: NOW,
		});
		expect(input.sourceUrl).toBe(`screen://${NOW.toISOString()}`);
	});

	it("正文与标题同源一致（同一 ocrText 推导）", () => {
		const input = buildScreenClipSaveInput({
			ocrText: "同一段文字",
			bytes: new ArrayBuffer(1),
			ext: "png",
			capturedAt: NOW,
		});
		expect(input.title).toBe("同一段文字");
		expect(input.markdown).toContain("同一段文字");
	});
});
