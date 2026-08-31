import { describe, expect, it } from "vitest";
import {
	dirSegments,
	fsBasename,
	isAbsoluteFsPath,
	isHiddenVaultDir,
	joinRel,
	normalizeAssetRef,
	normalizeFsDir,
	normalizeVaultDir,
} from "../../src/storage/paths";

describe("isAbsoluteFsPath", () => {
	it("识别 Windows 盘符（大小写、正反斜杠）", () => {
		expect(isAbsoluteFsPath("D:\\Data")).toBe(true);
		expect(isAbsoluteFsPath("d:/data")).toBe(true);
	});
	it("识别 UNC 与 POSIX 根", () => {
		expect(isAbsoluteFsPath("\\\\server\\share")).toBe(true);
		expect(isAbsoluteFsPath("/mnt/data")).toBe(true);
	});
	it("vault 相对路径返回 false", () => {
		expect(isAbsoluteFsPath(".marinmind")).toBe(false);
		expect(isAbsoluteFsPath("Backups/MarinMind")).toBe(false);
		expect(isAbsoluteFsPath("books/a.pdf")).toBe(false);
	});
});

describe("normalizeVaultDir", () => {
	it("trim、折叠多余斜杠、去 ./ 与首尾斜杠", () => {
		expect(normalizeVaultDir("  .marinmind ")).toBe(".marinmind");
		expect(normalizeVaultDir("a//b/")).toBe("a/b");
		expect(normalizeVaultDir("./a/./b")).toBe("a/b");
		expect(normalizeVaultDir("Backups/MarinMind/")).toBe("Backups/MarinMind");
	});
	it("拒绝空值", () => {
		expect(() => normalizeVaultDir("")).toThrow("不能为空");
		expect(() => normalizeVaultDir("   ")).toThrow("不能为空");
	});
	it("拒绝 .. 段", () => {
		expect(() => normalizeVaultDir("..")).toThrow("..");
		expect(() => normalizeVaultDir("a/../b")).toThrow("..");
	});
	it("拒绝反斜杠与绝对路径形态", () => {
		expect(() => normalizeVaultDir("a\\b")).toThrow("正斜杠");
		expect(() => normalizeVaultDir("D:\\Data")).toThrow("绝对路径");
		expect(() => normalizeVaultDir("/data")).toThrow("绝对路径");
	});
	it("拒绝 .obsidian 目录", () => {
		expect(() => normalizeVaultDir(".obsidian")).toThrow(".obsidian");
		expect(() => normalizeVaultDir(".obsidian/plugins")).toThrow(".obsidian");
	});
});

describe("isHiddenVaultDir（㊻-A-2 隐藏数据目录判别）", () => {
	it("点开头目录为隐藏（旧版 .marinmind / 任意层级点段）", () => {
		expect(isHiddenVaultDir(".marinmind")).toBe(true);
		expect(isHiddenVaultDir(".hidden/data")).toBe(true);
		expect(isHiddenVaultDir("a/.b")).toBe(true);
	});
	it("普通目录与空（vault 根）不为隐藏", () => {
		expect(isHiddenVaultDir("MarinMind")).toBe(false);
		expect(isHiddenVaultDir("Backups/MarinMind")).toBe(false);
		expect(isHiddenVaultDir("")).toBe(false);
	});
});

describe("normalizeFsDir", () => {
	it("去尾随分隔符", () => {
		expect(normalizeFsDir("D:\\MarinMindData\\")).toBe("D:\\MarinMindData");
		expect(normalizeFsDir("D:/Data//")).toBe("D:/Data");
	});
	it("盘符根保留单个分隔符", () => {
		expect(normalizeFsDir("D:\\")).toBe("D:\\");
		expect(normalizeFsDir("d:////")).toBe("d:\\");
	});
	it("拒绝空值与非绝对路径", () => {
		expect(() => normalizeFsDir("")).toThrow("不能为空");
		expect(() => normalizeFsDir("marinmind")).toThrow("绝对路径");
	});
});

describe("normalizeAssetRef（旧 excerptRef 兼容）", () => {
	it("剥去旧版 .marinmind/ 前缀", () => {
		expect(normalizeAssetRef(".marinmind/assets/x.png")).toBe("assets/x.png");
		expect(normalizeAssetRef(".marinmind/assets/sub/y.png")).toBe("assets/sub/y.png");
	});
	it("新格式原样透传", () => {
		expect(normalizeAssetRef("assets/x.png")).toBe("assets/x.png");
	});
	it("非本目录路径不误剥", () => {
		expect(normalizeAssetRef("foo/.marinmind/assets/x.png")).toBe("foo/.marinmind/assets/x.png");
		expect(normalizeAssetRef(".marinmind/other.txt")).toBe(".marinmind/other.txt");
	});
});

describe("fsBasename", () => {
	it("Windows 盘符反斜杠 / 正斜杠", () => {
		expect(fsBasename("D:\\Books\\my book.pdf")).toBe("my book");
		expect(fsBasename("D:/Books/深度学习.pdf")).toBe("深度学习");
	});
	it("POSIX 与 UNC 绝对路径", () => {
		expect(fsBasename("/home/u/a.b.c.pdf")).toBe("a.b.c");
		expect(fsBasename("\\\\srv\\share\\x.pdf")).toBe("x");
	});
	it("vault 相对路径（正斜杠）同样适用", () => {
		expect(fsBasename("attachments/foo.pdf")).toBe("foo");
		expect(fsBasename("a.pdf")).toBe("a");
	});
	it("隐藏文件不去点、无扩展名原样", () => {
		expect(fsBasename("D:\\x\\.gitignore")).toBe(".gitignore");
		expect(fsBasename("/home/u/README")).toBe("README");
	});
});

describe("dirSegments / joinRel", () => {
	it("拆出逐层前缀序列", () => {
		expect(dirSegments("a/b/c")).toEqual(["a", "a/b", "a/b/c"]);
		expect(dirSegments("a")).toEqual(["a"]);
		expect(dirSegments("")).toEqual([]);
	});
	it("空段透传", () => {
		expect(joinRel("a", "b")).toBe("a/b");
		expect(joinRel("", "b")).toBe("b");
		expect(joinRel("a", "")).toBe("a");
	});
});
