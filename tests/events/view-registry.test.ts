/**
 * 通用视图注册表单测（147）：注册/注销/分桶隔离/广播只达本类型/幂等与空桶回收。
 * 注册表对 ItemView 仅类型依赖（零 obsidian 运行时导入），以最小形状桩代视图。
 */
import { describe, expect, it } from "vitest";
import {
	activeViewsOf,
	broadcastToViews,
	registerActiveView,
	unregisterActiveView,
} from "../../src/events/view-registry";
import type { ItemView } from "obsidian";

/** 最小视图桩：只有 getViewType 参与（注册表不触碰其他成员） */
function stubView(viewType: string): ItemView {
	return { getViewType: () => viewType } as unknown as ItemView;
}

describe("view-registry（147 通知机制收敛）", () => {
	it("注册后按类型可取快照，注销后不可见", () => {
		const a = stubView("type-a");
		registerActiveView(a);
		expect(activeViewsOf<ItemView>("type-a")).toHaveLength(1);
		expect(activeViewsOf<ItemView>("type-a")[0]).toBe(a);
		unregisterActiveView(a);
		expect(activeViewsOf<ItemView>("type-a")).toHaveLength(0);
	});

	it("类型分桶隔离：A 桶广播不达 B 桶（注册序送达）", () => {
		const calls: string[] = [];
		const mark = (id: string) => ({ getViewType: () => "type-a", mark: () => calls.push(id) });
		const a1 = mark("a1") as unknown as ItemView;
		const a2 = mark("a2") as unknown as ItemView;
		const b1 = {
			getViewType: () => "type-b",
			mark: () => calls.push("b1"),
		} as unknown as ItemView;
		registerActiveView(a1);
		registerActiveView(a2);
		registerActiveView(b1);
		broadcastToViews<{ getViewType(): string; mark(): void }>("type-a", (v) => v.mark());
		expect(calls).toEqual(["a1", "a2"]);
		unregisterActiveView(a1);
		unregisterActiveView(a2);
		unregisterActiveView(b1);
	});

	it("重复注册幂等（Set 语义），桶空后撤销（不残留空桶）", () => {
		const a = stubView("type-x");
		registerActiveView(a);
		registerActiveView(a);
		expect(activeViewsOf<ItemView>("type-x")).toHaveLength(1);
		unregisterActiveView(a);
		// 注销不存在的视图/空桶注销均安全
		expect(() => unregisterActiveView(a)).not.toThrow();
		expect(activeViewsOf<ItemView>("type-x")).toHaveLength(0);
	});
});
