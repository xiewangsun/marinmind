/**
 * 屏幕区域剪藏为笔记（119，obsidian 耦合层）：用户在覆盖窗冻结画面上框选
 * 屏幕区域（screen-select）→ 本模块做两件事——① 物理裁剪图片（image-crop，
 * 调用方完成，落库 WebP 优先回退 PNG）+ OCR 识别文字；② 组装「图 embed +
 * OCR 文字」的剪藏笔记经 saveWebclip 落数据根 clips/（本地图片经
 * attachments.save 入 assets/，**不 fetchImages 不压缩**，与 116 srcdoc
 * 框选剪藏互补：这条是「真实屏幕所见即所得」路径，根治预览排版失真问题）。
 * 组装逻辑全为纯函数（vitest 锁定）；OCR/落盘为运行时路径（桌面验收）。
 */
import { Notice } from "obsidian";
import type MarinMindPlugin from "../main";
import { ocrCanvasRegions } from "../ocr/ocr-service";
import { saveWebclip, type SaveWebclipInput } from "../webclip/webclip-service";
import { dataUrlToBytes, type CropResult } from "./image-crop";

/** 图 embed 占位符（与 html-to-md 的 __MMIMG_N__ 约定一致；fillImageRefs 回填） */
const SCREEN_CLIP_PLACEHOLDER = "__MMIMG_0__";

/** 标题长度上限（OCR 首行截断；超出加省略号） */
const SCREEN_CLIP_TITLE_MAX = 40;

/**
 * 屏幕剪藏正文（纯函数）：图 embed 占位符 + OCR 文字块；空文字退化纯图。
 * 图永远是主内容（所见即所得），OCR 文字是检索/复用增强。
 */
export function buildScreenClipMarkdown(ocrText: string): string {
	const text = ocrText.trim();
	if (!text) {
		return `![屏幕截图](${SCREEN_CLIP_PLACEHOLDER})\n`;
	}
	return `![屏幕截图](${SCREEN_CLIP_PLACEHOLDER})\n\n${text}\n`;
}

/** 两位数字补零（本地时间标题用） */
const pad2 = (n: number): string => String(n).padStart(2, "0");

/**
 * 屏幕剪藏标题（纯函数）：OCR 首个非空行截 40 字符（超出加 …）——笔记
 * 列表里一眼可辨；无文字（OCR 关/失败/纯图区域）回退「屏幕剪藏 + 本地
 * 时间」（与文件名冲突时 saveWebclip 自动 -2 递增）。
 */
export function deriveScreenClipTitle(ocrText: string, now: Date): string {
	const firstLine = ocrText
		.split(/\r?\n/)
		.map((line) => line.trim())
		.find((line) => line.length > 0);
	if (firstLine) {
		const cut = firstLine.slice(0, SCREEN_CLIP_TITLE_MAX);
		return cut.length < firstLine.length ? `${cut}…` : cut;
	}
	return `屏幕剪藏 ${now.getFullYear()}-${pad2(now.getMonth() + 1)}-${pad2(now.getDate())} ${pad2(now.getHours())}:${pad2(now.getMinutes())}`;
}

/**
 * 组装 saveWebclip 入参（纯函数，124 起落点固定 clips/ 无需目录校验）。
 * 本地图片嵌入的关键：**只走 fetched 不走 url**——saveWebclip 落盘判定只看
 * fetched[i] 有无数据，images[i] 的 url=null 表示无远程源（不会被 fetchImages
 * 重造），图片经 attachments.save 原样入数据根 assets/ 且绕过压缩；ext 跟随
 * 裁剪实际编码格式（png|webp）。
 */
export function buildScreenClipSaveInput(args: {
	ocrText: string;
	/** 图片字节（ArrayBuffer 形态与 FetchedImage.bytes 一致） */
	bytes: ArrayBuffer;
	/** 实际编码格式（跟随 image-crop 产物；决定 assets/ 扩展名） */
	ext: "png" | "webp";
	capturedAt: Date;
}): SaveWebclipInput {
	return {
		title: deriveScreenClipTitle(args.ocrText, args.capturedAt),
		markdown: buildScreenClipMarkdown(args.ocrText),
		images: [
			{
				placeholder: SCREEN_CLIP_PLACEHOLDER,
				url: null,
				dataUri: null,
				alt: "屏幕截图",
			},
		],
		fetched: [{ bytes: args.bytes, ext: args.ext }],
		// screen:// 伪协议标记来源（frontmatter source 字段）；ISO 时间戳即拍摄时刻
		sourceUrl: `screen://${args.capturedAt.toISOString()}`,
	};
}

