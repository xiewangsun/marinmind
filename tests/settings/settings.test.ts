import { describe, expect, it } from "vitest";
import type { Plugin } from "obsidian";
import {
	DEFAULT_SETTINGS,
	loadSettings,
	validateDirInput,
} from "../../src/settings/settings";
import {
	isLinkDirection,
	LINK_DIRECTIONS,
	LINK_DIRECTION_LABELS,
} from "../../src/types";

describe("联动方向名单（79-1）", () => {
	it("四档且顺序固定（both 默认在前，off 收尾）", () => {
		expect([...LINK_DIRECTIONS]).toEqual(["both", "docToMap", "mapToDoc", "off"]);
	});

	it("LABELS 键完备且显示名非空（设置页下拉可用性）", () => {
		for (const dir of LINK_DIRECTIONS) {
			expect(LINK_DIRECTION_LABELS[dir].length).toBeGreaterThan(0);
		}
	});

	it("isLinkDirection 守卫真假值（手编 data.json 防御）", () => {
		for (const dir of LINK_DIRECTIONS) {
			expect(isLinkDirection(dir)).toBe(true);
		}
		expect(isLinkDirection("diy")).toBe(false);
		expect(isLinkDirection(42)).toBe(false);
		expect(isLinkDirection(null)).toBe(false);
	});
});

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

	it("73 卡片页卡组树栏默认展开（homeCardsFoldersHidden=false，与文档页独立记忆）", () => {
		expect(DEFAULT_SETTINGS.homeCardsFoldersHidden).toBe(false);
	});

	it("㊹ 四类摘录工具默认色系全浅黄（按钮循环切色后经 data.json 持久化）", () => {
		expect(DEFAULT_SETTINGS.excerptColors).toEqual({
			text: "yellow",
			area: "yellow",
			lasso: "yellow",
			blank: "yellow",
		});
	});

	it("65 复习设置默认值：新卡上限 0=不限、批次 20（due 分批与新卡混排在 68 消费）", () => {
		expect(DEFAULT_SETTINGS.reviewNewPerDay).toBe(0);
		expect(DEFAULT_SETTINGS.reviewBatchSize).toBe(20);
	});

	it("75 划选工具栏默认开（text 工具划选弹工具栏；关闭恢复划选直接建卡旧路径）", () => {
		expect(DEFAULT_SETTINGS.selectionToolbar).toBe(true);
	});

	it("77 文字摘录线型默认下划线（存量观感不变；波浪线/删除线为显式选择）", () => {
		expect(DEFAULT_SETTINGS.excerptLineStyle).toBe("underline");
	});

	it("79-1 联动方向默认双向（MN4 四档开关，存量用户行为不变）", () => {
		expect(DEFAULT_SETTINGS.linkDirection).toBe("both");
	});

	it("79-3 隐藏侧缓存默认 null（无隐藏记录）", () => {
		expect(DEFAULT_SETTINGS.workspaceHidden).toBeNull();
	});
});

describe("loadSettings 复习设置字段（65）", () => {
	/** 最小 Plugin stub：loadSettings 只消费 loadData */
	function fakePlugin(raw: unknown): Plugin {
		return { loadData: async () => raw } as unknown as Plugin;
	}

	it("旧版 data.json 缺字段取默认（合并式加载前向兼容）", async () => {
		const merged = await loadSettings(fakePlugin({ dataDir: "X" }));
		expect(merged.reviewNewPerDay).toBe(0);
		expect(merged.reviewBatchSize).toBe(20);
	});

	it("合法存量值原样保留（不因归一化改写用户偏好）", async () => {
		const merged = await loadSettings(
			fakePlugin({ reviewNewPerDay: 15, reviewBatchSize: 50 }),
		);
		expect(merged.reviewNewPerDay).toBe(15);
		expect(merged.reviewBatchSize).toBe(50);
	});

	it("非法/越界值钳制回界内（手编 data.json 防御：NaN/字符串回默认、小数取整、越界夹取）", async () => {
		const merged = await loadSettings(
			fakePlugin({ reviewNewPerDay: -5, reviewBatchSize: 1000 }),
		);
		expect(merged.reviewNewPerDay).toBe(0);
		expect(merged.reviewBatchSize).toBe(200);
		const weird = await loadSettings(
			fakePlugin({ reviewNewPerDay: "abc", reviewBatchSize: 7.4 }),
		);
		expect(weird.reviewNewPerDay).toBe(0);
		expect(weird.reviewBatchSize).toBe(7);
	});
});

