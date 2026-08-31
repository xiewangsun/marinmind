import { describe, expect, it } from "vitest";
import {
	elementAttr,
	elementText,
	findElements,
	firstElement,
	parseXml,
	type XmlElement,
} from "../../src/reader/epub-xml";

describe("parseXml 基础结构（㊼ EPUB 结构解析）", () => {
	it("元素 + 单/双引号属性往返；标签与属性名小写归一", () => {
		const root = parseXml('<root Version="2.0" mode=\'auto\'><child/></root>');
		expect(root).not.toBeNull();
		expect(root!.tag).toBe("root");
		expect(root!.attrs).toEqual({ version: "2.0", mode: "auto" });
		expect(root!.children).toHaveLength(1);
		expect((root!.children[0] as { tag: string }).tag).toBe("child");
	});

	it("嵌套元素与文本节点按文档顺序混排；elementText 递归拼接并 trim", () => {
		const root = parseXml("<book><title>第一<em>卷</em>　总纲</title></book>");
		const title = root!.children[0] as XmlElement;
		expect(title.tag).toBe("title");
		expect(elementText(title)).toBe("第一卷　总纲");
	});

	it("XML 声明 / DOCTYPE（含内部子集）/ 注释 / PI 不影响解析", () => {
		const xml =
			'<?xml version="1.0" encoding="UTF-8"?>\n' +
			"<!-- 生成器注释 -->\n" +
			'<!DOCTYPE package PUBLIC "+//IDPF//DTD OPF 2.0//EN" "opf.dtd" [<!ENTITY x "y">]>\n' +
			"<?instruction ignore?>" +
			"<package><item/></package>";
		const root = parseXml(xml);
		expect(root).not.toBeNull();
		expect(root!.tag).toBe("package");
		expect(findElements(root, "item")).toHaveLength(1);
	});

	it("CDATA 原样保留（不解码实体、不当标签）", () => {
		const root = parseXml("<a><![CDATA[<b>&amp;]]></a>");
		expect(root!.children[0]).toBe("<b>&amp;");
	});

	it("自闭合与空元素等价；重复属性判畸形", () => {
		expect(parseXml("<a/>")!.children).toHaveLength(0);
		expect(parseXml("<a></a>")!.children).toHaveLength(0);
		expect(parseXml('<a x="1" x="2"/>')).toBeNull();
	});
});

describe("parseXml 实体解码", () => {
	it("五种 XML 预定义实体", () => {
		const root = parseXml('<a v="&lt;&amp;&gt;">&quot;&apos;</a>');
		expect(root!.attrs.v).toBe("<&>");
		expect(root!.children[0]).toBe('"\'');
	});

	it("十进制与十六进制数字字符引用（含 CJK）", () => {
		const root = parseXml("<a>&#20013;&#x4E66;</a>");
		expect(root!.children[0]).toBe("中书");
	});

	it("常用命名实体（nbsp/mdash/ldquo 等）解码；未知命名实体原样保留", () => {
		const root = parseXml("<a>a&nbsp;b&mdash;c&ldquo;d&quot;&fake;</a>");
		// nbsp 显式写  ，避免测试源文件里混入不可见字符
		expect(root!.children[0]).toBe("a b—c“d\"&fake;");
	});

	it("非法数字码位（0 / 越界 / 代理区）原样保留", () => {
		const root = parseXml("<a>&#0;&#x110000;&#xD800;</a>");
		expect(root!.children[0]).toBe("&#0;&#x110000;&#xD800;");
	});
});

describe("parseXml 畸形拒绝（宁拒不赌）", () => {
	it.each([
		["标签不闭合", "<a><b></a>"],
		["缺闭标签到 EOF", "<a><b/>"],
		["开闭不匹配", "<a></b>"],
		["顶层游离文本", "hello<a/>"],
		["顶层闭标签", "</a>"],
		["多根元素", "<a/><b/>"],
		["属性缺值", "<a x/>"],
		["属性值裸奔", "<a x=1/>"],
		["引号未闭合", '<a x="1/>'],
		["注释未终止", "<a><!-- x</a>"],
	])("%s → null", (_name, xml) => {
		expect(parseXml(xml as string)).toBeNull();
	});
});

describe("查询辅助", () => {
	const root = parseXml(
		"<nav><navpoint><navlabel><text>一</text></navlabel></navpoint>" +
			"<navpoint><navlabel><text>二</text></navlabel></navpoint></nav>",
	)!;

	it("findElements 深度优先按文档序收集；firstElement 取首个", () => {
		const points = findElements(root, "navpoint");
		expect(points).toHaveLength(2);
		expect(firstElement(root, "navpoint")).toBe(points[0]);
		expect(firstElement(root, "missing")).toBeNull();
	});

	it("elementAttr 大小写不敏感取值", () => {
		const opf = parseXml('<package Version="3.0" unique-identifier="id"/>')!;
		expect(elementAttr(opf, "version")).toBe("3.0");
		expect(elementAttr(opf, "Unique-Identifier")).toBe("id");
		expect(elementAttr(opf, "missing")).toBeNull();
	});
});
