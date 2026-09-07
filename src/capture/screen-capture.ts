/**
 * 屏幕截图守卫层（114，obsidian 零依赖）：全屏位图抓取 + PNG 写系统剪贴板；
 * 117 追加外截（隐藏本窗口拍摄）与全局热键（validateAccelerator 纯函数 +
 * register/unregister 守卫封装）。
 * 加载铁律同 external-file.ts：window / require 只能在函数体内 typeof 守卫下
 * 访问——顶层引用会在移动端/测试环境崩溃（本模块顶层只声明类型与纯函数）。
 *
 * 抓取四级守卫链（Electron remote 暴露面随 Obsidian 版本有差异，任何一环
 * 缺口静默降级，全失败返回 [] 由命令层转 Notice）：
 * ① window.electron.remote.desktopCapturer.getSources（直取，无系统弹窗）；
 * ② remote.require("electron").desktopCapturer（remote 版本差异兜底，同无弹窗）；
 * ③ navigator.mediaDevices.getDisplayMedia → video 单帧 drawImage（纯 Web
 *    兜底，弹系统选择器；用户取消视为无结果）；
 * ④ 以上全空 → 返回 []。
 * macOS 无屏幕录制权限时 ①② 会拿到整排空缩略图——以专用中文错误抛出（不
 * 混入「不支持」文案），命令层 Notice 引导去系统设置授权。
 */

/** 显示器矩形（Electron bounds 形状，DIP 逻辑像素） */
export interface ElectronRect {
	x: number;
	y: number;
	width: number;
	height: number;
}

/** Electron DesktopCapturerSource 形状（仅取本模块关心的字段） */
interface RemoteSource {
	id?: string;
	name?: string;
	/** 对应显示器 id（与 screen.getPrimaryDisplay().id 对齐判主屏） */
	display_id?: string;
	/** 该 source 所在显示器逻辑尺寸（thumbnailSize 估算兜底用） */
	display_bounds?: ElectronRect;
	thumbnail?: {
		toDataURL?: () => string;
		isEmpty?: () => boolean;
		getSize?: () => { width: number; height: number };
	};
}

/** Electron Display 形状（守卫式窄化；bounds 为 DIP 逻辑像素，与 BrowserWindow 入参同单位） */
export interface DisplayLike {
	id?: number;
	bounds?: ElectronRect;
}

/** 矩形形状校验：四有限数值 + 正宽高（0×0/缺字段/经桥序列化丢值均判非法） */
function validRect(value: unknown): ElectronRect | undefined {
	if (typeof value !== "object" || value === null) {
		return undefined;
	}
	const r = value as Record<string, unknown>;
	const { x, y, width, height } = r;
	if (
		![x, y, width, height].every((n) => typeof n === "number" && Number.isFinite(n)) ||
		(width as number) <= 0 ||
		(height as number) <= 0
	) {
		return undefined;
	}
	return { x: x as number, y: y as number, width: width as number, height: height as number };
}

/**
 * 屏幕定位信息解析（纯函数，118 D2 修复）：source.display_bounds 经
 * @electron/remote 桥序列化可能丢失或为 0×0，screen.getAllDisplays 是完全
 * 独立的显示器枚举来源。解析顺序：① display_bounds 形状合法直接用 →
 * ② source.display_id 与 display.id 字符串匹配 → ③ 同下标兜底（单屏必然
 * 正确，多屏两 API 顺序通常一致）。全部失败返回 undefined（调用方降级弹窗）。
 */
export function resolveScreenBounds(
	sourceBounds: unknown,
	sourceDisplayId: unknown,
	displays: readonly DisplayLike[],
	index: number,
): ElectronRect | undefined {
	const fromSource = validRect(sourceBounds);
	if (fromSource) {
		return fromSource;
	}
	const list = Array.isArray(displays) ? displays : [];
	const rawId = sourceDisplayId;
	const idStr =
		typeof rawId === "string" ? rawId : typeof rawId === "number" ? String(rawId) : "";
	if (idStr) {
		const byId = validRect(list.find((d) => String(d.id) === idStr)?.bounds);
		if (byId) {
			return byId;
		}
	}
	return validRect(list[index]?.bounds);
}

