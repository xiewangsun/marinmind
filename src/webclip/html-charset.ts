/**
 * HTML 字节流解码纯函数（113-A）：剪藏抓取的响应体 → 文本。
 * 检测链：BOM（UTF-8/16LE/16BE）→ Content-Type charset → 文档前 4KB 的
 * meta charset / http-equiv 声明 → 默认 utf-8。GBK/Shift-JIS 等老站编码
 * 靠 meta 扫描命中；任何一环的非法 charset label 逐级回退不抛
 * （TextDecoder 对未知 label 抛 RangeError，catch 后继续走下一环）。
 *
 * TextDecoder 为 Node（≥11）与浏览器双端全局，纯 Node 环境可直接 vitest。
 */

/** BOM 字节数组前缀匹配 */
function startsWithBytes(bytes: Uint8Array, prefix: number[]): boolean {
	return prefix.every((b, i) => bytes[i] === b);
}

/** 以 latin1（字节直读）解码头部用于 ASCII 扫描——meta 标签在 GBK/Big5 等
 * ASCII 兼容编码里字节形态不变，可直接正则 */
function scanAsciiHead(bytes: Uint8Array, length: number): string {
	let out = "";
	for (let i = 0; i < Math.min(bytes.length, length); i++) {
		out += String.fromCharCode(bytes[i]);
	}
	return out;
}

/** 从声明串（"text/html; charset=gbk" 或 meta 属性）里提取 charset label */
function charsetFromContentType(contentType: string | undefined): string | null {
	if (!contentType) {
		return null;
	}
	const m = /charset\s*=\s*"?([a-zA-Z0-9_:.-]+)/i.exec(contentType);
	return m ? m[1] : null;
}

/** 前 4KB 扫 <meta charset="gbk"> 与 <meta http-equiv="content-type" content="...; charset=gbk"> */
function charsetFromMeta(bytes: Uint8Array): string | null {
	const head = scanAsciiHead(bytes, 4096);
	const simple = /<meta[^>]+charset\s*=\s*["']?\s*([a-zA-Z0-9_:.-]+)/i.exec(head);
	if (simple) {
		return simple[1];
	}
	const httpEquiv =
		/<meta[^>]+http-equiv\s*=\s*["']?content-type["']?[^>]*content\s*=\s*["'][^"']*charset\s*=\s*([a-zA-Z0-9_:.-]+)/i.exec(
			head,
		);
	if (httpEquiv) {
		return httpEquiv[1];
	}
	// content 属性在前、http-equiv 在后的乱序写法
	const reversed =
		/<meta[^>]+content\s*=\s*["'][^"']*charset\s*=\s*([a-zA-Z0-9_:.-]+)[^"']*["'][^>]*http-equiv\s*=\s*["']?content-type["']?/i.exec(
			head,
		);
	return reversed ? reversed[1] : null;
}

/** 用指定 label 容错解码（非法 label 抛错由调用方回退；非 fatal——坏字节替换为 U+FFFD） */
function decodeWith(bytes: Uint8Array, label: string): string {
	return new TextDecoder(label).decode(bytes);
}

/**
 * 解码 HTML 响应字节为文本。BOM 优先级最高（写入方语义最明确）且顺手剥除；
 * 命不中任何声明按 utf-8 容错解码（现代网页绝对主流）。
 * @param bytes 响应体（requestUrl.arrayBuffer 的视图/副本均可）
 * @param contentType 响应头 Content-Type（可省）
 */
export function decodeHtmlBytes(bytes: ArrayBuffer | Uint8Array, contentType?: string): string {
	const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
	// 1) BOM：UTF-8（EF BB BF）/ UTF-16LE（FF FE）/ UTF-16BE（FE FF）
	if (startsWithBytes(view, [0xef, 0xbb, 0xbf])) {
		return decodeWith(view.subarray(3), "utf-8");
	}
	if (startsWithBytes(view, [0xff, 0xfe])) {
		return decodeWith(view.subarray(2), "utf-16le");
	}
	if (startsWithBytes(view, [0xfe, 0xff])) {
		return decodeWith(view.subarray(2), "utf-16be");
	}
	// 2) Content-Type 头 charset → 3) meta 声明，逐级尝试（非法/未知 label 跳过）
	for (const label of [charsetFromContentType(contentType), charsetFromMeta(view)]) {
		if (!label) {
			continue;
		}
		try {
			return decodeWith(view, label);
		} catch {
			// 非法 label（RangeError）→ 下一环
		}
	}
	// 4) 默认 utf-8 容错（非 fatal：坏字节替换不抛）
	return decodeWith(view, "utf-8");
}
