// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { codeLanguageOf, domToMarkdown, fillImageRefs } from "../../src/webclip/html-to-md";

/** 从 HTML 片段取根元素（jsdom DOMParser 与运行时同一实现） */
function rootOf(html: string): Element {
	const doc = new DOMParser().parseFromString(`<body>${html}</body>`, "text/html");
	return doc.body;
}

const BASE = "https://example.com/post/page.html";

describe("domToMarkdown", () => {
	it("标题/段落/强调/删除线基础映射", () => {
		const md = domToMarkdown(
			rootOf("<h2>标题</h2><p>普通<strong>加粗</strong>与<em>斜体</em>及<del>删</del></p>"),
			{
				baseUrl: BASE,
			},
		).markdown;
		expect(md).toBe("## 标题\n\n普通**加粗**与*斜体*及~~删~~");
	});

	it("链接绝对化；锚点链接保文字；空文本链接降级自动链接", () => {
		const md = domToMarkdown(
			rootOf(
				'<p><a href="/docs/x">文档</a> · <a href="#top">顶部</a> · <a href="https://a.com"></a></p>',
			),
			{ baseUrl: BASE },
		).markdown;
		expect(md).toContain("[文档](https://example.com/docs/x)");
		expect(md).toContain("顶部");
		// 空文本链接降级自动链接（URL 规范化补尾斜杠）
		expect(md).toContain("<https://a.com/>");
	});

	it("图片占位符两遍法：收集相对/懒加载/data: 源并绝对化，无效源丢弃", () => {
		const { markdown, images } = domToMarkdown(
			rootOf(
				'<p><img src="img/a.jpg" alt="图一"></p><figure><img data-src="//cdn.b.com/p.webp"></figure>' +
					'<p><img src="data:image/png;base64,AAAA" alt="内联"></p><p><img src="javascript:void(0)"></p>',
			),
			{ baseUrl: BASE },
		);
		expect(images).toHaveLength(3);
		expect(images[0]).toMatchObject({ url: "https://example.com/post/img/a.jpg", alt: "图一" });
		// 协议相对 //cdn.b.com → https
		expect(images[1]?.url).toBe("https://cdn.b.com/p.webp");
		expect(images[2]).toMatchObject({ dataUri: "data:image/png;base64,AAAA", url: null });
		expect(markdown).toContain("![图一](__MMIMG_0__)");
		expect(markdown).toContain("![内联](__MMIMG_2__)");
	});

	it("嵌套列表逐级缩进（ul 套 ol）", () => {
		const md = domToMarkdown(
			rootOf("<ul><li>甲<ol><li>子一</li><li>子二</li></ol></li><li>乙</li></ul>"),
			{ baseUrl: BASE },
		).markdown;
		expect(md).toBe("- 甲\n  1. 子一\n  2. 子二\n- 乙");
	});

	it("引用块逐行加 > 前缀", () => {
		const md = domToMarkdown(rootOf("<blockquote><p>第一行</p><p>第二段</p></blockquote>"), {
			baseUrl: BASE,
		}).markdown;
		expect(md).toBe("> 第一行\n>\n> 第二段");
	});

	it("代码块：语言 class 推断 + 内容直收", () => {
		const md = domToMarkdown(
			rootOf('<pre><code class="language-python">print(1)\nprint(2)</code></pre>'),
			{
				baseUrl: BASE,
			},
		).markdown;
		expect(md).toBe("```python\nprint(1)\nprint(2)\n```");
	});

	it("表格转 GFM 管道表（thead 表头、| 转义）", () => {
		const md = domToMarkdown(
			rootOf(
				"<table><thead><tr><th>名称</th><th>说明</th></tr></thead>" +
					"<tbody><tr><td>a|b</td><td>2</td></tr></tbody></table>",
			),
			{ baseUrl: BASE },
		).markdown;
		expect(md).toBe("| 名称 | 说明 |\n| --- | --- |\n| a\\|b | 2 |");
	});

	it("正文文本转义特种字符，行首标记符防误解析", () => {
		const md = domToMarkdown(
			rootOf(
				"<p>*不是斜体* 与 [非链接] 与<code>码</code></p><p># 恰好井号开头</p><p>1. 恰好数字开头</p>",
			),
			{ baseUrl: BASE },
		).markdown;
		expect(md).toContain("\\*不是斜体\\* 与 \\[非链接\\] 与`码`");
		expect(md).toContain("\\# 恰好井号开头");
		expect(md).toContain("1\\. 恰好数字开头");
	});
});

describe("codeLanguageOf", () => {
	it("language-/lang-/highlight- 前缀优先", () => {
		expect(codeLanguageOf("language-typescript")).toBe("typescript");
		expect(codeLanguageOf("lang-py")).toBe("py");
		expect(codeLanguageOf("highlight-ruby")).toBe("ruby");
	});
	it("噪声 token 过滤后单 token 猜测", () => {
		expect(codeLanguageOf("python")).toBe("python");
		expect(codeLanguageOf("prettyprint")).toBe("");
		expect(codeLanguageOf("hljs js")).toBe("js");
		expect(codeLanguageOf(null)).toBe("");
	});
});

describe("fillImageRefs", () => {
	it("占位符回填本地路径与远程 URL，空目标抹除并折叠空行", () => {
		const md = "前文\n\n![a](__MMIMG_0__)\n\n![b](__MMIMG_1__)\n\n![c](__MMIMG_2__)\n\n后文";
		const out = fillImageRefs(md, {
			__MMIMG_0__: "笔记.assets/1.webp",
			__MMIMG_1__: "https://cdn.b.com/p.webp",
			// __MMIMG_2__ 无目标 → 抹除
		});
		expect(out).toBe(
			"前文\n\n![a](笔记.assets/1.webp)\n\n![b](https://cdn.b.com/p.webp)\n\n后文",
		);
	});
	it("代码围栏内的连续空行不被折叠", () => {
		const md = "```txt\na\n\n\nb\n```";
		expect(fillImageRefs(md, {})).toBe(md);
	});
});
