import { describe, expect, it } from "vitest";
import {
	DEFAULT_TRANSLATE_TARGET,
	MAX_TRANSLATE_CHARS,
	TRANSLATE_ENGINES,
	TRANSLATE_ENGINE_IDS,
	TRANSLATE_LANGUAGES,
	buildBaiduSign,
	buildGoogleBody,
	buildGoogleUrl,
	buildYoudaoSign,
	defaultEngineCall,
	isTranslateEngineId,
	isTranslateLangCode,
	parseGoogleResponse,
	resolveEngineCall,
	translateLangLabel,
	translationAnchor,
} from "../../src/translate/translate-engine";
import { md5Hex } from "../../src/translate/md5";

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

// ---------- 83 多引擎注册表 ----------

describe("引擎注册表（83，85-B 增有道）", () => {
	it("四引擎且 google 首位（缺省引擎语义）", () => {
		expect(TRANSLATE_ENGINES.map((e) => e.id)).toEqual(["google", "baidu", "youdao", "deepl"]);
		expect(defaultEngineCall().engine.id).toBe("google");
	});

	it("isTranslateEngineId 守卫真假值（手编 data.json 防御）", () => {
		for (const id of TRANSLATE_ENGINE_IDS) {
			expect(isTranslateEngineId(id)).toBe(true);
		}
		expect(isTranslateEngineId("caiyun")).toBe(false);
		expect(isTranslateEngineId(7)).toBe(false);
	});

	it("Google def 收编既有函数：mapTarget 恒等 + 请求构造与原函数一致", () => {
		const google = TRANSLATE_ENGINES[0];
		expect(google.mapTarget("yue")).toBe("yue");
		const spec = google.buildRequest("hello", "zh-CN", {
			baiduAppid: "",
			baiduSecret: "",
			youdaoAppKey: "",
			youdaoAppSecret: "",
			deeplKey: "",
		});
		expect(spec.url).toBe(buildGoogleUrl("zh-CN"));
		expect(spec.body).toBe(buildGoogleBody("hello"));
		expect(spec.headers["Content-Type"]).toBe("application/x-www-form-urlencoded");
	});
});

describe("百度翻译引擎（83）", () => {
	const cred = {
		baiduAppid: "appid-1",
		baiduSecret: "sec&ret",
		youdaoAppKey: "",
		youdaoAppSecret: "",
		deeplKey: "",
	};
	const baidu = TRANSLATE_ENGINES.find((e) => e.id === "baidu")!;

	it("buildBaiduSign 拼接序：MD5(appid + q原文 + salt + 密钥)——q 未编码", () => {
		// 与 md5Hex 直算对照：签名的输入串就是四段原样拼接
		const q = "机器学习&deep learning";
		expect(buildBaiduSign("appid-1", q, "salt-9", "sec&ret")).toBe(
			md5Hex(`appid-1${q}salt-9sec&ret`),
		);
	});

	it("mapTarget 全部 13 种目标语言均有映射", () => {
		for (const lang of TRANSLATE_LANGUAGES) {
			expect(baidu.mapTarget(lang.code)).not.toBeNull();
		}
		expect(baidu.mapTarget("zh-CN")).toBe("zh");
		expect(baidu.mapTarget("zh-TW")).toBe("cht");
		expect(baidu.mapTarget("ja")).toBe("jp");
		expect(baidu.mapTarget("lzh")).toBe("wyw");
		expect(baidu.mapTarget("xx")).toBeNull();
	});

	it("buildRequest：urlencoded 参数齐全且 sign 与 body 内 salt/q 可复算（q 特殊字符）", () => {
		const text = "a=b&c d";
		const spec = baidu.buildRequest(text, "jp", cred);
		expect(spec.url).toBe("https://fanyi.baidu.com/api/trans/vip/translate");
		const params = new URLSearchParams(spec.body);
		expect(params.get("q")).toBe(text); // 编码往返无损
		expect(params.get("from")).toBe("auto");
		expect(params.get("to")).toBe("jp");
		expect(params.get("appid")).toBe("appid-1");
		const salt = params.get("salt")!;
		expect(salt.length).toBeGreaterThan(0);
		// 服务端按未编码 q 校验签名：本地复算必须一致
		expect(params.get("sign")).toBe(buildBaiduSign("appid-1", text, salt, "sec&ret"));
	});

	it("parse 正常响应：dst 按序 join + from 百度缩写转 Google 代码", () => {
		const out = baidu.parse({
			from: "zh",
			to: "en",
			trans_result: [
				{ src: "机器", dst: "machine" },
				{ src: "学习", dst: "learning" },
			],
		});
		expect(out.text).toBe("machine\nlearning");
		expect(out.from).toBe("zh-CN");
	});

	it("parse error_code 非空抛带 code 的中文错（54001 签名错等）", () => {
		expect(() => baidu.parse({ error_code: "54001", error_msg: "Invalid Sign" })).toThrow(
			/54001/,
		);
		expect(() => baidu.parse({ trans_result: [] })).toThrow("翻译响应格式异常");
		expect(() => baidu.parse(null)).toThrow("翻译响应格式异常");
	});
});

