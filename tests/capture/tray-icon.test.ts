/**
 * tray-icon 纯函数单测（120；125 菜单加退出项）：托盘菜单模板结构
 * （动作键/分隔线/顺序——退出收尾）。Tray 构造 / nativeImage / 菜单分发
 * 属 electron 桌面运行时路径，不在此覆盖（守卫链静默降级由桌面手动验收）。
 */
import { describe, expect, it } from "vitest";

import { TRAY_TOOLTIP, trayMenuItems } from "../../src/capture/tray-icon";

describe("trayMenuItems", () => {
	it("结构：截图复制 / 剪藏为笔记 / 分隔线 / 打开设置 / 分隔线 / 退出（125）", () => {
		const items = trayMenuItems();
		expect(items).toHaveLength(6);
		expect(items[0]).toMatchObject({ label: "截图（框选）复制", action: "copy" });
		expect(items[1]).toMatchObject({ label: "剪藏屏幕区域为笔记…", action: "note" });
		expect(items[2]).toEqual({ type: "separator" });
		expect(items[3]).toMatchObject({ label: "打开设置", action: "settings" });
		expect(items[4]).toEqual({ type: "separator" });
		expect(items[5]).toMatchObject({ label: "退出", action: "exit" });
	});

	it("非分隔项全部带动作键（分发无死角），退出项收尾", () => {
		const items = trayMenuItems();
		for (const item of items) {
			if (item.type === "separator") {
				expect(item.action).toBeUndefined();
			} else {
				expect(["copy", "note", "settings", "exit"]).toContain(item.action);
			}
		}
		expect(items[items.length - 1]).toMatchObject({ action: "exit" });
	});

	it("Tooltip 文案含左键提示", () => {
		expect(TRAY_TOOLTIP).toContain("MarinMind");
		expect(TRAY_TOOLTIP).toContain("左键");
	});
});
