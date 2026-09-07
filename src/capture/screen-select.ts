/**
 * Snipaste 式全屏覆盖窗直选（118，obsidian 零依赖）：抓屏冻结画面已由
 * screen-capture 取得，本模块把它铺回屏幕——每显示器一个不透明无边框
 * 置顶 BrowserWindow（冻结截图整屏铺满 + 选区 UI），用户直接在"屏幕上"
 * 框选，松手工具条确认。覆盖窗不需要 transparent：画面本身就是截图，
 * 遮罩画在截图上，绕开各平台透明窗全套坑。
 *
 * 内容路径必须是临时 HTML 文件（data: URL 顶层导航被 Chromium 禁止）：
 * os.tmpdir()/marinmind-capture-<会话>/ 下逐屏写 screen-<i>.png + select-<i>.html，
 * loadURL(pathToFileURL(...))（应对 Windows 中文用户名路径）。
 *
 * 结果回传三件套：页面挂 window.__mmP = Promise（__mmDone 为 resolver）+
 * __mmResult 暂存；插件侧 executeJavaScript("window.__mmP") 经
 * @electron/remote 桥自动 await 并结构化克隆回传；桥版本差异下辅以
 * closed/minimize 事件、isDestroyed 2s 轮询与 10 分钟硬上限看门狗。
 *
 * 加载铁律同 external-file.ts：window / require 只能在函数体内守卫式访问。
 * 任何一环不可用返回 {ok:false}，由调用方降级 114 裁剪弹窗——功能永不丢。
 */
import { loadModule } from "../storage/node-fs-adapter";
import { dataUrlToBytes } from "./image-crop";
import { MIN_SELECT, type CapturedScreen, type ElectronRect } from "./screen-capture";

/** 覆盖窗确认动作：copy=复制到剪贴板；note=剪藏为笔记（119 接线） */
export type OverlayAction = "copy" | "note";

/** 页面回传选区（经插件侧合并 screenIndex 后的完整结果） */
export interface ScreenSelectResult {
	/** 选中屏幕（传入 screens 数组的下标） */
	screenIndex: number;
	/** 选区（覆盖窗口内 CSS px，原点 = 显示器左上） */
	sel: { x: number; y: number; w: number; h: number };
	/** 页面实测图片显示尺寸（窗口 CSS px；插件侧物理像素换算基准） */
	dispW: number;
	dispH: number;
	/** 用户点选的动作（工具条按钮 / Enter / 双击取第一个） */
	action: OverlayAction;
}

/** 覆盖窗会话结局：ok=true 且 result=null 表示用户取消（Esc/右键/Win+D）；ok=false 携带降级原因（编号 D1-D5，Notice 展示便于用户回报定位） */
export type OverlayOutcome =
	{ ok: true; result: ScreenSelectResult | null } | { ok: false; reason: string };

/** 覆盖窗工具条动作定义（buildOverlayHtml 注入页面） */
export interface OverlayActionDef {
	key: OverlayAction;
	label: string;
	/** 第一个动作为主按钮（Enter/双击默认） */
	primary: boolean;
}

/**
 * 动作 → 工具条定义（纯函数）：**保持传入顺序**渲染（第一个动作即
 * Enter/双击默认，119 屏幕剪藏传 note 在前使其为主按钮）；重复与未知
 * 动作静默丢弃。
 */
export function overlayActionDefs(actions: readonly OverlayAction[]): OverlayActionDef[] {
	const labels: Record<OverlayAction, string> = { copy: "复制", note: "存为笔记" };
	const seen = new Set<OverlayAction>();
	const defs: OverlayActionDef[] = [];
	for (const key of actions) {
		if (key !== "copy" && key !== "note") {
			continue; // 未知动作防御
		}
		if (seen.has(key)) {
			continue; // 重复去重
		}
		seen.add(key);
		defs.push({ key, label: labels[key], primary: false });
	}
	if (defs.length > 0) {
		defs[0]!.primary = true;
	}
	return defs;
}

