import { describe, expect, it } from "vitest";
import { DEFAULT_SETTINGS, validateDirInput } from "../../src/settings/settings";

describe("DEFAULT_SETTINGS", () => {
	it("默认数据目录为 ㉚ md 存储的显式目录（老用户旧数据经启动迁移引导搬家）", () => {
		expect(DEFAULT_SETTINGS.dataDir).toBe("MarinMind");
		expect(DEFAULT_SETTINGS.backupDir).toBe("Backups/MarinMind");
		// ㉗ 摘录自动入图默认开（合并式加载：老 data.json 缺字段自动补 true）
		expect(DEFAULT_SETTINGS.autoAddToMindmap).toBe(true);
	});

	it("㊲ 主页主题默认 Linear 深色（保持既有观感；㊸ 三态：dark/light/auto）", () => {
		expect(DEFAULT_SETTINGS.homeTheme).toBe("dark");
	});

	it("㊵ 主页文档页默认列表视图（窗格为可选 PDF 封面书架模式）", () => {
		expect(DEFAULT_SETTINGS.homeDocsView).toBe("list");
	});

	it("㊸ 主页文件夹栏默认展开（homeFoldersHidden=false，页内切换即时写回）", () => {
		expect(DEFAULT_SETTINGS.homeFoldersHidden).toBe(false);
	});

	it("㊹ 四类摘录工具默认色系全浅黄（按钮循环切色后经 data.json 持久化）", () => {
		expect(DEFAULT_SETTINGS.excerptColors).toEqual({
			text: "yellow",
			area: "yellow",
			lasso: "yellow",
			blank: "yellow",
		});
	});
});

describe("validateDirInput", () => {
	it("桌面端：vault 相对路径规范化通过", () => {
		const v = validateDirInput(" .marinmind/ ", true);
		expect(v).toEqual({ ok: true, normalized: ".marinmind" });
	});

	it("桌面端：本机绝对路径规范化通过（去尾分隔符、盘符根保留）", () => {
		expect(validateDirInput("D:\\MarinMindData\\", true)).toEqual({
			ok: true,
			normalized: "D:\\MarinMindData",
		});
		expect(validateDirInput("D:\\", true)).toEqual({ ok: true, normalized: "D:\\" });
	});

	it("移动端：绝对路径被拒绝", () => {
		const v = validateDirInput("D:\\Data", false);
		expect(v.ok).toBe(false);
		if (!v.ok) expect(v.reason).toContain("移动端");
	});

	it("空值拒绝", () => {
		const v = validateDirInput("   ", true);
		expect(v.ok).toBe(false);
		if (!v.ok) expect(v.reason).toContain("不能为空");
	});

	it("非法相对路径拒绝（../反斜杠/.obsidian）", () => {
		expect(validateDirInput("a/../b", true).ok).toBe(false);
		expect(validateDirInput("a\\b", true).ok).toBe(false);
		expect(validateDirInput(".obsidian/plugins", true).ok).toBe(false);
	});
});
