import { TFile } from "obsidian";
import type MarinMindPlugin from "../main";
import type { BookDocument } from "../types";
import { acquirePdf, pdfCacheKey, type PdfHandle } from "../reader/pdf-cache";
import { epubCoverBytes } from "../reader/epub-document";
import { readExternalBinary } from "../storage/external-file";
import { docExtOf, isAbsoluteFsPath } from "../storage/paths";

/**
 * 文档封面渲染服务（㊵ 主页文档页「窗格」书架视图）：
 * 把文档首页渲染为封面缩略图 dataURL，供瓷片 `<img>` 回填。
 *
 * - PDF：首页 pdf.js 渲染（原路径）；EPUB（㊼）：manifest 封面条目解出
 *   （epubCoverBytes filter 限次解压）→ 位图 Image 解码 + canvas 缩放 WebP，
 *   svg 直接 base64 dataURL（矢量保真且免解码）；md/未知扩展占位 null。
 * - 缓存键 = `pdfCacheKey(doc.filePath)`（非 docId）：重关联/改名改路径后
 *   新键自动失效重渲，无需额外清缓存耦合；与 pdf-cache 自身键语义一致。
 *   同路径文件被原地替换的残留风险与 pdf-cache 的 byteLength 容忍度同级，可接受。
 * - 缓存**字符串不缓存句柄**：渲染 → 编码 → 立即 release（worker 侧内存随用随还）。
 * - **确定性 null 同样入缓存**（㊼）：md 白试、epub 无封面——每次进主页重复
 *   读字节纯属浪费；pdf 读取/渲染失败属偶发，维持不缓存可重试。
 * - 解析走 ㊳ pdf-cache 共享缓存：与阅读器/AI 摘录弹窗/复习缩略图复用同一次解析。
 * - 并发由调用方 mapLimit 限流（本服务不做信号量，同 pdf-document 简单优先取舍）；
 *   同路径在途单飞去重。
 * - 契约：**永不 reject**——任何失败（失联/移动端库外/解析报错）归一 null，
 *   调用方渲染占位图标（封面是增强不是依赖，同 context-preview 语义）。
 */

/** 封面渲染目标宽度（CSS 像素）：窗格列 ~170px（renderTo 内部另乘 dpr 提清晰度） */
const COVER_WIDTH = 170;
/** 封面框高度上限（CSS 像素）：170 × 4/3，横版页按高适配渲染防模糊 */
const COVER_HEIGHT = 227;
/** 封面缓存上限（LRU）：~24 张 dataURL（每张数十 KB 字符串，内存可控） */
const MAX_COVERS = 24;

/** 封面缓存：规范化文件路径 → 已编码 dataURL（或确定性 null 占位；Map 迭代序=最近使用序，touch 用 delete+set） */
const covers = new Map<string, string | null>();
/** 在途渲染单飞：路径 → 渲染 Promise（落定即出表；偶发失败不缓存可重试） */
const inflight = new Map<string, Promise<string | null>>();

/**
 * 获取（或复用缓存的）文档封面缩略图。
 * 库内文档经 vault 读取；库外绝对路径桌面 fs 直读（移动端在读取处抛错 → null）。
 */
export function getDocCover(plugin: MarinMindPlugin, doc: BookDocument): Promise<string | null> {
	const key = pdfCacheKey(doc.filePath);
	const hit = covers.get(key);
	if (hit !== undefined) {
		// touch：删掉重插维持 Map 迭代序 = 最近使用序
		covers.delete(key);
		covers.set(key, hit);
		return Promise.resolve(hit);
	}
	const pending = inflight.get(key);
	if (pending) {
		return pending; // 单飞：搭同路径首次渲染的车
	}
	const p = renderCoverOnce(plugin, key, doc).finally(() => {
		inflight.delete(key);
	});
	inflight.set(key, p);
	return p;
}