describe("有道翻译引擎（85-B）", () => {
	const cred = {
		baiduAppid: "",
		baiduSecret: "",
		youdaoAppKey: "appkey-1",
		youdaoAppSecret: "sec&ret",
		deeplKey: "",
	};
	const youdao = TRANSLATE_ENGINES.find((e) => e.id === "youdao")!;

	it("buildYoudaoSign 拼接序：MD5(appKey + q全文 + salt + 密钥)——经典签名 q 不截断", () => {
		// 与 md5Hex 直算对照（与百度签名同构）
		const q = "机器学习&deep learning";
		expect(buildYoudaoSign("appkey-1", q, "salt-9", "sec&ret")).toBe(
			md5Hex(`appkey-1${q}salt-9sec&ret`),
		);
	});

	it("q 超过 20 字符仍全文参与签名（input 截断仅属 v3——若误用会在此暴露）", () => {
		// 21 字符长句：v3 的 input 截断 = 前10+长度+后10，两者签名必然不同
		const q20 = "a".repeat(20);
		const q21 = "a".repeat(21);
		for (const q of [q20, q21]) {
			expect(buildYoudaoSign("k", q, "s", "t")).toBe(md5Hex(`k${q}st`));
		}
	});

	it("mapTarget：简繁用有道惯用码，粤语/文言文不支持返回 null", () => {
		for (const lang of TRANSLATE_LANGUAGES) {
			const mapped = youdao.mapTarget(lang.code);
			if (lang.code === "yue" || lang.code === "lzh") {
				expect(mapped).toBeNull();
			} else {
				expect(mapped).not.toBeNull();
			}
		}
		expect(youdao.mapTarget("zh-CN")).toBe("zh-CHS");
		expect(youdao.mapTarget("zh-TW")).toBe("zh-CHT");
		expect(youdao.mapTarget("xx")).toBeNull();
	});

	it("buildRequest：openapi 端点 urlencoded 参数齐全，sign 可按 body 内 salt/q 复算", () => {
		const text = "a=b&c d";
		const spec = youdao.buildRequest(text, "en", cred);
		expect(spec.url).toBe("https://openapi.youdao.com/api");
		expect(spec.headers["Content-Type"]).toBe("application/x-www-form-urlencoded");
		const params = new URLSearchParams(spec.body);
		expect(params.get("q")).toBe(text); // 编码往返无损
		expect(params.get("from")).toBe("auto");
		expect(params.get("to")).toBe("en");
		expect(params.get("appKey")).toBe("appkey-1");
		const salt = params.get("salt")!;
		expect(salt.length).toBeGreaterThan(0);
		// 服务端按未编码 q 全文校验签名：本地复算必须一致
		expect(params.get("sign")).toBe(buildYoudaoSign("appkey-1", text, salt, "sec&ret"));
		// 经典 MD5 签名不携带 v3 参数（signType/curtime/input）
		expect(params.get("signType")).toBeNull();
		expect(params.get("curtime")).toBeNull();
		expect(params.get("input")).toBeNull();
	});

	it("parse 正常响应：translation 按行 join + l 源段映射（zh-CHS → zh-CN）", () => {
		const out = youdao.parse({
			translation: ["machine learning"],
			l: "zh-CHS->en",
			query: "机器学习",
		});
		expect(out.text).toBe("machine learning");
		expect(out.from).toBe("zh-CN");
	});

	it("parse：errorCode 数字/字符串形态统一识别，成功无该字段", () => {
		expect(() => youdao.parse({ errorCode: 202 })).toThrow(/202.*签名/);
		expect(() => youdao.parse({ errorCode: "110" })).toThrow(/110.*文本翻译服务/);
		expect(() => youdao.parse({ translation: ["ok"] })).not.toThrow(); // 无 errorCode
	});

	it("parse：异常结构与空结果抛错；未知 l 源码原样、缺 l 回退 auto", () => {
		expect(() => youdao.parse({ translation: [] })).toThrow("翻译响应格式异常");
		expect(() => youdao.parse(null)).toThrow("翻译响应格式异常");
		expect(() => youdao.parse({ translation: [""] })).toThrow("翻译结果为空");
		expect(youdao.parse({ translation: ["hi"], l: "xx-YY->en" }).from).toBe("xx-YY");
		expect(youdao.parse({ translation: ["hi"] }).from).toBe("auto");
	});
});

