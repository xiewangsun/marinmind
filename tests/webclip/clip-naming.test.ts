import { describe, expect, it } from "vitest";
import { nextFileName, sanitizeFileName } from "../../src/webclip/clip-naming";

describe("sanitizeFileName", () => {
	it("Windows 非法字符替换为空格并折叠", () => {
		expect(sanitizeFileName('a<b>c:d"e/f\\g|h?i*j', "x")).toBe("a b c d e f g h i j");
	});
	it("控制符替换为空格", () => {
		expect(sanitizeFileName("a\x00b\x1fc", "x")).toBe("a b c");
	});
	it("去尾随点/空格（Windows 资源管理器会剥离）", () => {
		expect(sanitizeFileName("标题.. ", "x")).toBe("标题");
	});
	it("保留名加后缀（大小写不敏感）", () => {
		expect(sanitizeFileName("con", "x")).toBe("con-note");
		expect(sanitizeFileName("COM3", "x")).toBe("COM3-note");
	});
	it("截断到 80 码点（CJK 保字、代理对不截半）", () => {
		const long = "字".repeat(90);
		expect(Array.from(sanitizeFileName(long, "x"))).toHaveLength(80);
		const emoji = "😀".repeat(90); // 每个表情 1 码点（2 个 UTF-16 单元），码点计截 80 个
		const out = sanitizeFileName(emoji, "x");
		expect(out).toBe("😀".repeat(80));
	});
	it("空/全非法输入回 fallback", () => {
		expect(sanitizeFileName("", "网页剪藏")).toBe("网页剪藏");
		expect(sanitizeFileName("   ", "网页剪藏")).toBe("网页剪藏");
		expect(sanitizeFileName("///", "网页剪藏")).toBe("网页剪藏");
	});
	it("中文/全角字符原样保留", () => {
		expect(sanitizeFileName("深度学习：Transformer 详解（一）", "x")).toBe(
			"深度学习：Transformer 详解（一）",
		);
	});
});

describe("nextFileName", () => {
	it("未占用原样返回", () => {
		expect(nextFileName("foo", "md", new Set())).toBe("foo.md");
		expect(nextFileName("foo", "md", new Set(["bar.md"]))).toBe("foo.md");
	});
	it("占用则 -2/-3 递增（copy-into-vault 同款语义）", () => {
		expect(nextFileName("foo", "md", new Set(["foo.md"]))).toBe("foo-2.md");
		expect(nextFileName("foo", "md", new Set(["foo.md", "foo-2.md"]))).toBe("foo-3.md");
	});
});
