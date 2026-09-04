import { describe, expect, it } from "vitest";
import { md5Hex } from "../../src/translate/md5";

describe("MD5 摘要 md5Hex（83 百度签名用，RFC 1321）", () => {
	it("RFC 1321 标准向量：空串 / a / abc / message digest", () => {
		expect(md5Hex("")).toBe("d41d8cd98f00b204e9800998ecf8427e");
		expect(md5Hex("a")).toBe("0cc175b9c0f1b6a831c399e269772661");
		expect(md5Hex("abc")).toBe("900150983cd24fb0d6963f7d28e17f72");
		expect(md5Hex("message digest")).toBe("f96b697d7cb7938d525a2f31aaf161d0");
	});

	it("UTF-8 多字节向量：中文与含空格串（签名拼接会出现中英混合）", () => {
		// 向量与 node crypto MD5（UTF-8）逐位核对
		expect(md5Hex("中文")).toBe("a7bac2239fcdcb3a067903d8077c4a07");
		expect(md5Hex(" MarinMind ")).toBe("39ba72850867b493e0a8f0ee40821c7c");
	});

	it("长输入跨多个 64 字节分组（填充边界：55/56/64 字节附近）", () => {
		// 56 字节恰触发第二分组（56+1+8=65 > 64）；64 字节整组另起；向量与 node crypto 核对
		expect(md5Hex("x".repeat(56))).toBe("668a72d5ba17f08e62dabcafad6db14b");
		expect(md5Hex("x".repeat(64))).toBe("c1bb4f81d892b2d57947682aeb252456");
		expect(md5Hex("x".repeat(55))).not.toBe(md5Hex("x".repeat(56)));
	});
});
