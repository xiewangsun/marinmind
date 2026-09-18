/**
 * Anki CSV 导出纯函数测试（139-G）：单元格转义 / 正反面映射（MN4 语义）/
 * CSV 组装（BOM + 指令行 + 三列）。命令入口（vault 落盘）为 obsidian 耦合
 * 沿用不单测先例。
 */
import { describe, expect, it, vi } from "vitest";

// 模块顶层 import { Notice }（obsidian 无运行时入口）——纯函数测试以空替身解依赖
vi.mock("obsidian", () => ({ Notice: class {} }));

import { ankiRowOf, buildAnkiCsv, csvEscape } from "../../src/review/anki-export";
import type { Card } from "../../src/types";

function card(partial: Partial<Card> = {}): Card {
	return {
		id: partial.id ?? `c${Math.random().toString(36).slice(2, 8)}`,
		documentId: null,
		page: null,
		rects: [],
		excerptType: "text",
		polygon: null,
		excerptText: null,
		excerptRef: null,
		note: null,
		color: null,
		tags: [],
		createdAt: 1700000000000,
		updatedAt: 1700000000000,
		...partial,
	};
}

describe("csvEscape 单元格转义", () => {
	it("纯文本原样不加引号（含中文）", () => {
		expect(csvEscape("强化学习")).toBe("强化学习");
		expect(csvEscape("plain text")).toBe("plain text");
	});

	it("逗号/引号/换行触发整体引号，内部引号翻倍", () => {
		expect(csvEscape("a,b")).toBe('"a,b"');
		expect(csvEscape('他说"你好"')).toBe('"他说""你好"""');
		expect(csvEscape("第一行\n第二行")).toBe('"第一行\n第二行"');
	});
});

describe("ankiRowOf 正反面映射（MN4：批注=正面，摘录=背面）", () => {
	it("批注 + 摘录 → 批注正面 / 摘录背面", () => {
		const row = ankiRowOf(
			card({ note: "什么是 Q 学习？", excerptText: "无模型的强化学习方法" }),
		);
		expect(row).toEqual({ front: "什么是 Q 学习？", back: "无模型的强化学习方法", tags: [] });
	});

	it("仅批注 → 批注正面、背面留空；仅摘录 → 摘录兜底正面", () => {
		expect(ankiRowOf(card({ note: "笔记" }))).toEqual({ front: "笔记", back: "", tags: [] });
		expect(ankiRowOf(card({ excerptText: "摘录文字" }))).toEqual({
			front: "摘录文字",
			back: "",
			tags: [],
		});
	});

	it("无文字字段（纯媒体卡）→ null；纯空白视同缺失", () => {
		expect(ankiRowOf(card({ excerptType: "photo" }))).toBeNull();
		expect(ankiRowOf(card({ excerptType: "audio", note: "  ", excerptText: " " }))).toBeNull();
	});

	it("标签去空白过滤后随行携带", () => {
		const row = ankiRowOf(card({ note: "n", tags: [" 英语 ", "", "GRE"] }));
		expect(row!.tags).toEqual(["英语", "GRE"]);
	});
});

describe("buildAnkiCsv 组装", () => {
	it("BOM 起头 + Anki 指令行 + 数据行三列（正/背/标签）", () => {
		const csv = buildAnkiCsv([
			card({ note: "问", excerptText: "答", tags: ["英语"] }),
			card({ excerptText: "只有摘录" }),
		]);
		const lines = csv.split("\n");
		expect(csv.charCodeAt(0)).toBe(0xfeff); // UTF-8 BOM（Excel 兼容，Anki 剥除）
		expect(lines[0].slice(1)).toBe("#separator:Comma");
		expect(lines[1]).toBe("#html:false");
		expect(lines[2]).toBe("问,答,英语");
		expect(lines[3]).toBe("只有摘录,,");
		expect(csv.endsWith("\n")).toBe(true);
	});

	it("含逗号/引号/换行的字段走引号转义，换行保留在 quoted cell 内不破行", () => {
		const csv = buildAnkiCsv([card({ note: '带,逗号"和"引号', excerptText: "多行\n答案" })]);
		// 整串精确比对：数据行是一个 CSV 行（字段内换行被引号包裹）
		expect(csv).toBe(
			"\uFEFF" + "#separator:Comma\n#html:false\n" + '"带,逗号""和""引号","多行\n答案",\n',
		);
	});

	it("纯媒体卡整行跳过；空输入仍产出 BOM + 指令行", () => {
		const csv = buildAnkiCsv([card({ excerptType: "photo" })]);
		expect(csv.split("\n")).toHaveLength(3); // 指令两行 + 尾空串
		const empty = buildAnkiCsv([]);
		expect(empty.charCodeAt(0)).toBe(0xfeff);
		expect(empty).toContain("#separator:Comma");
	});
});