/** Uint8Array → 独立 ArrayBuffer（不与解码缓冲共享内存，镜像 fs-adapter readBinary） */
function toBuffer(bytes: Uint8Array): ArrayBuffer {
	return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

/**
 * 裁剪产物 → 白底 2x 画布（OCR 前置；镜像手写卡 OCR 样板）：tesseract 对
 * 透明底识别率极低；16M 像素钳超限按 sqrt 保比例回缩。失败返回 null
 * （调用方按无文字处理，不阻塞存图）。
 */
export async function screenRegionOcrCanvas(bytes: ArrayBuffer): Promise<HTMLCanvasElement | null> {
	const bitmap = await createImageBitmap(new Blob([bytes]));
	try {
		let scale = 2;
		if (bitmap.width * bitmap.height * scale * scale > 16_000_000) {
			scale = Math.max(1, Math.sqrt(16_000_000 / (bitmap.width * bitmap.height)));
		}
		const canvas = document.createElement("canvas");
		canvas.width = Math.max(1, Math.round(bitmap.width * scale));
		canvas.height = Math.max(1, Math.round(bitmap.height * scale));
		const ctx = canvas.getContext("2d");
		if (!ctx) {
			return null;
		}
		ctx.imageSmoothingEnabled = true;
		ctx.fillStyle = "#ffffff";
		ctx.fillRect(0, 0, canvas.width, canvas.height);
		ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
		return canvas;
	} finally {
		bitmap.close();
	}
}

/**
 * 屏幕区域剪藏主入口（119）：可选 OCR（screenClipOcr 设置开关；失败/空文本
 * 不阻塞——纯图照存）→ saveWebclip 落数据根 clips/ → Notice + 打开阅读
 * （clip 阅读分支：摘录建卡全链路可用）。返回剪藏的数据根相对路径（失败 null）。
 */
export async function clipScreenRegionToNote(
	plugin: MarinMindPlugin,
	crop: CropResult,
): Promise<string | null> {
	await plugin.whenReady();
	const bytes = dataUrlToBytes(crop.dataUrl);
	if (!bytes) {
		new Notice("屏幕剪藏失败：图片编码异常", 5000);
		return null;
	}
	const byteBuf = toBuffer(bytes);

	// 可选 OCR：识别屏幕区域文字（设置 screenClipOcr，默认开；失败不阻塞）
	let ocrText = "";
	if (plugin.settings.screenClipOcr) {
		const notice = new Notice("正在识别屏幕文字…", 0);
		try {
			const canvas = await screenRegionOcrCanvas(byteBuf);
			if (canvas) {
				ocrText = await ocrCanvasRegions(canvas, [{ x: 0, y: 0, w: 1, h: 1 }], {
					langs: plugin.settings.ocrLangs,
					onStatus: (u) => {
						if (u.progress != null && u.progress > 0 && u.progress < 1) {
							notice.setMessage(`正在识别屏幕文字… ${Math.round(u.progress * 100)}%`);
						}
					},
				});
			}
		} catch (err) {
			console.warn("[MarinMind] 屏幕剪藏 OCR 失败（不阻塞，纯图保存）", err);
		} finally {
			notice.hide();
		}
	}

	try {
		const input = buildScreenClipSaveInput({
			ocrText,
			bytes: byteBuf,
			ext: crop.ext,
			capturedAt: new Date(),
		});
		const result = await saveWebclip(plugin, input);
		const summary = ocrText.trim() ? "（含识别文字）" : "（纯图）";
		new Notice(`已剪藏屏幕区域「${input.title}」${summary}`, 4000);
		// 打开即走 clip 阅读分支：upsertByPath 自动登记文档，摘录建卡全链路可用
		await plugin.openClip(result.path);
		return result.path;
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		new Notice(`屏幕剪藏失败：${message}`, 6000);
		console.error("[MarinMind] 屏幕剪藏落盘失败", err);
		return null;
	}
}
