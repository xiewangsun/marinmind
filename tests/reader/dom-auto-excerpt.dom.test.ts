// @vitest-environment jsdom
/**
 * DOM 版面 AI 摘录纯函数测试（164）：结构走查（标签分类/跳过规则/文档序）
 * + 布局换算（归一化/钳制/截断）。走查只依赖 DOM 结构（jsdom 原生）；
 * 布局换算经 getBox 注入（纯数学）。
 */
import { describe, expect, it } from "vitest";
import {
	collectDomBlocks,
	domBlocksToAuto,
	DOM_BLOCK_CAP,
} from "../../src/reader/dom-auto-excerpt";

function build(html: string): Element {
	document.body.innerHTML = `<div id="root">${html}</div>`;
	return document.body.querySelector("#root")!;
}

describe("collectDomBlocks 结构走查", () => {
	it("h1-h6 → heading、p/li → body，文档序保持", () => {
		const root = build(
			`<h1>标题一</h1><p>段落甲。</p><ul><li>列表项一</li><li>列表项二</li></ul><h2>小节</h2><p>段落乙。</p>`,
		);
		const blocks = collectDomBlocks(root);
		expect(blocks.map((b) => [b.kind, b.text])).toEqual([
			["heading", "标题一"],
			["body", "段落甲。"],
			["body", "列表项一"],
			["body", "列表项二"],
			["heading", "小节"],
			["body", "段落乙。"],
		]);
	});

	it("pre/code/table/svg 子树整族跳过；松散列表 li 内嵌 p 不重复收集", () => {
		const root = build(
			`<pre><p>代码里的假段落</p></pre>` +
				`<table><tbody><tr><td><p>表格段落</p></td></tr></tbody></table>` +
				`<ul><li><p>松散列表内嵌段落</p></li></ul>`,
		);
		const blocks = collectDomBlocks(root);
		expect(blocks).toHaveLength(1); // 只剩 li 整体
		expect(blocks[0]!.kind).toBe("body");
		expect(blocks[0]!.text).toBe("松散列表内嵌段落");
	});

	it("空白与单字符文本跳过；连续空白折叠为单空格", () => {
		const root = build(`<p>  </p><p>a</p><p>多　行\n换行\t制表</p>`);
		const blocks = collectDomBlocks(root);
		expect(blocks.map((b) => b.text)).toEqual(["多 行 换行 制表"]);
	});
});

describe("domBlocksToAuto 布局换算", () => {
	it("归一化相对基准盒并钳制 [0,1]；产物复用 AutoBlock 形状", () => {
		const root = build(`<h1>题</h1><p>文</p>`.replace("题", "标题").replace("文", "正文"));
		const blocks = collectDomBlocks(root);
		const base = { left: 100, top: 200, width: 400, height: 1000 };
		// 标题盒 (150, 220, 200, 40)；正文盒越界 (-50, 3000, 100, 5000) 验证钳制
		const boxes = new Map<
			Element,
			{ left: number; top: number; width: number; height: number }
		>([
			[blocks[0]!.el, { left: 150, top: 220, width: 200, height: 40 }],
			[blocks[1]!.el, { left: -50, top: 3000, width: 100, height: 5000 }],
		]);
		const { blocks: auto, truncated } = domBlocksToAuto(blocks, base, (el) => boxes.get(el)!);
		expect(truncated).toBe(false);
		expect(auto[0]).toEqual({
			kind: "heading",
			text: "标题",
			rects: [{ x: 0.125, y: 0.02, w: 0.5, h: 0.04 }],
		});
		// 左/上越界钳 0：x=0（(-50-100)/400 为负）、y=1（(3000-200)/1000=2.8 → 1）
		expect(auto[1]!.rects[0]!.x).toBe(0);
		expect(auto[1]!.rects[0]!.y).toBe(1);
	});

	it(`超 ${DOM_BLOCK_CAP} 块截断并置 truncated`, () => {
		const root = build(new Array(DOM_BLOCK_CAP + 5).fill("<p>段落</p>").join(""));
		const blocks = collectDomBlocks(root);
		expect(blocks).toHaveLength(DOM_BLOCK_CAP + 5);
		const { blocks: auto, truncated } = domBlocksToAuto(
			blocks,
			{ left: 0, top: 0, width: 100, height: 100 },
			() => ({ left: 0, top: 0, width: 10, height: 10 }),
		);
		expect(truncated).toBe(true);
		expect(auto).toHaveLength(DOM_BLOCK_CAP);
	});
});
