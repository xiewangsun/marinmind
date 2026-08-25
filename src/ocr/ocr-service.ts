import { createWorker } from "tesseract.js";
import type { Worker } from "tesseract.js";
import type { DocRect } from "../types";
import { joinRectTexts } from "./ocr-text";

/**
 * tesseract.js 版本锁：主包（API 面）经 npm 进 bundle，而 worker 脚本与
 * 核心 WASM 运行时从 CDN 加载——**两边版本必须严格一致**，否则 worker 与
 * 主包的消息协议不匹配，报错难排查。升级时须同步修改 package.json 与此处并重测。
 */
const TESS_VERSION = "7.0.0";

/** worker 脚本 / 核心 WASM 的 CDN 前缀（Text Extractor 插件已验证该链路在 Obsidian 桌面可用） */
const WORKER_PATH = `https://cdn.jsdelivr.net/npm/tesseract.js@${TESS_VERSION}/dist/worker.min.js`;
const CORE_PATH = `https://cdn.jsdelivr.net/npm/tesseract.js-core@${TESS_VERSION}`;
/** 语言包 CDN（chi_sim/eng 的 traineddata，下载后由 tesseract 缓存到 IndexedDB，二次离线可用） */
const LANG_PATH = "https://tessdata.projectnaptha.com/4.0.0";

/** 识别语言：简体中文 + 英文混排 */
const LANGS = "chi_sim+eng";

/** OCR 进度回调（notice 文案用） */
export interface OcrStatusUpdate {
	message: string;
	/** 0-1（部分阶段无值） */
	progress?: number;
}

/** 当前进度出口：logger 在 createWorker 时固定注册，后续调用靠换 sink 转发 */
let statusSink: ((u: OcrStatusUpdate) => void) | null = null;

/** 模块级 worker 单例（首次调用才联网加载引擎与语言包，约 10-20MB） */
let workerPromise: Promise<Worker> | null = null;

function getWorker(): Promise<Worker> {
	workerPromise ??= createWorker(LANGS, 1, {
		workerPath: WORKER_PATH,
		corePath: CORE_PATH,
		langPath: LANG_PATH,
		// worker 脚本经 Blob URL 装载，绕开"远程 worker 脚本"的 CSP 限制
		workerBlobURL: true,
		logger: (m) => {
			statusSink?.({ message: m.status ?? "", progress: m.progress });
		},
	}).catch((err) => {
		// 失败重置单例，允许下次重试（网络恢复后不必重启 Obsidian）
		workerPromise = null;
		throw err;
	});
	return workerPromise;
}

/**
 * 对 canvas 的若干归一化矩形区域做 OCR，按顺序拼接返回清洗后的文本。
 *
 * rectangle 换算用 canvas 的**内部像素尺寸**（width/height 属性）——renderTo
 * 已按 dpr 与像素钳制设定物理分辨率，CSS 尺寸与识别精度无关。
 * 换算后不足 1 像素的矩形跳过（极小误触框）。
 */
export async function ocrCanvasRegions(
	canvas: HTMLCanvasElement,
	normRects: DocRect[],
	onStatus?: (u: OcrStatusUpdate) => void,
): Promise<string> {
	const worker = await getWorker();
	const parts: string[] = [];
	statusSink = onStatus ?? null;
	try {
		for (const r of normRects) {
			const left = Math.max(0, Math.round(r.x * canvas.width));
			const top = Math.max(0, Math.round(r.y * canvas.height));
			const right = Math.min(canvas.width, Math.round((r.x + r.w) * canvas.width));
			const bottom = Math.min(canvas.height, Math.round((r.y + r.h) * canvas.height));
			if (right - left < 1 || bottom - top < 1) {
				continue;
			}
			const { data } = await worker.recognize(canvas, {
				rectangle: { left, top, width: right - left, height: bottom - top },
			});
			parts.push(data.text ?? "");
		}
	} finally {
		statusSink = null;
	}
	return joinRectTexts(parts);
}
