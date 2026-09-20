// @vitest-environment jsdom
/**
 * md 文本锚重定位测试（169）：块查找（探针包含/空白折叠/文档序首中）+
 * 归一化 y（相对根、钳制）；getRect 注入假布局（jsdom 无布局）。
 */
import { describe, expect, it } from "vitest";
import { relocateMdAnchorY } from "../../src/reader/md-relocate";

function build(html: string): HTMLElement {
	document.body.innerHTML = `<div class="marinmind-md-doc">${html}</div>`;
	return document.body.querySelector<HTMLElement>(".marinmind-md-doc")!;
}

describe("relocateMdAnchorY 文本锚重定位", () => {
	it("按摘录文本命中块，y = (块顶 − 根顶) / 根高；编辑后重排仍精确", () => {
		const root = build(
			`<p>第一段介绍内容。</p><p>目标段落：这是被摘录的句子，值得记忆。</p><p>第三段结尾。</p>`,
		);
		const boxes = new Map<Element, { top: number; height: number }>();
		const p = root.querySelectorAll("p");
		boxes.set(root, { top: 0, height: 3000 });
		boxes.set(p[0]!, { top: 0, height: 100 });
		boxes.set(p[1]!, { top: 1800, height: 120 }); // 编辑后块被挤到 60% 处
		boxes.set(p[2]!, { top: 2600, height: 100 });
		const y = relocateMdAnchorY(
			root,
			"目标段落：这是被摘录的句子，值得记忆。",
			(el) => boxes.get(el) ?? { top: 0, height: 0 },
		);
		expect(y).toBeCloseTo(0.6);
	});

	it("空白折叠通吃（摘录跨行/块内多空白）＋长摘录取头部探针（尾部被编辑仍命中）", () => {
		const head = "这是一段足够长的头部内容用来验证探针截断逻辑"; // 22 字 ×2 = 44 > 32
		const longHead = head + head;
		const blockText = `${longHead}，块内的后续排版细节。`;
		const root = build(`<p>首段。</p><p>${blockText}</p>`);
		const boxes = new Map<Element, { top: number; height: number }>();
		boxes.set(root, { top: 100, height: 1000 });
		const p = root.querySelectorAll("p");
		boxes.set(p[0]!, { top: 100, height: 50 });
		boxes.set(p[1]!, { top: 600, height: 50 });
		const get = (el: Element) => boxes.get(el) ?? { top: 0, height: 0 };
		// 摘录 > 32 字符：探针只取头部（尾部与现文不符——被编辑），头部命中
		const longExcerpt = `${longHead}，\n\n后半已被用户改成完全不同的内容了`;
		expect(longExcerpt.length).toBeGreaterThan(32);
		const y = relocateMdAnchorY(root, longExcerpt, get);
		expect(y).toBeCloseTo(0.5);
	});

	it("未命中 / 探针过短 / 空文本 → null（调用方回退存量 rect）", () => {
		const root = build(`<p>唯一段落。</p>`);
		const get = (el: Element) => ({ top: 0, height: el === root ? 500 : 50 });
		expect(relocateMdAnchorY(root, "完全不存在的内容", get)).toBeNull();
		expect(relocateMdAnchorY(root, "  ", get)).toBeNull();
		expect(relocateMdAnchorY(root, "", get)).toBeNull();
	});

	it("y 钳制 [0,1]（越界布局防御）", () => {
		const root = build(`<p>目标句。</p>`);
		const get = (el: Element) =>
			el === root ? { top: 0, height: 100 } : { top: 500, height: 50 };
		expect(relocateMdAnchorY(root, "目标句", get)).toBe(1);
	});
});
