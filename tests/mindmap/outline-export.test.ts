import { describe, expect, it } from "vitest";
import {
	buildOutlineMarkdown,
	buildOutlineOpml,
	outlineLineText,
	type OutlineGraphNode,
} from "../../src/mindmap/outline-export";
import type { Card } from "../../src/types";

/** 最小卡片工厂（纯函数测试用，不需要存储） */
function makeCard(over: Partial<Card> & Pick<Card, "id">): Card {
	return {
		documentId: null,
		page: null,
		rects: [],
		excerptType: "text",
		polygon: null,
		excerptText: null,
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

/** 大纲节点工厂：id 同卡 id 简化（测试里两者无区分需求） */
function outlineNode(
	id: string,
	parentId: string | null,
	card: Card,
	order?: number,
): OutlineGraphNode {
	return { id, parentId, x: 0, y: 0, card, ...(order != null ? { order } : {}) };
}

describe("outlineLineText 大纲行文本（54）", () => {
	it("取值优先级：标题 > 批注 > 摘录文字 > 形态占位", () => {
		expect(
			outlineLineText(makeCard({ id: "a", title: "T", note: "N", excerptText: "E" })),
		).toBe("T");
		expect(outlineLineText(makeCard({ id: "a", note: "N", excerptText: "E" }))).toBe("N");
		expect(outlineLineText(makeCard({ id: "a", excerptText: "E" }))).toBe("E");
		expect(outlineLineText(makeCard({ id: "a", excerptType: "photo" }))).toBe("（照片摘录）");
	});

	it("多行内容只取首行；超长截断加省略号", () => {
		expect(outlineLineText(makeCard({ id: "a", note: "第一行\n第二行" }))).toBe("第一行");
		const long = "长".repeat(150);
		const out = outlineLineText(makeCard({ id: "a", excerptText: long }));
		expect(out).toBe(`长`.repeat(120) + "…");
		expect(out.length).toBe(121);
	});

	it("全空白首行归占位（不留空列表项）", () => {
		expect(outlineLineText(makeCard({ id: "a", note: "  \n第二行" }))).toBe("（空白卡片）");
	});
});

describe("buildOutlineMarkdown 大纲构建（54）", () => {
	it("树层级 → 两空格缩进嵌套列表；根按 order 序", () => {
		const root2 = outlineNode("r2", null, makeCard({ id: "c2", excerptText: "根二" }), 1);
		const root1 = outlineNode("r1", null, makeCard({ id: "c1", excerptText: "根一" }), 0);
		const kid = outlineNode("k", "r1", makeCard({ id: "c3", title: "子项" }));
		const grand = outlineNode("g", "k", makeCard({ id: "c4", excerptText: "孙项" }));
		const md = buildOutlineMarkdown([root2, root1, kid, grand], () => null);
		expect(md).toBe("- 根一\n  - 子项\n    - 孙项\n- 根二\n");
	});

	it("linkOf 返回 wikilink 时替换纯标题；null 时降级", () => {
		const linked = outlineNode("a", null, makeCard({ id: "c1", title: "有链" }));
		const plain = outlineNode("b", "a", makeCard({ id: "c2", title: "无链" }));
		const md = buildOutlineMarkdown([linked, plain], (card) =>
			card.id === "c1" ? "[[MarinMind/书#^card-c1|有链]]" : null,
		);
		expect(md).toBe("- [[MarinMind/书#^card-c1|有链]]\n  - 无链\n");
	});

	it("空图返回空字符串", () => {
		expect(buildOutlineMarkdown([], () => null)).toBe("");
	});

	it("脏数据成环不死循环（环上节点只出现一次）", () => {
		// a→b→a 互为父（正常流程不会产生，防御手编库）
		const a = outlineNode("a", "b", makeCard({ id: "c1", title: "A" }));
		const b = outlineNode("b", "a", makeCard({ id: "c2", title: "B" }));
		const r = outlineNode("r", null, makeCard({ id: "c3", title: "R" }));
		const md = buildOutlineMarkdown([a, b, r], () => null);
		// 根集合 = parentId 为 null 或指向环外不存在的节点——环上节点互相挂接，
		// 既不在根集合也无从根可达：产物只剩真根 r（宁缺毋滥，不悬挂不重复）
		expect(md).toBe("- R\n");
	});
});

describe("buildOutlineOpml OPML 2.0 大纲（63）", () => {
	it("树层级 → 嵌套 outline；叶子自闭合；根按 order 序；head 承载图名", () => {
		const root2 = outlineNode("r2", null, makeCard({ id: "c2", excerptText: "根二" }), 1);
		const root1 = outlineNode("r1", null, makeCard({ id: "c1", excerptText: "根一" }), 0);
		const kid = outlineNode("k", "r1", makeCard({ id: "c3", title: "子项" }));
		const opml = buildOutlineOpml([root2, root1, kid], "我的图");
		expect(opml).toBe(
			'<?xml version="1.0" encoding="UTF-8"?>\n' +
				'<opml version="2.0">\n' +
				"\t<head>\n" +
				"\t\t<title>我的图</title>\n" +
				"\t</head>\n" +
				"\t<body>\n" +
				'\t\t<outline text="根一">\n' +
				'\t\t\t<outline text="子项"/>\n' +
				"\t\t</outline>\n" +
				'\t\t<outline text="根二"/>\n' +
				"\t</body>\n" +
				"</opml>\n",
		);
	});

	it("text 属性 XML 五实体转义（& < > 双引号 单引号）", () => {
		const r = outlineNode("r", null, makeCard({ id: "c1", title: `A & B <C> "D" 'E'` }));
		const opml = buildOutlineOpml([r], `图&名`);
		expect(opml).toContain('<outline text="A &amp; B &lt;C&gt; &quot;D&quot; &apos;E&apos;"/>');
		expect(opml).toContain("<title>图&amp;名</title>");
	});

	it("正文混入 XML 非法控制字符整份剥离（㊽-2 同教训，防导出文件无法解析）", () => {
		const r = outlineNode(
			"r",
			null,
			makeCard({ id: "c1", title: `坏${String.fromCharCode(2)}字符` }),
		);
		const opml = buildOutlineOpml([r], "t");
		expect(opml).toContain('<outline text="坏字符"/>');
	});

	it("多行批注只取首行（与 Markdown 大纲同源 outlineLineText）", () => {
		const r = outlineNode("r", null, makeCard({ id: "c1", note: "第一行\n第二行" }));
		expect(buildOutlineOpml([r], "t")).toContain('<outline text="第一行"/>');
	});

	it("空图产出合法空 body 文档（防御——调用方已有空图守卫）", () => {
		const opml = buildOutlineOpml([], "空图");
		expect(opml).toBe(
			'<?xml version="1.0" encoding="UTF-8"?>\n' +
				'<opml version="2.0">\n' +
				"\t<head>\n" +
				"\t\t<title>空图</title>\n" +
				"\t</head>\n" +
				"\t<body>\n" +
				"\t</body>\n" +
				"</opml>\n",
		);
	});

	it("脏数据成环不死循环（产物只剩真根，标签严格配对）", () => {
		const a = outlineNode("a", "b", makeCard({ id: "c1", title: "A" }));
		const b = outlineNode("b", "a", makeCard({ id: "c2", title: "B" }));
		const r = outlineNode("r", null, makeCard({ id: "c3", title: "R" }));
		const opml = buildOutlineOpml([a, b, r], "t");
		expect(opml).toContain('<outline text="R"/>');
		expect(opml).not.toContain('text="A"');
		expect(opml).not.toContain('text="B"');
		// 开合标签数量相等（无悬挂）
		expect(opml.match(/<outline /g)?.length ?? 0).toBe(1);
		expect(opml.match(/<\/outline>/g)?.length ?? 0).toBe(0);
	});
});
