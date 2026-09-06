import { PdfDocument } from "./pdf-document";

/**
 * 跨视图共享的已解析 PDF 缓存（㊳ 性能）：
 * 同一文件被多个视图打开（两个阅读标签 / 阅读器 + AI 摘录弹窗 + 复习上下文缩略图）
 * 时复用同一次 getDocument 解析结果，引用计数归零才销毁。
 *
 * - 键 = 规范化文件路径（`pdfCacheKey` 统一分隔符）
 * - 命中判定用 byteLength：同尺寸异内容漏检（同路径文件在两次读取间被替换且大小
 *   恰好不变）——可接受，换来零哈希开销；尺寸不符则按"文件已替换"整条重建
 * - 并发同 key 的 acquire 单飞（等首次解析，不重复 open）
 *
 * 112 空闲暖窗：refs 归零不再立即销毁——进入 60s 暖窗 + LRU（≤2 份）保留，
 * 期间 retainPdf/acquirePdf 直接复用（免整份字节读取 + 重新解析）。动机：主页
 * 卡片预览的页裁剪出图（renderPageCrop）此前每次 acquire→release，从主页打开
 * （无人长期持有）时每次点击都重读重解析大文件，预览要 1-2 秒；暖窗内重复打开
 * 同书的卡片即时出图。代价是空闲期多占 ≤2 份已解析文档内存（与 context-preview
 * 的 MAX_OPEN_DOCS 同量级）。
 */

/** 空闲保留时长：refs 归零后到点仍未被引用才销毁 */
const WARM_IDLE_MS = 60_000;
/** 空闲保留份数上限（LRU，超限淘汰最久未暖入的） */
const MAX_WARM = 2;

/** 缓存条目：一个被共享的 PdfDocument 与其引用计数 */
interface PdfEntry {
	doc: PdfDocument;
	byteLength: number;
	refs: number;
	/** 已从缓存表移除（被新内容替换）：仅剩存量持有者，release 归零即销毁 */
	detached: boolean;
	/** 暖窗计时器句柄（非暖入态为 null）；到点仍 refs≤0 则真销毁 */
	warmTimer: ReturnType<typeof setTimeout> | null;
}

/** acquirePdf 的返回句柄：调用方用完必须 release（幂等） */
export interface PdfHandle {
	readonly doc: PdfDocument;
	/** 归还一个引用；最后一个引用释放时进入空闲暖窗（112 前为立即销毁） */
	release(): void;
}

const cache = new Map<string, PdfEntry>();

/** 在途首次解析（单飞）：await 同 key 的后来者搭同一班车 */
const openings = new Map<string, { promise: Promise<PdfEntry>; byteLength: number }>();

/** 空闲条目表（Map 迭代序 = 最近暖入序，作 LRU 淘汰依据） */
const warm = new Map<string, PdfEntry>();

/** 缓存键：统一路径分隔符（Windows 库外绝对路径 `\` 与 vault `/` 归一） */
export function pdfCacheKey(path: string): string {
	return path.replace(/\\/g, "/");
}

/** 脱离暖表并停表（保留 cache 条目与否由调用方决定） */
function leaveWarm(key: string, entry: PdfEntry): void {
	if (entry.warmTimer !== null) {
		clearTimeout(entry.warmTimer);
		entry.warmTimer = null;
	}
	warm.delete(key);
}

/** 真销毁：清 cache 映射（仍指向本条目时）并销毁文档 */
function destroyEntry(key: string, entry: PdfEntry): void {
	leaveWarm(key, entry);
	if (cache.get(key) === entry) {
		cache.delete(key);
	}
	void entry.doc.destroy();
}

/**
 * 进入/续期暖窗：refs 刚归零的未替换条目。重置计时器并置顶 LRU；
 * 超出保留份数时淘汰最久未暖入的（真销毁）。
 */
