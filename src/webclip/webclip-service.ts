/**
 * 网页剪藏服务层（113-B，obsidian 耦合层）：抓取（requestUrl 绕 CORS，桌面/
 * 移动端均可用）→ 纯函数层转换（webclip-engine，113-A）→ 图片下载 → 数据根落盘。
 * 构造/解析全在纯函数层（vitest 覆盖），本层只做网络与文件 IO，中文错误直抛
 * （镜像 translate-service「描述对象进、中文错误出」的分工）。
 *
 * 落盘布局（124 布局 v2）：
 * - md 落数据根 `clips/<名>.md`（adapter IO 自动建目录；vault 数据根走
 *   vault.createBinary 入索引，阅读器 openClip 立即可解析）；
 * - 图片统一经 attachments.save 落数据根 `assets/<uid>.<ext>`——与照片/
 *   手写等媒体附件同仓（attachment-audit 保留集扫 clips md 引用，不判孤儿）；
 *   md 内引用写数据根相对路径文本，阅读器渲染前 localizeClipImageRefs
 *   替换 blob（MarkdownRenderer 的相对解析对数据根内路径不可用）；
 * - 下载失败回退远程 URL；仅复用 media-import 的纯函数 imageExtOf /
 *   preparePhotoBytes（压缩接缝）。
 */
import { requestUrl } from "obsidian";
import type { Vault } from "obsidian";
import type MarinMindPlugin from "../main";
import { CLIPS_SUBDIR } from "../constants";
import { joinRel, dirSegments } from "../storage/paths";
import { imageExtOf, preparePhotoBytes } from "../attachments/media-import";
import { decodeHtmlBytes } from "./html-charset";
import { fillImageRefs, type MdImageRef } from "./html-to-md";
import { nextFileName, sanitizeFileName } from "./clip-naming";
import { normalizeClipUrl } from "./clip-url";
import { clipWebpage } from "./webclip-engine";

/** 单张下载成功的图片（ext 不含点） */
export interface FetchedImage {
	bytes: ArrayBuffer;
	ext: string;
}

/** 单次剪藏至多本地化的图片数：超出部分整段保留远程链接（防图床页拖垮库体积） */
export const MAX_CLIP_IMAGES = 20;
/** 单张图片字节上限（20MB：远超正文配图常规量级，防错误页面巨型响应） */
const MAX_IMAGE_BYTES = 20 * 1024 * 1024;
/** 图片下载并发数（3：对目标站友好，兼顾图床页整体耗时） */
const CLIP_CONCURRENCY = 3;

/** 桌面 Chrome UA：部分站点对无 UA / 默认 UA 返回精简页或拒答 */
const DESKTOP_UA =
	"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";

/** 可本地化的图片 MIME 白名单（与 imageExtOf 映射同源） */
const IMAGE_MIMES = new Set([
	"image/png",
	"image/jpeg",
	"image/webp",
	"image/gif",
	"image/svg+xml",
	"image/bmp",
]);

/** 大小写不敏感取响应头（requestUrl 头键大小写不定） */
function headerOf(headers: Record<string, string>, name: string): string {
	const lower = name.toLowerCase();
	for (const [key, value] of Object.entries(headers)) {
		if (key.toLowerCase() === lower) {
			return value;
		}
	}
	return "";
}

/**
 * 抓取网页 HTML：requestUrl（throw:false 自判状态码）+ 桌面 UA；字节按
 * decodeHtmlBytes 链（BOM → Content-Type charset → meta charset → utf-8 容错）
 * 解码，覆盖 GBK 老站。网络层异常与业务失败统一转中文 Error（Modal 直显）。
 */
export async function fetchHtml(url: string): Promise<string> {
	let response: Awaited<ReturnType<typeof requestUrl>>;
	try {
		response = await requestUrl({
			url,
			method: "GET",
			headers: {
				"User-Agent": DESKTOP_UA,
				Accept: "text/html,application/xhtml+xml,*/*;q=0.8",
				"Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
			},
			throw: false,
		});
	} catch (err) {
		console.warn("[MarinMind] 剪藏抓取失败", url, err);
		throw new Error("无法连接该网址（网络不可用、站点拒绝访问或需要代理）", { cause: err });
	}
	if (response.status !== 200) {
		throw new Error(`网页返回 HTTP ${response.status}，无法剪藏`);
	}
	const contentType = headerOf(response.headers, "content-type")
		.split(";")[0]
		.trim()
		.toLowerCase();
	// CT 明确非网页（文件/接口）时早失败——解码出的乱码只会产出更迷惑的「提取不到正文」
	if (
		contentType &&
		!/^(?:text\/html|application\/xhtml\+xml|text\/xml|application\/xml|text\/plain)/.test(
			contentType,
		)
	) {
		throw new Error(`该网址返回的不是网页（${contentType}），无法剪藏`);
	}
	return decodeHtmlBytes(response.arrayBuffer, contentType);
}