/** desktopCapturer 形状 */
interface CapturerLike {
	getSources?: (opts: Record<string, unknown>) => Promise<RemoteSource[]>;
}

/** @electron/remote 形状（守卫式窄化，全部字段可选） */
interface RemoteLike {
	desktopCapturer?: CapturerLike;
	screen?: {
		getPrimaryDisplay?: () => { id: number; bounds?: ElectronRect };
		getDisplayMatching?: (rect: ElectronRect) => { bounds: ElectronRect; scaleFactor: number };
		/** 全部显示器枚举（118 D2 修复：display_bounds 丢失时的独立定位来源） */
		getAllDisplays?: () => DisplayLike[];
	};
	clipboard?: { writeImage?: (image: unknown) => void };
	globalShortcut?: {
		register?: (accelerator: string, handler: () => void) => void;
		isRegistered?: (accelerator: string) => boolean;
		unregister?: (accelerator: string) => void;
	};
	require?: (module: string) => unknown;
	getCurrentWindow?: () => ElectronWindowLike;
}

/** 当前窗口形状（守卫式窄化；117 外截用 minimize/restore/focus/show） */
interface ElectronWindowLike {
	getBounds?: () => ElectronRect;
	minimize?: () => void;
	restore?: () => void;
	focus?: () => void;
	show?: () => void;
}

/** 单屏截图产物（dataURL 形态——裁剪弹窗直接展示，不落盘） */
export interface CapturedScreen {
	/** 显示器标识（display_id；getDisplayMedia 兜底路径无稳定 id 留空） */
	id: string;
	/** 显示器名（Electron source.name，如 "Screen 1" / "整个屏幕"） */
	label: string;
	/** 全屏位图 PNG dataURL */
	dataUrl: string;
	/** 位图物理像素尺寸（裁剪弹窗尺寸标签与换算基准） */
	width: number;
	height: number;
	/** 是否主显示器（多屏时裁剪弹窗的默认屏） */
	primary: boolean;
	/** 该显示器工作区矩形（DIP；118 覆盖窗逐屏定位用。getDisplayMedia 兜底路径无此值） */
	bounds?: ElectronRect;
}

/** 选区矩形（裁剪弹窗 frame 的显示坐标，px） */
export interface SelRect {
	x: number;
	y: number;
	w: number;
	h: number;
}

/** 最小选区边长（px）：小于此视为误触，松手后清空选区 */
export const MIN_SELECT = 8;

/** 缩略图物理像素单边上限（4K 原生档 clamp：118 直选覆盖窗 1:1 铺满需 4K 保真） */
export const THUMB_CAP = 3840;

/** 取 electron remote（window 访问只能出现在函数体内——移动端无此对象） */
function electronRemote(): RemoteLike | null {
	const electron = (window as unknown as { electron?: { remote?: RemoteLike } }).electron;
	return electron?.remote ?? null;
}

/** 数值钳制 */
const clamp = (v: number, lo: number, hi: number): number => Math.min(Math.max(v, lo), hi);

/**
 * 显示逻辑尺寸 → 缩略图物理像素尺寸（factor 缩放 + cap 保比 clamp）。
 * 纯函数（测试锁定）：factor≤0 或退化输入至少回 1×1，绝不放大超过 cap。
 */
export function physicalThumbSize(
	w: number,
	h: number,
	factor: number,
	cap: number,
): { width: number; height: number } {
	const px = Math.max(1, Math.round(Math.max(0, w) * Math.max(0, factor)));
	const py = Math.max(1, Math.round(Math.max(0, h) * Math.max(0, factor)));
	const scale = Math.min(1, cap / px, cap / py);
	return {
		width: Math.max(1, Math.round(px * scale)),
		height: Math.max(1, Math.round(py * scale)),
	};
}

