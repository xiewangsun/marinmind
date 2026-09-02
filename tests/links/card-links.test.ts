import { describe, expect, it } from "vitest";
import {
	buildCardCopyText,
	buildCardEmbed,
	buildCardLink,
	cardLinkTarget,
} from "../../src/links/card-links";
import type { Card } from "../../src/types";

/** Card 字段较多，用工厂补默认值（对齐 map-context 测试先例） */
function makeCard(id: string, over: Partial<Card> = {}): Card {
	return {
		id,
		documentId: null,
		page: null,
		rects: [],
		excerptType: "text",
		excerptText: `摘录-${id}`,
		excerptRef: null,
		note: null,
		color: null,
		title: null,
		deck: null,
		occlusions: [],
		tags: [],
		createdAt: 0,
		updatedAt: 0,
		...over,
	};
}

describe("cardLinkTarget 链接目标拼接", () => {
	it("数据根前缀 + 书文件 + 块锚点，剥 .md 扩展名", () => {
		expect(cardLinkTarget("MarinMind", "学习英语.md", "c1")).toBe(
			"MarinMind/学习英语#^card-c1",
		);
	});

	it("rootDir 为空（数据根即 vault 根）直接用书文件路径", () => {
		expect(cardLinkTarget("", "未归类卡片.md", "x")).toBe("未归类卡片#^card-x");
	});

	it("嵌套路径书文件逐段保留", () => {
		expect(cardLinkTarget("MarinMind", "子目录/书.md", "k")).toBe(
			"MarinMind/子目录/书#^card-k",
		);
	});
});

describe("buildCardLink / buildCardEmbed 文本形态", () => {
	it("链接带别名（cardTitle 同源），嵌入无别名前缀 !", () => {
		expect(buildCardLink("MarinMind/书#^card-a", "标题")).toBe(
			"[[MarinMind/书#^card-a|标题]]",
		);
		expect(buildCardEmbed("MarinMind/书#^card-a")).toBe("![[MarinMind/书#^card-a]]");
	});

	it("标题方括号转全角、换行压空格（不破坏 wikilink 语法）", () => {
		expect(buildCardLink("t#^card-b", "注[释]")).toBe("[[t#^card-b|注［释］]]");
		expect(buildCardLink("t#^card-b", "a\nb")).toBe("[[t#^card-b|a b]]");
	});
});

describe("buildCardCopyText 入口整合", () => {
	it("link 模式 = wikilink（标题推导 cardTitle 优先级）", () => {
		expect(buildCardCopyText("link", "MarinMind", "书.md", makeCard("c", { note: "批注" })))
			.toBe("[[MarinMind/书#^card-c|批注]]");
	});

	it("embed 模式 = 嵌入语法（无别名）", () => {
		expect(buildCardCopyText("embed", "MarinMind", "书.md", makeCard("c"))).toBe(
			"![[MarinMind/书#^card-c]]",
		);
	});
});
