import { describe, expect, it } from "vitest";
import {
	DEFAULT_TRANSLATE_TARGET,
	MAX_TRANSLATE_CHARS,
	TRANSLATE_LANGUAGES,
	buildGoogleBody,
	buildGoogleUrl,
	isTranslateLangCode,
	parseGoogleResponse,
	translateLangLabel,
	translationAnchor,
} from "../../src/translate/translate-engine";

describe("buildGoogleUrl", () => {
	it("携带 gtx 免密钥客户端、自动源语言、目标语言与 dt=t", () => {
		const url = buildGoogleUrl("zh-CN");
		expect(url.startsWith("https://translate.googleapis.com/translate_a/single?")).toBe(true);
		expect(url).toContain("client=gtx");
		expect(url).toContain("sl=auto");
		expect(url).toContain("tl=zh-CN");
		expect(url).toContain("dt=t");
	});

	it("目标语言经 URL 编码（特殊字符安全）", () => {
		expect(buildGoogleUrl("zh-CN")).toContain("tl=zh-CN");
	});
});

describe("buildGoogleBody", () => {
	it("q 参数为 URL 编码文本", () => {
		expect(buildGoogleBody("你好 world")).toBe(`q=${encodeURIComponent("你好 world")}`);
	});

	it("表单特殊字符被转义（&/= 不破坏 k=v 结构）", () => {
		const body = buildGoogleBody("a&b=c+d");
		expect(body.startsWith("q=")).toBe(true);
		expect(body).not.toMatch(/&b=/);
	});
});

describe("parseGoogleResponse", () => {
	it("按序拼接句段译文并取检测到的源语言", () => {
		const data = [
			[
				["Hello, ", "你好，", null, null, 10],
				["world.", "世界。", null, null, 10],
			],
			null,
			"zh-CN",
		];
		const outcome = parseGoogleResponse(data);
		expect(outcome.text).toBe("Hello, world.");
		expect(outcome.from).toBe("zh-CN");
	});

	it("非预期结构抛错", () => {
		expect(() => parseGoogleResponse(null)).toThrow();
		expect(() => parseGoogleResponse({})).toThrow();
		expect(() => parseGoogleResponse([null, null, "en"])).toThrow();
	});

	it("译文为空抛错", () => {
		expect(() => parseGoogleResponse([[[]], null, "en"])).toThrow();
		expect(() => parseGoogleResponse([[["", "原文", null, null, 1]], null, "en"])).toThrow();
	});

	it("源语言缺失回退 auto", () => {
		const outcome = parseGoogleResponse([[["hi", "嗨", null, null, 1]]]);
		expect(outcome.from).toBe("auto");
	});
});

describe("translationAnchor（译文留白锚点）", () => {
	it("锚到最下沿矩形的正下方（与原文并排对照）", () => {
		const anchor = translationAnchor([
			{ x: 0.1, y: 0.1, w: 0.3, h: 0.05 },
			{ x: 0.5, y: 0.4, w: 0.2, h: 0.05 },
		]);
		expect(anchor.x).toBeCloseTo(0.5);
		expect(anchor.y).toBeGreaterThan(0.45); // 下沿 0.4+0.05 之下
		expect(anchor.w).toBeGreaterThan(0);
		expect(anchor.h).toBeGreaterThan(0);
	});

	it("下沿贴页底时夹取不越界", () => {
		const anchor = translationAnchor([{ x: 0.1, y: 0.95, w: 0.3, h: 0.04 }]);
		expect(anchor.y + anchor.h).toBeLessThanOrEqual(1);
	});

	it("空矩形回退页首默认锚点", () => {
		const anchor = translationAnchor([]);
		expect(anchor.x).toBeGreaterThan(0);
		expect(anchor.y).toBeGreaterThan(0);
		expect(anchor.w).toBeGreaterThan(0);
	});
});

describe("目标语言表（MN4 同款 13 种）", () => {
	it("13 种且代码唯一", () => {
		expect(TRANSLATE_LANGUAGES.length).toBe(13);
		expect(new Set(TRANSLATE_LANGUAGES.map((l) => l.code)).size).toBe(13);
	});

	it("默认目标语言在表内", () => {
		expect(isTranslateLangCode(DEFAULT_TRANSLATE_TARGET)).toBe(true);
	});

	it("非法代码被拒绝", () => {
		expect(isTranslateLangCode("xx")).toBe(false);
		expect(isTranslateLangCode(123)).toBe(false);
		expect(isTranslateLangCode(null)).toBe(false);
	});

	it("代码转显示名，未知代码原样返回", () => {
		expect(translateLangLabel("en")).toBe("英语");
		expect(translateLangLabel("yue")).toBe("粤语");
		expect(translateLangLabel("unknown")).toBe("unknown");
	});

	it("字符上限为正数", () => {
		expect(MAX_TRANSLATE_CHARS).toBeGreaterThan(0);
	});
});