/** contain 适配（保比缩放至盒内，不放大；纯函数） */
export function fitSize(
	w: number,
	h: number,
	maxW: number,
	maxH: number,
): { width: number; height: number } {
	const scale = Math.min(1, w > 0 ? maxW / w : 1, h > 0 ? maxH / h : 1);
	return {
		width: Math.max(1, Math.round(w * scale)),
		height: Math.max(1, Math.round(h * scale)),
	};
}

/** 多屏默认展示屏：主显示器优先，否则首屏（纯函数，测试锁定） */
export function pickActiveScreen(screens: readonly CapturedScreen[]): number {
	const idx = screens.findIndex((s) => s.primary);
	return idx >= 0 ? idx : 0;
}

/** 锚点拖拽选区：拖动点钳制到 [0,max] 后与锚点归一出矩形，宽高不足 min 时向拖动侧撑开（锚点侧必要时让位） */
export function resizeFromAnchor(
	anchorX: number,
	anchorY: number,
	px: number,
	py: number,
	maxW: number,
	maxH: number,
	min: number,
): SelRect {
	let ax = clamp(anchorX, 0, Math.max(0, maxW));
	let ay = clamp(anchorY, 0, Math.max(0, maxH));
	let cx = clamp(px, 0, Math.max(0, maxW));
	let cy = clamp(py, 0, Math.max(0, maxH));
	// x 轴最小尺寸（y 同理）：拖动点在锚点右侧则撑右缘，反之撑左缘；
	// 撑到边界仍不足时移动锚点侧补足（贴边拖小框的让位行为）
	if (cx >= ax) {
		if (cx - ax < min) {
			cx = Math.min(ax + min, maxW);
			ax = Math.max(0, cx - min);
		}
	} else if (ax - cx < min) {
		cx = Math.max(ax - min, 0);
		ax = Math.min(cx + min, maxW);
	}
	if (cy >= ay) {
		if (cy - ay < min) {
			cy = Math.min(ay + min, maxH);
			ay = Math.max(0, cy - min);
		}
	} else if (ay - cy < min) {
		cy = Math.max(ay - min, 0);
		ay = Math.min(cy + min, maxH);
	}
	return { x: Math.min(ax, cx), y: Math.min(ay, cy), w: Math.abs(cx - ax), h: Math.abs(cy - ay) };
}

/** 选区整体平移（钳制在框内：任意方向都拖不出画面；纯函数） */
export function moveSelRect(
	sel: SelRect,
	dx: number,
	dy: number,
	maxW: number,
	maxH: number,
): SelRect {
	const x = clamp(sel.x + dx, 0, Math.max(0, maxW - sel.w));
	const y = clamp(sel.y + dy, 0, Math.max(0, maxH - sel.h));
	return { x, y, w: sel.w, h: sel.h };
}

/**
 * 显示坐标选区 → 图源物理像素裁剪矩形。按实测显示比例
 * （naturalWidth / clientWidth）换算而非推算 devicePixelRatio——显示器
 * 缩放与图片缩放链路无关，实测即真理。round 可能溢出 1px，右/下界内收。
 */
export function physicalCropRect(
	sel: SelRect,
	dispW: number,
	dispH: number,
	naturalW: number,
	naturalH: number,
): { sx: number; sy: number; sw: number; sh: number } {
	const kx = dispW > 0 ? naturalW / dispW : 1;
	const ky = dispH > 0 ? naturalH / dispH : 1;
	const sw = Math.min(naturalW, Math.max(1, Math.round(sel.w * kx)));
	const sh = Math.min(naturalH, Math.max(1, Math.round(sel.h * ky)));
	const sx = clamp(Math.round(sel.x * kx), 0, Math.max(0, naturalW - sw));
	const sy = clamp(Math.round(sel.y * ky), 0, Math.max(0, naturalH - sh));
	return { sx, sy, sw, sh };
}