function enterWarm(key: string, entry: PdfEntry): void {
	leaveWarm(key, entry);
	warm.set(key, entry);
	entry.warmTimer = setTimeout(() => {
		entry.warmTimer = null;
		if (entry.refs <= 0 && !entry.detached) {
			destroyEntry(key, entry); // 暖窗到点仍无人引用
		}
	}, WARM_IDLE_MS);
	while (warm.size > MAX_WARM) {
		const oldestKey = warm.keys().next().value;
		if (oldestKey === undefined || oldestKey === key) {
			break; // 只剩自己（MAX_WARM ≥ 1 时不可能被淘汰）
		}
		const oldest = warm.get(oldestKey);
		warm.delete(oldestKey);
		if (oldest) {
			if (oldest.warmTimer !== null) {
				clearTimeout(oldest.warmTimer);
				oldest.warmTimer = null;
			}
			if (cache.get(oldestKey) === oldest) {
				cache.delete(oldestKey);
			}
			void oldest.doc.destroy();
		}
	}
}

/** 包装条目为句柄（每次 acquire/retain 独立一份，release 各自扣减一次） */
function entryHandle(key: string, entry: PdfEntry): PdfHandle {
	let released = false;
	return {
		doc: entry.doc,
		release: () => {
			if (released) {
				return; // 幂等：重复 release 只扣一次
			}
			released = true;
			entry.refs -= 1;
			if (entry.refs <= 0) {
				if (entry.detached) {
					// 已被替换：无暖窗资格，直接销毁（脱离暖表防计时器悬挂）
					destroyEntry(key, entry);
				} else {
					// 112 暖窗：归零先保留 60s（重复打开同书即时出图），到点真销毁
					enterWarm(key, entry);
				}
			}
		},
	};
}

/**
 * 打开（或复用）文件路径对应的 PDF 文档。
 * @param bytes 调用方刚读取的文件内容（首开时解析；复用时不消费——仅比对长度）
 */
export async function acquirePdf(key: string, bytes: ArrayBuffer): Promise<PdfHandle> {
	const hit = cache.get(key);
	if (hit && hit.byteLength === bytes.byteLength) {
		leaveWarm(key, hit); // 复用即脱离暖窗（refs 将 > 0，计时器作废）
		hit.refs += 1;
		return entryHandle(key, hit);
	}
	if (hit) {
		// 同 key 字节数不符（文件被替换）：旧条目让位——存量持有者的 release
		// 仍走原条目计数，归零自然销毁，不会悬挂
		hit.detached = true;
		leaveWarm(key, hit);
		cache.delete(key);
		if (hit.refs === 0) {
			void hit.doc.destroy();
		}
	}
	const opening = openings.get(key);
	if (opening && opening.byteLength === bytes.byteLength) {
		const entry = await opening.promise; // 单飞：搭首次解析的车
		leaveWarm(key, entry);
		entry.refs += 1;
		return entryHandle(key, entry);
	}
	if (opening) {
		// 病态时序（解析在途且文件已被替换为不同大小）：不进缓存，独立开一份
		const doc = await PdfDocument.open(bytes);
		return entryHandle(key, {
			doc,
			byteLength: bytes.byteLength,
			refs: 1,
			detached: true,
			warmTimer: null,
		});
	}
	const p = (async () => {
		try {
			const doc = await PdfDocument.open(bytes);
			const entry: PdfEntry = {
				doc,
				byteLength: bytes.byteLength,
				refs: 0,
				detached: false,
				warmTimer: null,
			};
			cache.set(key, entry);
			return entry;
		} finally {
			openings.delete(key);
		}
	})();
	openings.set(key, { promise: p, byteLength: bytes.byteLength });
	const entry = await p;
	leaveWarm(key, entry);
	entry.refs += 1;
	return entryHandle(key, entry);
}

/**
 * 短期持有者入口：路径已在缓存中则借一份引用（refs++），否则返回 null。
 * 用于弹窗等"可能赶不上阅读器生命周期"的窗口期，防止 reader 关标签把文档销毁；
 * 112 起也命中暖窗条目（refs 归零后 60s 内仍可借——renderPageCrop 借此跳过
 * 整份字节读取与重新解析）。注意：暖窗命中无字节可比，文件在窗口内被替换的
 * 漏检可接受（仅预览出图、窗口极短；正式阅读路径仍读字节经 acquire 比对）。
 */
export function retainPdf(key: string): PdfHandle | null {
	const entry = cache.get(key);
	if (!entry || entry.detached) {
		return null;
	}
	leaveWarm(key, entry);
	entry.refs += 1;
	return entryHandle(key, entry);
}
