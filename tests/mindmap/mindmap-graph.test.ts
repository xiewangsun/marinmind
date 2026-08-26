import { describe, expect, it } from "vitest";
import {
	buildChildrenMap,
	dropPlacement,
	edgePath,
	fitViewportTransform,
	GAP_X,
	GAP_Y,
	isDescendantOrSelf,
	layoutTree,
	MIN_SCALE,
	NODE_HEIGHT_EST,
	NODE_WIDTH,
	ROOT_GAP_Y,
	suggestChildPosition,
	suggestRootPosition,
	visibleNodes,
} from "../../src/mindmap/mindmap-graph";
import type { GraphNode } from "../../src/mindmap/mindmap-graph";

/** 最小节点工厂 */
function makeNode(
	id: string,
	parentId: string | null,
	x = 0,
	y = 0,
	collapsed = false,
): GraphNode {
	return { id, parentId, x, y, collapsed };
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

	// ---------- ⑨-C 折叠 / 自动布局 / 视口适配 ----------

	it("visibleNodes：无折叠全部可见", () => {
		const nodes = [makeNode("a", null), makeNode("b", "a"), makeNode("c", "b")];
		expect(visibleNodes(nodes)).toEqual(new Set(["a", "b", "c"]));
	});

	it("visibleNodes：折叠节点自身可见，直接子与深层后代均隐藏", () => {
		const nodes = [
			makeNode("a", null),
			makeNode("b", "a", 0, 0, true), // b 折叠
			makeNode("c", "b"), // 直接子：隐藏
			makeNode("d", "c"), // 孙：隐藏
			makeNode("e", "a"), // b 的兄弟：不受影响
		];
		expect(visibleNodes(nodes)).toEqual(new Set(["a", "b", "e"]));
	});

	it("visibleNodes：孤儿（父不在集合内）视为根，可见", () => {
		const nodes = [makeNode("a", null), makeNode("o", "missing-parent")];
		expect(visibleNodes(nodes)).toEqual(new Set(["a", "o"]));
	});

	it("visibleNodes：成环脏数据不死循环，环上节点均可见（链上无折叠）", () => {
		const nodes = [makeNode("a", "b"), makeNode("b", "a"), makeNode("r", null)];
		expect(visibleNodes(nodes)).toEqual(new Set(["a", "b", "r"]));
	});

	it("layoutTree：深度对齐列 x，叶子纵序堆叠，父垂直居中于子块", () => {
		// r → { b1, b2 }（均为叶）：b1 y=0、b2 y=H+GAP；r 居中于 [0, 2H+GAP]
		const nodes = [makeNode("r", null), makeNode("b1", "r"), makeNode("b2", "r")];
		const pos = layoutTree(nodes);
		expect(pos.get("r")).toEqual({ x: 0, y: (2 * NODE_HEIGHT_EST + GAP_Y - NODE_HEIGHT_EST) / 2 });
		expect(pos.get("b1")).toEqual({ x: NODE_WIDTH + GAP_X, y: 0 });
		expect(pos.get("b2")).toEqual({
			x: NODE_WIDTH + GAP_X,
			y: NODE_HEIGHT_EST + GAP_Y,
		});
	});

	it("layoutTree：深层后代列 x 随深度递增", () => {
		const nodes = [
			makeNode("a", null),
			makeNode("b", "a"),
			makeNode("c", "b"),
			makeNode("d", "c"),
		];
		const pos = layoutTree(nodes);
		expect(pos.get("a")!.x).toBe(0);
		expect(pos.get("b")!.x).toBe(NODE_WIDTH + GAP_X);
		expect(pos.get("c")!.x).toBe(2 * (NODE_WIDTH + GAP_X));
		expect(pos.get("d")!.x).toBe(3 * (NODE_WIDTH + GAP_X));
	});

	it("layoutTree：多根（含孤儿）自上而下纵向堆叠 ROOT_GAP_Y", () => {
		// 两棵单叶树：r1 块 [0, H]，r2 顶 = H + ROOT_GAP_Y；孤儿 o 视为根继续顺延
		const nodes = [
			makeNode("r1", null),
			makeNode("r2", null),
			makeNode("o", "missing-parent"),
		];
		const pos = layoutTree(nodes);
		expect(pos.get("r1")!.y).toBe(0);
		expect(pos.get("r2")!.y).toBe(NODE_HEIGHT_EST + ROOT_GAP_Y);
		expect(pos.get("o")!.y).toBe(2 * (NODE_HEIGHT_EST + ROOT_GAP_Y));
	});

	it("layoutTree：空图返回空 Map", () => {
		expect(layoutTree([]).size).toBe(0);
	});

	it("layoutTree：父子成环脏数据不死循环（环上节点不入结果，保留旧坐标）", () => {
		const nodes = [
			makeNode("a", "b"),
			makeNode("b", "a"),
			makeNode("r", null), // 干净根照常布局
		];
		const pos = layoutTree(nodes);
		expect(pos.has("a")).toBe(false);
		expect(pos.has("b")).toBe(false);
		expect(pos.get("r")).toEqual({ x: 0, y: 0 });
	});

	it("fitViewportTransform：小包围盒不放大（scale=1），居中", () => {
		const t = fitViewportTransform(
			{ minX: 0, minY: 0, maxX: 100, maxY: 100 },
			{ width: 1000, height: 800 },
			0,
		);
		expect(t.scale).toBe(1);
		expect(t.tx).toBe((1000 - 100) / 2);
		expect(t.ty).toBe((800 - 100) / 2);
	});

	it("fitViewportTransform：大包围盒按可用区域缩小适配（留 padding）", () => {
		const t = fitViewportTransform(
			{ minX: 0, minY: 0, maxX: 2000, maxY: 100 },
			{ width: 1000, height: 800 },
			50,
		);
		// availW=900、availH=700 → scale = min(1, 900/2000, 700/100) = 0.45
		expect(t.scale).toBe(0.45);
		expect(t.tx).toBe((1000 - 2000 * 0.45) / 2);
		expect(t.ty).toBe((800 - 100 * 0.45) / 2);
	});

	it("fitViewportTransform：极小视口夹到 MIN_SCALE 下限", () => {
		const t = fitViewportTransform(
			{ minX: 0, minY: 0, maxX: 100000, maxY: 100000 },
			{ width: 100, height: 100 },
			10,
		);
		expect(t.scale).toBe(MIN_SCALE);
	});
});
