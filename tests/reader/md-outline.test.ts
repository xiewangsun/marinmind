import { describe, expect, it } from "vitest";
import { outlineFromHeadings, type HeadingItem } from "../../src/reader/md-outline";

/** 便捷工厂：h("## a", 2) 形态太隐晦，直接 (level, text) */
function h(level: number, text: string): HeadingItem {
	return { level, text };
}

describe("outlineFromHeadings 标题树化（㊻-B md 目录）", () => {
	it("同级标题互为根，子级挂前一个标题下", () => {
		const tree = outlineFromHeadings([h(1, "一"), h(2, "1.1"), h(2, "1.2"), h(1, "二")]);
		expect(tree.map((e) => e.title)).toEqual(["一", "二"]);
		expect(tree[0].children.map((e) => e.title)).toEqual(["1.1", "1.2"]);
		expect(tree[1].children).toHaveLength(0);
	});

	it("级别回落上溯：h3 后遇 h2 挂回 h1 层", () => {
		const tree = outlineFromHeadings([h(1, "A"), h(2, "B"), h(3, "C"), h(2, "D")]);
		expect(tree[0].children.map((e) => e.title)).toEqual(["B", "D"]);
		expect(tree[0].children[0].children.map((e) => e.title)).toEqual(["C"]);
	});

	it("级别跳跃（h1 直接到 h4 再回 h2）：回落后挂最近浅级祖先", () => {
		const tree = outlineFromHeadings([h(1, "甲"), h(4, "深"), h(2, "乙")]);
		// 标准大纲语义：## 乙 紧随 # 甲（无论中间隔了多深的标题）仍是甲的子级
		expect(tree.map((e) => e.title)).toEqual(["甲"]);
		expect(tree[0].children.map((e) => e.title)).toEqual(["深", "乙"]);
	});

	it("空文本/纯空白标题跳过不占位", () => {
		const tree = outlineFromHeadings([h(2, "  "), h(1, "有效"), h(2, "")]);
		expect(tree.map((e) => e.title)).toEqual(["有效"]);
		expect(tree).toHaveLength(1);
	});

	it("标题文本保留首尾空白 trim；page 恒 1（md 单页长文）", () => {
		const tree = outlineFromHeadings([h(1, " 标题 ")]);
		expect(tree[0].title).toBe("标题");
		expect(tree[0].page).toBe(1);
	});
});
