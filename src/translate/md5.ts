/**
 * MD5 摘要纯函数（83 百度翻译签名用）：RFC 1321 标准实现，输入 UTF-8 字符串，
 * 输出 32 位小写 hex。运行时零 crypto 依赖（百度签名 = MD5(appid+q+salt+密钥)，
 * 引 spark-md5 等包为一段固定算法不值——标准测试向量见 tests/translate/md5.test.ts）。
 */

/** MD5 每轮循环左移位数表（RFC 1321 四轮 × 16 步） */
const SHIFTS = [
	7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9,
	14, 20, 5, 9, 14, 20, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 6, 10, 15, 21,
	6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21,
];

/** K 表：K[i] = floor(|sin(i+1)| × 2^32)（RFC 1321 第 3.4 节定义） */
const K = new Uint32Array(64);
for (let i = 0; i < 64; i++) {
	K[i] = Math.floor(Math.abs(Math.sin(i + 1)) * 2 ** 32);
}

/** 对 UTF-8 字节序列做 MD5，输出 32 位小写十六进制串 */
export function md5Hex(input: string): string {
	const msg = new TextEncoder().encode(input);
	// 填充到 64 字节对齐：原文 + 0x80 + 0…0 + 末 8 字节小端位长
	// （翻译文本长度远小于 2^29 字符，位长高 32 位恒 0——零初始化天然保持）
	const bitLen = msg.length * 8;
	const padded = new Uint8Array((((msg.length + 8) >> 6) + 1) << 6);
	padded.set(msg);
	padded[msg.length] = 0x80;
	for (let i = 0; i < 4; i++) {
		padded[padded.length - 8 + i] = (bitLen >>> (i * 8)) & 0xff;
	}

	let a0 = 0x67452301;
	let b0 = 0xefcdab89;
	let c0 = 0x98badcfe;
	let d0 = 0x10325476;
	const M = new Uint32Array(16);
	for (let off = 0; off < padded.length; off += 64) {
		for (let i = 0; i < 16; i++) {
			const p = off + i * 4;
			M[i] = padded[p] | (padded[p + 1] << 8) | (padded[p + 2] << 16) | (padded[p + 3] << 24);
		}
		let a = a0;
		let b = b0;
		let c = c0;
		let d = d0;
		for (let i = 0; i < 64; i++) {
			let f: number;
			let g: number;
			if (i < 16) {
				f = (b & c) | (~b & d);
				g = i;
			} else if (i < 32) {
				f = (d & b) | (~d & c);
				g = (5 * i + 1) % 16;
			} else if (i < 48) {
				f = b ^ c ^ d;
				g = (3 * i + 5) % 16;
			} else {
				f = c ^ (b | ~d);
				g = (7 * i) % 16;
			}
			f = (f + a + K[i] + M[g]) | 0;
			a = d;
			d = c;
			c = b;
			b = (b + ((f << SHIFTS[i]) | (f >>> (32 - SHIFTS[i])))) | 0;
		}
		a0 = (a0 + a) | 0;
		b0 = (b0 + b) | 0;
		c0 = (c0 + c) | 0;
		d0 = (d0 + d) | 0;
	}

	// 四个 32 位寄存器小端序展开为 hex
	let hex = "";
	for (const word of [a0, b0, c0, d0]) {
		for (let i = 0; i < 4; i++) {
			hex += ((word >>> (i * 8)) & 0xff).toString(16).padStart(2, "0");
		}
	}
	return hex;
}