describe("loadSettings 线型字段（77）", () => {
	/** 最小 Plugin stub：loadSettings 只消费 loadData */
	function fakePlugin(raw: unknown): Plugin {
		return { loadData: async () => raw } as unknown as Plugin;
	}

	it("旧版 data.json 缺字段取默认下划线（合并式加载前向兼容）", async () => {
		const merged = await loadSettings(fakePlugin({ dataDir: "X" }));
		expect(merged.excerptLineStyle).toBe("underline");
	});

	it("合法值原样保留（用户偏好不被归一化改写）", async () => {
		const merged = await loadSettings(fakePlugin({ excerptLineStyle: "squiggle" }));
		expect(merged.excerptLineStyle).toBe("squiggle");
	});

	it("非法值归一回下划线（防脏值流进 dataset/CSS）", async () => {
		const merged = await loadSettings(fakePlugin({ excerptLineStyle: "wavy" }));
		expect(merged.excerptLineStyle).toBe("underline");
		const num = await loadSettings(fakePlugin({ excerptLineStyle: 42 }));
		expect(num.excerptLineStyle).toBe("underline");
	});
});

describe("loadSettings 联动方向字段（79-1）", () => {
	/** 最小 Plugin stub：loadSettings 只消费 loadData */
	function fakePlugin(raw: unknown): Plugin {
		return { loadData: async () => raw } as unknown as Plugin;
	}

	it("旧版 data.json 缺字段取默认双向（合并式加载前向兼容）", async () => {
		const merged = await loadSettings(fakePlugin({ dataDir: "X" }));
		expect(merged.linkDirection).toBe("both");
	});

	it("四档合法值原样保留（用户偏好不被归一化改写）", async () => {
		for (const dir of ["both", "docToMap", "mapToDoc", "off"] as const) {
			const merged = await loadSettings(fakePlugin({ linkDirection: dir }));
			expect(merged.linkDirection).toBe(dir);
		}
	});

	it("非法值归一回双向（手编 data.json 防御）", async () => {
		const merged = await loadSettings(fakePlugin({ linkDirection: "diy" }));
		expect(merged.linkDirection).toBe("both");
		const num = await loadSettings(fakePlugin({ linkDirection: 7 }));
		expect(num.linkDirection).toBe("both");
	});
});

describe("loadSettings 隐藏侧缓存字段（79-3）", () => {
	/** 最小 Plugin stub：loadSettings 只消费 loadData */
	function fakePlugin(raw: unknown): Plugin {
		return { loadData: async () => raw } as unknown as Plugin;
	}

	it("旧版/缺失字段取默认 null（合并式加载前向兼容）", async () => {
		const merged = await loadSettings(fakePlugin({ dataDir: "X" }));
		expect(merged.workspaceHidden).toBeNull();
	});

	it("完整合法形状原样保留（reader 文件+页码 与 mapId 并存）", async () => {
		const merged = await loadSettings(
			fakePlugin({
				workspaceHidden: {
					reader: { file: "books/os.webp.pdf", page: 12 },
					mapId: "map-1",
				},
			}),
		);
		expect(merged.workspaceHidden).toEqual({
			reader: { file: "books/os.webp.pdf", page: 12 },
			mapId: "map-1",
		});
	});

	it("reader.page 非法归 null 但 reader 保留（页码缺失仍可恢复文件）", async () => {
		const merged = await loadSettings(
			fakePlugin({
				workspaceHidden: { reader: { file: "a.pdf", page: "12" }, mapId: "map-1" },
			}),
		);
		expect(merged.workspaceHidden).toEqual({
			reader: { file: "a.pdf", page: null },
			mapId: "map-1",
		});
	});

	it("子字段损坏只弃该子字段（空 file 弃 reader、空 mapId 弃 mapId）", async () => {
		const badFile = await loadSettings(
			fakePlugin({ workspaceHidden: { reader: { file: "", page: 3 }, mapId: "map-1" } }),
		);
		expect(badFile.workspaceHidden).toEqual({ mapId: "map-1" });
		const badMap = await loadSettings(
			fakePlugin({ workspaceHidden: { reader: { file: "a.pdf", page: 3 }, mapId: 42 } }),
		);
		expect(badMap.workspaceHidden).toEqual({ reader: { file: "a.pdf", page: 3 } });
	});

	it("整体非对象/全空归 null（手编 data.json 防御）", async () => {
		for (const junk of ["cache", 7, true, {}, { reader: null, mapId: "" }]) {
			const merged = await loadSettings(fakePlugin({ workspaceHidden: junk }));
			expect(merged.workspaceHidden).toBeNull();
		}
	});
});