/** 覆盖窗 BrowserWindow 形状（守卫式窄化；@electron/remote 桥接对象） */
interface OverlayWindowLike {
	webContents: {
		loadURL?: (url: string) => Promise<void> | void;
		executeJavaScript?: (code: string, userGesture?: boolean) => Promise<unknown> | unknown;
	};
	on?: (event: string, listener: () => void) => unknown;
	show?: () => void;
	focus?: () => void;
	close?: () => void;
	destroy?: () => void;
	isDestroyed?: () => boolean;
	setAlwaysOnTop?: (flag: boolean, level?: string) => void;
}

/** @electron/remote 形状（仅覆盖窗所需字段，守卫式窄化） */
interface SelectRemoteLike {
	BrowserWindow?: unknown;
	require?: (module: string) => unknown;
}

/** 取 electron remote（typeof window 守卫——node 测试环境无此全局） */
function electronRemote(): SelectRemoteLike | null {
	if (typeof window === "undefined") {
		return null;
	}
	const electron = (window as unknown as { electron?: { remote?: SelectRemoteLike } }).electron;
	return electron?.remote ?? null;
}

/** 桥接返回值可能是 Promise 也可能是裸值（remote 版本差异）——统一 await */
async function maybeAwait<T>(value: T | Promise<T>): Promise<T> {
	return await value;
}

/**
 * 取 BrowserWindow 构造器：① remote.BrowserWindow（@electron/remote 官方
 * 属性）→ ② remote.require("electron").BrowserWindow（版本差异兜底）。
 * 都不可用返回 null（调用方降级 114 弹窗）。
 */
function resolveBrowserWindowCtor():
	(new (opts: Record<string, unknown>) => OverlayWindowLike) | null {
	const remote = electronRemote();
	if (!remote) {
		return null;
	}
	if (typeof remote.BrowserWindow === "function") {
		return remote.BrowserWindow as new (opts: Record<string, unknown>) => OverlayWindowLike;
	}
	try {
		const electron = remote.require?.("electron") as { BrowserWindow?: unknown } | undefined;
		if (typeof electron?.BrowserWindow === "function") {
			return electron.BrowserWindow as new (
				opts: Record<string, unknown>,
			) => OverlayWindowLike;
		}
	} catch (err) {
		console.warn("[MarinMind] remote.require('electron') 取 BrowserWindow 失败", err);
	}
	return null;
}

/**
 * 覆盖窗 BrowserWindow 选项（纯函数）：按显示器 bounds 逐屏定位（DIP 单位
 * 与 BrowserWindow 入参一致）；不透明黑底（截图整屏铺满）；show:false 先装
 * 后显防白闪；minimizable 保留——Win+D 最小化即用户取消的信号。
 *
 * fullscreen 分支（122，Windows）：任务栏同为 topmost 层，普通置顶窗（即使
 * screen-saver 级）仍会被任务栏盖住底部——冻结画面底部被挡，用户只能框到
 * 任务栏上缘，截图恒缺任务栏区域。无边框全屏（borderless fullscreen）是
 * Snipaste 同款的稳定压过任务栏形态。注意 resizable:false 的窗口在 Windows
 * 上无法进入全屏（Electron 已知限制），故该分支放开 resizable（无边框窗
 * 无拖边手柄，放开无副作用）；macOS/Linux 保持普通置顶行为（Dock/面板
 * 干扰场景少，全屏有空格切换动画副作用）。
 */
export function buildOverlayWindowOptions(
	bounds: ElectronRect,
	opts?: { fullscreen?: boolean },
): Record<string, unknown> {
	const fullscreen = opts?.fullscreen === true;
	return {
		x: bounds.x,
		y: bounds.y,
		width: Math.max(1, Math.round(bounds.width)),
		height: Math.max(1, Math.round(bounds.height)),
		frame: false,
		transparent: false,
		backgroundColor: "#000000",
		show: false,
		resizable: fullscreen,
		movable: false,
		minimizable: true,
		maximizable: false,
		fullscreenable: fullscreen,
		fullscreen,
		skipTaskbar: true,
		hasShadow: false,
		alwaysOnTop: true,
		title: "MarinMind 屏幕截图",
		webPreferences: { nodeIntegration: false, contextIsolation: true },
	};
}

