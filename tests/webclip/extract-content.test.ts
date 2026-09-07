// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { extractArticle } from "../../src/webclip/extract-content";

/**
 * 生成 n 段中文长文本（每段约 24 字符）。115 起成段正文门槛 120 字：
 * 正文用例统一 filler(6)（144 字）起步，壳用例刻意压在门槛下。
 */
const filler = (n: number): string =>
	Array.from({ length: n }, (_, i) => `第${i}段内容：知识卡片与思维导图的学习方法论实践。`).join(
		"",
	);

describe("extractArticle", () => {
	it("article 语义标签优先命中，nav/aside 噪声整块剥离", () => {
		const html = `<!doctype html><html><head><title>文章标题</title></head><body>
			<nav><a href="/">首页</a><a href="/x">目录</a></nav>
			<aside>侧栏推荐</aside>
			<article><h1>正文标题</h1><p>${filler(6)}</p></article>
			</body></html>`;
		const result = extractArticle(html);
		expect(result).not.toBeNull();
		expect(result?.title).toBe("文章标题");
		expect(result?.root.tagName).toBe("ARTICLE");
		expect(result?.root.textContent).not.toContain("侧栏推荐");
	});

	it("main 与 [role=main] 候选兜底", () => {
		const html = `<html><body><div id="wrap"><main><p>${filler(6)}</p></main></div></body></html>`;
		expect(extractArticle(html)?.root.tagName).toBe("MAIN");
		const html2 = `<html><body><div role="main"><p>${filler(6)}</p></div></body></html>`;
		expect(extractArticle(html2)?.root.tagName).toBe("DIV");
	});

	it("无语义标签时按类名关键词+段落评分取正文容器", () => {
		const html = `<html><body>
			<div id="wrap">
				<div class="content"><p>${filler(4)}</p><p>${filler(4)}</p></div>
				<div class="promo"><p>${filler(4)}</p></div>
			</div></body></html>`;
		const result = extractArticle(html);
		expect(result?.root.className).toBe("content");
	});

	it("链接密度过半的导航壳出局，不抢正文", () => {
		const html = `<html><body>
			<div class="menu"><a href="/1">链接一长串占正文</a><a href="/2">链接继续占正文</a><a href="/3">链接还在占正文</a></div>
			<div><p>${filler(6)}</p></div>
			</body></html>`;
		const result = extractArticle(html);
		// menu 链接密度 1 出局；正文 div（无类名）以文本量胜出
		expect(result?.root.className).not.toBe("menu");
		expect(result?.root.textContent).toContain("第0段内容");
	});

	it("SPA 空壳返回 null", () => {
		expect(extractArticle("<html><body><div id='app'></div></body></html>")).toBeNull();
	});

	it("正文不足 80 字符返回 null", () => {
		expect(extractArticle("<html><body><p>太短</p></body></html>")).toBeNull();
	});

	// ===== 115 修复四缺陷的新增场景 =====

	it("多个 article 同台竞争：侧栏推荐卡在前也不抢跑（115 语义候选不再首个早退）", () => {
		const html = `<html><body>
			<div class="layout">
			<div class="side"><article class="card"><p>${filler(8)}</p></article><article class="card"><p>${filler(8)}</p></article></div>
			<article class="post"><h1>真正的正文</h1><p>${filler(20)}</p></article>
			</div></body></html>`;
		const result = extractArticle(html);
		expect(result?.root.className).toBe("post");
		expect(result?.root.textContent).toContain("真正的正文");
	});

	it("side-content 负向关键词强扣，不再被子串命中误加分（115）", () => {
		const html = `<html><body>
			<div class="side-content recommend-list"><p>${filler(10)}</p></div>
			<div class="article-body"><p>${filler(12)}</p></div>
			</body></html>`;
		const result = extractArticle(html);
		expect(result?.root.className).toBe("article-body");
	});

	it("整页壳无成段正文返回 null（gitee 形态：面板+链接农场，正文由脚本渲染，115 诚实失败）", () => {
		const html = `<html><body>
			<div class="ui container">
			<div class="repo-panel"><div>Watch</div><a href="/s">Star 0</a><a href="/f">Fork 6</a><div>开源协议 MIT</div><div>默认分支 main</div><span>仓库面板文本撑过最短正文下限的一长串说明文字继续补充更多面板内容</span></div>
			<div class="dialog"><p>确定同步？此操作将覆盖自 Fork 仓库以来所做的任何修改且无法恢复，确定后同步将在后台操作完成时刷新页面请耐心等待。</p></div>
			<div class="services"><a href="/q">质量分析</a><a href="/j">Jenkins</a><a href="/c">云托管</a><a href="/s2">Serverless</a><span>服务推广位文本</span></div>
			<div class="readme-holder">README 区域（服务端为空，脚本渲染）</div>
			</div></body></html>`;
		// 面板文本总量过 80 字符（能进评分），但成段正文（p）全在已剥除的 dialog 里
		const result = extractArticle(html);
		expect(result).toBeNull();
	});

	it("python-guide 形态回归：div.body[role=main] 语义命中且不被外层壳/侧栏抢走", () => {
		const html = `<html><body>
			<div class="document"><div class="documentwrapper"><div class="bodywrapper">
			<div class="body" role="main"><div class="section"><h2>WSGI</h2><p>${filler(10)}</p></div><div class="section"><h2>Frameworks</h2><p>${filler(10)}</p></div></div>
			</div></div></div>
			<div class="sphinxsidebar" role="navigation"><p>侧栏导航链接一</p><p>侧栏导航链接二</p></div>
			</body></html>`;
		const result = extractArticle(html);
		expect(result?.root.className).toBe("body");
		expect(result?.root.textContent).not.toContain("侧栏导航");
	});

	it("隐藏 UI（modal/aria-hidden）整块剥离，文本不混入产物（115）", () => {
		const html = `<html><body>
			<article><h1>正文标题</h1><p>${filler(6)}</p></article>
			<div class="modal-mask"><div class="modal"><p>弹窗正文：${filler(20)}</p></div></div>
			<div aria-hidden="true"><p>隐藏层文本：${filler(20)}</p></div>
			</body></html>`;
		const result = extractArticle(html);
		expect(result?.root.tagName).toBe("ARTICLE");
		expect(result?.root.textContent).not.toContain("弹窗正文");
		// 全页只剩隐藏 UI 时同样提取不到（剥离先于评分）
		expect(
			extractArticle("<html><body><div class='modal'><p>只有弹窗</p></div></body></html>"),
		).toBeNull();
	});
});
