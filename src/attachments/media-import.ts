import { Notice } from "obsidian";
import type MarinMindPlugin from "../main";
import { compressImageBytes, shouldCompressImage } from "./image-compress";

/**
 * 媒体卡导入共享件（84-C）：照片选图 / 入库前处理 / 建 photo 卡——
 * reader 插入图片与命令面板「捕捉照片为自由卡片」两入口单源共用。
 * attachments 域零 reader 依赖（plugin 为 type-only 引入，无运行时环）。
 */

/** MIME 类型 → 图片扩展名（未知类型兜底 png；不识别 charset 后缀按兜底走） */
export function imageExtOf(mime: string): string {
	const map: Record<string, string> = {
		"image/png": "png",
		"image/jpeg": "jpg",
		"image/webp": "webp",
		"image/gif": "gif",
		"image/svg+xml": "svg",
		"image/bmp": "bmp",
	};
	return map[mime] ?? "png";
}

/**
 * 隐藏 file input 选图（Promise 化，取消返回 []；移动端同样可用）。
 * settled 防重入：部分环境 cancel 事件不触发，change/cancel 至多兑现一次。
 */
export function pickImageFiles(multiple = true): Promise<File[]> {
	return new Promise((resolve) => {
		const input = document.createElement("input");
		input.type = "file";
		input.accept = "image/*";
		input.multiple = multiple;
		input.hidden = true; // P3-3：隐藏 file input 用 hidden 属性（UA 规则对 inline-block 生效）
		let settled = false;
		const finish = (files: File[]) => {
			if (settled) {
				return;
			}
			settled = true;
			input.remove();
			resolve(files);
		};
		input.addEventListener("change", () => finish(Array.from(input.files ?? [])));
		input.addEventListener("cancel", () => finish([]));
		document.body.appendChild(input);
		input.click();
	});
}

/**
 * 照片入库前处理（唯一压缩接缝，84-E 实装）：超 300KB 的位图缩放到最长边
 * 2560px 并转 WebP（q0.85 肉眼无损）；GIF/SVG 原样保留；压缩失败回退原字节
 * （宁存大勿丢图）。reader 与命令两入口一处生效。
 * @param compress 来自 settings.photoCompress（默认开）
 */
export async function preparePhotoBytes(
	bytes: ArrayBuffer,
	ext: string,
	compress: boolean,
): Promise<{ bytes: ArrayBuffer; ext: string }> {
	if (!compress || !shouldCompressImage(bytes.byteLength, ext)) {
		return { bytes, ext };
	}
	try {
		return await compressImageBytes(bytes, ext);
	} catch (err) {
		console.warn("[MarinMind] 照片压缩失败，按原图保存", err);
		return { bytes, ext };
	}
}

/** 媒体卡落锚：documentId null = 自由卡（未归类卡片.md，84-C） */
export interface MediaAnchor {
	documentId: string | null;
	page: number | null;
}

/**
 * 图片文件批量导入为 photo 卡（逐文件容错：单张失败 Notice 不牵连其余）。
 * 非图片文件静默跳过（拖入混合内容常见）；返回实际建卡数。
 */
export async function importPhotoCard(
	plugin: MarinMindPlugin,
	files: File[],
	anchor: MediaAnchor,
): Promise<number> {
	let saved = 0;
	for (const file of files.filter((f) => f.type.startsWith("image/"))) {
		try {
			const raw = await file.arrayBuffer();
			// 压缩开关来自设置（84-E 默认开；GIF/SVG/小图在接缝内自动放行）
			const { bytes, ext } = await preparePhotoBytes(
				raw,
				imageExtOf(file.type),
				plugin.settings.photoCompress,
			);
			const ref = await plugin.attachments.save(bytes, ext);
			// 回显由 cardBus 事件回环完成（主页/阅读器徽标各自订阅）
			plugin.cards.create({
				documentId: anchor.documentId,
				page: anchor.page,
				rects: [],
				excerptType: "photo",
				excerptRef: ref,
				color: "red", // ㊹ 四色化：照片/语音统一浅红（无页面矩形，仅脑图色条可见）
			});
			saved++;
		} catch (err) {
			console.error("[MarinMind] 图片保存失败", err, file.name);
			new Notice(`图片保存失败：${file.name}`);
		}
	}
	return saved;
}
