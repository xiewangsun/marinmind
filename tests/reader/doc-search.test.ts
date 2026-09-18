import { describe, expect, it } from "vitest";
import {
	buildSnippet,
	PAGE_HIT_CAP,
	pdfLinesFromSpecs,
	searchTexts,
	snippetSegments,
	TOTAL_HIT_CAP,
	type PdfSearchLine,
} from "../../src/reader/doc-search";
import type { PdfTextSpanSpec } from "../../src/reader/pdf-document";

/** 造一个文本 spec（top = 基线 y - fontSize 的近似，left 像素） */
function spec(text: string, left: number, top: number, fontSize = 14): PdfTextSpanSpec {
	return { text, left, top, fontSize };
}

describe("pdfLinesFromSpecs（PDF 文本聚行，89-D）", () => {
	it("空 specs 返回空数组", () => {
		expect(pdfLinesFromSpecs([])).toEqual([]);
	});

	it("同 top 的分 item 按左序拼成一行（CJK 分 item 短语恢复可搜）", () => {
		const lines = pdfLinesFromSpecs([
			spec("中", 10, 100),
			spec("文", 20, 100),
			spec("拼", 30, 100),
			spec("接", 40, 100),
		]);
		expect(lines).toHaveLength(1);
		expect(lines[0].text).toBe("中文拼接");
	});

	it("left 乱序输入行内按左序排列", () => {
		const lines = pdfLinesFromSpecs([spec("界", 30, 100), spec("世", 10, 100)]);
		expect(lines).toHaveLength(1);
		expect(lines[0].text).toBe("世界");
		expect(lines[0].left).toBe(10);
	});

	it("不同 top 超容差分两行", () => {
		const lines = pdfLinesFromSpecs([
			spec("上行", 10, 100),
			spec("下行", 10, 130), // 字号 14 容差 ≈ 4.9px，30px 远超
		]);
		expect(lines).toHaveLength(2);
		expect(lines.map((l) => l.text)).toEqual(["上行", "下行"]);
	});

	it("同视觉行轻微 top 漂移（±2px 内）合并", () => {
		const lines = pdfLinesFromSpecs([spec("He", 10, 100), spec("llo", 30, 101.5)]);
		expect(lines).toHaveLength(1);
		expect(lines[0].text).toBe("Hello");
	});

	it("行混排字号：容差随两侧最大字号放大，仍合一", () => {
		// 大字 30px 基线近似 top 偏小 10px，容差 = max(2, 30×0.35)=10.5 ≥ 10 → 合并
		const lines = pdfLinesFromSpecs([spec("大标题", 10, 90, 30), spec("小字", 100, 100, 14)]);
		expect(lines).toHaveLength(1);
		expect(lines[0].fontSize).toBe(30);
	});

	it("拉丁 item 直接拼接不合成空格（mid-word 拆分不破词）", () => {
		const lines = pdfLinesFromSpecs([spec("Hel", 10, 100), spec("lo", 28, 100)]);
		expect(lines[0].text).toBe("Hello");
	});

	it("行元数据：top 取行内最小、left 取最左", () => {
		const lines = pdfLinesFromSpecs([spec("b", 30, 102), spec("a", 10, 100)]);
		expect(lines[0].top).toBe(100);
		expect(lines[0].left).toBe(10);
	});
});

describe("buildSnippet（命中摘要，89-D）", () => {
	it("命中居中文本中部无省略号", () => {
		const text = "0123456789".repeat(6);
		const snippet = buildSnippet(text, 30, 4);
		expect(snippet.startsWith("…")).toBe(true);
		expect(snippet.endsWith("…")).toBe(true);
		expect(snippet).toContain(text.slice(30, 34));
	});

	it("命中在开头/结尾只加单侧省略号", () => {
		const text = "这是一个用来测试摘要功能的长句子，必须包含足够多足够多的字符数量才行。";
		expect(buildSnippet(text, 0, 2).startsWith("…")).toBe(false);
		expect(buildSnippet(text, 0, 2).endsWith("…")).toBe(true);
		const tail = text.length - 3;
		expect(buildSnippet(text, tail, 2).startsWith("…")).toBe(true);
		expect(buildSnippet(text, tail, 2).endsWith("…")).toBe(false);
	});

	it("短文本整段返回", () => {
		expect(buildSnippet("短句命中", 0, 2)).toBe("短句命中");
	});
});

