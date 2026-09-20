/**
 * epub 内联样式白名单过滤测试（170）：白名单属性保留重组、非白名单剥除、
 * 畸形段静默丢弃、全滤空返回 null。
 */
import { describe, expect, it } from "vitest";
import { filterInlineStyle } from "../../src/reader/epub-style";

describe("filterInlineStyle 内联样式白名单", () => {
	it("白名单属性保留（属性名大小写归一），重组 `prop: value` 序", () => {
		expect(filterInlineStyle("text-indent:2em;text-align:center")).toBe(
			"text-indent: 2em; text-align: center",
		);
		expect(filterInlineStyle("TEXT-ALIGN: right")).toBe("text-align: right");
		expect(filterInlineStyle("font-style: italic")).toBe("font-style: italic");
	});

	it("非白名单剥除（颜色/字体/字号/布局），白名单混排只留白名单", () => {
		expect(
			filterInlineStyle(
				"color:red;font-family:serif;text-indent:1.5em;font-size:20px;position:fixed",
			),
		).toBe("text-indent: 1.5em");
		expect(filterInlineStyle("color: red")).toBeNull();
	});

	it("畸形段（无冒号/空值/超长值）静默丢弃；全滤空 → null", () => {
		expect(
			filterInlineStyle("text-align; ; text-align:  ; text-align: " + "x".repeat(101)),
		).toBeNull();
		expect(filterInlineStyle("")).toBeNull();
	});
});
