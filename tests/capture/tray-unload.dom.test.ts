// @vitest-environment jsdom
/**
 * tray-icon 卸载钩子单测（131）：Obsidian 退出不保证走插件 onunload，
 * 托盘（主进程对象）成孤儿——图标残留任务栏且右键菜单回调全部失效。
 * 锁定 attachTrayUnloadHook / destroyCaptureTray 的 beforeunload 接线：
 * 挂钩 → 页面卸载即销毁；显式销毁/重建换钩不残留死监听。
 * （Tray 构造/nativeImage 属 electron 桌面运行时路径，不在此覆盖。）
 */
import { describe, expect, it } from "vitest";

import {
	attachTrayUnloadHook,
	destroyCaptureTray,
	type CaptureTrayLike,
} from "../../src/capture/tray-icon";

/** 触发一次页面卸载（模拟渲染进程关闭前一刻） */
function fireBeforeUnload(): void {
	window.dispatchEvent(new Event("beforeunload"));
}

/** 最小托盘桩：只记录 destroy 调用 */
function fakeTray(): CaptureTrayLike & { destroyed: () => number } {
	let count = 0;
	return {
		destroy: () => {
			count += 1;
		},
		destroyed: () => count,
	};
}

describe("attachTrayUnloadHook（131 随 Obsidian 退场）", () => {
	it("beforeunload 触发即销毁托盘", () => {
		const tray = fakeTray();
		attachTrayUnloadHook(tray);
		fireBeforeUnload();
		expect(tray.destroyed()).toBe(1);
	});

	it("显式销毁卸下钩子——之后页面卸载不再重复 destroy", () => {
		const tray = fakeTray();
		attachTrayUnloadHook(tray);
		destroyCaptureTray(tray);
		fireBeforeUnload();
		expect(tray.destroyed()).toBe(1); // 仅显式那次
	});

	it("重建换钩——只销毁新托盘，旧钩子不残留", () => {
		const oldTray = fakeTray();
		const newTray = fakeTray();
		attachTrayUnloadHook(oldTray);
		attachTrayUnloadHook(newTray); // 模拟设置切换重建
		fireBeforeUnload();
		expect(oldTray.destroyed()).toBe(0);
		expect(newTray.destroyed()).toBe(1);
	});

	it("destroyCaptureTray(null) 静默且同样清理钩子", () => {
		const tray = fakeTray();
		attachTrayUnloadHook(tray);
		expect(() => destroyCaptureTray(null)).not.toThrow();
		fireBeforeUnload();
		expect(tray.destroyed()).toBe(0);
	});

	it("destroy 抛错不外溢（已销毁托盘 beforeunload 再触发）", () => {
		const tray: CaptureTrayLike = {
			destroy: () => {
				throw new Error("already destroyed");
			},
		};
		attachTrayUnloadHook(tray);
		expect(() => fireBeforeUnload()).not.toThrow();
	});
});
