import { describe, expect, it } from "vitest";
import {
	buildChildrenMap,
	dropPlacement,
	edgePath,
	GAP_X,
	isDescendantOrSelf,
	NODE_HEIGHT_EST,
	NODE_WIDTH,
	suggestChildPosition,
	suggestRootPosition,
} from "../../src/mindmap/mindmap-graph";
import type { GraphNode } from "../../src/mindmap/mindmap-graph";

/** 最小节点工厂 */
function makeNode(id: string, parentId: string | null, x = 0, y = 0): GraphNode {
	return { id, parentId, x, y };
}

describe("mindmap-graph 图纯逻辑", () => {
	it("buildChildrenMap：按 parentId 分组，null 键为根集合", () => {
		const nodes = [
			makeNode("a", null),
			makeNode("b", "a"),
			makeNode("c", "a"),
			makeNode("d", null),
		];
		const map = buildChildrenMap(nodes);
		expect(map.get(null)?.map((n) => n.id)).toEqual(["a", "d"]);
		expect(map.get("a")?.map((n) => n.id)).toEqual(["b", "c"]);
		expect(map.has("b")).toBe(false);
	});

	it("isDescendantOrSelf：直接子 / 孙 / 自身为 true，无关为 false", () => {
		const nodes = [makeNode("a", null), makeNode("b", "a"), makeNode("c", "b"), makeNode("x", null)];
		expect(isDescendantOrSelf(nodes, "a", "a")).toBe(true); // 自身
		expect(isDescendantOrSelf(nodes, "a", "b")).toBe(true); // 直接子
		expect(isDescendantOrSelf(nodes, "a", "c")).toBe(true); // 孙
		expect(isDescendantOrSelf(nodes, "b", "c")).toBe(true);
		expect(isDescendantOrSelf(nodes, "c", "a")).toBe(false); // 反向
		expect(isDescendantOrSelf(nodes, "x", "a")).toBe(false);
	});

	it("isDescendantOrSelf 对成环脏数据不死循环（visited 防护）", () => {
		// b→a、a→b 互为父（正常流程不会产生，防御外写入的脏数据）
		const nodes = [makeNode("a", "b"), makeNode("b", "a")];
		expect(isDescendantOrSelf(nodes, "a", "b")).toBe(true);
		expect(isDescendantOrSelf(nodes, "a", "x")).toBe(false);
	});

	it("suggestChildPosition：首子对齐父 y；后续子低于最低兄弟", () => {
		const parent = { x: 100, y: 200 };
		const first = suggestChildPosition(parent, []);
		expect(first).toEqual({ x: 100 + NODE_WIDTH + GAP_X, y: 200 });

		const siblings = [{ x: 0, y: 300 }, { x: 0, y: 500 }];
		const next = suggestChildPosition(parent, siblings);
		expect(next.x).toBe(first.x);
		expect(next.y).toBe(500 + NODE_HEIGHT_EST + 24);
	});

	it("suggestRootPosition：空 → (0,0)；非空 → 最低根下方", () => {
		expect(suggestRootPosition([])).toEqual({ x: 0, y: 0 });
		const pos = suggestRootPosition([
			{ x: 50, y: 100 },
			{ x: 0, y: 400 },
		]);
		expect(pos.x).toBe(0);
		expect(pos.y).toBe(400 + NODE_HEIGHT_EST + 64);
	});

	it("edgePath：缺省高度用估算值，锚点为缘中点", () => {
		// 父 (0,0)、子 (500,0)，均无 h：y 锚 = NODE_HEIGHT_EST/2；dx = |500-200|/2 = 150（区间内）
		const path = edgePath({ x: 0, y: 0 }, { x: 500, y: 0 });
		const mid = NODE_HEIGHT_EST / 2;
		expect(path).toBe(`M ${NODE_WIDTH} ${mid} C ${NODE_WIDTH + 150} ${mid}, ${500 - 150} ${mid}, 500 ${mid}`);
	});

	it("edgePath：传入实测高度时锚点按中点偏移；近距离收紧控制点", () => {
		// dx = |280-200|/2 = 40 → 触发下限 40
		const path = edgePath({ x: 0, y: 0, h: 80 }, { x: 280, y: 100, h: 60 });
		expect(path).toBe("M 200 40 C 240 40, 240 130, 280 130");
	});

	it("dropPlacement：命中无兄弟节点 → 挂其子并对齐父 y（不用指针位置）", () => {
		const nodes = [makeNode("a", null, 100, 200), makeNode("b", "a", 380, 200)];
		const r = dropPlacement(nodes, "b", { x: 999, y: 999 });
		expect(r.parentId).toBe("b");
		expect(r.x).toBe(380 + NODE_WIDTH + GAP_X);
		expect(r.y).toBe(200);
	});

	it("dropPlacement：命中有兄弟的节点 → 低于最低兄弟顺延", () => {
		const nodes = [
			makeNode("a", null),
			makeNode("b", "a", 0, 100),
			makeNode("c1", "b", 380, 200),
			makeNode("c2", "b", 380, 400),
		];
		const r = dropPlacement(nodes, "b", { x: 0, y: 0 });
		expect(r.parentId).toBe("b");
		// x 由父 b（x=0）决定：0 + NODE_WIDTH + GAP_X；y 低于最低兄弟 c2 顺延
		expect(r.x).toBe(NODE_WIDTH + GAP_X);
		expect(r.y).toBe(400 + NODE_HEIGHT_EST + 24);
	});

	it("dropPlacement：未命中 → 根节点，指针世界坐标透传", () => {
		const nodes = [makeNode("a", null)];
		expect(dropPlacement(nodes, null, { x: 123.6, y: -45.2 })).toEqual({
			parentId: null,
			x: 123.6,
			y: -45.2,
		});
	});

	it("dropPlacement：脏 id（不在图中）→ 退化为根节点透传", () => {
		const nodes = [makeNode("a", null)];
		expect(dropPlacement(nodes, "ghost-id", { x: 5, y: 6 })).toEqual({
			parentId: null,
			x: 5,
			y: 6,
		});
	});
});
