import { createWorker } from "tesseract.js";
import type { PSM, Worker } from "tesseract.js";
import type { DocRect } from "../types";
import {
	DEFAULT_OCR_LANGS,
	joinRectTexts,
	ocrLinesFromBlocks,
	pickOcrPsm,
	type OcrLine,
	type OcrPsm,
} from "./ocr-text";

/**
 * tesseract.js 版本锁：主包（API 面）经 npm 进 bundle，而 worker 脚本与
 * 核心 WASM 运行时从 CDN 加载——**两边版本必须严格一致**，否则 worker 与
 * 主包的消息协议不匹配，报错难排查。升级时须同步修改 package.json 与此处并重测。
 */
const TESS_VERSION = "7.0.0";

/** worker 脚本 / 核心 WASM 的 CDN 前缀（Text Extractor 插件已验证该链路在 Obsidian 桌面可用） */
const WORKER_PATH = `https://cdn.jsdelivr.net/npm/tesseract.js@${TESS_VERSION}/dist/worker.min.js`;
const CORE_PATH = `https://cdn.jsdelivr.net/npm/tesseract.js-core@${TESS_VERSION}`;
/** 语言包 CDN（traineddata，下载后由 tesseract 缓存到 IndexedDB，二次离线可用） */
const LANG_PATH = "https://tessdata.projectnaptha.com/4.0.0";

/** OCR 进度回调（notice 文案用） */
export interface OcrStatusUpdate {
	message: string;
	/** 0-1（部分阶段无值） */
	progress?: number;
}

/** 单次识别的可选项（83）：进度出口 / 显式 PSM（跳过启发式）/ 识别语言组合 */
export interface OcrRunOptions {
	onStatus?: (u: OcrStatusUpdate) => void;
	psm?: OcrPsm;
	/** OCR_LANGUAGES 表内值（缺省中英混排）；与当前 worker 不同时自动重建 */
	langs?: string;
}

/** 当前进度出口：logger 在 createWorker 时固定注册，后续调用靠换 sink 转发 */
let statusSink: ((u: OcrStatusUpdate) => void) | null = null;

/** 模块级 worker 单例（首次调用才联网加载引擎与语言包，约 10-20MB） */
let workerPromise: Promise<Worker> | null = null;

/** 当前单例的识别语言（83 语言可选）：请求语言不同时旧 worker 终止重建 */
let workerLangs: string | null = null;

/**
 * 本会话已成功就绪的语言组合（85-C OCR 提示优化）：worker + 语言包加载成功后
 * 登记，用于识别前的"首次需联网下载"提示判定——同会话第二次调用其实秒加载
 * （语言包缓存在 IndexedDB），不该再弹下载提示。会话级不持久化：wasm 每会话
 * 可能重下载，误报"已就绪"的代价远小于误报"需下载"；语言切换重建 worker 时
 * 旧语种条目保留（IndexedDB 有缓存，确实无需再提示）。
 */
const readyLangs = new Set<string>();

/** 语言组合的引擎是否已在本会话加载成功（提示文案分流用，不影响识别本身） */
export function isOcrEngineReady(langs: string): boolean {
	return readyLangs.has(langs);
}

function getWorker(langs: string): Promise<Worker> {
	// 语言切换：terminate 旧 worker（fire-and-forget 释放，失败仅日志）后按新语言重建
	if (workerPromise && workerLangs !== langs) {
		const old = workerPromise;
		void old.then((w) => w.terminate()).catch(() => undefined);
		workerPromise = null;
		workerLangs = null;
	}
	workerPromise ??= createWorker(langs, 1, {
		workerPath: WORKER_PATH,
		corePath: CORE_PATH,
		langPath: LANG_PATH,
		// worker 脚本经 Blob URL 装载，绕开"远程 worker 脚本"的 CSP 限制
		workerBlobURL: true,
		logger: (m) => {
			statusSink?.({ message: m.status ?? "", progress: m.progress });
		},
	})
		// 成功才登记就绪（85-C：在 catch 之前——失败不登记，下次仍提示首次）
		.then((w) => {
			readyLangs.add(langs);
			return w;
		})
		.catch((err) => {
			// 失败重置单例，允许下次重试（网络恢复后不必重启 Obsidian）
			workerPromise = null;
			throw err;
		});
	workerLangs = langs;
	return workerPromise;
}

