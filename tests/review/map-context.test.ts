import { describe, expect, it } from "vitest";
import { buildMapContext, cardTitle } from "../../src/review/map-context";
import type { Card, MindmapNodeWithCard } from "../../src/types";

/** Card 字段较多，用工厂补默认值 */
function makeCard(id: string, over: Partial<Card> = {}): Card {
	return {
		id,
		documentId: null,
		page: null,
		rects: [],
		excerptType: "text",
		excerptText: `摘录-${id}`,
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

function makeNode(id: string, card: Card, parentId: string | null): MindmapNodeWithCard {
	return {
		id,
		mapId: "m1",
		cardId: card.id,
		parentId,
		x: 0,
		y: 0,
		collapsed: false,
		branchStyle: null,
		createdAt: 0,
		card,
	};
}

describe("cardTitle 节点标题推导", () => {
	it("批注优先于摘录文字；媒体卡回退形态占位", () => {
		expect(cardTitle(makeCard("a", { note: "批注", excerptText: "摘录" }))).toBe("批注");
		expect(cardTitle(makeCard("b"))).toBe("摘录-b");
		expect(
			cardTitle(makeCard("c", { excerptType: "audio", excerptText: null })),
		).toBe("（语音摘录）");
		expect(
			cardTitle(makeCard("d", { excerptType: "area", excerptText: null, note: null })),
		).toBe("（区域摘录）");
	});

	it("㊺ 标题最高优先：压过批注与摘录文字", () => {
		expect(
			cardTitle(makeCard("t", { title: "我的标题", note: "批注", excerptText: "摘录" })),
		).toBe("我的标题");
	});
});

describe("buildMapContext 脑图位置摘要（㉒ 溯源上下文·脑图栏）", () => {
	// 结构：root → mid → self → c1..c4（四个子）；root2 为另一根节点
	function buildFixture() {
		const root = makeNode("n-root", makeCard("root"), null);
		const root2 = makeNode("n-root2", makeCard("root2"), null);
		const mid = makeNode("n-mid", makeCard("mid"), root.id);
		const self = makeNode("n-self", makeCard("self"), mid.id);
		const children = [1, 2, 3, 4].map((i) =>
			makeNode(`n-c${i}`, makeCard(`c${i}`), self.id),
		);
		return { root, root2, mid, self, children };
	}

	it("祖先两级（远→近）+ 子节点截断到 3 个 + 同级不含自身", () => {
		const { root, root2, mid, self, children } = buildFixture();
		const nodes = [root, root2, mid, self, ...children];
		const entry = buildMapContext(nodes, "学习图", "self");

		expect(entry).toBeDefined();
		expect(entry!.mapTitle).toBe("学习图");
		expect(entry!.ancestors).toEqual(["摘录-root", "摘录-mid"]);
		expect(entry!.selfTitle).toBe("摘录-self");
		expect(entry!.childCount).toBe(4);
		expect(entry!.childTitles).toEqual(["摘录-c1", "摘录-c2", "摘录-c3"]);
		// self 的同级：无（mid 只有 self 一个子）
		expect(entry!.siblingCount).toBe(0);
	});

	it("根节点：祖先为空数组，其余根节点计为同级", () => {
		const { root, root2, mid, self, children } = buildFixture();
		const nodes = [root, root2, mid, self, ...children];
		const entry = buildMapContext(nodes, "学习图", "root")!;

		expect(entry.ancestors).toEqual([]);
		expect(entry.siblingCount).toBe(1); // root2
		expect(entry.childCount).toBe(1); // mid
	});

	it("卡不在该图节点集中返回 undefined", () => {
		const { root, mid } = buildFixture();
		expect(buildMapContext([root, mid], "学习图", "不存在")).toBeUndefined();
	});

	it("祖先链超过两级截断（不无限上溯）", () => {
		// a0 → a1 → a2 → self
		const a0 = makeNode("n0", makeCard("a0"), null);
		const a1 = makeNode("n1", makeCard("a1"), a0.id);
		const a2 = makeNode("n2", makeCard("a2"), a1.id);
		const self = makeNode("n3", makeCard("self"), a2.id);
		const entry = buildMapContext([a0, a1, a2, self], "学习图", "self")!;
		expect(entry.ancestors).toEqual(["摘录-a1", "摘录-a2"]);
	});

	it("parentId 成环（手工改库的脏数据）不悬挂：祖先链到环前截断", () => {
		// a.parent = b、b.parent = a，查 a
		const a = makeNode("na", makeCard("a"), "nb");
		const b = makeNode("nb", makeCard("b"), "na");
		const entry = buildMapContext([a, b], "学习图", "a");
		expect(entry).toBeDefined();
		expect(entry!.ancestors).toEqual(["摘录-b"]);
	});

	it("同级计数：同父的兄弟不含自身", () => {
		const root = makeNode("n-root", makeCard("root"), null);
		const s1 = makeNode("n-s1", makeCard("s1"), root.id);
		const s2 = makeNode("n-s2", makeCard("s2"), root.id);
		const s3 = makeNode("n-s3", makeCard("s3"), root.id);
		const entry = buildMapContext([root, s1, s2, s3], "学习图", "s2")!;
		expect(entry.siblingCount).toBe(2); // s1 与 s3
		expect(entry.ancestors).toEqual(["摘录-root"]);
	});
});