describe("searchTexts（三形态统一匹配，89-D）", () => {
	it("空/空白查询早退空结果", () => {
		expect(searchTexts(1, ["关键词"], "")).toEqual({ hits: [], truncated: false });
		expect(searchTexts(1, ["关键词"], "  ")).toEqual({ hits: [], truncated: false });
	});

	it("单段多处命中各成一条（含重叠）", () => {
		const { hits } = searchTexts(3, ["aa aa baa"], "aa");
		expect(hits).toHaveLength(3);
		expect(hits.every((h) => h.page === 3 && h.lineIndex === 0)).toBe(true);
	});

	it("大小写不敏感；命中记录段序与摘要", () => {
		const { hits } = searchTexts(2, ["无关段", "Memory Consolidation 睡眠"], "consolidation");
		expect(hits).toHaveLength(1);
		expect(hits[0].lineIndex).toBe(1);
		expect(hits[0].snippet).toContain("Consolidation");
	});

	it("超过每页上限截断并置 truncated", () => {
		const texts = Array.from({ length: PAGE_HIT_CAP + 2 }, () => "关键词重复");
		const { hits, truncated } = searchTexts(1, texts, "关键词");
		expect(truncated).toBe(true);
		expect(hits.length).toBeLessThanOrEqual(PAGE_HIT_CAP);
	});

	it("恰好每页上限不截断", () => {
		const texts = Array.from({ length: PAGE_HIT_CAP }, () => "命中一次");
		const { hits, truncated } = searchTexts(1, texts, "命中");
		expect(hits).toHaveLength(PAGE_HIT_CAP);
		expect(truncated).toBe(false);
	});

	it("无命中返回空", () => {
		expect(searchTexts(1, ["甲", "乙"], "丙").hits).toHaveLength(0);
	});

	it("总量上限常量为约定值（Modal 停扫依据）", () => {
		expect(TOTAL_HIT_CAP).toBe(200);
	});

	it("PDF 聚行结果可直接作 texts 传入（CJK 短语命中）", () => {
		const lines: PdfSearchLine[] = pdfLinesFromSpecs([
			spec("长时程", 10, 100),
			spec("增强", 40, 100),
		]);
		const { hits } = searchTexts(
			7,
			lines.map((l) => l.text),
			"长时程增强",
		);
		expect(hits).toHaveLength(1);
		expect(hits[0].page).toBe(7);
	});
});

describe("snippetSegments（命中摘要分段，91 批语义；151 审查改版：段落化免拼 HTML）", () => {
	it("大小写不敏感：查询词与原文大小写不一致也标原文形态", () => {
		expect(snippetSegments("consol", "Memory Consolidation")).toEqual([
			{ text: "Memory ", hit: false },
			{ text: "Consol", hit: true },
			{ text: "idation", hit: false },
		]);
		expect(snippetSegments("memory", "Memory 管理")).toEqual([
			{ text: "Memory", hit: true },
			{ text: " 管理", hit: false },
		]);
	});

	it("段落化不再需要转义（HTML 特殊字符原样入段，渲染侧 textContent 天然安全）", () => {
		expect(snippetSegments("命中", `<b>命中</b>`)).toEqual([
			{ text: "<b>", hit: false },
			{ text: "命中", hit: true },
			{ text: "</b>", hit: false },
		]);
	});

	it("多处命中全标", () => {
		expect(snippetSegments("ab", "ab_ab_ab")).toEqual([
			{ text: "ab", hit: true },
			{ text: "_", hit: false },
			{ text: "ab", hit: true },
			{ text: "_", hit: false },
			{ text: "ab", hit: true },
		]);
	});

	it("空/空白 query 返回单段非命中", () => {
		expect(snippetSegments("", "a<b>c")).toEqual([{ text: "a<b>c", hit: false }]);
		expect(snippetSegments("   ", "a<b>c")).toEqual([{ text: "a<b>c", hit: false }]);
	});

	it("query 含 & / < / .* 按字面匹配（原文定位不错位）", () => {
		expect(snippetSegments("a&b", "x a&b y")).toEqual([
			{ text: "x ", hit: false },
			{ text: "a&b", hit: true },
			{ text: " y", hit: false },
		]);
		expect(snippetSegments(".*", "a .* b")).toEqual([
			{ text: "a ", hit: false },
			{ text: ".*", hit: true },
			{ text: " b", hit: false },
		]);
	});

	it("重叠不嵌套（aaa 搜 aa 只标首个）", () => {
		expect(snippetSegments("aa", "aaa")).toEqual([
			{ text: "aa", hit: true },
			{ text: "a", hit: false },
		]);
	});

	it("无命中返回单段原文", () => {
		expect(snippetSegments("丙", "甲乙")).toEqual([{ text: "甲乙", hit: false }]);
	});
});