/** macOS 无屏幕录制权限的专用错误（文案引导授权，与「环境不支持」区分） */
class ScreenPermissionError extends Error {}

/**
 * 取 desktopCapturer：链 ① remote.desktopCapturer 直取；缺口走链 ②
 * remote.require("electron").desktopCapturer。都不可用返回 null。
 */
async function resolveCapturer(remote: RemoteLike): Promise<CapturerLike | null> {
	if (remote.desktopCapturer?.getSources) {
		return remote.desktopCapturer;
	}
	if (typeof remote.require === "function") {
		try {
			const electron = remote.require("electron") as
				{ desktopCapturer?: CapturerLike } | undefined;
			if (electron?.desktopCapturer?.getSources) {
				return electron.desktopCapturer;
			}
		} catch (err) {
			console.warn("[MarinMind] remote.require('electron') 不可用", err);
		}
	}
	return null;
}

/**
 * 缩略图尺寸三档估算：① 窗口所在显示器 bounds×scaleFactor（物理像素 1:1，
 * 最准）→ ② 枚举一遍取 source.display_bounds×devicePixelRatio → ③ 2560×1600
 * 兜底（Electron 对超尺寸自动保比缩到各屏，16:10 内常见比例全覆盖）。
 */
async function bestThumbSize(
	remote: RemoteLike,
	capturer: CapturerLike,
): Promise<{ width: number; height: number }> {
	try {
		const bounds = remote.getCurrentWindow?.()?.getBounds?.();
		const display = bounds ? remote.screen?.getDisplayMatching?.(bounds) : undefined;
		if (display?.bounds && display.scaleFactor > 0) {
			return physicalThumbSize(
				display.bounds.width,
				display.bounds.height,
				display.scaleFactor,
				THUMB_CAP,
			);
		}
	} catch (err) {
		console.warn("[MarinMind] getDisplayMatching 不可用", err);
	}
	try {
		const probe = await capturer.getSources?.({ types: ["screen"] });
		const b = probe?.[0]?.display_bounds;
		const dpr = typeof window === "undefined" ? 1 : window.devicePixelRatio;
		if (b && dpr > 0) {
			return physicalThumbSize(b.width, b.height, dpr, THUMB_CAP);
		}
	} catch (err) {
		console.warn("[MarinMind] display_bounds 探测失败", err);
	}
	return { width: THUMB_CAP, height: 1600 };
}

/** 链 ①②：desktopCapturer 取全部显示器位图（无系统弹窗，多屏一次全得） */
async function captureViaElectron(remote: RemoteLike): Promise<CapturedScreen[]> {
	const capturer = await resolveCapturer(remote);
	if (!capturer?.getSources) {
		return [];
	}
	const thumbnailSize = await bestThumbSize(remote, capturer);
	const sources = await capturer.getSources({ types: ["screen"], thumbnailSize });

	let primaryId = "";
	try {
		primaryId = String(remote.screen?.getPrimaryDisplay?.()?.id ?? "");
	} catch {
		// 主屏判定缺省：首屏即主屏（下方回退）
	}
	// 显示器枚举（独立定位来源）：display_bounds 经桥序列化丢失时按
	// display_id 配对 / 同下标兜底（resolveScreenBounds 纯函数，测试锁定）
	let displays: DisplayLike[] = [];
	try {
		displays = remote.screen?.getAllDisplays?.() ?? [];
	} catch (err) {
		console.warn("[MarinMind] getAllDisplays 不可用（display_bounds 配对兜底失效）", err);
	}

	const screens: CapturedScreen[] = [];
	for (const source of sources) {
		const thumb = source.thumbnail;
		if (!thumb?.toDataURL || typeof thumb.isEmpty !== "function" || thumb.isEmpty()) {
			continue; // 空缩略图 = 该屏画面未取得（macOS 无权限的整排黑图在此过滤）
		}
		const size = typeof thumb.getSize === "function" ? thumb.getSize() : undefined;
		if (!size || size.width <= 0 || size.height <= 0) {
			continue;
		}
		screens.push({
			id: source.display_id ?? source.id ?? "",
			label: source.name || "屏幕",
			dataUrl: thumb.toDataURL(),
			width: size.width,
			height: size.height,
			primary: primaryId !== "" ? source.display_id === primaryId : screens.length === 0,
			bounds: resolveScreenBounds(
				source.display_bounds,
				source.display_id,
				displays,
				screens.length,
			),
		});
	}
	// 有 source 却全军覆没：不是「不支持」而是「没权限」——专用文案引导授权
	if (screens.length === 0 && sources.length > 0) {
		throw new ScreenPermissionError(
			"未能取得屏幕画面：请在系统设置中允许 Obsidian 屏幕录制（macOS：设置 → 隐私与安全性 → 屏幕录制）后重试",
		);
	}
	return screens;
}