/** 选区结束等待用户操作的最长时限（看门狗硬上限：10 分钟后按取消收场） */
const OVERLAY_HARD_CAP_MS = 10 * 60 * 1000;

/**
 * 覆盖窗页面 HTML（纯函数，自包含——无任何外部网络引用）：冻结截图
 * 100% 铺满 + 四遮罩夹选区 + 虚线框 + 四角柄 + 物理像素尺寸标签（页面内
 * natural/client 实算）+ 松手工具条（按 actions 渲染）。交互与 114 弹窗
 * 同构：锚点新选/框内平移/角柄缩放、最小 8px、误触清空；Enter/双击/
 * 主按钮 = 第一个动作，Esc/右键 = 取消。结果经 __mmP/__mmDone/__mmResult
 * 三件套回传（payload 含 dispW/dispH 实测值）。
 */
export function buildOverlayHtml(ctx: {
	pngSrc: string;
	actions: readonly OverlayAction[];
}): string {
	// 相对文件名防御性转义（内部生成 screen-N.png，理论无引号）
	const src = ctx.pngSrc.replace(/"/g, "%22");
	const actionsJson = JSON.stringify(overlayActionDefs(ctx.actions));
	return `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src file:; style-src 'unsafe-inline'; script-src 'unsafe-inline'">
<title>MarinMind 屏幕截图</title>
<style>
html,body{margin:0;padding:0;width:100%;height:100%;overflow:hidden;background:#000;cursor:crosshair;user-select:none;-webkit-user-select:none}
#mm-shot{position:absolute;left:0;top:0;width:100%;height:100%;display:block}
.mm-mask{position:absolute;background:rgba(0,0,0,.45);pointer-events:none}
#mm-box{position:absolute;border:1px dashed #4aa3ff;box-sizing:border-box;display:none;pointer-events:none}
.mm-h{position:absolute;width:10px;height:10px;background:#fff;border:1px solid #4aa3ff;box-sizing:border-box;pointer-events:auto}
#mm-sz{position:absolute;left:0;top:-24px;background:#1e1e1e;color:#fff;font:12px/1.6 monospace;padding:0 6px;border-radius:3px;white-space:nowrap}
#mm-bar{position:absolute;display:none;background:#1e1e1e;border-radius:4px;padding:4px;box-shadow:0 2px 8px rgba(0,0,0,.5);z-index:9}
#mm-bar button{border:0;background:#333;color:#fff;font:13px/1 sans-serif;padding:8px 14px;border-radius:3px;margin:0 3px;cursor:pointer}
#mm-bar button.mm-primary{background:#4aa3ff}
</style>
</head>
<body>
<img id="mm-shot" src="${src}" draggable="false" alt="">
<div class="mm-mask" id="mm-m0"></div><div class="mm-mask" id="mm-m1"></div>
<div class="mm-mask" id="mm-m2"></div><div class="mm-mask" id="mm-m3"></div>
<div id="mm-box">
<div class="mm-h" data-c="nw" style="left:-5px;top:-5px;cursor:nwse-resize"></div>
<div class="mm-h" data-c="ne" style="right:-5px;top:-5px;cursor:nesw-resize"></div>
<div class="mm-h" data-c="sw" style="left:-5px;bottom:-5px;cursor:nesw-resize"></div>
<div class="mm-h" data-c="se" style="right:-5px;bottom:-5px;cursor:nwse-resize"></div>
<div id="mm-sz"></div>
</div>
<div id="mm-bar"></div>
<script>
(function () {
	"use strict";
	var img = document.getElementById("mm-shot");
	var masks = [document.getElementById("mm-m0"), document.getElementById("mm-m1"), document.getElementById("mm-m2"), document.getElementById("mm-m3")];
	var box = document.getElementById("mm-box");
	var sz = document.getElementById("mm-sz");
	var bar = document.getElementById("mm-bar");
	var ACTIONS = ${actionsJson};
	var MIN = ${MIN_SELECT};
	var sel = null;
	var drag = null; // {ax,ay} 锚点式（新选/缩放）| {sx,sy,orig} 平移式（移动）
	// 结果回传三件套：Promise + resolver + 暂存（桥不 await promise 时插件侧可轮询 __mmResult）
	window.__mmResult = null;
	window.__mmP = new Promise(function (r) { window.__mmDone = r; });
	var finished = false;
	function finish(payload) {
		if (finished) { return; }
		finished = true;
		window.__mmResult = payload;
		try { window.__mmDone(payload); } catch (e) {}
	}
	function W() { return img.clientWidth || img.naturalWidth || 1; }
	function H() { return img.clientHeight || img.naturalHeight || 1; }
	function clamp(v, lo, hi) { return Math.min(Math.max(v, lo), hi); }
	function place(el, x, y, w, h) {
		el.style.left = Math.round(x) + "px"; el.style.top = Math.round(y) + "px";
		el.style.width = Math.round(w) + "px"; el.style.height = Math.round(h) + "px";
	}
	// 锚点式缩放（与插件侧 resizeFromAnchor 同规则：最小尺寸撑开 + 贴边让位）
	function fromAnchor(ax, ay, cx, cy) {
		ax = clamp(ax, 0, W()); ay = clamp(ay, 0, H());
		cx = clamp(cx, 0, W()); cy = clamp(cy, 0, H());
		if (cx >= ax) { if (cx - ax < MIN) { cx = Math.min(ax + MIN, W()); ax = Math.max(0, cx - MIN); } }
		else if (ax - cx < MIN) { cx = Math.max(ax - MIN, 0); ax = Math.min(cx + MIN, W()); }
		if (cy >= ay) { if (cy - ay < MIN) { cy = Math.min(ay + MIN, H()); ay = Math.max(0, cy - MIN); } }
		else if (ay - cy < MIN) { cy = Math.max(ay - MIN, 0); ay = Math.min(cy + MIN, H()); }
		return { x: Math.min(ax, cx), y: Math.min(ay, cy), w: Math.abs(cx - ax), h: Math.abs(cy - ay) };
	}
	function render() {
		if (!sel) {
			place(masks[0], 0, 0, W(), H());
			for (var k = 1; k < 4; k++) { place(masks[k], 0, 0, 0, 0); }
			box.style.display = "none";
			bar.style.display = "none";
			return;
		}
		place(masks[0], 0, 0, W(), sel.y);
		place(masks[1], 0, sel.y + sel.h, W(), H() - sel.y - sel.h);
		place(masks[2], 0, sel.y, sel.x, sel.h);
		place(masks[3], sel.x + sel.w, sel.y, W() - sel.x - sel.w, sel.h);
		box.style.display = "block";
		place(box, sel.x, sel.y, sel.w, sel.h);
		sz.textContent = Math.round(sel.w * img.naturalWidth / W()) + " × " + Math.round(sel.h * img.naturalHeight / H());
		bar.style.display = drag ? "none" : "block";
		if (!drag) {
			var barH = bar.offsetHeight || 36;
			var top = sel.y + sel.h + 8;
			if (top + barH > H()) { top = sel.y - barH - 8; }
			bar.style.left = Math.max(4, Math.min(sel.x, W() - 180)) + "px";
			bar.style.top = Math.max(4, top) + "px";
		}
	}
	function confirmAction(key) {
		if (!sel) { return; }
		finish({ action: key, x: sel.x, y: sel.y, w: sel.w, h: sel.h, dispW: W(), dispH: H() });
	}
	function cancel() { finish(null); }
	document.addEventListener("pointerdown", function (ev) {
		if (ev.button === 2) { ev.preventDefault(); cancel(); return; }
		if (ev.button !== 0 || bar.contains(ev.target)) { return; }
		var corner = ev.target && ev.target.getAttribute ? ev.target.getAttribute("data-c") : null;
		if (corner && sel) {
			// 角柄：对角为锚（拖西柄锚在东缘，拖北柄锚在南缘）
			drag = { ax: (corner === "nw" || corner === "sw") ? sel.x + sel.w : sel.x, ay: (corner === "nw" || corner === "ne") ? sel.y + sel.h : sel.y };
		} else if (sel && ev.clientX >= sel.x && ev.clientX <= sel.x + sel.w && ev.clientY >= sel.y && ev.clientY <= sel.y + sel.h) {
			drag = { sx: ev.clientX, sy: ev.clientY, orig: { x: sel.x, y: sel.y, w: sel.w, h: sel.h } };
		} else {
			drag = { ax: ev.clientX, ay: ev.clientY };
			sel = { x: ev.clientX, y: ev.clientY, w: 0, h: 0 };
		}
		try { document.body.setPointerCapture(ev.pointerId); } catch (e) {}
		ev.preventDefault();
		render();
	});
	document.addEventListener("pointermove", function (ev) {
		if (!drag) { return; }
		if (drag.orig) {
			sel = { x: clamp(drag.orig.x + ev.clientX - drag.sx, 0, W() - drag.orig.w), y: clamp(drag.orig.y + ev.clientY - drag.sy, 0, H() - drag.orig.h), w: drag.orig.w, h: drag.orig.h };
		} else {
			sel = fromAnchor(drag.ax, drag.ay, ev.clientX, ev.clientY);
		}
		render();
	});
	function endDrag(ev) {
		if (!drag) { return; }
		drag = null;
		if (sel && (sel.w < MIN || sel.h < MIN)) { sel = null; } // 微小框视为误触
		render();
	}
	document.addEventListener("pointerup", endDrag);
	document.addEventListener("pointercancel", endDrag);
	document.addEventListener("dblclick", function (ev) {
		if (sel && ACTIONS.length > 0 && !bar.contains(ev.target)) { ev.preventDefault(); confirmAction(ACTIONS[0].key); }
	});
	document.addEventListener("keydown", function (ev) {
		if (ev.key === "Escape") { ev.preventDefault(); cancel(); }
		else if (ev.key === "Enter" && sel && ACTIONS.length > 0) { ev.preventDefault(); confirmAction(ACTIONS[0].key); }
	});
	document.addEventListener("contextmenu", function (ev) { ev.preventDefault(); });
	(ACTIONS || []).forEach(function (a) {
		var b = document.createElement("button");
		b.type = "button";
		b.textContent = a.label;
		if (a.primary) { b.className = "mm-primary"; }
		b.addEventListener("click", function (ev) { ev.stopPropagation(); confirmAction(a.key); });
		bar.appendChild(b);
	});
	render();
})();
</script>
</body>
</html>`;
}

/**
 * 页面回传值 → 规整结果（纯函数）：形状校验（action 合法 / 七个数值 /
 * screenIndex 在界）+ 选区钳制到显示范围内；微小或退化选区返回 null
 * （取消语义——比错误数据更安全）。dispW/dispH 为页面实测值，非整数四舍五入。
 */
export function parseOverlayResult(
	value: unknown,
	screens: readonly CapturedScreen[],
): ScreenSelectResult | null {
	if (value === null || value === undefined || typeof value !== "object") {
		return null;
	}
	const v = value as Record<string, unknown>;
	if (v.action !== "copy" && v.action !== "note") {
		return null;
	}
	const nums = [v.x, v.y, v.w, v.h, v.dispW, v.dispH, v.screenIndex];
	if (nums.some((n) => typeof n !== "number" || !Number.isFinite(n))) {
		return null;
	}
	const screenIndex = Math.trunc(v.screenIndex as number);
	if (screenIndex < 0 || screenIndex >= screens.length) {
		return null;
	}
	const dispW = Math.round(v.dispW as number);
	const dispH = Math.round(v.dispH as number);
	if (dispW <= 0 || dispH <= 0) {
		return null;
	}
	const clampNum = (n: number, lo: number, hi: number) => Math.min(Math.max(n, lo), hi);
	const x = clampNum(Math.round(v.x as number), 0, Math.max(0, dispW - 1));
	const y = clampNum(Math.round(v.y as number), 0, Math.max(0, dispH - 1));
	const w = clampNum(Math.round(v.w as number), 1, Math.max(1, dispW - x));
	const h = clampNum(Math.round(v.h as number), 1, Math.max(1, dispH - y));
	if (w < MIN_SELECT || h < MIN_SELECT) {
		return null; // 微小/退化选区（越界钳缩所致）视为无效 → 取消
	}
	return { screenIndex, action: v.action, sel: { x, y, w, h }, dispW, dispH };
}

/** 临时会话文件路径集（纯函数）：目录 + 逐屏 PNG/HTML 文件名生成器 */
export function tempCapturePaths(
	tmpdir: string,
	sessionId: string,
): {
	dir: string;
	png: (index: number) => string;
	html: (index: number) => string;
} {
	const pathMod = loadModule<typeof import("path")>("path");
	const dir = pathMod.join(tmpdir, `marinmind-capture-${sessionId}`);
	return {
		dir,
		png: (index: number) => pathMod.join(dir, `screen-${index}.png`),
		html: (index: number) => pathMod.join(dir, `select-${index}.html`),
	};
}

/** 进行中的覆盖窗会话（重入守卫 + onunload 强制清理） */
interface ActiveSession {
	windows: OverlayWindowLike[];
	dir: string | null;
}

/** 模块级唯一会话（会话串行：热键连按先销毁旧会话再开新的） */
let activeSession: ActiveSession | null = null;

/**
 * 销毁当前覆盖窗会话（幂等）：尽力 destroy 全部窗 + 清临时目录。
 * onunload 与 selectScreenRegion 的 finally / 重入守卫三处调用。
 */
export function destroyActiveOverlaySession(): void {
	const session = activeSession;
	activeSession = null;
	if (!session) {
		return;
	}
	for (const win of session.windows) {
		try {
			win.destroy?.();
		} catch (err) {
			console.warn("[MarinMind] 覆盖窗销毁失败", err);
		}
	}
	if (session.dir) {
		try {
			const fsMod = loadModule<typeof import("fs")>("fs");
			fsMod.rmSync(session.dir, { recursive: true, force: true });
		} catch (err) {
			console.warn("[MarinMind] 临时目录清理失败", session.dir, err);
		}
	}
}

/**
 * 单窗收束 Promise（四路看门狗）：executeJavaScript 主路（页面 __mmP）+
 * closed 事件（关窗即取消）+ minimize 事件（Win+D 视为取消）+ isDestroyed
 * 2s 轮询（事件缺失的环境兜底；轮询在收束后自清）。payload 合并真实
 * screenIndex（页面不知道自己在第几屏，由插件侧注入）。
 */
function windowOutcome(
	win: OverlayWindowLike,
	screenIndex: number,
): Promise<ScreenSelectResult | null> {
	return new Promise((resolve) => {
		let settled = false;
		let poll: ReturnType<typeof setInterval> | null = null;
		const finish = (payload: unknown) => {
			if (settled) {
				return;
			}
			settled = true;
			if (poll !== null) {
				clearInterval(poll);
			}
			resolve(
				payload === null || payload === undefined
					? null
					: ({ ...(payload as object), screenIndex } as ScreenSelectResult),
			);
		};
		try {
			win.on?.("closed", () => finish(null));
			win.on?.("minimize", () => finish(null));
		} catch (err) {
			console.warn("[MarinMind] 覆盖窗事件挂载失败", err);
		}
		try {
			const pending = win.webContents.executeJavaScript?.("window.__mmP", false);
			void Promise.resolve(pending).then(finish, () => finish(null));
		} catch {
			finish(null);
		}
		poll = setInterval(() => {
			try {
				if (win.isDestroyed?.()) {
					finish(null);
				}
			} catch {
				finish(null);
			}
		}, 2000);
	});
}

/** 页面脚本探活：loadURL 后轮询 __mmP 是否挂载（3×500ms；false = 该窗不可用） */
async function probeOverlayReady(win: OverlayWindowLike): Promise<boolean> {
	for (let attempt = 0; attempt < 3; attempt++) {
		try {
			const state = await maybeAwait(
				win.webContents.executeJavaScript?.("typeof window.__mmP", false),
			);
			if (state === "object") {
				return true;
			}
		} catch {
			// 页面未就绪或桥未通——继续等
		}
		await new Promise((resolve) => setTimeout(resolve, 500));
	}
	return false;
}

/** selectScreenRegion 入参 */
export interface SelectScreenRegionOpts {
	/** 松手工具条呈现的动作（顺序 = Enter/双击默认动作）；空数组视为调用方错误 */
	actions: OverlayAction[];
}

/**
 * 覆盖窗直选主入口：写临时文件 → 逐屏建窗装载 → 探活 → 全部就绪后统一
 * show（避免逐窗白闪）→ 多窗 race（任意一窗确认/取消即收场）→ 销毁全部窗
 * + 清临时目录。返回 {ok:true,result}（null=取消）或 {ok:false}（环境
 * 不可用，调用方降级 114 弹窗）。无 bounds 的屏（getDisplayMedia 兜底
 * 路径）无法定位覆盖窗，直接整体降级。
 */
export async function selectScreenRegion(
	screens: readonly CapturedScreen[],
	opts: SelectScreenRegionOpts,
): Promise<OverlayOutcome> {
	if (opts.actions.length === 0) {
		return { ok: false, reason: "D1 动作列表为空" };
	}
	// 任一屏缺 bounds（如 getDisplayMedia 兜底）即整体降级——有屏盖不住
	// 冻结画面幻象就破（露出活画面），宁可用弹窗
	const positioned = screens
		.map((screen, index) => ({ screen, index }))
		.filter(
			({ screen }) => screen.bounds && screen.bounds.width > 0 && screen.bounds.height > 0,
		);
	if (positioned.length === 0 || positioned.length !== screens.length) {
		// 诊断详情：各屏 id/label/bounds 全量打印（id 空串 + label 非 "Screen N"
		// 形态 = 抓屏走了 getDisplayMedia 兜底链，bounds 无从谈起；id 正常但
		// bounds null = display_bounds 经桥丢失且 getAllDisplays 配对失败）
		console.warn(
			"[MarinMind] D2 屏幕缺少定位信息：共",
			screens.length,
			"屏，有 bounds 的",
			positioned.length,
			"屏；各屏 =",
			JSON.stringify(
				screens.map((s) => ({ id: s.id, label: s.label, bounds: s.bounds ?? null })),
			),
		);
		return { ok: false, reason: "D2 屏幕缺少定位信息（详情见控制台）" };
	}
	const BrowserWindow = resolveBrowserWindowCtor();
	if (!BrowserWindow) {
		console.warn("[MarinMind] D3 BrowserWindow 不可用，覆盖窗直选降级弹窗");
		return { ok: false, reason: "D3 BrowserWindow 不可用" };
	}
	let fsMod: typeof import("fs");
	let osMod: typeof import("os");
	let urlMod: typeof import("url");
	let pathMod: typeof import("path");
	try {
		fsMod = loadModule<typeof import("fs")>("fs");
		osMod = loadModule<typeof import("os")>("os");
		urlMod = loadModule<typeof import("url")>("url");
		pathMod = loadModule<typeof import("path")>("path");
	} catch (err) {
		console.warn("[MarinMind] D4 node 模块不可用，覆盖窗直选降级弹窗", err);
		return {
			ok: false,
			reason: `D4 node 模块不可用（${err instanceof Error ? err.message : String(err)}）`,
		};
	}

	// 重入守卫：先销毁旧会话（全局热键连按）
	destroyActiveOverlaySession();
	const sessionId = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
	const paths = tempCapturePaths(osMod.tmpdir(), sessionId);
	// 崩溃残留自愈：会话串行，tmpdir 下遗留的 marinmind-capture-* 全是残骸
	try {
		for (const name of fsMod.readdirSync(osMod.tmpdir())) {
			if (name.startsWith("marinmind-capture-")) {
				fsMod.rmSync(pathMod.join(osMod.tmpdir(), name), { recursive: true, force: true });
			}
		}
	} catch (err) {
		console.warn("[MarinMind] 旧临时目录清理失败", err);
	}

	const session: ActiveSession = { windows: [], dir: paths.dir };
	activeSession = session;
	// 122：Windows 任务栏为 topmost 层，普通置顶窗盖不住它（冻结画面底部被挡，
	// 截图恒缺任务栏区域）——Windows 上改用无边框全屏（Snipaste 同款）压过
	// 任务栏；macOS/Linux 保持普通置顶（全屏有空格切换动画副作用）
	const fullscreenOverlay =
		typeof navigator !== "undefined" && /win/i.test(navigator.platform ?? "");
	try {
		fsMod.mkdirSync(paths.dir, { recursive: true });
		for (const { screen, index } of positioned) {
			const bytes = dataUrlToBytes(screen.dataUrl);
			if (!bytes) {
				throw new Error("冻结画面 PNG 解码失败");
			}
			fsMod.writeFileSync(paths.png(index), bytes);
			fsMod.writeFileSync(
				paths.html(index),
				buildOverlayHtml({ pngSrc: `screen-${index}.png`, actions: opts.actions }),
				"utf8",
			);
			const win = new BrowserWindow(
				buildOverlayWindowOptions(screen.bounds!, { fullscreen: fullscreenOverlay }),
			);
			session.windows.push(win);
			// 临时文件 file URL（pathToFileURL 应对中文用户名路径）
			await maybeAwait(
				win.webContents.loadURL?.(urlMod.pathToFileURL(paths.html(index)).href) ??
					undefined,
			);
			if (!(await probeOverlayReady(win))) {
				throw new Error("覆盖窗页面装载超时");
			}
		}
		// 全部就绪后统一显示（先装后显防白闪；screen-saver 层级压过其他应用）
		for (const win of session.windows) {
			try {
				win.show?.();
				win.focus?.();
				win.setAlwaysOnTop?.(true, "screen-saver");
			} catch (err) {
				console.warn("[MarinMind] 覆盖窗显示失败", err);
			}
		}
		const outcomes = session.windows.map((win, i) => windowOutcome(win, positioned[i]!.index));
		const hardCap = new Promise<null>((resolve) => setTimeout(resolve, OVERLAY_HARD_CAP_MS));
		const first = await Promise.race([...outcomes, hardCap]);
		// 122 裁剪偏差诊断：请求 bounds vs 页面实测显示尺寸——两者应一致
		// （不一致 = 窗口被系统 clamp 或 DPI 异常，控制台一眼定位）
		if (first) {
			const idx = positioned.findIndex((p) => p.index === first.screenIndex);
			const b = idx >= 0 ? positioned[idx]!.screen.bounds : null;
			console.log(
				"[MarinMind] 直选诊断",
				JSON.stringify({
					fullscreen: fullscreenOverlay,
					bounds: b,
					disp: { w: first.dispW, h: first.dispH },
					sel: first.sel,
					bitmap:
						idx >= 0
							? {
									w: positioned[idx]!.screen.width,
									h: positioned[idx]!.screen.height,
								}
							: null,
				}),
			);
		}
		return { ok: true, result: parseOverlayResult(first, screens) };
	} catch (err) {
		console.warn("[MarinMind] D5 覆盖窗装载失败，降级弹窗", err);
		return {
			ok: false,
			reason: `D5 覆盖窗装载失败（${err instanceof Error ? err.message : String(err)}）`,
		};
	} finally {
		destroyActiveOverlaySession();
	}
}
