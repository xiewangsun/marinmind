/**
 * screen-capture 纯函数单测（114 选区几何；117 热键校验）：锚点缩放/平移
 * 钳制/物理像素换算 + 适配与多屏挑选 + validateAccelerator。网络/剪贴板/
 * Electron remote 属 obsidian 桌面运行时路径，不在此覆盖（守卫链任何缺口
 * 静默降级的约定由桌面手动验收）。
 */
import { describe, expect, it } from "vitest";

import {
	MIN_SELECT,
	THUMB_CAP,
	fitSize,
	moveSelRect,
	physicalCropRect,
	physicalThumbSize,
	pickActiveScreen,
	resizeFromAnchor,
	resolveScreenBounds,
	validateAccelerator,
	type CapturedScreen,
	type DisplayLike,
} from "../../src/capture/screen-capture";

/** 构造屏幕产物（默认非主屏） */
const screen = (over: Partial<CapturedScreen> = {}): CapturedScreen => ({
	id: "1",
	label: "Screen 1",
	dataUrl: "data:image/png;base64,",
	width: 1920,
	height: 1080,
	primary: false,
	...over,
});

describe("pickActiveScreen", () => {
	it("主显示器优先", () => {
		expect(
			pickActiveScreen([screen(), screen({ id: "2", primary: true }), screen({ id: "3" })]),
		).toBe(1);
	});

	it("无主屏标记回退首屏", () => {
		expect(pickActiveScreen([screen({ id: "a" }), screen({ id: "b" })])).toBe(0);
	});

	it("空列表回退 0（调用方先判长度）", () => {
		expect(pickActiveScreen([])).toBe(0);
	});
});

describe("fitSize", () => {
	it("超盒保比缩小", () => {
		expect(fitSize(2000, 1000, 800, 600)).toEqual({ width: 800, height: 400 });
	});

	it("盒内不放大", () => {
		expect(fitSize(400, 300, 800, 600)).toEqual({ width: 400, height: 300 });
	});

	it("高度受限时以高定缩放", () => {
		expect(fitSize(1000, 1000, 100, 50)).toEqual({ width: 50, height: 50 });
	});
});

describe("resolveScreenBounds（118 D2 修复：display_bounds 桥序列化丢失的配对兜底）", () => {
	const displays: DisplayLike[] = [
		{ id: 1001, bounds: { x: 0, y: 0, width: 1920, height: 1080 } },
		{ id: 1002, bounds: { x: 1920, y: 0, width: 2560, height: 1440 } },
	];

	it("display_bounds 形状合法直接用（主路不回归）", () => {
		const b = { x: 0, y: 0, width: 1920, height: 1080 };
		expect(resolveScreenBounds(b, "1001", displays, 0)).toEqual(b);
	});

	it("display_bounds 丢失 → display_id 配对 getAllDisplays", () => {
		expect(resolveScreenBounds(undefined, "1002", displays, 0)).toEqual(displays[1]!.bounds);
	});

	it("display_bounds 0×0（退化值）→ 视为丢失走配对", () => {
		expect(
			resolveScreenBounds({ x: 0, y: 0, width: 0, height: 0 }, "1002", displays, 0),
		).toEqual(displays[1]!.bounds);
	});

	it("display_id 配不上 → 同下标兜底（单屏必然正确）", () => {
		expect(resolveScreenBounds(undefined, "9999", displays, 1)).toEqual(displays[1]!.bounds);
	});

	it("display_id 为数字串形态也能配（Electron id 数字两边类型不齐防御）", () => {
		expect(resolveScreenBounds(undefined, 1002, displays, 0)).toEqual(displays[1]!.bounds);
	});

	it("显示器枚举也拿不到 → undefined（调用方降级弹窗）", () => {
		expect(resolveScreenBounds(undefined, "1001", [], 0)).toBeUndefined();
		expect(resolveScreenBounds(undefined, undefined, [], 0)).toBeUndefined();
	});
});

describe("physicalThumbSize", () => {
	it("按 scaleFactor 放大到物理像素", () => {
		expect(physicalThumbSize(1920, 1080, 2, 2560)).toEqual({ width: 2560, height: 1440 });
	});

	it("超 cap 保比 clamp（4K 单边压到 cap）", () => {
		expect(physicalThumbSize(3840, 2400, 1, 2560)).toEqual({ width: 2560, height: 1600 });
	});

	it("cap 内不受影响", () => {
		expect(physicalThumbSize(1000, 500, 1, 2560)).toEqual({ width: 1000, height: 500 });
	});

	it("退化输入（factor 0 / 尺寸 0）至少回 1×1", () => {
		expect(physicalThumbSize(0, 500, 0, 2560)).toEqual({ width: 1, height: 1 });
	});

	it("118：cap 升 3840（4K 原生 1:1 保真，覆盖窗直选铺满不降采样）", () => {
		expect(THUMB_CAP).toBe(3840);
		expect(physicalThumbSize(3840, 2160, 1, THUMB_CAP)).toEqual({ width: 3840, height: 2160 });
		expect(physicalThumbSize(1920, 1080, 2, THUMB_CAP)).toEqual({ width: 3840, height: 2160 });
	});
});

