/**
 * 视觉多模态图片准备（104-C）：把摘录附件字节转成 vision 请求可用的 dataURL。
 * 「AI 补充解释」的图片摘录路径（区域/套索/手写/照片）经此栅格化压缩后随
 * ChatMessage 分段数组直发模型（需模型支持视觉输入，如 gpt-4o / glm-4v 系列）。
 *
 * - 位图（png/jpg/webp/bmp/gif 首帧）：createImageBitmap 解码 → 超 2048 边
 *   等比缩 canvas → toDataURL WebP q0.85（环境不支持回退 PNG，前缀即实际
 *   格式——region-snapshot「前缀即实际格式」惯例，mime 无需单独推断）。
 * - SVG：无固有像素，经 `<img>` 栅格化（doc-covers 封面同款 blob URL + Image
 *   解码路径）；无固有尺寸（naturalWidth=0）判失败。
 * - 契约：**永不 reject**——解码失败 / 无固有尺寸 / dataURL 超限一律归一
 *   null，调用方降级（有文字走纯文本、无文字 Notice 提示）。
 */

/** 视觉请求图片最长边（2048 = 主流 vision API 的合理上界；再大徒增 base64 体积与 token） */
export const VISION_MAX_EDGE = 2048;

/** dataURL 字符上限（约 3.75MB 图片；超出多为异常图，放弃发送走降级路径） */
export const VISION_DATALURL_MAX = 5 * 1024 * 1024;

/** WebP 有损质量（0-1）：与 image-compress / region-snapshot 同档（0.85 肉眼无损） */
const WEBP_QUALITY = 0.85;

/** SVG 扩展名（矢量，走 img 栅格化路径而非 createImageBitmap） */
const SVG_EXTS = new Set(["svg"]);

/** 是否需要缩到视觉上限（纯函数）：任一边超 2048 即缩 */
export function shouldResizeForVision(width: number, height: number): boolean {
	return Math.max(width, height) > VISION_MAX_EDGE;
}

/** canvas 编码为 dataURL：优先 WebP；环境不支持时静默回退 PNG（前缀判别，
 *  image-compress / doc-covers 同语义——模块私有不复用，避免跨文件耦合） */
function encodeCanvas(canvas: HTMLCanvasElement): string {
	let url = canvas.toDataURL("image/webp", WEBP_QUALITY);
	if (!url.startsWith("data:image/webp")) {
		url = canvas.toDataURL("image/png");
	}
	return url;
}

/** 源尺寸 → 画布尺寸（超边等比缩，1px 下限防零尺寸画布） */
function canvasSize(w: number, h: number): { w: number; h: number } {
	const scale = Math.min(1, VISION_MAX_EDGE / Math.max(w, h));
	return { w: Math.max(1, Math.round(w * scale)), h: Math.max(1, Math.round(h * scale)) };
}

/** 源对象（bitmap/img 同形）绘制进画布并编码；超限归一 null */
function drawAndEncode(src: CanvasImageSource, w: number, h: number): string | null {
	const size = canvasSize(w, h);
	const canvas = document.createElement("canvas");
	canvas.width = size.w;
	canvas.height = size.h;
	const ctx = canvas.getContext("2d");
	if (!ctx) {
		return null;
	}
	ctx.imageSmoothingEnabled = true;
	ctx.imageSmoothingQuality = "high";
	ctx.drawImage(src, 0, 0, size.w, size.h);
	const url = encodeCanvas(canvas);
	return url.length > VISION_DATALURL_MAX ? null : url;
}

/** SVG 字节经 `<img>` 栅格化（blob URL 显式 image/svg+xml type）；无固有尺寸 / 解码失败归一 null */
async function rasterizeSvg(bytes: ArrayBuffer): Promise<string | null> {
	// slice 拷贝满足 TS 的 BlobPart 泛型（ArrayBufferLike→ArrayBuffer，doc-covers 同款）
	const blobUrl = URL.createObjectURL(new Blob([bytes.slice()], { type: "image/svg+xml" }));
	try {
		const img = await new Promise<HTMLImageElement>((resolve, reject) => {
			const el = new Image();
			el.onload = () => resolve(el);
			el.onerror = () => reject(new Error("SVG 解码失败"));
			el.src = blobUrl;
		});
		if (img.naturalWidth <= 0 || img.naturalHeight <= 0) {
			return null; // 无固有尺寸的 SVG（百分比宽高）——画不出确定大小的图
		}
		return drawAndEncode(img, img.naturalWidth, img.naturalHeight);
	} catch {
		return null;
	} finally {
		URL.revokeObjectURL(blobUrl);
	}
}

/**
 * 附件字节 → vision dataURL。ext 取自 excerptRef 的扩展名（小写不敏感）；
 * 未知扩展名也按位图尝试解码（字节可能是有效图片），失败归一 null。
 */
export async function imageToDataUrl(bytes: ArrayBuffer, ext: string): Promise<string | null> {
	try {
		if (SVG_EXTS.has(ext.toLowerCase())) {
			return await rasterizeSvg(bytes);
		}
		const bitmap = await createImageBitmap(new Blob([bytes]));
		try {
			return drawAndEncode(bitmap, bitmap.width, bitmap.height);
		} finally {
			bitmap.close();
		}
	} catch {
		return null; // 解码失败（损坏字节/浏览器不认的格式）——调用方降级
	}
}
