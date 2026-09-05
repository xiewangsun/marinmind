import { describe, expect, it } from "vitest";
import {
	aiPageLabel,
	buildContextText,
	chunkText,
	clampToTokenBudget,
	extractPageRefs,
	type AiContextBlock,
} from "../../src/ai/ai-context";

describe("aiPageLabel", () => {
	it("pdf 页 / epub 章 / md 全文三口径", () => {
		expect(aiPageLabel("pdf", 3)).toBe("第 3 页");
		expect(aiPageLabel("epub", 5)).toBe("第 5 章");
		expect(aiPageLabel("md", 1)).toBe("全文");
	});
});

describe("buildContextText", () => {
	it("每块前加页标记，空块过滤，块间空行分隔", () => {
		const blocks: AiContextBlock[] = [
			{ page: 1, text: "第一页内容" },
			{ page: 2, text: "" },
			{ page: 2, text: "  " },
			{ page: 3, text: "第三页内容" },
		];
		expect(buildContextText(blocks, "pdf")).toBe(
			"[第 1 页]\n第一页内容\n\n[第 3 页]\n第三页内容",
		);
	});

	it("epub 用章标记", () => {
		expect(buildContextText([{ page: 2, text: "章节正文" }], "epub")).toBe(
			"[第 2 章]\n章节正文",
		);
	});
});

describe("clampToTokenBudget", () => {
	it("预算内全保留不截断", () => {
		const blocks: AiContextBlock[] = [
			{ page: 1, text: "你好" },
			{ page: 2, text: "世界" },
		];
		const out = clampToTokenBudget(blocks, 100);
		expect(out.blocks).toHaveLength(2);
		expect(out.truncated).toBe(false);
	});

	it("超预算保头部并标记截断", () => {
		const blocks: AiContextBlock[] = [
			{ page: 1, text: "一二三四五六七八九十" }, // 10 tokens
			{ page: 2, text: "一二三四五六七八九十" },
			{ page: 3, text: "一二三四五六七八九十" },
		];
		const out = clampToTokenBudget(blocks, 25);
		expect(out.blocks.map((b) => b.page)).toEqual([1, 2]);
		expect(out.truncated).toBe(true);
	});

	it("首块超预算仍保留（不产生空上下文）", () => {
		const blocks: AiContextBlock[] = [{ page: 1, text: "很长的内容".repeat(50) }];
		const out = clampToTokenBudget(blocks, 3);
		expect(out.blocks).toHaveLength(1);
		expect(out.truncated).toBe(false);
	});

	it("空块集返回空不截断", () => {
		const out = clampToTokenBudget([], 100);
		expect(out.blocks).toEqual([]);
		expect(out.truncated).toBe(false);
	});
});

describe("chunkText", () => {
	it("空文本/纯空白返回空数组", () => {
		expect(chunkText("", 100)).toEqual([]);
		expect(chunkText("   \n\n  \n", 100)).toEqual([]);
	});

	it("段间空行优先切分：各块不超过上限（近似）", () => {
		const paras = Array.from({ length: 10 }, (_, i) => `段落${i}：${"内容".repeat(10)}`);
		const text = paras.join("\n\n");
		const chunks = chunkText(text, 100);
		expect(chunks.length).toBeGreaterThan(1);
		for (const chunk of chunks) {
			expect(chunk.length).toBeLessThanOrEqual(100 + 4); // 段间连接符容差
		}
		// 无内容丢失（拼接还原全部字符）
		expect(chunks.join("")).toContain("段落0");
		expect(chunks.join("")).toContain("段落9");
	});

	it("超长无空行段按句边界硬切", () => {
		const long = "这是第一句话。".repeat(200); // 8 字 × 200 = 1600 字
		const chunks = chunkText(long, 300);
		expect(chunks.length).toBeGreaterThan(1);
		for (const chunk of chunks) {
			expect(chunk.length).toBeLessThanOrEqual(300);
		}
		// 句边界切：每块以句号收尾
		for (const chunk of chunks.slice(0, -1)) {
			expect(chunk.endsWith("。")).toBe(true);
		}
	});

	it("无句号长段按字符硬切兜底", () => {
		const long = "字".repeat(500);
		const chunks = chunkText(long, 200);
		expect(chunks.length).toBe(3); // 200+200+100
		expect(chunks.join("")).toBe(long);
	});
});

describe("extractPageRefs", () => {
	it("全半角括号与裸格式都识别，去重保序", () => {
		const reply = "定义见（第 3 页），推导过程见(第 7 页)，结论在第 3 页与第 12 页再次出现。";
		expect(extractPageRefs(reply)).toEqual([3, 7, 12]);
	});

	it("章引用同样识别（epub 口径共用）", () => {
		expect(extractPageRefs("见（第 2 章）")).toEqual([2]);
	});

	it("无引用返回空；页码 0/超长无效丢弃", () => {
		expect(extractPageRefs("没有引用")).toEqual([]);
		expect(extractPageRefs("第 0 页")).toEqual([]);
	});
});
