/**
 * 照片入库压缩（84-E）：超阈值照片缩放到最长边 COMPRESS_MAX_EDGE 并转 WebP——
 * 手机照片普遍 4000px+ / 3-8MB，入库即压能把库体积压到 1/5~1/10（q0.85 与区域
 * 快照同档，肉眼无损）。GIF（动图）/SVG（矢量）原样保留；结果比原字节更大时
 * 回退原字节（宁存大勿丢图）。接入点唯一：media-import preparePhotoBytes——
 * reader 插入图片与命令面板捕捉照片两入口一处生效。
 */

/** 压缩目标最长边（2560 = 2K 级；阅读器/复习展示远小于此，再大无收益） */
export const COMPRESS_MAX_EDGE = 2560;

/** 低于该字节数不折腾（300KB 已足够小，重编码收益趋零还可能更大） */
export const COMPRESS_MIN_BYTES = 300 * 1024;

/** 可压缩的位图扩展名（gif 动图 / svg 矢量不在此列，原样保留） */
const COMPRESSIBLE_EXTS = new Set(["png", "jpg", "jpeg", "webp", "bmp"]);

/** WebP 有损质量（0-1）：与 region-snapshot WEBP_QUALITY 同档（0.85 肉眼无损） */
const WEBP_QUALITY = 0.85;

/** 是否需要压缩（纯函数）：≥300KB 且是位图扩展名 */
export function shouldCompressImage(byteLength: number, ext: string): boolean {
	return byteLength >= COMPRESS_MIN_BYTES && COMPRESSIBLE_EXTS.has(ext.toLowerCase());
}

/** WebP 编码能力缓存（null = 未探测）——逻辑同 region-snapshot canEncodeWebp
 *  （模块私有不导出复用，避免 attachments → reader 反向依赖，两处注释互指） */
let webpSupported: boolean | null = null;

/** 探测当前环境能否用 canvas 编码 WebP：不支持时 toDataURL 静默回退 PNG，以前缀判别 */
function canEncodeWebp(): boolean {
	if (webpSupported === null) {
		const probe = document.createElement("canvas");
		probe.width = 1;
		probe.height = 1;
		webpSupported = probe.toDataURL("image/webp").startsWith("data:image/webp");
	}
	return webpSupported;
}

/** canvas → 图片字节 + 实际扩展名（WebP 优先，环境不支持回退 PNG） */
function encodeCanvas(canvas: HTMLCanvasElement): Promise<{ bytes: ArrayBuffer; ext: string }> {
	const useWebp = canEncodeWebp();
	return new Promise((resolve, reject) => {
		canvas.toBlob(
			(blob) => {
				if (!blob) {
					reject(new Error(`画布导出 ${useWebp ? "WebP" : "PNG"} 失败`));
					return;
				}
				void blob
					.arrayBuffer()
					.then((bytes) => resolve({ bytes, ext: useWebp ? "webp" : "png" }), reject);
			},
			useWebp ? "image/webp" : "image/png",
			useWebp ? WEBP_QUALITY : undefined,
		);
	});
}

/**
 * 压缩图片字节：createImageBitmap 解码（EXIF 方向自动旋正——竖拍照片不躺倒，
 * ocrHandwritingCard 同款用法）→ 超 2560 边等比缩 canvas → WebP q0.85
 * （环境不支持回退 PNG）。结果更大（罕见：原文件已是高度优化）时回退原字节。
 */
export async function compressImageBytes(
	bytes: ArrayBuffer,
	ext: string,
): Promise<{ bytes: ArrayBuffer; ext: string }> {
	const bitmap = await createImageBitmap(new Blob([bytes]));
	try {
		const scale = Math.min(1, COMPRESS_MAX_EDGE / Math.max(bitmap.width, bitmap.height));
		const w = Math.max(1, Math.round(bitmap.width * scale));
		const h = Math.max(1, Math.round(bitmap.height * scale));
		const canvas = document.createElement("canvas");
		canvas.width = w;
		canvas.height = h;
		const ctx = canvas.getContext("2d");
		if (!ctx) {
			return { bytes, ext };
		}
		ctx.imageSmoothingEnabled = true;
		ctx.imageSmoothingQuality = "high";
		ctx.drawImage(bitmap, 0, 0, w, h);
		const out = await encodeCanvas(canvas);
		return out.bytes.byteLength < bytes.byteLength ? out : { bytes, ext };
	} finally {
		bitmap.close();
	}
}
