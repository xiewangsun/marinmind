import type { TFile } from "obsidian";
import type MarinMindPlugin from "../main";
import type { Card, DocRect } from "../types";
import { excerptCropRect, occlusionBounds, snapshotImgSize } from "./rect-utils";
import { paintCardHighlights, pixelRect } from "./region-snapshot";
import { acquirePdf, pdfCacheKey, retainPdf, type PdfHandle } from "./pdf-cache";
import { readExternalBinary } from "../storage/external-file";
import { docExtOf, isAbsoluteFsPath } from "../storage/paths";
import { EXCERPT_LABELS } from "../home/home-data";

/**
 * 摘录视觉共享管线（㊷ 自 CardPreviewModal 上提）：只显示摘录区域本身——
 * 1. 媒体附件（photo/handwriting/area/lasso 的 excerptRef）——"只有摘录区域"的成品图；
 * 2. 原文页裁剪：excerptCropRect 规格渲染整页（isolated，经 pdf-cache 共享解析）
 *    → 叠高亮 → 裁出摘录窗口（text/blank 卡主路径，带少量上下文）；
 * 3. 全部失败 → rendered:false（调用方文本兜底）。
 * 主页卡片预览弹窗（㶈）与复习遮挡正面（㊷）共用同一出图。
 */

/** 裁剪预览的目标尺寸上限（CSS 像素）：按裁剪窗口宽高比取小不拉伸 */
const PREVIEW_WIDTH = 560;
const PREVIEW_HEIGHT = 420;

/** 单次整页渲染像素预算（与 pdf-document 的 16M 钳制同量级，防巨画布） */
const MAX_RENDER_PIXELS = 16_000_000;

/**
 * renderExcerptVisual 结果：rendered=是否成功出图；objectUrl=创建的 blob URL
 * （调用方负责 revoke）；bounds=出图对应的页归一化窗口（㊷ 复习遮挡摆位用——
 * 快照图 = rects 并集包围盒 / 页裁剪 = 裁剪窗口；失败为 null，调用方按
 * occlusionBounds 估算）。audio 无页面几何，bounds 无意义。
 */
export interface ExcerptVisualResult {
	rendered: boolean;
	objectUrl: string | null;
	bounds: DocRect | null;
}

/**
 * 是否可走原文页裁剪渲染（84-D 抽出为纯守卫）：
 * photo 卡 rects 是页面展示框（重定位语义）而非摘录区域——绝不能当裁剪窗口
 * 裁 PDF 页，附件读取失败的 photo 直接落文本兜底。
 */
export function canPageCrop(card: {
	documentId: string | null;
	page: number | null;
	rects: DocRect[];
	excerptType: string;
}): boolean {
	return (
		card.documentId != null &&
		card.page != null &&
		card.rects.length > 0 &&
		card.excerptType !== "photo"
	);
}

/**
 * 108 preferCrop 适用面（纯守卫，vitest 直测）：仅 area/lasso——handwriting
 * 笔迹不在 PDF 里（附件即全部内容，裁页只见底页不见笔迹）、photo 与页裁剪
 * 互斥（canPageCrop 恒拒）、text/blank 无附件不受优先序影响。
 */
export function canPreferCrop(card: { excerptType: string }, preferCrop?: boolean): boolean {
	return preferCrop === true && (card.excerptType === "area" || card.excerptType === "lasso");
}

/**
 * 渲染摘录视觉（异步三级回退，host 内追加媒体元素或裁剪画布）。
 * host 已断开（弹窗/视图关闭）时视为成功并丢弃，不触发兜底回退。
 * opts.preferCrop（108 复习展示形态统一）：area/lasso **页裁剪优先**、附件快照
 * 兜底——快照图按截取时缩放档出图、400px 基宽展示有缩放感；页裁剪按窗口
 * 自适应渲染，与 text 卡同形态（带上下文余量、居中舞台）。handwriting 不适用
 * （笔迹不在 PDF 里，附件即全部内容）；photo/页裁剪互斥不受影响。
 * 110 area/lasso 裁剪窗口走 context 档（excerptCropRect 页比例余量 + 文字量级
 * 最小窗口）——显示范围与 text 卡对齐，不再紧贴包围盒裁成小 zoom 图。
 */
export async function renderExcerptVisual(
	plugin: MarinMindPlugin,
	card: Card,
	host: HTMLElement,
	opts?: { preferCrop?: boolean },
): Promise<ExcerptVisualResult> {
	const preferCrop = canPreferCrop(card, opts?.preferCrop);
	if (card.excerptRef && !preferCrop) {
		const attached = await renderAttachment(plugin, card, host);
		if (attached.rendered) {
			return attached;
		}
		// 附件读取失败（文件被移动/删除）→ 落页裁剪兜底（area/lasso/handwriting 有 rects）
	}
	if (canPageCrop(card)) {
		const crop = await renderPageCrop(plugin, card, host);
		if (crop) {
			return { rendered: true, objectUrl: null, bounds: crop };
		}
	}
	// preferCrop 兜底链：页裁剪失败（文档失联/非 PDF）回落附件快照，再落调用方文本兜底
	if (card.excerptRef && preferCrop) {
		const attached = await renderAttachment(plugin, card, host);
		if (attached.rendered) {
			return attached;
		}
	}
	return { rendered: false, objectUrl: null, bounds: null };
}

