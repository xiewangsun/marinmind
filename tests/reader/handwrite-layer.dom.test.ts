// @vitest-environment jsdom
/**
 * 视图层冒烟测试（103-E）：jsdom 环境直测零 obsidian 依赖的 DOM 组件。
 * 旗舰场景 = HandwriteLayer 指针绑定回归（101 修的原生场景：处理器未 bind 时
 * this 指向 DOM 元素，mode 守卫恒假，画布收不到任何一笔）。
 *
 * jsdom 能力边界（本文件绕行方式）：
 * - 无 PointerEvent → 最小桩（继承 MouseEvent 补 pointerId/pressure）
 * - 无指针捕获 API → HTMLElement.prototype.setPointerCapture 打桩
 * - 无 canvas 2d 上下文 → HandwriteLayer ctx 判空守卫天然跳过绘制路径（只测模型）
 * - getBoundingClientRect 恒 0 → toNorm 走 max(1, 0) 分支，坐标即像素原值
 */
import { describe, expect, it, vi, beforeAll } from "vitest";
import { HandwriteLayer } from "../../src/reader/handwrite-layer";
import type { PageView } from "../../src/reader/page-view";

/** 指针事件最小桩：补 jsdom 缺的 pointerId / pressure 两个可读属性 */
class PointerEventStub extends MouseEvent {
	readonly pointerId: number;
	readonly pressure: number;
	constructor(
		type: string,
		init: { pointerId?: number; pressure?: number; clientX?: number; clientY?: number } = {},
	) {
		super(type, {
			bubbles: true,
			cancelable: true,
			clientX: init.clientX,
			clientY: init.clientY,
		});
		this.pointerId = init.pointerId ?? 1;
		this.pressure = init.pressure ?? 0.5;
	}
}

beforeAll(() => {
	(globalThis as { PointerEvent?: unknown }).PointerEvent = PointerEventStub;
	// 指针捕获未实现：打空桩（onPointerDown 无条件调用，不打桩直接 TypeError）
	HTMLElement.prototype.setPointerCapture = () => undefined;
});

/** 页视图替身：手写层只消费 el / displayWidth / displayHeight（baseSize 仅 commit 用） */
function makePageView(): PageView {
	const el = document.createElement("div");
	document.body.appendChild(el);
	return {
		el,
		displayWidth: 100,
		displayHeight: 100,
	} as unknown as PageView;
}

/** 在层根元素上派发一次指针事件 */
function fire(
	root: Element,
	type: "pointerdown" | "pointermove" | "pointerup",
	x: number,
	y: number,
): void {
	root.dispatchEvent(new PointerEventStub(type, { clientX: x, clientY: y, pointerId: 7 }));
}

function layerRoot(pageEl: HTMLElement): HTMLElement {
	const root = pageEl.querySelector(".marinmind-handwrite-layer");
	expect(root).not.toBeNull();
	return root as HTMLElement;
}

describe("HandwriteLayer 视图层冒烟（jsdom）", () => {
	it("手写模式落笔→移动→抬笔：笔迹入模型、onInk 触发、可撤销（101 绑定回归）", () => {
		const pv = makePageView();
		const layer = new HandwriteLayer(pv);
		const onInk = vi.fn();
		layer.onInk = onInk;
		layer.setHandwriteMode(true);
		expect(layerRoot(pv.el).classList.contains("marinmind-handwrite-on")).toBe(true);

		const root = layerRoot(pv.el);
		fire(root, "pointerdown", 10, 10);
		fire(root, "pointermove", 40, 60); // 距上一采样 > 0.001（防过密跳过）
		fire(root, "pointerup", 40, 60);

		expect(layer.hasInk()).toBe(true); // 未 bind this 时恒 false——101 原缺陷
		expect(onInk).toHaveBeenCalledTimes(1);
		expect(layer.canUndo()).toBe(true);

		expect(layer.undo()).toBe(true);
		expect(layer.hasInk()).toBe(false);
		expect(layer.canUndo()).toBe(false);
		layer.destroy();
	});

	it("模式关闭时指针穿透：不落笔不入撤销栈", () => {
		const pv = makePageView();
		const layer = new HandwriteLayer(pv);
		const root = layerRoot(pv.el);
		fire(root, "pointerdown", 10, 10);
		fire(root, "pointermove", 40, 60);
		fire(root, "pointerup", 40, 60);
		expect(layer.hasInk()).toBe(false);
		expect(layer.canUndo()).toBe(false);
		layer.destroy();
	});

	it("橡皮擦：命中整笔删除，撤销按原样插回", () => {
		const pv = makePageView();
		const layer = new HandwriteLayer(pv);
		layer.setHandwriteMode(true);
		const root = layerRoot(pv.el);
		fire(root, "pointerdown", 10, 10);
		fire(root, "pointermove", 40, 60);
		fire(root, "pointerup", 40, 60);
		expect(layer.hasInk()).toBe(true);

		layer.setEraser(true);
		fire(root, "pointerdown", 40, 60); // 恰落在笔迹终点（jsdom 坐标即原值）
		expect(layer.hasInk()).toBe(false);

		expect(layer.undo()).toBe(true); // erase 撤销 = 原下标插回
		expect(layer.hasInk()).toBe(true);
		layer.destroy();
	});

	it("pointercancel：丢弃未完成笔迹", () => {
		const pv = makePageView();
		const layer = new HandwriteLayer(pv);
		layer.setHandwriteMode(true);
		const root = layerRoot(pv.el);
		fire(root, "pointerdown", 10, 10);
		fire(root, "pointermove", 30, 30);
		fire(root, "pointercancel", 30, 30);
		fire(root, "pointerup", 30, 30); // cancel 后 up 不再入栈
		expect(layer.hasInk()).toBe(false);
		layer.destroy();
	});

	it("destroy：移除根元素并解绑监听（事件不再进入模型）", () => {
		const pv = makePageView();
		const layer = new HandwriteLayer(pv);
		layer.setHandwriteMode(true);
		const root = layerRoot(pv.el);
		layer.destroy();
		expect(pv.el.querySelector(".marinmind-handwrite-layer")).toBeNull();

		fire(root, "pointerdown", 10, 10); // 对已脱离文档的根再派发
		fire(root, "pointermove", 40, 60);
		fire(root, "pointerup", 40, 60);
		expect(layer.hasInk()).toBe(false); // 监听已解绑，模型零变化
	});
});
