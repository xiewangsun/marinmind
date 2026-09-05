import { loadModule } from "./node-fs-adapter";

/**
 * 库外文件（桌面绝对路径）直读桥：阅读 vault 外 PDF 的地基。
 *
 * 与 NodeFsAdapter 的分工：NodeFsAdapter 以数据根为界锁根（path.resolve 越界拒绝），
 * 本模块面向用户主动选择的任意绝对路径（系统文件对话框产出），不设根边界。
 * 加载铁律同 node-fs-adapter：require 只能在函数体内 typeof 守卫下调用，
 * window 访问（electron remote）同样只在函数体内——顶层引用会在移动端/测试环境崩溃。
 */

/** node:fs 模块缓存（require 为同步低开销本地调用，缓存仅避免重复查找） */
let fsMod: typeof import("fs") | undefined;

/** 懒加载 node:fs（移动端 / 未注入环境抛出明确中文错误） */
function fs(): typeof import("fs") {
	fsMod ??= loadModule<typeof import("fs")>("fs");
	return fsMod;
}

/**
 * 读取库外文件的二进制内容。
 * 读取失败转中文错误（文件不存在 / 无权限 / 非桌面环境），上层直接以 Notice/tip 呈现。
 */
export async function readExternalBinary(absPath: string): Promise<ArrayBuffer> {
	if (typeof require !== "function") {
		throw new Error(`库外文档仅桌面端可用：${absPath}`);
	}
	try {
		const buf = await fs().promises.readFile(absPath);
		// 复制独立 buffer，避免与 node 内部池化内存共享（同 NodeFsAdapter 先例）
		return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
	} catch (err) {
		const code = (err as NodeJS.ErrnoException).code;
		if (code === "ENOENT") {
			throw new Error(`库外文件不存在：${absPath}`, { cause: err });
		}
		if (code === "EACCES" || code === "EPERM") {
			throw new Error(`无权限读取库外文件：${absPath}`, { cause: err });
		}
		throw new Error(
			`读取库外文件失败：${absPath}（${err instanceof Error ? err.message : String(err)}）`,
			{ cause: err },
		);
	}
}

/** 库外文件是否仍存在（任何失败一律视为不存在，供文档管理面板失联判定） */
export async function externalFileExists(absPath: string): Promise<boolean> {
	if (typeof require !== "function") {
		return false;
	}
	try {
		await fs().promises.stat(absPath);
		return true;
	} catch {
		return false;
	}
}

/**
 * 弹系统文件对话框选择一个库外文档（㊼ 起收 PDF/EPUB），返回其绝对路径；
 * 取消 / 环境不支持返回 null。
 * Obsidian 桌面把 @electron/remote 挂在 window.electron.remote（守卫式访问，任何缺口返回 null 不抛）。
 */
export async function pickExternalPath(): Promise<string | null> {
	// eslint 访问 window.electron 无类型声明，只能在函数体内窄化
	const electron = (
		window as unknown as {
			electron?: {
				remote?: {
					dialog?: {
						showOpenDialog?: (opts: Record<string, unknown>) => Promise<{
							canceled?: boolean;
							filePaths?: string[];
						}>;
					};
				};
			};
		}
	).electron;
	const dialog = electron?.remote?.dialog;
	if (!dialog || typeof dialog.showOpenDialog !== "function") {
		return null;
	}
	const result = await dialog.showOpenDialog({
		title: "选择库外文档",
		properties: ["openFile"],
		filters: [{ name: "文档", extensions: ["pdf", "epub"] }],
	});
	if (result.canceled || !result.filePaths || result.filePaths.length === 0) {
		return null;
	}
	return result.filePaths[0];
}
