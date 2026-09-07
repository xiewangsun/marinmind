/**
 * screen-select 纯函数单测（118）：覆盖窗 HTML 生成 / 窗口选项 / 回传值
 * 校验钳制 / 临时路径 / 动作定义 / 入口环境守卫。BrowserWindow 编排与
 * executeJavaScript 桥属 obsidian 桌面运行时路径，不在此覆盖（降级链
 * 由桌面手动验收）。
 */
import { describe, expect, it } from "vitest";
// vitest 为 ESM 环境，无全局 require——注入 createRequire 产物，
// 使 tempCapturePaths 的守卫式 require（path.join）可用
import { createRequire } from "module";
(globalThis as { require?: unknown }).require ??= createRequire(import.meta.url);
import { join } from "path";
import { tmpdir } from "os";

import {
	buildOverlayHtml,
	buildOverlayWindowOptions,
	overlayActionDefs,
	parseOverlayResult,
	selectScreenRegion,
	tempCapturePaths,
} from "../../src/capture/screen-select";
import type { CapturedScreen } from "../../src/capture/screen-capture";

/** 构造带 bounds 的屏幕产物 */
const screen = (over: Partial<CapturedScreen> = {}): CapturedScreen => ({
	id: "1",
	label: "Screen 1",
	dataUrl: "data:image/png;base64,",
	width: 1920,
	height: 1080,
	primary: true,
	bounds: { x: 0, y: 0, width: 1920, height: 1080 },
	...over,
});

describe("overlayActionDefs", () => {
	it("copy 单动作：主按钮唯一", () => {
		expect(overlayActionDefs(["copy"])).toEqual([
			{ key: "copy", label: "复制", primary: true },
		]);
	});

	it("note+copy 保序：第一个为主按钮（Enter/双击默认）", () => {
		const defs = overlayActionDefs(["note", "copy"]);
		expect(defs.map((d) => d.key)).toEqual(["note", "copy"]);
		expect(defs[0]!.primary).toBe(true);
		expect(defs[1]!.primary).toBe(false);
	});

	it("空动作：空数组（调用方错误，selectScreenRegion 拦截）", () => {
		expect(overlayActionDefs([])).toEqual([]);
	});
});

