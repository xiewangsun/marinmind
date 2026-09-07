// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { clipWebpage } from "../../src/webclip/webclip-engine";

/** 撑正文下限的长文本（每段约 24 字符） */
const filler = (n: number): string =>
	Array.from({ length: n }, (_, i) => `第${i}段：摘录即卡片的学习方法论与间隔重复实践。`).join(
		"",
	);

/** 端到端样本页：nav 噪声 + article 正文（标题/链接/图片/代码/引用） */
const SAMPLE = `<!doctype html><html><head><title>样本文章 - 示例站</title></head><body>
<nav><a href="/">首页</a><a href="/cat">分类</a></nav>
<div class="layout">
<article>
<h1>卡片学习法</h1>
<p>摘录即卡片，<a href="/docs/link">卡片即节点</a>。${filler(4)}</p>
<figure><img src="img/diagram.png" alt="结构图"></figure>
<p>${filler(4)}</p>
<pre><code class="language-ts">const x = 1;</code></pre>
<blockquote><p>一图胜千言。</p></blockquote>
</article>
<aside>推荐阅读</aside>
</div>
</body></html>`;

describe("clipWebpage", () => {
	it("端到端：标题提取 + 噪声剥离 + markdown 产出 + 图片收集", () => {
		const result = clipWebpage(SAMPLE, { baseUrl: "https://example.com/post/a.html" });
		expect(result).not.toBeNull();
		expect(result?.title).toBe("样本文章 - 示例站");
		expect(result?.markdown).toContain("# 卡片学习法");
		expect(result?.markdown).toContain("[卡片即节点](https://example.com/docs/link)");
		expect(result?.markdown).toContain("```ts");
		expect(result?.markdown).toContain("> 一图胜千言。");
		expect(result?.markdown).not.toContain("推荐阅读");
		expect(result?.markdown).not.toContain("首页");
		expect(result?.images).toHaveLength(1);
		expect(result?.images[0]).toMatchObject({
			url: "https://example.com/post/img/diagram.png",
			alt: "结构图",
		});
	});

	it("手填标题优先，空串视为未填回退 <title>", () => {
		const over = clipWebpage(SAMPLE, {
			baseUrl: "https://example.com/a.html",
			titleOverride: "  我的标题 ",
		});
		expect(over?.title).toBe("我的标题");
		const blank = clipWebpage(SAMPLE, {
			baseUrl: "https://example.com/a.html",
			titleOverride: "  ",
		});
		expect(blank?.title).toBe("样本文章 - 示例站");
	});

	it("无 <title> 时回退域名（去 www. 前缀）", () => {
		const html = `<html><body><article><p>${"长正文".repeat(40)}</p></article></body></html>`;
		const result = clipWebpage(html, { baseUrl: "https://www.example.com/a.html" });
		expect(result?.title).toBe("example.com");
	});

	it("SPA 空正文返回 null（上层转中文 Notice）", () => {
		expect(
			clipWebpage("<html><body><div id='app'></div></body></html>", {
				baseUrl: "https://a.com/",
			}),
		).toBeNull();
	});
});
