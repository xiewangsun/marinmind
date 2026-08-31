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
 */

/** 缓存条目：一个被共享的 PdfDocument 与其引用计数 */
interface PdfEntry {
	doc: PdfDocument;
	byteLength: number;
	refs: number;
	/** 已从缓存表移除（被新内容替换）：仅剩存量持有者，release 归零即销毁 */
	detached: boolean;
}

/** acquirePdf 的返回句柄：调用方用完必须 release（幂等） */
export interface PdfHandle {
	readonly doc: PdfDocument;
	/** 归还一个引用；最后一个引用释放时销毁文档并清出缓存 */
	release(): void;
}

const cache = new Map<string, PdfEntry>();

/** 在途首次解析（单飞）：await 同 key 的后来者搭同一班车 */
const openings = new Map<string, { promise: Promise<PdfEntry>; byteLength: number }>();

/** 缓存键：统一路径分隔符（Windows 库外绝对路径 `\` 与 vault `/` 归一） */
export function pdfCacheKey(path: string): string {
	return path.replace(/\\/g, "/");
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
				if (!entry.detached && cache.get(key) === entry) {
					cache.delete(key);
				}
				void entry.doc.destroy();
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
		hit.refs += 1;
		return entryHandle(key, hit);
	}
	if (hit) {
		// 同 key 字节数不符（文件被替换）：旧条目让位——存量持有者的 release
		// 仍走原条目计数，归零自然销毁，不会悬挂
		hit.detached = true;
		cache.delete(key);
		if (hit.refs === 0) {
			void hit.doc.destroy();
		}
	}
	const opening = openings.get(key);
	if (opening && opening.byteLength === bytes.byteLength) {
		const entry = await opening.promise; // 单飞：搭首次解析的车
		entry.refs += 1;
		return entryHandle(key, entry);
	}
	if (opening) {
		// 病态时序（解析在途且文件已被替换为不同大小）：不进缓存，独立开一份
		const doc = await PdfDocument.open(bytes);
		return entryHandle(key, { doc, byteLength: bytes.byteLength, refs: 1, detached: true });
	}
	const p = (async () => {
		try {
			const doc = await PdfDocument.open(bytes);
			const entry: PdfEntry = {
				doc,
				byteLength: bytes.byteLength,
				refs: 0,
				detached: false,
			};
			cache.set(key, entry);
			return entry;
		} finally {
			openings.delete(key);
		}
	})();
	openings.set(key, { promise: p, byteLength: bytes.byteLength });
	const entry = await p;
	entry.refs += 1;
	return entryHandle(key, entry);
}

/**
 * 短期持有者入口：路径已在缓存中则借一份引用（refs++），否则返回 null。
 * 用于弹窗等"可能赶不上阅读器生命周期"的窗口期，防止 reader 关标签把文档销毁。
 */
export function retainPdf(key: string): PdfHandle | null {
	const entry = cache.get(key);
	if (!entry || entry.detached) {
		return null;
	}
	entry.refs += 1;
	return entryHandle(key, entry);
}
