// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import {
	CLICK_THRESHOLD,
	CONTAIN_RATIO,
	describeElement,
	injectBaseHref,
	isClickGesture,
	rectContainment,
	resolveRegionElement,
	type RegionRect,
} from "../../src/webclip/region-resolve";

/**
 * jsdom 无布局引擎（getBoundingClientRect 恒零）且未实现 elementFromPoint——
 * 逐元素 rect 桩 + document 级命中桩注入后测同一实现（运行时真实 DOM 直跑）。
 */

/** 给元素装视口矩形桩 */
function box(el: Element, x: number, y: number, w: number, h: number): Element {
	el.getBoundingClientRect = () =>
		({
			left: x,
			top: y,
			width: w,
			height: h,
			right: x + w,
			bottom: y + h,
			x,
			y,
			toJSON() {},
		}) as DOMRect;
	return el;
}

/** 构建带桩文档：hit 为 elementFromPoint 指定返回（null = 空白命中） */
function makeDoc(html: string, hit: Element | null): Document {
	const doc = new DOMParser().parseFromString(html, "text/html");
	doc.elementFromPoint = () => hit as Element | null;
	return doc;
}

describe("isClickGesture", () => {
	it("宽高均小于阈值判定为单击", () => {
		expect(isClickGesture({ x: 10, y: 10, w: 4, h: 3 })).toBe(true);
		expect(isClickGesture({ x: 10, y: 10, w: 0, h: 0 })).toBe(true);
	});
	it("达到 5px 即视为拖框（边界含等号）", () => {
		expect(isClickGesture({ x: 0, y: 0, w: CLICK_THRESHOLD, h: 2 })).toBe(false);
		expect(isClickGesture({ x: 0, y: 0, w: 100, h: 3 })).toBe(false);
	});
});

describe("rectContainment", () => {
	it("全包含为 1，无交集为 0，半覆盖 0.5", () => {
		const rect: RegionRect = { x: 0, y: 0, w: 100, h: 100 };
		expect(rectContainment(rect, { x: -50, y: -50, w: 200, h: 200 })).toBe(1);
		expect(rectContainment(rect, { x: 200, y: 200, w: 50, h: 50 })).toBe(0);
		expect(rectContainment(rect, { x: 50, y: 0, w: 100, h: 100 })).toBe(0.5);
	});
	it("零面积矩形返回 0（防除零）", () => {
		expect(rectContainment({ x: 5, y: 5, w: 0, h: 0 }, { x: 0, y: 0, w: 10, h: 10 })).toBe(0);
	});
	it("负宽交叠（仅边线接触）不算覆盖", () => {
		const rect: RegionRect = { x: 0, y: 0, w: 50, h: 50 };
		expect(rectContainment(rect, { x: 50, y: 0, w: 50, h: 50 })).toBe(0);
	});
});

