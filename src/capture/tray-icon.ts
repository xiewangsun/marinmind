/**
 * 截图托盘（120，obsidian 耦合层，仅桌面）：像 Snipaste 一样图标常驻系统
 * 托盘，聚合截图/屏幕剪藏入口——左键单击 = 截图（框选）复制；右键菜单 =
 * 剪藏屏幕区域为笔记 / 打开设置 / 退出（125——收起托盘图标，设置开关不动，
 * 重载插件后按设置恢复）。全部动作复用 main.ts 公开的
 * runScreenCaptureAction（命令 / 全局热键 / 托盘三入口同链路）。
 *
 * Electron 桥接：@electron/remote 的 Tray / Menu 属性 + nativeImage.
 * createFromDataURL（图标用运行时 canvas 画 32px 方案——插件无图标资源
 * 文件可复用，且避免打包资源路径问题）。守卫链任何一环缺失返回 null
 * （托盘只是入口聚合，命令/热键入口不受影响，调用方静默降级）。
 * 加载铁律同 external-file.ts：window / require 只能在函数体内。
 *
 * 131 随 Obsidian 退场：托盘活在 Electron 主进程，渲染进程一死就成了
 * 孤儿——图标残留任务栏、右键菜单回调（remote 转发回渲染进程）全部失效
 * （含「退出」项）。Obsidian 退出不保证走到插件 onunload（走时渲染进程
 * 也常已在拆除、remote 通道发不出 destroy）——故在 window beforeunload
 * （渲染进程关闭前一刻、remote 通道仍活）挂销毁钩子，托盘随 Obsidian
 * 自动退出；重载插件同样路过该清理（新会话按设置重建，无残留双图标）。
 */
import type MarinMindPlugin from "../main";

/** 托盘菜单动作（菜单项 → 行为的分发键） */
export type TrayAction = "copy" | "note" | "settings" | "exit";

/** 托盘菜单项（Electron 菜单模板的窄化形态；type=separator 为分隔线） */
export interface TrayMenuItem {
	label?: string;
	type?: "normal" | "separator";
	action?: TrayAction;
}

/**
 * 托盘菜单模板（纯函数，测试锁定）：截图复制 / 剪藏为笔记 / 分隔线 /
 * 打开设置 / 分隔线 / 退出（125）。label 末尾 … 表示会进入框选交互。
 */
export function trayMenuItems(): TrayMenuItem[] {
	return [
		{ label: "截图（框选）复制", action: "copy" },
		{ label: "剪藏屏幕区域为笔记…", action: "note" },
		{ type: "separator" },
		{ label: "打开设置", action: "settings" },
		{ type: "separator" },
		{ label: "退出", action: "exit" },
	];
}

/** 托盘 Tooltip 文案（截图中提示热键之外的常驻入口） */
export const TRAY_TOOLTIP = "MarinMind 截图工具（左键：截图框选）";

/** 托盘实例形状（守卫式窄化；@electron/remote 桥接对象） */
export interface CaptureTrayLike {
	setToolTip?: (text: string) => void;
	setContextMenu?: (menu: unknown) => void;
	on?: (event: string, listener: (...args: unknown[]) => void) => unknown;
	destroy?: () => void;
}

/** @electron/remote 形状（托盘所需字段，守卫式窄化） */
interface TrayRemoteLike {
	Tray?: unknown;
	Menu?: { buildFromTemplate?: (template: unknown) => unknown };
	require?: (module: string) => unknown;
}

/** 取 electron remote（typeof window 守卫——node 测试环境无此全局） */
function electronRemote(): TrayRemoteLike | null {
	if (typeof window === "undefined") {
		return null;
	}
	const electron = (window as unknown as { electron?: { remote?: TrayRemoteLike } }).electron;
	return electron?.remote ?? null;
}

/**
 * 运行时 canvas 画托盘图标 → PNG dataURL（32px 圆角方底 + M 字样，托盘
 * 小尺寸下清晰可辨）。生成失败（无 DOM/无 2d 上下文）返回 null——不建托盘。
 */
export function drawTrayIconDataUrl(size = 32): string | null {
	if (typeof document === "undefined") {
		return null;
	}
	try {
		const canvas = document.createElement("canvas");
		canvas.width = size;
		canvas.height = size;
		const ctx = canvas.getContext("2d");
		if (!ctx) {
			return null;
		}
		// 圆角方底（Chromium 99+ 有 roundRect；旧内核回退直角）
		ctx.fillStyle = "#4aa3ff";
		ctx.beginPath();
		if (typeof ctx.roundRect === "function") {
			ctx.roundRect(1, 1, size - 2, size - 2, size * 0.22);
		} else {
			ctx.rect(1, 1, size - 2, size - 2);
		}
		ctx.fill();
		// M 字样居中（视觉重心微下移补偿基线）
		ctx.fillStyle = "#ffffff";
		ctx.font = `bold ${Math.round(size * 0.62)}px sans-serif`;
		ctx.textAlign = "center";
		ctx.textBaseline = "middle";
		ctx.fillText("M", size / 2, size / 2 + size * 0.04);
		return canvas.toDataURL("image/png");
	} catch (err) {
		console.warn("[MarinMind] 托盘图标绘制失败", err);
		return null;
	}
}

