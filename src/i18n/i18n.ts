import { EN } from "./en";

/**
 * 界面文案翻译（148 i18n）：t("中文原文") 经当前语言词典查换，缺词条回退
 * 中文原文——中文即键 + 渐进双语（词条随批次补齐，en.ts 单一词典文件）。
 * 动态文案用 {name} 占位：t("已删除 {n} 张卡片", { n: 3 })。
 * 语言切换即时影响此后渲染；命令名等注册期快照需重载 Obsidian 生效
 * （设置页切换时有提示）。
 */

/** 界面语言（148）：默认中文 */
export type UiLocale = "zh" | "en";

export function isUiLocale(v: unknown): v is UiLocale {
	return v === "zh" || v === "en";
}

let locale: UiLocale = "zh";

/** 切换界面语言（main onload 按设置调用；设置页切换即时调用） */
export function setLocale(l: UiLocale): void {
	locale = l;
}

export function getLocale(): UiLocale {
	return locale;
}

/** 翻译一条文案：en 模式查词典（缺词条回退中文原文）；params 做 {name} 插值 */
export function t(source: string, params?: Record<string, string | number>): string {
	let text = locale === "en" ? (EN[source] ?? source) : source;
	if (params) {
		for (const [key, value] of Object.entries(params)) {
			text = text.split(`{${key}}`).join(String(value));
		}
	}
	return text;
}