/**
 * 识别任务串行队列（83）：promise 链排队，后到的 job 等前一个落定（无论成败）
 * 才执行——statusSink 单槽与 setParameters 全局态在并发下互抢/交错的根治
 * （拖框即识连续触发、整页与区域识别并行等场景）。job 自身错误仍抛给调用方，
 * 但不污染链尾（吞落态续链）。
 */
let queue: Promise<unknown> = Promise.resolve();

function enqueue<T>(job: () => Promise<T>): Promise<T> {
	const run = queue.then(job);
	queue = run.then(
		() => undefined,
		() => undefined,
	);
	return run;
}

/** 最近一次设置过的 PSM（队列串行下安全）：不变则跳过 setParameters 往返 */
let lastPsm: OcrPsm | null = null;

async function applyPsm(worker: Worker, psm: OcrPsm): Promise<void> {
	if (lastPsm === psm) {
		return;
	}
	// OcrPsm 字符串值与 tesseract PSM 枚举一致（纯文本层不依赖枚举，此处收窄）
	await worker.setParameters({ tessedit_pageseg_mode: psm as PSM });
	lastPsm = psm;
}

/**
 * 对 canvas 的若干归一化矩形区域做 OCR，按顺序拼接返回清洗后的文本。
 *
 * rectangle 换算用 canvas 的**内部像素尺寸**（width/height 属性）——renderTo
 * 已按 dpr 与像素钳制设定物理分辨率，CSS 尺寸与识别精度无关。
 * 换算后不足 1 像素的矩形跳过（极小误触框）。
 * 每矩形先按几何挑 PSM（显式 psm 跳过启发式；83 PSM 细分）再识别。
 */
export async function ocrCanvasRegions(
	canvas: HTMLCanvasElement,
	normRects: DocRect[],
	opts?: OcrRunOptions,
): Promise<string> {
	return enqueue(async () => {
		const worker = await getWorker(opts?.langs ?? DEFAULT_OCR_LANGS);
		const parts: string[] = [];
		statusSink = opts?.onStatus ?? null;
		try {
			for (const r of normRects) {
				const left = Math.max(0, Math.round(r.x * canvas.width));
				const top = Math.max(0, Math.round(r.y * canvas.height));
				const right = Math.min(canvas.width, Math.round((r.x + r.w) * canvas.width));
				const bottom = Math.min(canvas.height, Math.round((r.y + r.h) * canvas.height));
				if (right - left < 1 || bottom - top < 1) {
					continue;
				}
				await applyPsm(worker, opts?.psm ?? pickOcrPsm(r, canvas.width, canvas.height));
				const { data } = await worker.recognize(canvas, {
					rectangle: { left, top, width: right - left, height: bottom - top },
				});
				parts.push(data.text ?? "");
			}
		} finally {
			statusSink = null;
		}
		return joinRectTexts(parts);
	});
}

/** 整页识别结果：全文（清洗拼接）+ 行级明细（83 整页 OCR 逐行 rects 建卡用） */
export interface OcrPageResult {
	text: string;
	lines: OcrLine[];
}

/**
 * 整页行级识别（83）：无 rectangle 整页一次识别，输出格式开 blocks 取
 * Block→paragraphs→lines 的行级 bbox，经 ocrLinesFromBlocks 换算归一化矩形。
 * 行序即 tesseract 版面阅读序；识别不出文字时 lines 为空、text 为空串。
 */
export async function ocrCanvasPageLines(
	canvas: HTMLCanvasElement,
	opts?: OcrRunOptions,
): Promise<OcrPageResult> {
	return enqueue(async () => {
		const worker = await getWorker(opts?.langs ?? DEFAULT_OCR_LANGS);
		statusSink = opts?.onStatus ?? null;
		try {
			// 整页交给全自动版面分析（PSM 3）；显式 psm 仅手写合成图等无版面场景用
			await applyPsm(worker, opts?.psm ?? "3");
			const { data } = await worker.recognize(canvas, {}, { blocks: true, text: true });
			const lines = ocrLinesFromBlocks(data.blocks, canvas.width, canvas.height);
			return { text: joinRectTexts(lines.map((l) => l.text)), lines };
		} finally {
			statusSink = null;
		}
	});
}
