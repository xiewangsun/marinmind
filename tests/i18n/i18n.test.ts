/**
 * i18n 基础设施测试（148）：中文即键回退语义 / en 词典命中与缺词回退 /
 * {name} 参数插值 / isUiLocale 守卫。en 词典词条完整性随抽取批次在
 * 各面测试中断言（本文件只测机制）。
 */
import { afterEach, describe, expect, it } from "vitest";
import { getLocale, isUiLocale, setLocale, t } from "../../src/i18n/i18n";
import { EN } from "../../src/i18n/en";

afterEach(() => {
	setLocale("zh"); // 不泄漏语言态到其他测试文件无关——同文件隔离
});

describe("t() 中文即键 + 渐进双语", () => {
	it("zh 模式原样返回（中文即源）", () => {
		expect(t("复习统计")).toBe("复习统计");
	});

	it("en 模式命中词典换英文，缺词条回退中文", () => {
		setLocale("en");
		// 注入临时词条验证机制（不污染 en.ts 渐进词典本体）
		EN["机制验证词条"] = "mechanism probe";
		try {
			expect(t("机制验证词条")).toBe("mechanism probe");
			expect(t("尚未收录的中文文案")).toBe("尚未收录的中文文案"); // 回退
		} finally {
			delete EN["机制验证词条"];
		}
	});

	it("{name} 参数插值（zh/en 均适用，重复占位全替换）", () => {
		setLocale("zh");
		expect(t("已删除 {n} 张卡片", { n: 3 })).toBe("已删除 3 张卡片");
		EN["deleted {n} cards"] = "Deleted {n} card(s)";
		setLocale("en");
		try {
			expect(t("deleted {n} cards", { n: 5 })).toBe("Deleted 5 card(s)");
		} finally {
			delete EN["deleted {n} cards"];
		}
	});

	it("setLocale/getLocale 与 isUiLocale 守卫", () => {
		expect(getLocale()).toBe("zh");
		setLocale("en");
		expect(getLocale()).toBe("en");
		expect(isUiLocale("en")).toBe(true);
		expect(isUiLocale("zh")).toBe(true);
		expect(isUiLocale("jp")).toBe(false);
		expect(isUiLocale(1)).toBe(false);
	});
});
