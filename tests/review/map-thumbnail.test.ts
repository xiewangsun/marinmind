import { describe, expect, it } from "vitest";
import { buildMapThumbnailSvg, VIEW_PAD } from "../../src/review/map-thumbnail";
import { NODE_HEIGHT_EST, NODE_WIDTH } from "../../src/mindmap/mindmap-graph";
import type { Card, MindmapNodeWithCard } from "../../src/types";

function card(partial: Partial<Card> = {}): Card {
	return {
		id: partial.id ?? `c${Math.random().toString(36).slice(2, 8)}`,
		documentId: null,
		page: null,
		rects: [],
		excerptType: "text",
		polygon: null,
		excerptText: "文本",
		excerptRef: null,
		note: null,
		color: null,
		title: null,
		deck: null,
		occlusions: [],
		tags: [],
		createdAt: 1700000000000,
		updatedAt: 1700000000000,
		...partial,
	};
}

/** 建节点（MindmapNodeWithCard 全字段） */
function node(
	partial: Partial<MindmapNodeWithCard> & { id: string; cardId: string },
): MindmapNodeWithCard {
	return {
		mapId: "m1",
		parentId: null,
		x: 0,
		y: 0,
		collapsed: false,
		branchStyle: null,
		childMapId: null,
		createdAt: 1700000000000,
		card: card({ id: partial.cardId }),
		...partial,
	};
}

/** 从 svg 字符串取 viewBox 四元数值 */
function viewBoxOf(svg: string): number[] {
	const m = svg.match(/viewBox="([^"]+)"/)!;
	return m[1].split(" ").map(Number);
}

describe("buildMapThumbnailSvg（71 脑图位置缩略图）", () => {
	it("空可见集返回空串（空图跳过缩略图块）", () => {
		expect(buildMapThumbnailSvg([], null)).toBe("");
	});

	it("viewBox = 可见节点包围盒外扩 VIEW_PAD（镜像 drawEdges 取景法）；边数 = 可见父子对", () => {
		const nodes = [
			node({ id: "n1", cardId: "c1", x: 0, y: 0 }),
			node({ id: "n2", cardId: "c2", parentId: "n1", x: 300, y: 120 }),
			node({ id: "n3", cardId: "c3", parentId: "n1", x: 300, y: 240 }),
		];
		const svg = buildMapThumbnailSvg(nodes, null);
		expect(viewBoxOf(svg)).toEqual([
			-VIEW_PAD,
			-VIEW_PAD,
			300 + NODE_WIDTH + VIEW_PAD * 2,
			240 + NODE_HEIGHT_EST + VIEW_PAD * 2,
		]);
		// tree 样式两条边拼进单条 path 的 d（两段 M 起头）
		expect(svg).toContain("<path ");
		expect((svg.match(/ M /g) ?? []).length + 1).toBe(2); // d="M… M…"：第二段以空格 M 分隔
	});

	it("高亮卡：当前卡节点带 data-hit + accent 描边；无高亮时全部普通节点", () => {
		const nodes = [
			node({ id: "n1", cardId: "c1" }),
			node({ id: "n2", cardId: "c2", parentId: "n1", x: 300, y: 120 }),
		];
		const hit = buildMapThumbnailSvg(nodes, "c2");
		expect(hit).toContain('data-hit="1"');
		expect(hit).toContain("var(--interactive-accent)");
		expect(hit).toContain("var(--background-secondary)"); // 非高亮节点普通底色
		const none = buildMapThumbnailSvg(nodes, null);
		expect(none).not.toContain('data-hit="1"');
		expect(none).not.toContain("var(--interactive-accent)");
	});

	it("折叠子树过滤：折叠父的后代不进缩略图（visibleNodes 同语义）", () => {
		const nodes = [
			node({ id: "root", cardId: "c1", collapsed: true }),
			node({ id: "kid", cardId: "c2", parentId: "root", x: 300, y: 120 }),
			node({ id: "grand", cardId: "c3", parentId: "kid", x: 600, y: 240 }),
		];
		const svg = buildMapThumbnailSvg(nodes, null);
		// 只剩 root 一个可见节点：viewBox 宽 = NODE_WIDTH + 2×PAD
		expect(viewBoxOf(svg)[2]).toBe(NODE_WIDTH + VIEW_PAD * 2);
		// 文本节点数 = 可见节点数（折叠后代不渲染）
		expect((svg.match(/<text /g) ?? []).length).toBe(1);
	});

	it("frame 父：不画连线、补收纳框背景（rx 圆角框元素存在）", () => {
		const nodes = [
			node({ id: "n1", cardId: "c1", branchStyle: "frame" }),
			node({ id: "n2", cardId: "c2", parentId: "n1", x: 40, y: 120 }),
		];
		const svg = buildMapThumbnailSvg(nodes, null);
		expect(svg).not.toContain("<path "); // frame 边不画线（edgePath 返 null）
		expect(svg).toContain('rx="8"'); // 收纳框（唯一 rx=8 的元素）
		// 收纳框把子节点圈进包围盒：viewBox 高超出纯节点并集
		expect(viewBoxOf(svg)[3]).toBeGreaterThan(NODE_HEIGHT_EST + VIEW_PAD * 2);
	});

	it("标题转义：卡片文本含 XML 特殊字符不出废 XML（五实体转义）", () => {
		const nodes = [node({ id: "n1", cardId: "c1", card: card({ title: `a<b>&"c` }) })];
		const svg = buildMapThumbnailSvg(nodes, null);
		expect(svg).toContain("&lt;");
		expect(svg).toContain("&amp;");
		expect(svg).toContain("&quot;");
		expect(svg).not.toContain("a<b>");
	});
});