/** 附件媒体展示（img / audio）；失败 rendered:false 供调用方回退 */
async function renderAttachment(
	plugin: MarinMindPlugin,
	card: Card,
	host: HTMLElement,
): Promise<ExcerptVisualResult> {
	const ref = card.excerptRef;
	if (!ref) {
		return { rendered: false, objectUrl: null, bounds: null };
	}
	try {
		const bytes = await plugin.attachments.read(ref);
		if (!host.isConnected) {
			return { rendered: true, objectUrl: null, bounds: null }; // 关闭竞态：宿主已拆，丢弃且不再回退
		}
		const url = URL.createObjectURL(new Blob([bytes]));
		if (card.excerptType === "audio") {
			const audio = host.createEl("audio", { cls: "marinmind-card-preview-media" });
			audio.controls = true;
			audio.src = url;
		} else {
			const img = host.createEl("img", { cls: "marinmind-card-preview-media" });
			img.alt = EXCERPT_LABELS[card.excerptType];
			// R3（W-02）：按 rects 包围盒预留宽高比——加载前占位防下方脚注跳动
			const size = snapshotImgSize(card);
			img.width = size.width;
			img.height = size.height;
			img.src = url;
		}
		// 快照图边界 = rects 并集包围盒（area/lasso/handwriting 裁剪即按此范围）
		return { rendered: true, objectUrl: url, bounds: occlusionBounds(card) };
	} catch (err) {
		console.debug("[MarinMind] 摘录附件读取失败，回退页裁剪", err);
		return { rendered: false, objectUrl: null, bounds: null };
	}
}

/**
 * 原文页裁剪（text/blank 卡主路径，媒体卡兜底）：整页 isolated 渲染 →
 * 叠高亮 → 裁出 excerptCropRect 窗口。句柄用完即 release（一次性渲染不缓存）。
 * 成功返回裁剪窗口（= 遮挡摆位的 bounds），失败返回 null。
 */
async function renderPageCrop(
	plugin: MarinMindPlugin,
	card: Card,
	host: HTMLElement,
): Promise<DocRect | null> {
	const documentId = card.documentId;
	const page = card.page;
	if (!documentId || page == null) {
		return null;
	}
	const doc = plugin.documents.get(documentId);
	if (!doc) {
		return null;
	}
	// ㊼ 页裁剪只对 PDF 成立（md/epub 无 pdf.js 位图）：短路返回 null，
	// 调用方落文本兜底（顺手修掉 md 白读字节白解析 pdf.js 的浪费）
	if (docExtOf(doc.filePath) !== "pdf") {
		return null;
	}
	let handle: PdfHandle | null = null;
	try {
		// 112 提速：暖窗命中（60s 内解析过同书，pdf-cache 空闲保留）先借引用——
		// 跳过整份字节读取与重新解析（冷首开大文件的秒级开销）；未命中才读字节
		// 走 acquirePdf（byteLength 比对与替换语义不变）
		const cacheKey = pdfCacheKey(doc.filePath);
		handle = retainPdf(cacheKey);
		if (!handle) {
			// 路径双语义（㉞）：库外绝对路径桌面 fs 直读；库内经 vault（失联抛错走 catch 回退）
			const buf = isAbsoluteFsPath(doc.filePath)
				? await readExternalBinary(doc.filePath)
				: await plugin.app.vault.readBinary(
						plugin.app.vault.getAbstractFileByPath(doc.filePath) as TFile,
					);
			handle = await acquirePdf(cacheKey, buf);
		}
		const base = await handle.doc.getPageSize(page);
		// 110 area/lasso 参照文字摘录的显示范围：context 档裁剪窗口（页比例余量 +
		// 文字量级最小窗口）；text/blank 主路径不传——窗口量纲与现状一致零回归
		const crop = excerptCropRect(card.rects, {
			context: card.excerptType === "area" || card.excerptType === "lasso",
		});
		// 渲染尺度：裁剪窗口贴目标档位（取小不拉伸），整页像素不超预算
		let scale = Math.min(
			PREVIEW_WIDTH / (crop.w * base.width),
			PREVIEW_HEIGHT / (crop.h * base.height),
		);
		scale = Math.min(scale, Math.sqrt(MAX_RENDER_PIXELS / (base.width * base.height)));
		const full = document.createElement("canvas");
		const ticket = handle.doc.renderTo(full, page, scale, { isolated: true });
		await ticket.done;
		paintCardHighlights(full, card);
		// 裁出摘录窗口（含余量上下文），再挂载避免半成品闪现
		const win = pixelRect(crop, full.width, full.height);
		const out = document.createElement("canvas");
		out.width = win.sw;
		out.height = win.sh;
		const ctx = out.getContext("2d");
		if (!ctx) {
			return null;
		}
		ctx.drawImage(full, win.sx, win.sy, win.sw, win.sh, 0, 0, win.sw, win.sh);
		if (!host.isConnected) {
			return crop; // 渲染期间宿主已拆——丢弃
		}
		out.addClass("marinmind-card-preview-crop");
		host.appendChild(out);
		return crop;
	} catch (err) {
		console.debug("[MarinMind] 摘录页裁剪渲染失败", err);
		return null;
	} finally {
		handle?.release();
	}
}