describe("resizeFromAnchor", () => {
	it("右下拖动出正矩形", () => {
		expect(resizeFromAnchor(10, 20, 110, 70, 800, 600, MIN_SELECT)).toEqual({
			x: 10,
			y: 20,
			w: 100,
			h: 50,
		});
	});

	it("左上拖动归一（锚点为右下角）", () => {
		expect(resizeFromAnchor(100, 80, 20, 30, 800, 600, MIN_SELECT)).toEqual({
			x: 20,
			y: 30,
			w: 80,
			h: 50,
		});
	});

	it("拖动点越界钳制到画面内", () => {
		const sel = resizeFromAnchor(700, 500, 5000, 5000, 800, 600, MIN_SELECT);
		expect(sel.x + sel.w).toBeLessThanOrEqual(800);
		expect(sel.y + sel.h).toBeLessThanOrEqual(600);
	});

	it("近锚点微动保最小尺寸（拖动侧撑开）", () => {
		const sel = resizeFromAnchor(100, 100, 103, 100, 800, 600, MIN_SELECT);
		expect(sel).toEqual({ x: 100, y: 100, w: MIN_SELECT, h: MIN_SELECT });
	});

	it("贴边拖小框时锚点侧让位（锚 0，min=8 → x 回退到 0）", () => {
		const sel = resizeFromAnchor(0, 0, 2, 2, 800, 600, MIN_SELECT);
		expect(sel.x).toBe(0);
		expect(sel.w).toBe(MIN_SELECT);
	});

	it("画面右下角附近也能保住最小框（双向让位不越界）", () => {
		const sel = resizeFromAnchor(798, 598, 797, 597, 800, 600, MIN_SELECT);
		expect(sel.x + sel.w).toBeLessThanOrEqual(800);
		expect(sel.y + sel.h).toBeLessThanOrEqual(600);
		expect(sel.w).toBeGreaterThanOrEqual(MIN_SELECT - 1);
	});
});

describe("moveSelRect", () => {
	it("整体平移", () => {
		expect(moveSelRect({ x: 10, y: 10, w: 100, h: 50 }, 20, 5, 800, 600)).toEqual({
			x: 30,
			y: 15,
			w: 100,
			h: 50,
		});
	});

	it("右/下缘钳制（拖不出画面）", () => {
		const sel = moveSelRect({ x: 700, y: 550, w: 100, h: 50 }, 500, 500, 800, 600);
		expect(sel).toEqual({ x: 700, y: 550, w: 100, h: 50 });
	});

	it("负向钳制到 0", () => {
		const sel = moveSelRect({ x: 10, y: 10, w: 100, h: 50 }, -500, -500, 800, 600);
		expect(sel).toEqual({ x: 0, y: 0, w: 100, h: 50 });
	});
});

describe("physicalCropRect", () => {
	it("按实测比例换算物理像素（2× 显示）", () => {
		const rect = physicalCropRect({ x: 100, y: 50, w: 200, h: 100 }, 800, 600, 1600, 1200);
		expect(rect).toEqual({ sx: 200, sy: 100, sw: 400, sh: 200 });
	});

	it("非等比显示（letterbox 外的框内坐标仍按轴独立换算）", () => {
		const rect = physicalCropRect({ x: 0, y: 0, w: 800, h: 600 }, 800, 600, 1600, 1000);
		expect(rect).toEqual({ sx: 0, sy: 0, sw: 1600, sh: 1000 });
	});

	it("round 溢出钳制在图源边界内", () => {
		const rect = physicalCropRect({ x: 795, y: 595, w: 5, h: 5 }, 800, 600, 1601, 1201);
		expect(rect.sx + rect.sw).toBeLessThanOrEqual(1601);
		expect(rect.sy + rect.sh).toBeLessThanOrEqual(1201);
	});
});

describe("validateAccelerator（117）", () => {
	it("合法组合：修饰键+单键（大小写不敏感，多修饰键）", () => {
		expect(validateAccelerator("Ctrl+Shift+A")).toBe(true);
		expect(validateAccelerator("ctrl+shift+a")).toBe(true);
		expect(validateAccelerator("CmdOrCtrl+Alt+T")).toBe(true);
		expect(validateAccelerator("Super+F1")).toBe(true);
		expect(validateAccelerator("Ctrl+,")).toBe(true);
		expect(validateAccelerator("Alt+Space")).toBe(true);
		expect(validateAccelerator("Command+Shift+4")).toBe(true);
	});

	it("空串与纯空白拒绝", () => {
		expect(validateAccelerator("")).toBe(false);
		expect(validateAccelerator("   ")).toBe(false);
	});

	it("无修饰键拒绝（全局裸键会劫持所有应用输入）", () => {
		expect(validateAccelerator("A")).toBe(false);
		expect(validateAccelerator("F5")).toBe(false);
		expect(validateAccelerator("Space")).toBe(false);
	});

	it("空段拒绝（尾随 + / Ctrl++ / 前导 +）", () => {
		expect(validateAccelerator("Ctrl+")).toBe(false);
		expect(validateAccelerator("Ctrl++")).toBe(false);
		expect(validateAccelerator("+A")).toBe(false);
	});

	it("非法键名拒绝（F25 越界 / 中文 / 未知词）", () => {
		expect(validateAccelerator("Ctrl+F25")).toBe(false);
		expect(validateAccelerator("Ctrl+截图")).toBe(false);
		expect(validateAccelerator("Ctrl+Meta+A")).toBe(false); // Meta 非 Electron 词形（用 Super）
		expect(validateAccelerator("Ctrl+Shift")).toBe(false); // Shift 是修饰键不是单键
	});

	it("重复修饰键拒绝", () => {
		expect(validateAccelerator("Ctrl+Ctrl+A")).toBe(false);
	});

	it("修饰键缺单键 / 单键当修饰键拒绝", () => {
		expect(validateAccelerator("A+B")).toBe(false);
		expect(validateAccelerator("Ctrl+A+S")).toBe(false); // S 不是修饰键
	});
});