/**
 * 并发受限的任务池：同时至多 limit 个 worker 在飞，结果按输入下标对齐
 * （乱序完成不乱序输出）。worker 抛错直接向上传播（调用方保证逐项容错）。
 */
export async function runLimited<T, R>(
	items: readonly T[],
	limit: number,
	worker: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
	const results = new Array<R>(items.length);
	let next = 0;
	// 车道数 = min(limit, 任务数)（且 ≥1 才有车道；空集直接空结果）
	const lanes = Math.min(Math.max(1, limit), items.length);
	const runLane = async (): Promise<void> => {
		for (;;) {
			const index = next++;
			if (index >= items.length) {
				return;
			}
			results[index] = await worker(items[index]!, index);
		}
	};
	await Promise.all(Array.from({ length: lanes }, () => runLane()));
	return results;
}

/** URL 路径后缀 → 图片扩展名（CT 缺失/通用类型时的兜底；非图片后缀返回 null） */
function urlImageExt(url: string): string | null {
	const m = /\.(png|jpe?g|webp|gif|bmp|svg)(?:[?#]|$)/i.exec(url);
	if (!m) {
		return null;
	}
	const ext = m[1]!.toLowerCase();
	return ext === "jpeg" ? "jpg" : ext;
}

/** data:image/*;base64 内联图解码（非 base64 形态与坏输入返回 null） */
function decodeDataUriImage(uri: string): FetchedImage | null {
	const m = /^data:(image\/[\w.+-]+)?(;base64)?,([\s\S]*)$/.exec(uri);
	if (!m || !m[2]) {
		return null; // 非 base64 的图片 data: URI 罕见到不值得支持
	}
	const mime = m[1] ?? "";
	if (mime && !IMAGE_MIMES.has(mime)) {
		return null;
	}
	try {
		const bin = atob(m[3]!);
		if (bin.length === 0 || bin.length > MAX_IMAGE_BYTES) {
			return null;
		}
		const bytes = new Uint8Array(bin.length);
		for (let i = 0; i < bin.length; i++) {
			bytes[i] = bin.charCodeAt(i);
		}
		return { bytes: bytes.buffer, ext: mime ? imageExtOf(mime) : "png" };
	} catch {
		return null;
	}
}

/** 远程图片抓取：非 200 / 空体 / 超限 / CT 明示非图片（错误页防伪）判失败 */
async function fetchRemoteImage(url: string): Promise<FetchedImage | null> {
	let response: Awaited<ReturnType<typeof requestUrl>>;
	try {
		response = await requestUrl({ url, method: "GET", throw: false });
	} catch (err) {
		console.warn("[MarinMind] 剪藏图片请求失败", url, err);
		return null;
	}
	if (response.status !== 200) {
		return null;
	}
	const bytes = response.arrayBuffer;
	if (bytes.byteLength === 0 || bytes.byteLength > MAX_IMAGE_BYTES) {
		return null;
	}
	const contentType = headerOf(response.headers, "content-type")
		.split(";")[0]
		.trim()
		.toLowerCase();
	// text/html / json 多半是图床的错误页——存成假 png 只会产出坏图
	if (contentType.startsWith("text/") || contentType === "application/json") {
		return null;
	}
	let ext: string | null;
	if (IMAGE_MIMES.has(contentType)) {
		ext = imageExtOf(contentType);
	} else {
		// application/octet-stream（图床常见）/ 空 CT：URL 后缀兜底，无后缀判失败
		ext = urlImageExt(url);
		if (!ext) {
			return null;
		}
	}
	return { bytes, ext };
}

/**
 * 批量下载剪藏图片（并发 3）：逐张容错——任一失败落 null（调用方回退远程
 * URL，绝不因单图失败中断整篇剪藏）。onProgress 携带（已完成, 总数）。
 */
export async function fetchImages(
	images: MdImageRef[],
	opts: { compress: boolean; onProgress?: (done: number, total: number) => void },
): Promise<Array<FetchedImage | null>> {
	let done = 0;
	return runLimited(images, CLIP_CONCURRENCY, async (ref) => {
		let raw: FetchedImage | null = null;
		if (ref.dataUri) {
			raw = decodeDataUriImage(ref.dataUri);
		} else if (ref.url) {
			raw = await fetchRemoteImage(ref.url);
		}
		// preparePhotoBytes 内部已容错（压缩失败回退原字节），此处不会再抛
		const data = raw ? await preparePhotoBytes(raw.bytes, raw.ext, opts.compress) : null;
		done++;
		opts.onProgress?.(done, images.length);
		return data;
	});
}

/** 逐层确保 vault 目录存在（adapter.mkdir 不更新索引，但 create/createBinary 会补登） */
async function ensureVaultDir(vault: Vault, dir: string): Promise<void> {
	for (const seg of dirSegments(dir)) {
		if (!(await vault.adapter.exists(seg))) {
			await vault.adapter.mkdir(seg);
		}
	}
}

/** 剪藏时间戳（frontmatter clipped 属性值，本地时区可读形态） */
function formatClipDate(d: Date): string {
	const pad = (n: number) => String(n).padStart(2, "0");
	return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** saveWebclip 入参（clipWebpageToNote 组装，纯数据便于独立演进；124 起落点固定 clips/ 无需 folder） */
export interface SaveWebclipInput {
	title: string;
	/** 占位符形态的正文（fillImageRefs 前） */
	markdown: string;
	/** 与 fetched 逐位对齐的图片引用（已按 MAX_CLIP_IMAGES 截断） */
	images: MdImageRef[];
	/** 逐位下载结果（null = 失败/跳过，回退远程 URL 或抹除） */
	fetched: ReadonlyArray<FetchedImage | null>;
	sourceUrl: string;
}

export interface SaveWebclipResult {
	/** 剪藏 md 的数据根相对路径（clips/<名>.md；调用方经 plugin.openClip 打开） */
	path: string;
	/** 本地化落盘的图片数 */
	imagesSaved: number;
	/** 回退保留远程链接的图片数（下载失败项） */
	imagesFallback: number;
}

/**
 * 剪藏笔记落盘（124 重写）：文件名净化 + 冲突 -2 递增（clips/ 既有文件名）→
 * 图片逐张 attachments.save 进数据根 assets/（md 引用写根相对路径文本）→
 * 占位符回填 → frontmatter（source 原网址 + clipped 时间，无 marinmind:
 * 键——book-format 扫描不会误认领为书文件）→ md 落 clips/。
 * - vault 数据根：vault.createBinary（走索引，openClip 的 getAbstractFileByPath
 *   立即可解析；adapter 直写索引滞后）；
 * - fs 数据根（桌面绝对路径）：dataLoc.adapter.writeBinary（自动建父目录）。
 * 单图落盘失败（超 20MB 上限等）回退该图远程 URL，不中断整篇。
 */
export async function saveWebclip(
	plugin: MarinMindPlugin,
	input: SaveWebclipInput,
): Promise<SaveWebclipResult> {
	const loc = plugin.dataLoc;

	// clips/ 既有文件名集合（adapter.list 读盘而非索引——目录可能刚建）
	const listing = await loc.adapter.list(CLIPS_SUBDIR);
	const taken = new Set(listing.files.map((f) => f.slice(f.lastIndexOf("/") + 1)));
	const mdName = nextFileName(sanitizeFileName(input.title, "网页剪藏"), "md", taken);

	// 图片落盘 + 占位符回填目标组装
	let imagesSaved = 0;
	let imagesFallback = 0;
	const resolved: Record<string, string> = {};
	for (let i = 0; i < input.images.length; i++) {
		const ref = input.images[i]!;
		const data = input.fetched[i] ?? null;
		if (data) {
			try {
				// md 内嵌数据根相对路径（uid 文件名无空格/括号，无需转义）
				resolved[ref.placeholder] = await plugin.attachments.save(data.bytes, data.ext);
				imagesSaved++;
			} catch (err) {
				// 单图落盘失败（超上限等）回退远程链接，不中断整篇
				console.warn("[MarinMind] 剪藏图片落盘失败（回退远程链接）", ref.url, err);
				if (ref.url) {
					resolved[ref.placeholder] = ref.url;
					imagesFallback++;
				}
			}
		} else if (ref.url) {
			resolved[ref.placeholder] = ref.url; // 下载失败回退远程链接
			imagesFallback++;
		}
		// 无远程源的失败项（data: 解码失败）无目标 → fillImageRefs 抹除
	}

	const body = fillImageRefs(input.markdown, resolved);
	const content = `---\nsource: ${input.sourceUrl}\nclipped: ${formatClipDate(new Date())}\n---\n\n${body}\n`;
	const rel = `${CLIPS_SUBDIR}/${mdName}`;
	const bytes = new TextEncoder().encode(content);
	if (loc.kind === "vault") {
		await ensureVaultDir(plugin.app.vault, joinRel(loc.rootDir, CLIPS_SUBDIR));
		// createBinary 走 vault 索引：openClip 即刻可解析（adapter.writeBinary 索引滞后）
		await plugin.app.vault.createBinary(
			joinRel(loc.rootDir, rel),
			bytes.slice().buffer as ArrayBuffer,
		);
	} else {
		await loc.adapter.writeBinary(rel, bytes.slice().buffer as ArrayBuffer);
	}
	return { path: rel, imagesSaved, imagesFallback };
}

/** clipWebpageToNote 可选项 */
export interface ClipToNoteOptions {
	/** 手填标题（空白 = 用网页标题）；Modal 的标题输入透传至此 */
	titleOverride?: string;
	/** 是否下载图片；缺省取设置 webclipDownloadImages */
	downloadImages?: boolean;
	/** 阶段进度文案回调（Modal 进度行显示） */
	onStage?: (message: string) => void;
}

/** 剪藏总产物（Modal 组装 Notice 用） */
export type ClipOutcome = SaveWebclipResult & {
	title: string;
	/** 超出 MAX_CLIP_IMAGES 截断、整段保留远程链接的图片数 */
	imagesDropped: number;
};

/**
 * 图片下载 + 落盘共用段（116 抽出）：自动模式（clipWebpageToNote）与框选
 * 剪藏（RegionClipModal）共用——截断上限 → 可选下载 → saveWebclip（落点
 * 固定数据根 clips/，无需目录校验）。markdown/images 由调用方产出（自动
 * 模式 extractArticle；框选模式用户选区），本函数只负责「占位符正文 +
 * 图片引用表」之后的网络与落盘。
 */
export async function saveClipMarkdown(
	plugin: MarinMindPlugin,
	input: { markdown: string; images: MdImageRef[]; title: string; sourceUrl: string },
	opts: { downloadImages: boolean; onStage?: (message: string) => void },
): Promise<ClipOutcome> {
	// 图片截断到上限：超出部分不下载、占位符回填远程链接
	const capped = input.images.slice(0, MAX_CLIP_IMAGES);
	const imagesDropped = input.images.length - capped.length;
	let fetched: Array<FetchedImage | null> = capped.map(() => null);
	if (opts.downloadImages && capped.length > 0) {
		opts.onStage?.(`正在下载图片（0/${capped.length}）…`);
		fetched = await fetchImages(capped, {
			compress: plugin.settings.photoCompress,
			onProgress: (done, total) => opts.onStage?.(`正在下载图片（${done}/${total}）…`),
		});
	}

	opts.onStage?.("正在保存笔记…");
	const saved = await saveWebclip(plugin, {
		title: input.title,
		markdown: input.markdown,
		images: capped,
		fetched,
		sourceUrl: input.sourceUrl,
	});
	return { ...saved, title: input.title, imagesDropped };
}

/**
 * 剪藏总入口（命令 / 主页 / Modal 共用）：URL 校验 → 抓取 → 纯函数转换 →
 * 图片下载（可选）→ 落盘（数据根 clips/）。任何一步失败抛中文 Error（调用方
 * 转 UI 错误），不写半截文件（落盘全在最后 saveWebclip 内完成）。
 */
export async function clipWebpageToNote(
	plugin: MarinMindPlugin,
	rawUrl: string,
	opts: ClipToNoteOptions = {},
): Promise<ClipOutcome> {
	await plugin.whenReady();
	const urlCheck = normalizeClipUrl(rawUrl);
	if (!urlCheck.ok) {
		throw new Error(urlCheck.reason);
	}

	opts.onStage?.("正在抓取网页…");
	const html = await fetchHtml(urlCheck.url);
	const clipped = clipWebpage(html, { baseUrl: urlCheck.url, titleOverride: opts.titleOverride });
	if (!clipped) {
		throw new Error("未能从该网页提取到正文（可能是纯脚本渲染的单页应用，或页面内容过短）");
	}
	const wantDownload = opts.downloadImages ?? plugin.settings.webclipDownloadImages;
	return saveClipMarkdown(
		plugin,
		{
			markdown: clipped.markdown,
			images: clipped.images,
			title: clipped.title,
			sourceUrl: urlCheck.url,
		},
		{ downloadImages: wantDownload, onStage: opts.onStage },
	);
}