describe("buildOverlayHtml", () => {
	it("引用相对 PNG 文件名（与临时 HTML 同目录）", () => {
		const html = buildOverlayHtml({ pngSrc: "screen-0.png", actions: ["copy"] });
		expect(html).toContain('src="screen-0.png"');
		expect(html).not.toContain("file://"); // 不硬编码绝对路径
	});

	it("自包含：无任何 http(s) 外部引用（CSP default-src 'none' 兜底）", () => {
		const html = buildOverlayHtml({ pngSrc: "screen-0.png", actions: ["note", "copy"] });
		expect(html).not.toMatch(/https?:\/\//);
	});

	it("注入工具条动作（含中文标签与 primary 标记）", () => {
		const html = buildOverlayHtml({ pngSrc: "screen-0.png", actions: ["note", "copy"] });
		expect(html).toContain('"label":"存为笔记"');
		expect(html).toContain('"label":"复制"');
		expect(html).toContain('"primary":true');
	});

	it("结果回传三件套脚本齐备（__mmP / __mmDone / __mmResult）", () => {
		const html = buildOverlayHtml({ pngSrc: "screen-0.png", actions: ["copy"] });
		expect(html).toContain("window.__mmP");
		expect(html).toContain("window.__mmDone");
		expect(html).toContain("window.__mmResult");
	});

	it("四角柄与遮罩层齐备（与 114 弹窗同构交互）", () => {
		const html = buildOverlayHtml({ pngSrc: "screen-0.png", actions: ["copy"] });
		expect(html).toContain('data-c="nw"');
		expect(html).toContain('data-c="se"');
		expect(html).toContain('id="mm-m0"');
		expect(html).toContain('id="mm-bar"');
	});
});

describe("buildOverlayWindowOptions", () => {
	it("按显示器 bounds 定位（负坐标副屏原样透传）+ 无边框不透明隐藏", () => {
		const opts = buildOverlayWindowOptions({ x: -1920, y: 0, width: 1920, height: 1080 });
		expect(opts).toMatchObject({
			x: -1920,
			y: 0,
			width: 1920,
			height: 1080,
			frame: false,
			transparent: false,
			backgroundColor: "#000000",
			show: false,
			skipTaskbar: true,
			hasShadow: false,
			alwaysOnTop: true,
			minimizable: true, // Win+D 最小化即用户取消信号，必须保留
		});
	});

	it("退化尺寸钳制到 1×1（防 0 尺寸窗构造抛错）", () => {
		const opts = buildOverlayWindowOptions({ x: 0, y: 0, width: 0, height: -5 });
		expect(opts.width).toBe(1);
		expect(opts.height).toBe(1);
	});

	it("122：fullscreen 分支（Windows）进无边框全屏压任务栏——resizable 放开（false 无法进全屏）", () => {
		const opts = buildOverlayWindowOptions(
			{ x: 0, y: 0, width: 1920, height: 1080 },
			{
				fullscreen: true,
			},
		);
		expect(opts).toMatchObject({ fullscreen: true, fullscreenable: true, resizable: true });
	});

	it("122：默认分支保持普通置顶（macOS/Linux 行为不回归）", () => {
		const opts = buildOverlayWindowOptions({ x: 0, y: 0, width: 1920, height: 1080 });
		expect(opts).toMatchObject({ fullscreen: false, fullscreenable: false, resizable: false });
	});
});

describe("parseOverlayResult", () => {
	const screens = [
		screen(),
		screen({ id: "2", bounds: { x: 1920, y: 0, width: 1920, height: 1080 } }),
	];

	it("合法回传原样规整", () => {
		const r = parseOverlayResult(
			{
				action: "copy",
				x: 10.4,
				y: 20.6,
				w: 100,
				h: 50,
				dispW: 1920,
				dispH: 1080,
				screenIndex: 1,
			},
			screens,
		);
		expect(r).toEqual({
			screenIndex: 1,
			action: "copy",
			sel: { x: 10, y: 21, w: 100, h: 50 },
			dispW: 1920,
			dispH: 1080,
		});
	});

	it("null/undefined/非对象/缺字段判 null（取消或垃圾值）", () => {
		expect(parseOverlayResult(null, screens)).toBeNull();
		expect(parseOverlayResult(undefined, screens)).toBeNull();
		expect(parseOverlayResult("copy", screens)).toBeNull();
		expect(parseOverlayResult({}, screens)).toBeNull();
		expect(
			parseOverlayResult(
				{ action: "copy", x: 1, y: 1, w: 1, h: 1, dispW: 100, dispH: 100 },
				screens,
			),
		).toBeNull(); // 缺 screenIndex
	});

	it("非法动作拒绝", () => {
		expect(
			parseOverlayResult(
				{
					action: "delete",
					x: 1,
					y: 1,
					w: 9,
					h: 9,
					dispW: 100,
					dispH: 100,
					screenIndex: 0,
				},
				screens,
			),
		).toBeNull();
	});

	it("screenIndex 越界拒绝（页面伪造/桥异常防御）", () => {
		expect(
			parseOverlayResult(
				{ action: "copy", x: 1, y: 1, w: 9, h: 9, dispW: 100, dispH: 100, screenIndex: 2 },
				screens,
			),
		).toBeNull();
	});

	it("越界选区钳制到显示范围内", () => {
		const r = parseOverlayResult(
			{
				action: "note",
				x: -50,
				y: -50,
				w: 5000,
				h: 4000,
				dispW: 1000,
				dispH: 800,
				screenIndex: 0,
			},
			screens,
		)!;
		expect(r.sel).toEqual({ x: 0, y: 0, w: 1000, h: 800 });
	});

	it("微小选区（越界钳缩所致）视为无效 → null（取消语义）", () => {
		expect(
			parseOverlayResult(
				{
					action: "copy",
					x: 999,
					y: 799,
					w: 500,
					h: 500,
					dispW: 1000,
					dispH: 800,
					screenIndex: 0,
				},
				screens,
			),
		).toBeNull();
	});

	it("非有限数值拒绝（NaN/Infinity 防御）", () => {
		expect(
			parseOverlayResult(
				{
					action: "copy",
					x: Number.NaN,
					y: 1,
					w: 9,
					h: 9,
					dispW: 100,
					dispH: 100,
					screenIndex: 0,
				},
				screens,
			),
		).toBeNull();
	});
});

describe("tempCapturePaths", () => {
	it("目录与逐屏文件名生成（会话隔离前缀）", () => {
		const paths = tempCapturePaths(tmpdir(), "abc123");
		expect(paths.dir).toBe(join(tmpdir(), "marinmind-capture-abc123"));
		expect(paths.png(0)).toBe(join(paths.dir, "screen-0.png"));
		expect(paths.html(2)).toBe(join(paths.dir, "select-2.html"));
	});
});

describe("selectScreenRegion 环境守卫（node 环境，无 window/remote）", () => {
	it("空动作列表判不可用（调用方错误防御）", async () => {
		const outcome = await selectScreenRegion([screen()], { actions: [] });
		expect(outcome).toMatchObject({ ok: false, reason: expect.stringContaining("D1") });
	});

	it("任一屏缺 bounds 判不可用（覆盖不全则冻结幻象破，宁降级弹窗）", async () => {
		const noBounds = screen({ bounds: undefined });
		const outcome = await selectScreenRegion([screen(), noBounds], { actions: ["copy"] });
		expect(outcome).toMatchObject({ ok: false, reason: expect.stringContaining("D2") });
	});

	it("无 remote/BrowserWindow（node 环境）判不可用", async () => {
		const outcome = await selectScreenRegion([screen()], { actions: ["copy"] });
		expect(outcome).toMatchObject({ ok: false, reason: expect.stringContaining("D3") });
	});
});