describe("loadSettings OCR 字段（83）", () => {
	/** 最小 Plugin stub：loadSettings 只消费 loadData */
	function fakePlugin(raw: unknown): Plugin {
		return { loadData: async () => raw } as unknown as Plugin;
	}

	it("旧版 data.json 缺字段取默认（中英混排语言 + 两个开关全关）", async () => {
		const merged = await loadSettings(fakePlugin({ dataDir: "X" }));
		expect(merged.ocrLangs).toBe("chi_sim+eng");
		expect(merged.ocrOnAreaExcerpt).toBe(false);
		expect(merged.ocrAutoTranslate).toBe(false);
	});

	it("合法值原样保留（语言表内组合 + 布尔偏好不被归一化改写）", async () => {
		const merged = await loadSettings(
			fakePlugin({ ocrLangs: "jpn+eng", ocrOnAreaExcerpt: true, ocrAutoTranslate: true }),
		);
		expect(merged.ocrLangs).toBe("jpn+eng");
		expect(merged.ocrOnAreaExcerpt).toBe(true);
		expect(merged.ocrAutoTranslate).toBe(true);
	});

	it("非法值归一回默认（表外语言串 / 布尔脏值防脏值流进引擎层）", async () => {
		const merged = await loadSettings(
			fakePlugin({
				ocrLangs: "latin",
				ocrOnAreaExcerpt: "yes",
				ocrAutoTranslate: 1,
			}),
		);
		expect(merged.ocrLangs).toBe("chi_sim+eng");
		expect(merged.ocrOnAreaExcerpt).toBe(false);
		expect(merged.ocrAutoTranslate).toBe(false);
	});
});

describe("loadSettings 翻译引擎字段（83）", () => {
	/** 最小 Plugin stub：loadSettings 只消费 loadData */
	function fakePlugin(raw: unknown): Plugin {
		return { loadData: async () => raw } as unknown as Plugin;
	}

	it("旧版 data.json 缺字段取默认（google 引擎 + 凭据全空）", async () => {
		const merged = await loadSettings(fakePlugin({ dataDir: "X" }));
		expect(merged.translateEngine).toBe("google");
		expect(merged.translateBaiduAppid).toBe("");
		expect(merged.translateBaiduSecret).toBe("");
		expect(merged.translateYoudaoAppid).toBe("");
		expect(merged.translateYoudaoAppSecret).toBe("");
		expect(merged.translateDeeplKey).toBe("");
	});

	it("合法引擎与凭据原样保留（trim 收敛首尾空白）", async () => {
		const merged = await loadSettings(
			fakePlugin({
				translateEngine: "baidu",
				translateBaiduAppid: " app-1 ",
				translateBaiduSecret: "sec",
				translateDeeplKey: " key:fx ",
			}),
		);
		expect(merged.translateEngine).toBe("baidu");
		expect(merged.translateBaiduAppid).toBe("app-1");
		expect(merged.translateDeeplKey).toBe("key:fx");
	});

	it("有道引擎与凭据原样保留（85-B，trim 收敛）", async () => {
		const merged = await loadSettings(
			fakePlugin({
				translateEngine: "youdao",
				translateYoudaoAppid: " key-1 ",
				translateYoudaoAppSecret: "sec-1",
			}),
		);
		expect(merged.translateEngine).toBe("youdao");
		expect(merged.translateYoudaoAppid).toBe("key-1");
		expect(merged.translateYoudaoAppSecret).toBe("sec-1");
	});

	it("引擎脏值归一 google、凭据非字符串归空串（签名串不得混入脏值）", async () => {
		const merged = await loadSettings(
			fakePlugin({
				translateEngine: "caiyun",
				translateBaiduAppid: 42,
				translateBaiduSecret: true,
				translateYoudaoAppid: 7,
				translateYoudaoAppSecret: null,
				translateDeeplKey: null,
			}),
		);
		expect(merged.translateEngine).toBe("google");
		expect(merged.translateBaiduAppid).toBe("");
		expect(merged.translateBaiduSecret).toBe("");
		expect(merged.translateYoudaoAppid).toBe("");
		expect(merged.translateYoudaoAppSecret).toBe("");
		expect(merged.translateDeeplKey).toBe("");
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
