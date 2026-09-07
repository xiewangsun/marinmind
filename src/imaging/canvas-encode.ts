/**
 * 画布图片编码公共件（单源收敛）：WebP 优先、环境不支持回退 PNG。
 * 原先 region-snapshot（reader 域）与 image-compress（attachments 域）各持一份
 * 私有 canEncodeWebp/encodeCanvas（互指注释表明私有化的唯一顾虑是跨域反向依赖），
 * 截图/手写 WebP 化（2026-09）再添两处调用方后收敛为本零依赖公共件——
 * 本模块不 import 任何 obsidian/领域模块，任意域引用均不构成反向依赖。
 * iOS WKWebView 的 canvas 不支持编码 WebP（toBlob 静默回退 PNG），故先探测能力、
 * 不支持则落回 PNG；扩展名/媒体类型以 blob.type 实测为准（不假设编码成功）。
 */

/** WebP 有损默认质量（0-1）：文字页/照片 0.85 肉眼无损（与原区域快照/照片压缩同档） */
export const WEBP_QUALITY = 0.85;

/** WebP 编码能力缓存（null = 尚未探测） */
let webpSupported: boolean | null = null;

/** 探测当前环境能否用 canvas 编码 WebP：不支持时 toDataURL 静默回退 PNG，以前缀判别 */
export function canEncodeWebp(): boolean {
	if (webpSupported === null) {
		const probe = document.createElement("canvas");
		probe.width = 1;
		probe.height = 1;
		webpSupported = probe.toDataURL("image/webp").startsWith("data:image/webp");
	}
	return webpSupported;
}

/** canvas 编码产物：blob 供剪贴板/字节派生（arrayBuffer()），ext 决定落库扩展名 */
export interface EncodedCanvasImage {
	blob: Blob;
	/** 实际编码媒体类型（以 blob.type 实测，非请求值） */
	mime: "image/webp" | "image/png";
	/** 实际编码格式（决定附件扩展名与 excerptRef） */
	ext: "webp" | "png";
}

/**
 * canvas → 图片（WebP 优先，环境不支持或编码失败回退 PNG；两者全失败返回 null，
 * 由调用方给中文提示）。quality 仅 WebP 分支生效（PNG 无质量参数）。
 */
export async function encodeCanvasWebpFirst(
	canvas: HTMLCanvasElement,
	quality: number = WEBP_QUALITY,
): Promise<EncodedCanvasImage | null> {
	const useWebp = canEncodeWebp();
	const blob = await new Promise<Blob | null>((resolve) =>
		canvas.toBlob(
			(b) => resolve(b),
			useWebp ? "image/webp" : "image/png",
			useWebp ? quality : undefined,
		),
	);
	if (!blob) {
		return null;
	}
	// 实测兜底：极旧 WebView 可能探测通过但编码静默回退——以 blob.type 为准
	const mime = blob.type === "image/webp" ? "image/webp" : "image/png";
	return { blob, mime, ext: mime === "image/webp" ? "webp" : "png" };
}
