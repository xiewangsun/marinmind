import { describe, expect, it } from "vitest";
import { normalizeClipUrl, validateWebclipFolder } from "../../src/webclip/clip-url";

describe("normalizeClipUrl", () => {
	it("无协议补 https:// 并绝对化", () => {
		expect(normalizeClipUrl("example.com/a?x=1")).toEqual({
			ok: true,
			url: "https://example.com/a?x=1",
		});
		expect(normalizeClipUrl(" www.example.com ")).toEqual({
			ok: true,
			url: "https://www.example.com/",
		});
	});
	it("http/https 原样透传（去片段）", () => {
		expect(normalizeClipUrl("http://a.com/p#sec")).toEqual({ ok: true, url: "http://a.com/p" });
		expect(normalizeClipUrl("https://a.com/p")).toEqual({ ok: true, url: "https://a.com/p" });
	});
	it("拒绝空值与非 http(s) 协议", () => {
		expect(normalizeClipUrl("  ")).toMatchObject({ ok: false });
		expect(normalizeClipUrl("ftp://a.com/f")).toMatchObject({ ok: false });
		expect(normalizeClipUrl("javascript:alert(1)")).toMatchObject({ ok: false });
		expect(normalizeClipUrl("file:///C:/x")).toMatchObject({ ok: false });
	});
	it("拒绝无法解析/无点号主机", () => {
		expect(normalizeClipUrl("不是网址")).toMatchObject({ ok: false });
		expect(normalizeClipUrl("localhost")).toMatchObject({ ok: false });
	});
});

describe("validateWebclipFolder", () => {
	it("合法目录规范化通过", () => {
		expect(validateWebclipFolder("WebClips", "MarinMind")).toEqual({
			ok: true,
			normalized: "WebClips",
		});
		expect(validateWebclipFolder("Clips//Web/", "MarinMind")).toEqual({
			ok: true,
			normalized: "Clips/Web",
		});
	});
	it("拒绝绝对路径与非法相对形态（复用 normalizeVaultDir 规则）", () => {
		expect(validateWebclipFolder("D:\\Clips", "MarinMind")).toMatchObject({ ok: false });
		expect(validateWebclipFolder("a\\b", "MarinMind")).toMatchObject({ ok: false });
		expect(validateWebclipFolder("..", "MarinMind")).toMatchObject({ ok: false });
		expect(validateWebclipFolder(".obsidian/x", "MarinMind")).toMatchObject({ ok: false });
	});
	it("拒绝隐藏目录（Obsidian 不索引）", () => {
		expect(validateWebclipFolder(".clips", "MarinMind")).toMatchObject({ ok: false });
		expect(validateWebclipFolder("a/.b", "MarinMind")).toMatchObject({ ok: false });
	});
	it("拒绝与 vault 相对数据目录相同/互相包含", () => {
		expect(validateWebclipFolder("MarinMind", "MarinMind")).toMatchObject({ ok: false });
		expect(validateWebclipFolder("MarinMind/clips", "MarinMind")).toMatchObject({ ok: false });
		// 反向包含：剪藏目录把数据目录包进去
		expect(validateWebclipFolder("Vault", "Vault/MarinMind")).toMatchObject({ ok: false });
		// 前缀同名但不构成路径段的不受影响
		expect(validateWebclipFolder("MarinMind-web", "MarinMind")).toEqual({
			ok: true,
			normalized: "MarinMind-web",
		});
	});
	it("数据目录为本机绝对路径时免冲突检（vault 相对目录不可能包含它）", () => {
		expect(validateWebclipFolder("WebClips", "D:\\MarinMindData")).toEqual({
			ok: true,
			normalized: "WebClips",
		});
	});
});