describe("resolveRegionElement", () => {
	it("单击直取命中的最深元素（不上溯）", () => {
		const doc = new DOMParser().parseFromString(
			`<html><body><article><p id="hit">段落</p></article></body></html>`,
			"text/html",
		);
		const p = doc.getElementById("hit")!;
		box(p, 0, 0, 100, 30);
		box(doc.body, 0, 0, 800, 600);
		doc.elementFromPoint = () => p;
		expect(resolveRegionElement(doc, { x: 40, y: 10, w: 2, h: 2 })).toBe(p);
	});

	it("拖框命中段落 → 上溯到覆盖 ≥95% 的 article", () => {
		const doc = new DOMParser().parseFromString(
			`<html><body><div class="layout"><article class="post"><p id="p">正文段落</p></article></div></body></html>`,
			"text/html",
		);
		const p = doc.getElementById("p")!;
		const article = doc.querySelector("article")!;
		box(p, 10, 10, 300, 40);
		box(article, 8, 8, 380, 400);
		box(doc.querySelector(".layout")!, 0, 0, 800, 600);
		box(doc.body, 0, 0, 800, 600);
		doc.elementFromPoint = () => p;
		// 拖框 100-370/50-380：p 只盖一角，article 全包含 → 取 article
		const got = resolveRegionElement(doc, { x: 100, y: 50, w: 270, h: 330 });
		expect(got).toBe(article);
	});

	it("跨列拖框无内层祖先全包含 → 落到 body（覆盖全视口）", () => {
		const doc = new DOMParser().parseFromString(
			`<html><body><div class="col" id="c1"><p id="p">左列</p></div><div class="col" id="c2">右列</div></body></html>`,
			"text/html",
		);
		const p = doc.getElementById("p")!;
		box(p, 0, 0, 200, 100);
		box(doc.getElementById("c1")!, 0, 0, 200, 600);
		box(doc.getElementById("c2")!, 200, 0, 200, 600);
		box(doc.body, 0, 0, 800, 600);
		doc.elementFromPoint = () => p;
		// 拖框横跨两列：c1 只覆盖一半，上溯到 body 全包含
		expect(resolveRegionElement(doc, { x: 0, y: 0, w: 400, h: 500 })).toBe(doc.body);
	});

	it("elementFromPoint 空白命中（null）→ body 兜底", () => {
		const doc = makeDoc(`<html><body><p>内容</p></body></html>`, null);
		expect(resolveRegionElement(doc, { x: 10, y: 10, w: 2, h: 2 })).toBe(doc.body);
	});

	it("阈值边界：覆盖率恰达 CONTAIN_RATIO 即采纳", () => {
		const doc = new DOMParser().parseFromString(
			`<html><body><section id="s"><p id="p">段</p></section></body></html>`,
			"text/html",
		);
		const p = doc.getElementById("p")!;
		const s = doc.getElementById("s")!;
		// 拖框 0-100：s 覆盖 0-95 → 恰好 0.95，采纳 s（不再上溯 body）
		box(p, 40, 10, 20, 20);
		box(s, 0, 0, 95, 100);
		box(doc.body, 0, 0, 800, 600);
		doc.elementFromPoint = () => p;
		const got = resolveRegionElement(doc, { x: 0, y: 0, w: 100, h: 100 });
		expect(got).toBe(s);
		expect(rectContainment({ x: 0, y: 0, w: 100, h: 100 }, { x: 0, y: 0, w: 95, h: 100 })).toBe(
			CONTAIN_RATIO,
		);
	});
});

describe("describeElement", () => {
	it("标签.类#id 形态，类名截断 24 字符", () => {
		const doc = new DOMParser().parseFromString(
			`<html><body><div class="article-content" id="main"></div><div class="${"x".repeat(40)}"></div></body></html>`,
			"text/html",
		);
		expect(describeElement(doc.querySelector("#main")!)).toBe("div.article-content#main");
		const long = describeElement(doc.querySelectorAll("div")[1]!);
		expect(long.startsWith("div.")).toBe(true);
		expect(long.length).toBeLessThanOrEqual("div.".length + 24);
	});
	it("无类无 id 只出标签名", () => {
		const doc = new DOMParser().parseFromString(
			`<html><body><article></article></body></html>`,
			"text/html",
		);
		expect(describeElement(doc.querySelector("article")!)).toBe("article");
	});
});

describe("injectBaseHref", () => {
	it("head 开标签后插入（href 属性转义）", () => {
		const out = injectBaseHref(
			`<!doctype html><html><head><title>t</title></head><body></body></html>`,
			`https://a.com/p?q=1&x="`,
		);
		expect(out).toContain(
			`<head><base href="https://a.com/p?q=1&amp;x=&quot;" target="_blank">`,
		);
	});
	it("无 head 时落到 body 开标签后", () => {
		const out = injectBaseHref(`<html><body><p>x</p></body></html>`, "https://a.com/");
		expect(out).toBe(
			`<html><body><base href="https://a.com/" target="_blank"><p>x</p></body></html>`,
		);
	});
	it("head/body 均无时前置", () => {
		const out = injectBaseHref(`<p>裸片段</p>`, "https://a.com/");
		expect(out.startsWith(`<base href="https://a.com/" target="_blank">`)).toBe(true);
	});
});