/** 托盘动作分发（settings 打开本插件设置页；exit 收起托盘；copy/note 走统一截图入口） */
function runTrayAction(plugin: MarinMindPlugin, action: TrayAction): void {
	if (action === "exit") {
		// 125：用户显式退出——只销毁托盘图标，设置开关不动（重载/重开开关即恢复）
		plugin.exitCaptureTray();
		return;
	}
	if (action === "settings") {
		// obsidian 类型桩未暴露 app.setting（运行时存在）——守卫式窄化访问
		const setting = (
			plugin.app as unknown as {
				setting?: { open?: () => void; openTabById?: (id: string) => void };
			}
		).setting;
		setting?.open?.();
		setting?.openTabById?.("marinmind");
		return;
	}
	void plugin.runScreenCaptureAction(action);
}

/**
 * 页面卸载销毁钩子（131，模块级单例——插件设计同一时刻至多一个托盘，
 * createCaptureTray 重建前先卸旧钩子）。钩子体即 destroyCaptureTray
 * （自卸载幂等，dispatch 中移除监听合法）。
 */
let trayUnloadHook: (() => void) | null = null;

/** 卸下页面卸载钩子（幂等；window 缺失环境为空操作） */
function detachTrayUnloadHook(): void {
	if (trayUnloadHook && typeof window !== "undefined") {
		window.removeEventListener("beforeunload", trayUnloadHook);
	}
	trayUnloadHook = null;
}

/**
 * 挂页面卸载钩子（131）：window beforeunload 在渲染进程关闭前一刻触发，
 * 此时 remote 通道仍活、destroy 能送达主进程——托盘随 Obsidian 退出/
 * 窗口关闭/插件重载自动销毁（见文件头 131 段）。先卸旧钩子再挂新。
 */
export function attachTrayUnloadHook(tray: CaptureTrayLike): void {
	if (typeof window === "undefined") {
		return;
	}
	detachTrayUnloadHook();
	const unload = (): void => destroyCaptureTray(tray);
	window.addEventListener("beforeunload", unload);
	trayUnloadHook = unload;
}

/**
 * 创建截图托盘：图标（nativeImage）→ Tray 构造 → 右键菜单（buildFromTemplate
 * + 动作分发）+ Tooltip + 左键单击 = 截图框选复制。任一环不可用返回 null
 * （调用方静默——命令/热键入口不受影响）。
 */
export function createCaptureTray(plugin: MarinMindPlugin): CaptureTrayLike | null {
	const remote = electronRemote();
	if (!remote) {
		return null;
	}
	// Tray 构造器：remote.Tray（@electron/remote 官方属性）；require 兜底
	let TrayCtor: (new (image: unknown) => CaptureTrayLike) | null = null;
	if (typeof remote.Tray === "function") {
		TrayCtor = remote.Tray as new (image: unknown) => CaptureTrayLike;
	} else {
		try {
			const viaRequire = (remote.require?.("electron") as { Tray?: unknown } | undefined)
				?.Tray;
			if (typeof viaRequire === "function") {
				TrayCtor = viaRequire as new (image: unknown) => CaptureTrayLike;
			}
		} catch (err) {
			console.warn("[MarinMind] remote.require('electron') 取 Tray 失败", err);
		}
	}
	const buildFromTemplate = remote.Menu?.buildFromTemplate;
	if (!TrayCtor || typeof buildFromTemplate !== "function") {
		console.warn("[MarinMind] Tray/Menu 不可用，托盘未创建");
		return null;
	}
	/** electron nativeImage 形状（守卫式窄化） */
	let nativeImage: { createFromDataURL?: (url: string) => unknown } | undefined;
	try {
		const electron = remote.require?.("electron") as
			{ nativeImage?: { createFromDataURL?: (url: string) => unknown } } | undefined;
		nativeImage = electron?.nativeImage;
	} catch (err) {
		console.warn("[MarinMind] remote.require('electron') 取 nativeImage 失败", err);
	}
	if (typeof nativeImage?.createFromDataURL !== "function") {
		console.warn("[MarinMind] nativeImage 不可用，托盘未创建");
		return null;
	}
	const iconUrl = drawTrayIconDataUrl();
	if (!iconUrl) {
		return null;
	}
	try {
		const image = nativeImage.createFromDataURL.call(nativeImage, iconUrl);
		const tray = new TrayCtor(image);
		// 右键菜单（Windows/Linux 语义；macOS 亦兼容显示）
		const template = trayMenuItems().map((item) =>
			item.type === "separator"
				? { type: "separator" }
				: { label: item.label, click: () => runTrayAction(plugin, item.action!) },
		);
		tray.setContextMenu?.(buildFromTemplate.call(remote.Menu, template));
		tray.setToolTip?.(TRAY_TOOLTIP);
		// 左键单击 = 截图（框选）复制（最常用动作一键直达）
		tray.on?.("click", () => runTrayAction(plugin, "copy"));
		// 131：随 Obsidian 退场（beforeunload 销毁，见 attachTrayUnloadHook）
		attachTrayUnloadHook(tray);
		return tray;
	} catch (err) {
		console.warn("[MarinMind] 托盘创建失败", err);
		return null;
	}
}

/**
 * 销毁托盘（尽力而为：已销毁/环境不可用静默）。同时卸下页面卸载钩子
 * （131）——设置切换 / 托盘「退出」/ 插件卸载等一切显式销毁路径都经此，
 * 钩子随之清理，不残留死监听。
 */
export function destroyCaptureTray(tray: CaptureTrayLike | null): void {
	detachTrayUnloadHook();
	if (!tray) {
		return;
	}
	try {
		tray.destroy?.();
	} catch (err) {
		console.warn("[MarinMind] 托盘销毁失败", err);
	}
}
