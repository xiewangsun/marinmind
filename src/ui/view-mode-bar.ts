import { Menu } from "obsidian";
import type MarinMindPlugin from "../main";
import { resolveIcon, setIconSafe } from "./icon-resolve";

/** 视图模式：单文档 / 单脑图 / 文档·脑图联动（MarginNote 学习集三视图，⑰） */
export type ViewMode = "doc" | "map" | "linked";

/** 循环顺序（左键点击按此顺序推进） */
const MODE_ORDER: readonly ViewMode[] = ["doc", "map", "linked"];

/** 切换按钮定义：icons 为兜底候选链（90 批：低版本 Obsidian 缺名时降级） */
const MODE_DEFS: ReadonlyArray<{
	mode: ViewMode;
	label: string;
	hint: string;
	icons: readonly string[];
}> = [
	{ mode: "doc", label: "文档", hint: "单文档视图：隐藏脑图窗格", icons: ["book-open"] },
	{ mode: "map", label: "脑图", hint: "单脑图视图：隐藏文档窗格", icons: ["git-fork"] },
	{ mode: "linked", label: "联动", hint: "联动视图：文档 + 脑图并排，点击互相定位", icons: ["columns-2", "columns"] },
];

/**
 * 三态视图模式循环按钮（90 批 MN3 式单 icon 化）：阅读器工具行与脑图头部共用。
 * - 左键：按 文档→脑图→联动→文档 循环，icon 实时反映当前视图；
 * - 右键：弹出三项直选菜单（当前项打勾），可一步跳转目标视图。
 * 当前模式经 plugin.onViewModeChange 订阅同步——模式由工作区实际布局推导
 * （setViewMode 切换、手动关标签等外部变化都会刷新）；
 * 返回 off 供视图销毁/重建时退订防泄漏。
 */
export function createViewModeBar(
	plugin: MarinMindPlugin,
): { el: HTMLElement; off: () => void } {
	const btn = document.createElement("button");
	btn.type = "button";
	btn.className = "marinmind-tool-btn marinmind-view-mode-btn";

	// 左键循环：doc→map→linked→doc（getViewMode 两侧皆无时返回 "linked"，indexOf 不为 -1）
	btn.addEventListener("click", () => {
		const cur = plugin.getViewMode();
		const next = MODE_ORDER[(MODE_ORDER.indexOf(cur) + 1) % MODE_ORDER.length];
		void plugin.setViewMode(next);
	});

	// 右键直选：三项菜单，当前项打勾
	btn.addEventListener("contextmenu", (evt) => {
		evt.preventDefault();
		const cur = plugin.getViewMode();
		const menu = new Menu();
		for (const def of MODE_DEFS) {
			menu.addItem((item) =>
				item
					.setTitle(def.label)
					.setIcon(resolveIcon(def.icons))
					.setChecked(def.mode === cur)
					.onClick(() => void plugin.setViewMode(def.mode)),
			);
		}
		menu.showAtMouseEvent(evt);
	});

	// 订阅同步：icon 随当前视图变化，tooltip 说明当前态与操作方式
	const sync = (): void => {
		const def = MODE_DEFS.find((d) => d.mode === plugin.getViewMode()) ?? MODE_DEFS[2];
		setIconSafe(btn, ...def.icons);
		const tip = `视图：${def.label}（${def.hint}）· 左键循环切换 / 右键直选`;
		btn.setAttr("title", tip);
		btn.setAttr("aria-label", tip);
	};
	sync();
	return { el: btn, off: plugin.onViewModeChange(sync) };
}
