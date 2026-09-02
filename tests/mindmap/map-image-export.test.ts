import { describe, expect, it, vi } from "vitest";

// obsidian npm 包是纯类型包（无可解析运行时入口）——本模块对 Notice 的值引用
// 在测试环境用空桩顶替（allocateExportPath 纯函数不触碰它）
vi.mock("obsidian", () => ({ Notice: class {} }));

import { allocateExportPath } from "../../src/mindmap/map-image-export";

/**
 * allocateExportPath 文件名分配（63）：PNG/OPML 导出共用。
 * 只测纯函数——exportMindmapPng 是 DOM/obsidian 编排层不单测（镜像
 * md-outline-measure 分层先例）。
 */
describe("allocateExportPath 导出文件名分配（63）", () => {
	it("无冲突直接 图名.扩展名（图名经 sanitizeFileName 净化）", () => {
		expect(allocateExportPath("我的脑图", "png", () => false)).toBe("我的脑图.png");
	});

	it("冲突 -2/-3 递增；首个不存在的序号胜出", () => {
		const taken = new Set(["我的脑图.png", "我的脑图-2.png", "我的脑图-3.png"]);
		expect(allocateExportPath("我的脑图", "png", (p) => taken.has(p))).toBe("我的脑图-4.png");
	});

	it("非法文件名字符净化（wikilink 保留字符 [ ] # | 等）", () => {
		const out = allocateExportPath('坏[名]字#号|斜杠', "opml", () => false);
		expect(out.endsWith(".opml")).toBe(true);
		for (const ch of ["[", "]", "#", "|"]) {
			expect(out).not.toContain(ch);
		}
	});

	it("全空白净化回退 sanitizeFileName 兜底名「未命名」", () => {
		expect(allocateExportPath("///", "png", () => false)).toBe("未命名.png");
	});
});
