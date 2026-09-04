import { describe, expect, it } from "vitest";
import type { Card, MindmapNodeWithCard } from "../../src/types";
import { NODE_SEARCH_LIMIT, searchMapNodes } from "../../src/mindmap/node-search";

/** 造一个带卡片的节点（只填搜索消费的字段） */
function makeNode(
	id: string,
	card: Partial<Pick<Card, "title" | "note" | "excerptText">>,
): MindmapNodeWithCard {
	return {
		id,
		mapId: "map-1",
		cardId: `card-${id}`,
		parentId: null,
		x: 0,
		y: 0,
		collapsed: false,
		branchStyle: null,
		childMapId: null,
		createdAt: 0,
		card: {
			id: `card-${id}`,
			documentId: null,
			page: null,
			rects: [],
			excerptType: "text",
			polygon: null,
			excerptRef: null,
			color: null,
			lineStyle: null,
			title: null,
			note: null,
			excerptText: null,
			...card,
		},
	};
}

describe("searchMapNodes（脑图节点搜索，89-C）", () => {
	it("空/空白查询早退空结果", () => {
		const nodes = [makeNode("a", { title: "关键词" })];
		expect(searchMapNodes(nodes, "")).toEqual({ rows: [], truncated: false });
		expect(searchMapNodes(nodes, "   ")).toEqual({ rows: [], truncated: false });
	});

	it("标题命中返回该节点与字段", () => {
		const nodes = [makeNode("a", { title: "海马体记忆" })];
		const { rows, truncated } = searchMapNodes(nodes, "海马");
		expect(truncated).toBe(false);
		expect(rows).toHaveLength(1);
		expect(rows[0].node.id).toBe("a");
		expect(rows[0].field).toBe("title");
		expect(rows[0].main).toBe("海马体记忆");
	});

	it("大小写不敏感（英文）", () => {
		const nodes = [makeNode("a", { title: "Hippocampus" })];
		expect(searchMapNodes(nodes, "hippo").rows).toHaveLength(1);
		expect(searchMapNodes(nodes, "HIPPO").rows).toHaveLength(1);
	});

	it("字段优先级：标题 > 批注 > 摘录（每节点只取首个命中字段）", () => {
		const both = makeNode("a", {
			title: "睡眠与记忆",
			note: "睡眠巩固记忆",
			excerptText: "睡眠是记忆巩固的关键",
		});
		const r = searchMapNodes([both], "记忆");
		expect(r.rows).toHaveLength(1);
		expect(r.rows[0].field).toBe("title");

		const noteOnly = makeNode("b", { note: "批注里的突触", excerptText: "摘录里的突触" });
		const r2 = searchMapNodes([noteOnly], "突触");
		expect(r2.rows[0].field).toBe("note");

		const excerptOnly = makeNode("c", { excerptText: "长时程增强 LTP" });
		const r3 = searchMapNodes([excerptOnly], "LTP");
		expect(r3.rows[0].field).toBe("excerptText");
	});

	it("批注/摘录兜底链：标题无命中时落到批注、摘录", () => {
		const nodes = [
			makeNode("a", { title: "无关标题", note: "复习间隔批注" }),
			makeNode("b", { title: "无关标题二", excerptText: "间隔重复正文" }),
		];
		const { rows } = searchMapNodes(nodes, "间隔");
		expect(rows.map((r) => r.node.id)).toEqual(["a", "b"]);
		expect(rows[0].field).toBe("note");
		expect(rows[1].field).toBe("excerptText");
	});

	it("无命中返回空", () => {
		const nodes = [makeNode("a", { title: "甲" })];
		expect(searchMapNodes(nodes, "乙").rows).toHaveLength(0);
	});

	it("超 limit 截断并置 truncated（第 limit+1 个命中即截断）", () => {
		const total = NODE_SEARCH_LIMIT + 5;
		const nodes = Array.from({ length: total }, (_, i) =>
			makeNode(`n${i}`, { title: `节点${i}号关键词` }),
		);
		const { rows, truncated } = searchMapNodes(nodes, "关键词");
		expect(rows).toHaveLength(NODE_SEARCH_LIMIT);
		expect(truncated).toBe(true);
		// 恰好等于 limit 不截断
		const exact = Array.from({ length: NODE_SEARCH_LIMIT }, (_, i) =>
			makeNode(`n${i}`, { title: `节点${i}号关键词` }),
		);
		const r2 = searchMapNodes(exact, "关键词");
		expect(r2.rows).toHaveLength(NODE_SEARCH_LIMIT);
		expect(r2.truncated).toBe(false);
	});

	it("折叠隐藏的节点照常命中（展开由 locateCard 负责）", () => {
		const collapsed = { ...makeNode("a", { title: "深处节点" }), collapsed: true };
		expect(searchMapNodes([collapsed], "深处").rows).toHaveLength(1);
	});
});
