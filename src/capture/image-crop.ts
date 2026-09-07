/**
 * 图像裁剪共用件（118，obsidian 零依赖）：从 114 裁剪弹窗抽出的
 * 解码等待 / 图片 dataURL→字节 / 物理像素裁剪三件套——旧弹窗
 * （screenshot-crop-modal）与覆盖窗直选（screen-select）共用同一套
 * 「实测即真理」换算。加载铁律同 external-file.ts：window/require 只能在
 * 函数体内访问。落库路径（preferWebp）WebP 优先回退 PNG（118 批统一存库
 * 图片格式；剪贴板路径恒 PNG——W3C ClipboardItem 规范只认 image/png）。
 */
import { loadModule } from "../storage/node-fs-adapter";
import { encodeCanvasWebpFirst, WEBP_QUALITY } from "../imaging/canvas-encode";
import { physicalCropRect, type CapturedScreen, type SelRect } from "./screen-capture";

/** 桌面 Buffer 形状（loadModule 守卫加载；仅 dataUrlToBytes 快路径使用） */
interface BufferLike {
	from: (data: string, encoding: string) => Uint8Array;
}

/** 模块级缓存：Buffer 只加载一次（require 是同步本地调用，缓存避免重复查找） */
let bufferMod: BufferLike | null = null;

/** 等既有 img 元素解码完成（dataURL 即时；坏图以 naturalWidth=0 继续，不 reject） */
export function waitForImage(img: HTMLImageElement, src: string): Promise<void> {
	return new Promise((resolve) => {
		img.onload = () => resolve();
		img.onerror = () => resolve();
		img.src = src;
		if (img.complete) {
			resolve();
		}
	});
}

/** 新建并解码图片元素（失败不 reject——naturalWidth=0 由调用方判定） */
export function loadImageEl(src: string): Promise<HTMLImageElement> {
	const img = document.createElement("img");
	img.alt = "";
	return waitForImage(img, src).then(() => img);
}

/**
 * 图片 dataURL → 字节数组（屏幕剪藏落盘 / OCR 前置）。收 image/png 与
 * image/webp（本模块产物 png|webp 两种格式——落库 WebP 优先回退 PNG）；
 * 解码 Buffer 快路径（桌面）→ atob 兜底（vitest/web 环境）；失败返回 null。
 */
export function dataUrlToBytes(dataUrl: string): Uint8Array | null {
	const match = /^data:image\/(?:png|webp);base64,(.*)$/s.exec(dataUrl);
	if (!match) {
		return null; // 非 png/webp dataURL 一律不收
	}
	const b64 = match[1]!;
	try {
		// 快路径：node Buffer（loadModule 自带移动端/测试环境守卫）
		bufferMod ??= loadModule<BufferLike>("buffer");
		const viaBuffer = bufferMod.from(b64, "base64");
		return viaBuffer.length > 0 ? viaBuffer : null;
	} catch {
		// 兜底：atob（jsdom/纯 web 环境全局可用）
		if (typeof atob !== "function") {
			return null;
		}
		try {
			const bin = atob(b64);
			if (bin.length === 0) {
				return null; // 空 base64（坏 dataURL）不出空字节产物
			}
			const bytes = new Uint8Array(bin.length);
			for (let i = 0; i < bin.length; i++) {
				bytes[i] = bin.charCodeAt(i);
			}
			return bytes;
		} catch {
			return null;
		}
	}
}

/** 物理裁剪产物：Blob（W3C 剪贴板）与 dataURL（electron 剪贴板兜底）双形态 + 实际编码格式 */
export interface CropResult {
	blob: Blob;
	dataUrl: string;
	/** 实际编码格式：决定落库扩展名；剪贴板路径（不传 preferWebp）恒 "png" */
	ext: "png" | "webp";
}

/** 裁剪编码选项：preferWebp 开启后落库路径 WebP 优先（回退 PNG，ext 跟随实际格式） */
export interface CropEncodeOptions {
	preferWebp?: boolean;
}

/**
 * 屏幕位图按显示坐标选区物理裁剪（弹窗/覆盖窗共用尾段）：解码全屏
 * dataURL → physicalCropRect（实测 natural/client 比例换算）→ canvas
 * 9 参 drawImage 1:1 落地 → Blob + dataURL。缺省 PNG（剪贴板两调用方——
 * W3C 规范只认 image/png）；传 opts.preferWebp 时 WebP 优先回退 PNG。
 * 任一环失败（解码坏图 / 无 2d 上下文 / toBlob 不支持）返回 null，
 * 由调用方给中文提示。
 */
export async function cropScreenRegion(
	screen: CapturedScreen,
	sel: SelRect,
	dispW: number,
	dispH: number,
	opts?: CropEncodeOptions,
): Promise<CropResult | null> {
	const img = await loadImageEl(screen.dataUrl);
	// 解码失败回退抓屏时记录的物理尺寸（理论不可达：dataUrl 来自 toDataURL）
	const naturalW = img.naturalWidth || screen.width;
	const naturalH = img.naturalHeight || screen.height;
	if (naturalW <= 0 || naturalH <= 0) {
		return null;
	}
	const phys = physicalCropRect(sel, dispW, dispH, naturalW, naturalH);
	const canvas = document.createElement("canvas");
	canvas.width = phys.sw;
	canvas.height = phys.sh;
	const ctx = canvas.getContext("2d");
	if (!ctx) {
		return null;
	}
	// 9 参裁剪：源物理像素矩形 1:1 落到目标（dataURL 同源，画布无污染）
	ctx.drawImage(img, phys.sx, phys.sy, phys.sw, phys.sh, 0, 0, phys.sw, phys.sh);
	if (opts?.preferWebp) {
		// 落库路径：公共件内部已探测回退 PNG（iOS WKWebView 等），ext 以实测为准
		const enc = await encodeCanvasWebpFirst(canvas);
		if (!enc) {
			return null;
		}
		const dataUrl = canvas.toDataURL(enc.mime, WEBP_QUALITY);
		// 实际格式以 dataUrl 前缀二次判别（不能假设编码成功——旧 WebView 会静默回退 PNG）
		const ext = dataUrl.startsWith("data:image/webp") ? "webp" : "png";
		return { blob: enc.blob, dataUrl, ext };
	}
	const blob = await new Promise<Blob | null>((resolve) =>
		canvas.toBlob((b) => resolve(b), "image/png"),
	);
	if (!blob) {
		return null;
	}
	return { blob, dataUrl: canvas.toDataURL("image/png"), ext: "png" };
}