/** 链 ③：getDisplayMedia 系统选择器 → video 单帧入画布（取消/失败返回 null） */
async function captureViaGetDisplayMedia(): Promise<CapturedScreen | null> {
	const media = typeof navigator === "undefined" ? undefined : navigator.mediaDevices;
	if (!media?.getDisplayMedia) {
		return null;
	}
	let stream: MediaStream;
	try {
		stream = await media.getDisplayMedia({ video: true, audio: false });
	} catch {
		return null; // 用户取消（NotAllowedError）或环境拒绝
	}
	try {
		const video = document.createElement("video");
		video.muted = true;
		video.playsInline = true;
		video.srcObject = stream;
		await video.play();
		// 等首帧就绪（videoWidth 从 0 变正；至多 ~2.5s，超时判失败）
		for (let i = 0; i < 50 && video.videoWidth === 0; i++) {
			await new Promise((resolve) => setTimeout(resolve, 50));
		}
		if (video.videoWidth <= 0 || video.videoHeight <= 0) {
			return null;
		}
		const canvas = document.createElement("canvas");
		canvas.width = video.videoWidth;
		canvas.height = video.videoHeight;
		const ctx = canvas.getContext("2d");
		if (!ctx) {
			return null;
		}
		ctx.drawImage(video, 0, 0);
		return {
			id: "",
			label: stream.getVideoTracks()[0]?.label || "屏幕",
			dataUrl: canvas.toDataURL("image/png"),
			width: video.videoWidth,
			height: video.videoHeight,
			primary: true,
		};
	} catch (err) {
		console.warn("[MarinMind] getDisplayMedia 取帧失败", err);
		return null;
	} finally {
		stream.getTracks().forEach((track) => track.stop());
	}
}

/**
 * 抓取全部显示器全屏位图（命令层入口）。macOS 无权限抛专用错误（Notice 引导
 * 授权）；环境不支持或用户取消返回 []。
 */
export async function captureAllScreens(): Promise<CapturedScreen[]> {
	const remote = electronRemote();
	if (remote) {
		try {
			const screens = await captureViaElectron(remote);
			if (screens.length > 0) {
				return screens;
			}
		} catch (err) {
			if (err instanceof ScreenPermissionError) {
				throw err;
			}
			console.warn("[MarinMind] desktopCapturer 截屏失败，降级 getDisplayMedia", err);
		}
	}
	const viaWeb = await captureViaGetDisplayMedia();
	if (!viaWeb) {
		return [];
	}
	// 兜底链补定位：getDisplayMedia 结果无 bounds，按主屏工作区假设填（Obsidian
	// 自动 handler 下多选主屏；配错最多覆盖窗画面错位，Esc 可退，比直接降级强）
	if (!viaWeb.bounds && remote) {
		try {
			const display = remote.screen?.getPrimaryDisplay?.();
			const rect = validRect(display?.bounds);
			if (rect) {
				viaWeb.bounds = rect;
			}
		} catch (err) {
			console.warn("[MarinMind] 主屏定位获取失败（兜底链无 bounds，直选降级）", err);
		}
	}
	return [viaWeb];
}

