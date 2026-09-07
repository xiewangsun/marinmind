import { describe, expect, it } from "vitest";
import { decodeHtmlBytes } from "../../src/webclip/html-charset";

/** 多段字节拼接 */
function concat(...parts: Uint8Array[]): Uint8Array {
	const total = parts.reduce((n, p) => n + p.length, 0);
	const out = new Uint8Array(total);
	let offset = 0;
	for (const p of parts) {
		out.set(p, offset);
		offset += p.length;
	}
	return out;
}

const enc = (s: string): Uint8Array => new TextEncoder().encode(s);

describe("decodeHtmlBytes", () => {
	it("BOM 优先：UTF-8 BOM 剥除解码", () => {
		const bytes = concat(new Uint8Array([0xef, 0xbb, 0xbf]), enc("<p>中文</p>"));
		expect(decodeHtmlBytes(bytes)).toBe("<p>中文</p>");
	});
	it("BOM 优先：UTF-16LE / UTF-16BE", () => {
		const le = new Uint8Array([0xff, 0xfe, 0x41, 0x00, 0x42, 0x00]); // "AB"
		expect(decodeHtmlBytes(le)).toBe("AB");
		const be = new Uint8Array([0xfe, 0xff, 0x00, 0x41, 0x00, 0x42]);
		expect(decodeHtmlBytes(be)).toBe("AB");
	});
	it("Content-Type charset 命中（GBK 老站）", () => {
		// "中文" 的 GBK 编码：D6D0 CEC4
		const bytes = concat(
			enc("<html><body>"),
			new Uint8Array([0xd6, 0xd0, 0xce, 0xc4]),
			enc("</body></html>"),
		);
		expect(decodeHtmlBytes(bytes, "text/html; charset=gbk")).toContain("中文");
	});
	it("meta charset 声明命中（http-equiv 形态）", () => {
		const head = enc(
			'<html><head><meta http-equiv="Content-Type" content="text/html; charset=gbk"></head><body>',
		);
		const bytes = concat(head, new Uint8Array([0xd6, 0xd0, 0xce, 0xc4]), enc("</body></html>"));
		expect(decodeHtmlBytes(bytes)).toContain("中文");
	});
	it("非法 charset label 逐级回退不抛（最终 utf-8 容错）", () => {
		const bytes = enc("<p>ok</p>");
		// 形态合法但不存在的 label：TextDecoder 构造抛 RangeError → 回退链继续
		expect(decodeHtmlBytes(bytes, "text/html; charset=x-no-such-encoding")).toBe("<p>ok</p>");
	});
	it("无任何声明按 utf-8 解码（坏字节替换不抛）", () => {
		const bytes = concat(enc("<p>ok</p>"), new Uint8Array([0xff, 0xfe, 0xfd]));
		expect(decodeHtmlBytes(bytes)).toContain("<p>ok</p>");
	});
});