/** 渲染一次封面并编码为 dataURL；成功/确定性 null 入 LRU（超限淘汰最久未用），偶发失败归一 null 不缓存 */
async function renderCoverOnce(
	plugin: MarinMindPlugin,
	key: string,
	doc: BookDocument,
): Promise<string | null> {
	const ext = docExtOf(doc.filePath);
	if (ext !== "pdf" && ext !== "epub") {
		cacheCover(key, null); // md/未知扩展（㊼）：无封面可渲，null 占位防重复白试
		return null;
	}
	let handle: PdfHandle | null = null;
	try {
		// 路径双语义（㉞）：库外绝对路径桌面 fs 直读；库内经 vault
		let buf: ArrayBuffer;
		if (isAbsoluteFsPath(doc.filePath)) {
			buf = await readExternalBinary(doc.filePath);
		} else {
			const file = plugin.app.vault.getAbstractFileByPath(doc.filePath);
			if (!(file instanceof TFile)) {
				return null; // 库内文档失联（探活后仍可能竞态消失）——占位（偶发，不缓存）
			}
			buf = await plugin.app.vault.readBinary(file);
		}
		let url: string | null;
		if (ext === "epub") {
			// ㊼ EPUB 封面：filter 限次解压只取封面条目（不整包解析）
			const cover = epubCoverBytes(new Uint8Array(buf));
			url = cover ? await encodeCoverImage(cover.href, cover.bytes) : null;
			if (url === null) {
				cacheCover(key, null); // 书内无封面（manifest 未声明）——确定性 null
				return null;
			}
		} else {
			handle = await acquirePdf(key, buf);
			const base = await handle.doc.getPageSize(1);
			// 混合开本双向钳制：竖版书按宽适配、横版 slide 按高适配，都渲够清晰度
			const scale = Math.min(COVER_WIDTH / base.width, COVER_HEIGHT / base.height);
			const canvas = document.createElement("canvas");
			// isolated：离屏封面渲染不取消同页在途显示渲染（复习缩略图同款）
			const ticket = handle.doc.renderTo(canvas, 1, scale, { isolated: true });
			await ticket.done;
			url = encodeCanvas(canvas);
		}
		cacheCover(key, url);
		return url;
	} catch (err) {
		console.debug("[MarinMind] 封面渲染跳过", err);
		return null; // 读取/解析/渲染偶发失败：不缓存，下次再试
	} finally {
		handle?.release();
	}
}

/** 入 LRU（超限淘汰最久未用） */
function cacheCover(key: string, url: string | null): void {
	covers.set(key, url);
	while (covers.size > MAX_COVERS) {
		const oldest = covers.keys().next().value;
		if (oldest === undefined) {
			break;
		}
		covers.delete(oldest);
	}
}

/** canvas 编码为 dataURL：优先 WebP（体积约 PNG 的 1/3~1/5）；iOS WKWebView 不支持时静默回退 PNG（toDataURL 前缀判别，㉛ 同语义） */
function encodeCanvas(canvas: HTMLCanvasElement): string {
	let url = canvas.toDataURL("image/webp", 0.85);
	if (!url.startsWith("data:image/webp")) {
		url = canvas.toDataURL("image/png");
	}
	return url;
}

/**
 * ㊼ EPUB 封面条目出图：svg 直接 base64 dataURL（矢量保真，不经 Image 解码）；
 * 位图经 blob URL + Image 解码 → 按封面框双向钳制缩放进 canvas → WebP dataURL。
 * 解码失败（损坏图/浏览器不认）归一 null（调用方按无封面占位）。
 */
async function encodeCoverImage(href: string, bytes: Uint8Array): Promise<string | null> {
	if (href.toLowerCase().endsWith(".svg")) {
		return `data:image/svg+xml;base64,${bytesToBase64(bytes)}`;
	}
	// slice 拷贝满足 TS 的 BlobPart 泛型（ArrayBufferLike→ArrayBuffer，epub-session 同款）
	const blobUrl = URL.createObjectURL(new Blob([bytes.slice()]));
	try {
		const img = await new Promise<HTMLImageElement>((resolve, reject) => {
			const el = new Image();
			el.onload = () => resolve(el);
			el.onerror = () => reject(new Error("封面图片解码失败"));
			el.src = blobUrl;
		});
		const scale = Math.min(
			COVER_WIDTH / img.naturalWidth,
			COVER_HEIGHT / img.naturalHeight,
		);
		const canvas = document.createElement("canvas");
		canvas.width = Math.max(1, Math.round(img.naturalWidth * scale));
		canvas.height = Math.max(1, Math.round(img.naturalHeight * scale));
		const ctx = canvas.getContext("2d");
		if (!ctx) {
			return null;
		}
		ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
		return encodeCanvas(canvas);
	} catch {
		return null;
	} finally {
		URL.revokeObjectURL(blobUrl);
	}
}

/** 字节 → base64（分块防 String.fromCharCode 展开参数上限；btoa 是浏览器同步标准） */
function bytesToBase64(bytes: Uint8Array): string {
	let bin = "";
	const CHUNK = 0x8000;
	for (let i = 0; i < bytes.length; i += CHUNK) {
		bin += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
	}
	return btoa(bin);
}