/**
 * PNG 写系统剪贴板（双通道，任一成功即 true）：
 * ① navigator.clipboard.write（W3C 异步剪贴板，Electron/Chrome 桌面支持
 *    image/png 的 ClipboardItem）；
 * ② electron remote.clipboard.writeImage（NativeImage.createFromDataURL，
 *    ① 缺失/失败时的系统级兜底）。
 * 两路都不可用返回 false（调用方 Notice）。
 */
export async function writePngToClipboard(blob: Blob, dataUrl: string): Promise<boolean> {
	// 主路：W3C 异步剪贴板
	try {
		const clipboard = typeof navigator === "undefined" ? undefined : navigator.clipboard;
		if (clipboard?.write && typeof ClipboardItem !== "undefined") {
			await clipboard.write([new ClipboardItem({ "image/png": blob })]);
			return true;
		}
	} catch (err) {
		console.warn("[MarinMind] 剪贴板写入失败（异步通道）", err);
	}
	// 兜底：electron remote clipboard.writeImage
	try {
		const remote = electronRemote();
		const writeImage = remote?.clipboard?.writeImage;
		if (typeof remote?.require === "function" && typeof writeImage === "function") {
			const electron = remote.require("electron") as {
				nativeImage?: { createFromDataURL?: (url: string) => unknown };
			};
			const createFromDataURL = electron?.nativeImage?.createFromDataURL;
			if (typeof createFromDataURL === "function") {
				writeImage.call(
					remote?.clipboard,
					createFromDataURL.call(electron?.nativeImage, dataUrl),
				);
				return true;
			}
		}
	} catch (err) {
		console.warn("[MarinMind] 剪贴板写入失败（electron 通道）", err);
	}
	return false;
}

// ===== 117：截图外截（隐藏窗口拍摄）+ 全局热键 =====

/** 隐藏窗口后的等待（ms）：Windows 最小化动画余量——立即拍会带上收起中的画面 */
const HIDE_DELAY_MS = 500;

/**
 * 隐藏本窗口后拍摄（117）：minimize → 等 500ms（动画余量）→ captureAllScreens →
 * restore+focus（finally 保证：无权限抛错也回弹）。裁剪弹窗展示的是隐藏期
 * 冻结画面，其他应用完整可见。无 remote（理论不可达，命令已限桌面）直接抓。
 * 118：可选 beforeRestore 钩子——拍摄完成后、恢复窗口前调用（覆盖窗直选用
 * 它先建全屏覆盖窗再 restore，恢复动作藏在冻结画面底下，无活画面闪现）。
 */
export async function captureOutside(opts?: {
	beforeRestore?: (screens: CapturedScreen[]) => Promise<void> | void;
}): Promise<CapturedScreen[]> {
	const win = electronRemote()?.getCurrentWindow?.();
	if (!win) {
		return captureAllScreens();
	}
	try {
		win.minimize?.();
	} catch (err) {
		console.warn("[MarinMind] 最小化窗口失败（直接拍摄）", err);
	}
	await new Promise((resolve) => setTimeout(resolve, HIDE_DELAY_MS));
	try {
		const screens = await captureAllScreens();
		if (opts?.beforeRestore) {
			await opts.beforeRestore(screens);
		}
		return screens;
	} finally {
		try {
			win.restore?.();
			win.focus?.();
		} catch (err) {
			console.warn("[MarinMind] 恢复窗口失败", err);
		}
	}
}