describe("DeepL 引擎（83）", () => {
	const deepl = TRANSLATE_ENGINES.find((e) => e.id === "deepl")!;

	it("mapTarget 大写化，zh-TW/粤语/文言文不支持返回 null", () => {
		expect(deepl.mapTarget("en")).toBe("EN");
		expect(deepl.mapTarget("zh-CN")).toBe("ZH");
		expect(deepl.mapTarget("zh-TW")).toBeNull();
		expect(deepl.mapTarget("yue")).toBeNull();
		expect(deepl.mapTarget("lzh")).toBeNull();
	});

	it("buildRequest 按 key :fx 后缀选免费版端点，Auth 头原样携带 key", () => {
		const free = deepl.buildRequest("hi", "EN", {
			baiduAppid: "",
			baiduSecret: "",
			youdaoAppKey: "",
			youdaoAppSecret: "",
			deeplKey: "abc:fx",
		});
		expect(free.url).toBe("https://api-free.deepl.com/v2/translate");
		expect(free.headers.Authorization).toBe("DeepL-Auth-Key abc:fx");
		const pro = deepl.buildRequest("hi", "EN", {
			baiduAppid: "",
			baiduSecret: "",
			youdaoAppKey: "",
			youdaoAppSecret: "",
			deeplKey: "abc123",
		});
		expect(pro.url).toBe("https://api.deepl.com/v2/translate");
		expect(JSON.parse(pro.body)).toEqual({ text: ["hi"], target_lang: "EN" });
	});

	it("parse：translations[0] + 检测语言大写转显示代码（ZH → zh-CN）；异常结构抛错", () => {
		const out = deepl.parse({
			translations: [{ detected_source_language: "ZH", text: "机器学习" }],
		});
		expect(out).toEqual({ text: "机器学习", from: "zh-CN" });
		expect(() => deepl.parse({ message: "Wrong endpoint" })).toThrow("翻译响应格式异常");
		expect(() => deepl.parse({ translations: [{ text: "" }] })).toThrow("翻译结果为空");
	});
});

describe("resolveEngineCall（83，85-B 增有道）", () => {
	it("引擎脏值/缺省回 google；百度/有道/DeepL 凭据缺失抛中文错", () => {
		expect(resolveEngineCall({}).engine.id).toBe("google");
		expect(resolveEngineCall({ translateEngine: "caiyun" }).engine.id).toBe("google");
		expect(() => resolveEngineCall({ translateEngine: "baidu" })).toThrow(/百度翻译需要/);
		expect(() =>
			resolveEngineCall({ translateEngine: "baidu", translateBaiduAppid: "a" }),
		).toThrow(/百度翻译需要/);
		expect(() => resolveEngineCall({ translateEngine: "youdao" })).toThrow(/有道翻译需要/);
		expect(() =>
			resolveEngineCall({ translateEngine: "youdao", translateYoudaoAppid: "k" }),
		).toThrow(/有道翻译需要/);
		expect(() => resolveEngineCall({ translateEngine: "deepl" })).toThrow(/DeepL 需要/);
	});

	it("凭据原样解析（trim 收敛）且正常返回对应引擎", () => {
		const call = resolveEngineCall({
			translateEngine: "baidu",
			translateBaiduAppid: " app-1 ",
			translateBaiduSecret: " sec ",
			translateDeeplKey: 42,
		});
		expect(call.engine.id).toBe("baidu");
		expect(call.cred.baiduAppid).toBe("app-1");
		expect(call.cred.baiduSecret).toBe("sec");
		expect(call.cred.deeplKey).toBe("");
	});

	it("有道凭据 trim 收敛并正常返回引擎", () => {
		const call = resolveEngineCall({
			translateEngine: "youdao",
			translateYoudaoAppid: " key-1 ",
			translateYoudaoAppSecret: " sec-1 ",
		});
		expect(call.engine.id).toBe("youdao");
		expect(call.cred.youdaoAppKey).toBe("key-1");
		expect(call.cred.youdaoAppSecret).toBe("sec-1");
	});
});
