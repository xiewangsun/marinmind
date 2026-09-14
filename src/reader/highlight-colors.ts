import type { Card, LineStyle } from "../types";

/**
 * 高亮颜色体系（㊹ MarginNote 3 化：四色 + 线稿式标注）：
 * - Card.color 存 value 字符串（数据层早已预留）
 * - value 与 styles.css 的 [data-color="…"] 变体一一对应：每色定义
 *   --mm-hl-line（下划线/边框线色）与 --mm-hl-tint（悬停反馈底色）两个变量，
 *   形态规则（.marinmind-hl-text 下划线 / .marinmind-hl-area 边框 / 套索 SVG
 *   描边 / 留白胶囊边框）只消费变量——syncCard 刷 data-color 即全员变色
 * - 建卡色 = settings.excerptColors（每工具独立记忆，工具按钮循环切换）；
 *   AI 摘录标题浅红/正文跟随文字工具色，翻译留白跟随留白工具色，照片/语音浅红
 * - 线型（77）：文字摘录的第三轨 data-line-style（下划线/波浪线/删除线，
 *   名单源 types.ts 的 LINE_STYLES，回退函数 highlightLineStyle）——
 *   建卡线型 = settings.excerptLineStyle 全局单值（只属 text 形态，无 per-tool）
 * - 旧 7 色中 teal/orange/purple/pink 为存量卡色相（CSS 保留旧变量定义继续渲染，
 *   新建卡不再产生）；blue 自文字摘录闭环（4ec3958）起即蓝色视觉（㊹ 曾误判
 *   "视觉一直是黄"做读取归一 blue→yellow，138 已移除——存量与新建蓝卡
 *   重开不再变黄），㊹ 起 blue 同时是四色体系中的浅蓝真义
 */
export type HighlightColorValue = "red" | "green" | "blue" | "yellow";

/** 一种可选高亮颜色的定义 */
export interface HighlightColorDef {
	/** 存入 Card.color 的值（也是 CSS data-color 键） */
	value: HighlightColorValue;
	/** 中文显示名（菜单/弹窗/Notice 用） */
	label: string;
	/** 色板弹窗的色块底色 */
	swatch: string;
	/** 下划线/边框线色（canvas 描边用；styles.css 的 --mm-hl-line 同步定义） */
	line: string;
}

/** 可选高亮颜色（四色：顺序即色板展示序 + 工具按钮循环切色序 黄→绿→蓝→红） */
export const HIGHLIGHT_COLORS: readonly HighlightColorDef[] = [
	{ value: "yellow", label: "浅黄", swatch: "#e8c53a", line: "#d9a916" },
	{ value: "green", label: "浅绿", swatch: "#5aab5a", line: "#5aab5a" },
	{ value: "blue", label: "浅蓝", swatch: "#4a90d9", line: "#4a90d9" },
	{ value: "red", label: "浅红", swatch: "#d9534f", line: "#d9534f" },
];

/** 是否为已知高亮颜色（设置归一入口；旧色相 teal/orange/… 刻意不算——新建卡只落四色） */
export function isHighlightColor(value: string): value is HighlightColorValue {
	return HIGHLIGHT_COLORS.some((c) => c.value === value);
}

/**
 * card.color 为空时按摘录形态取默认色（㊳ 起定义，㊹ 迁入本模块 + 四色化）：
 * 手写→浅绿、照片/语音→浅红、其余（文字/区域/套索/留白）→浅黄
 */
export function highlightFallbackColor(card: Card): string {
	if (card.color) {
		return card.color;
	}
	switch (card.excerptType) {
		case "handwriting":
			return "green";
		case "photo":
		case "audio":
			return "red";
		default:
			return "yellow";
	}
}

/**
 * card.lineStyle 读取回退（77）：null → underline。
 * 形态轨消费方（excerpt-layer 的 data-line-style / region-snapshot 的 canvas
 * 分支 / 高亮菜单当前态）共用同一处定义——名单源在 types.ts（LINE_STYLES）
 */
export function highlightLineStyle(card: Card): LineStyle {
	return card.lineStyle ?? "underline";
}

/** 线型 → 图标名（77 工具栏钮与菜单条目共用；三名均经 obsidian.asar 注册表双格式验证） */
export const LINE_STYLE_ICONS: Record<LineStyle, string> = {
	underline: "underline",
	squiggle: "waves",
	strikethrough: "strikethrough",
};

/** 存量 7 色卡（teal/orange/purple/pink）的描边线色——缩略图/预览保持原色相 */
const LEGACY_LINE_COLORS: Record<string, string> = {
	teal: "#14b8a6",
	orange: "#fb923c",
	purple: "#a062be",
	pink: "#d96a9c",
};

/** 高亮色 → canvas 线色（paintCardHighlights 用：四色取 line 字段，旧色相保持原色相，未知回黄） */
export function highlightLineColor(color: string): string {
	const def = HIGHLIGHT_COLORS.find((c) => c.value === color);
	if (def) {
		return def.line;
	}
	return LEGACY_LINE_COLORS[color] ?? "#d9a916";
}