/** Electron accelerator 修饰键（官方词形，大写归一比对；Meta 非法——用 Super） */
const ACCELERATOR_MODIFIERS = new Set([
	"COMMAND",
	"CMD",
	"CONTROL",
	"CTRL",
	"COMMANDORCONTROL",
	"CMDORCTRL",
	"ALT",
	"OPTION",
	"ALTGR",
	"SHIFT",
	"SUPER",
]);

/** Electron accelerator 单键（字母/数字/F1-F24/方向/编辑键/常用标点与 Plus） */
const ACCELERATOR_KEYS = new Set<string>([
	...Array.from({ length: 26 }, (_, i) => String.fromCharCode(65 + i)), // A-Z
	...Array.from({ length: 10 }, (_, i) => String(i)), // 0-9
	...Array.from({ length: 24 }, (_, i) => `F${i + 1}`), // F1-F24
	"UP",
	"DOWN",
	"LEFT",
	"RIGHT",
	"SPACE",
	"TAB",
	"ESCAPE",
	"ESC",
	"DELETE",
	"INSERT",
	"BACKSPACE",
	"HOME",
	"END",
	"PAGEUP",
	"PAGEDOWN",
	"RETURN",
	"ENTER",
	"PLUS",
	",",
	".",
	"/",
	"-",
	"=",
	";",
	"'",
	"[",
	"]",
	"\\",
	"`",
]);

/**
 * Electron 热键格式校验（117，纯函数）：「修饰键+…+单键」，**至少一个修饰键**
 * （全局裸键会劫持所有应用的输入）。词形大小写不敏感；空段（尾随 + / Ctrl++）
 * 与重复修饰键判非法；中文等非键名判非法。
 */
export function validateAccelerator(accelerator: string): boolean {
	const parts = accelerator
		.trim()
		.split("+")
		.map((p) => p.trim().toUpperCase());
	if (parts.length < 2) {
		return false; // 无修饰键（空串/单键）
	}
	if (parts.some((p) => p === "")) {
		return false; // 空段（Ctrl+ / Ctrl++ / +A）
	}
	const key = parts[parts.length - 1]!;
	const mods = parts.slice(0, -1);
	if (!ACCELERATOR_KEYS.has(key)) {
		return false;
	}
	if (!mods.every((m) => ACCELERATOR_MODIFIERS.has(m))) {
		return false;
	}
	return new Set(mods).size === mods.length;
}

/**
 * 注册全局热键（守卫链同 desktopCapturer）：remote.globalShortcut.register →
 * isRegistered 核验（register 对冲突键可能静默不生效）→ 失败返回 false 由
 * 调用方 Notice。环境不可用同样 false（不抛错——移动端/旧版无此 API）。
 */
export function registerGlobalHotkey(accelerator: string, handler: () => void): boolean {
	const gs = electronRemote()?.globalShortcut;
	if (!gs?.register) {
		console.warn("[MarinMind] globalShortcut 不可用，热键未注册");
		return false;
	}
	try {
		gs.register(accelerator, handler);
		if (typeof gs.isRegistered === "function" && !gs.isRegistered(accelerator)) {
			return false;
		}
		return true;
	} catch (err) {
		console.warn("[MarinMind] 热键注册失败", accelerator, err);
		return false;
	}
}

/** 注销全局热键（尽力而为：环境不可用/未注册静默） */
export function unregisterGlobalHotkey(accelerator: string): void {
	const gs = electronRemote()?.globalShortcut;
	if (!gs?.unregister) {
		return;
	}
	try {
		gs.unregister(accelerator);
	} catch (err) {
		console.warn("[MarinMind] 热键注销失败", accelerator, err);
	}
}

/** 置前本窗口（全局热键在后台触发后需要回到前台开裁剪弹窗） */
export function focusOwnWindow(): void {
	const win = electronRemote()?.getCurrentWindow?.();
	if (!win) {
		return;
	}
	try {
		win.show?.();
		win.focus?.();
	} catch (err) {
		console.warn("[MarinMind] 窗口置前失败", err);
	}
}
