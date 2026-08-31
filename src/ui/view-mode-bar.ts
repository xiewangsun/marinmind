import type MarinMindPlugin from "../main";

/** 视图模式：单文档 / 单脑图 / 文档·脑图联动（MarginNote 学习集三视图，⑰） */
export type ViewMode = "doc" | "map" | "linked";

/** 切换条按钮定义（顺序即显示顺序） */
const MODE_DEFS: ReadonlyArray<{ mode: ViewMode; label: string; hint: string }> = [
	{ mode: "doc", label: "文档", hint: "单文档视图：隐藏脑图窗格" },
	{ mode: "map", label: "脑图", hint: "单脑图视图：隐藏文档窗格" },
	{ mode: "linked", label: "联动", hint: "联动视图：文档 + 脑图并排，点击互相定位" },
];

/**
 * 三态视图模式切换条 [文档|脑图|联动]：阅读器工具行与脑图头部共用。
 * 激活态经 plugin.onViewModeChange 订阅同步——模式由工作区实际布局推导
 * （setViewMode 切换、手动关标签等外部变化都会刷新）；
 * 返回 off 供视图销毁/重建时退订防泄漏。
 */
export function createViewModeBar(
	plugin: MarinMindPlugin,
): { el: HTMLElement; off: () => void } {
	const bar = document.createElement("div");
	// P2-2：形态由 .marinmind-segmented 共享配方承担；view-mode 只留布局差异
	bar.className = "marinmind-segmented marinmind-view-mode";
	const btns = new Map<ViewMode, HTMLElement>();
	for (const def of MODE_DEFS) {
		const btn = bar.createEl("button", {
			cls: "marinmind-segmented-btn",
			attr: { type: "button", "aria-label": def.hint, title: def.hint },
			text: def.label,
		});
		btn.addEventListener("click", () => void plugin.setViewMode(def.mode));
		btns.set(def.mode, btn);
	}
	const sync = (): void => {
		const cur = plugin.getViewMode();
		for (const [mode, btn] of btns) {
			btn.classList.toggle("is-active", mode === cur);
		}
	};
	sync();
	return { el: bar, off: plugin.onViewModeChange(sync) };
}
