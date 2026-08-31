import { describe, expect, it } from "vitest";
import {
	autoCollectPlacement,
	buildChildrenMap,
	dropPlacement,
	dropZoneFor,
	edgePath,
	effectiveBranchStyle,
	fitViewportTransform,
	frameRectFor,
	FRAME_COLS,
	FRAME_PADDING,
	GAP_X,
	GAP_Y,
	insertOrder,
	isDescendantOrSelf,
	layoutSubtree,
	layoutTree,
	MIN_SCALE,
	NODE_HEIGHT_EST,
	NODE_WIDTH,
	restackRoots,
	ROOT_GAP_Y,
	subtreeIds,
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
	branchStyle: string | null = null,
): GraphNode {
	return { id, parentId, x, y, collapsed, branchStyle };
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
		expect(next.y).toBe(500 + NODE_HEIGHT_EST + GAP_Y);
	});

	it("suggestRootPosition：空 → (0,0)；非空 → 最低根下方", () => {
		expect(suggestRootPosition([])).toEqual({ x: 0, y: 0 });
		const pos = suggestRootPosition([
			{ x: 50, y: 100 },
			{ x: 0, y: 400 },
		]);
		expect(pos.x).toBe(0);
		expect(pos.y).toBe(400 + NODE_HEIGHT_EST + ROOT_GAP_Y);
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
		expect(r.y).toBe(400 + NODE_HEIGHT_EST + GAP_Y);
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

	// ---------- ⑱ 分支样式 ----------

	it("effectiveBranchStyle：自身覆盖 > 最近祖先覆盖 > 图默认；非法值忽略", () => {
		const nodes = [
			makeNode("r", null, 0, 0, false, "bidir"),
			makeNode("a", "r"),
			makeNode("b", "a", 0, 0, false, "frame"),
			makeNode("c", "b"),
			makeNode("x", null, 0, 0, false, "not-a-style"), // 手工改库的非法值
		];
		expect(effectiveBranchStyle(nodes, "r", "tree")).toBe("bidir"); // 自身
		expect(effectiveBranchStyle(nodes, "a", "tree")).toBe("bidir"); // 祖先 r 覆盖
		expect(effectiveBranchStyle(nodes, "b", "tree")).toBe("frame"); // 自身覆盖优先于祖先
		expect(effectiveBranchStyle(nodes, "c", "tree")).toBe("frame"); // 最近祖先 b
		expect(effectiveBranchStyle(nodes, "x", "tree")).toBe("tree"); // 非法值按继承处理 → 图默认
	});

	it("edgePath tree-left：镜像贝塞尔（父左缘中点 → 子右缘中点）", () => {
		// 父 (600,0)、子 (100,0)：终点 = 子右缘 300；dx = clamp(|300-600|/2=150)
		const path = edgePath({ x: 600, y: 0 }, { x: 100, y: 0 }, "tree-left");
		const mid = NODE_HEIGHT_EST / 2;
		expect(path).toBe(`M 600 ${mid} C 450 ${mid}, 450 ${mid}, 300 ${mid}`);
	});

	it("edgePath bidir：子在父右侧走右接贝塞尔、在左侧走左接贝塞尔", () => {
		const mid = NODE_HEIGHT_EST / 2;
		// 子在右（child.x=500 > parent.x=0）：等价 tree 右接
		const right = edgePath({ x: 0, y: 0 }, { x: 500, y: 0 }, "bidir");
		expect(right).toBe(edgePath({ x: 0, y: 0 }, { x: 500, y: 0 }, "tree"));
		// 子在左（child.x=-600）：起点 = 父左缘 0，终点 = 子右缘 -400，dx=clamp(200→160)
		const left = edgePath({ x: 0, y: 0 }, { x: -600, y: 0 }, "bidir");
		expect(left).toBe(`M 0 ${mid} C -160 ${mid}, -240 ${mid}, -400 ${mid}`);
	});

	it("edgePath tree-down：正交折线（父底缘中点 → 垂直 → 水平 → 子顶缘中点）", () => {
		// 父 (0,0,h=80) 子 (400,200,h=60)：x1=100、x2=500、y1=80、y2=200、midY=140
		const path = edgePath({ x: 0, y: 0, h: 80 }, { x: 400, y: 200, h: 60 }, "tree-down");
		expect(path).toBe("M 100 80 V 140 H 500 V 200");
		// 子在父上方：上下镜像（起点父顶缘、终点子底缘）
		const up = edgePath({ x: 0, y: 200, h: 80 }, { x: 400, y: 0, h: 60 }, "tree-down");
		expect(up).toBe("M 100 200 V 130 H 500 V 60");
	});

	it("edgePath line：同高为纯水平直线，高度不齐时中段直角校正", () => {
		const mid = NODE_HEIGHT_EST / 2;
		// 同高：V 段长度 0，即水平直线
		const flat = edgePath({ x: 0, y: 0 }, { x: 500, y: 0 }, "line");
		expect(flat).toBe(`M ${NODE_WIDTH} ${mid} H ${(NODE_WIDTH + 500) / 2} V ${mid} H 500`);
		// 高度不齐：中段垂直校正
		const skew = edgePath({ x: 0, y: 0, h: 80 }, { x: 500, y: 100, h: 60 }, "line");
		expect(skew).toBe("M 200 40 H 350 V 130 H 500");
		// 子在父左侧：自动换向
		const rev = edgePath({ x: 500, y: 0 }, { x: 0, y: 0 }, "line");
		expect(rev).toBe(`M 500 ${mid} H ${NODE_WIDTH + (500 - NODE_WIDTH) / 2} V ${mid} H ${NODE_WIDTH}`);
	});

	it("edgePath frame：无连线（null，层级由收纳框表达）", () => {
		expect(edgePath({ x: 0, y: 0 }, { x: 500, y: 0 }, "frame")).toBeNull();
	});

	it("frameRectFor：子节点包围盒外扩 FRAME_PADDING；空子返回 null", () => {
		expect(frameRectFor([])).toBeNull();
		const rect = frameRectFor([
			{ x: 300, y: 100, w: NODE_WIDTH, h: 72 },
			{ x: 300, y: 200, w: NODE_WIDTH, h: 90 },
		]);
		expect(rect).toEqual({
			x: 300 - FRAME_PADDING,
			y: 100 - FRAME_PADDING,
			w: NODE_WIDTH + FRAME_PADDING * 2,
			h: (200 + 90 - 100) + FRAME_PADDING * 2,
		});
	});

	it("suggestChildPosition：tree-left 落父左侧一列；tree-down 落父下方一行", () => {
		const parent = { x: 100, y: 200 };
		expect(suggestChildPosition(parent, [], "tree-left")).toEqual({
			x: 100 - NODE_WIDTH - GAP_X,
			y: 200,
		});
		const two = suggestChildPosition(parent, [{ x: 0, y: 0 }, { x: 0, y: 90 }], "tree-left");
		expect(two.x).toBe(100 - NODE_WIDTH - GAP_X);
		expect(two.y).toBe(90 + NODE_HEIGHT_EST + GAP_Y);
		const down = suggestChildPosition(parent, [{ x: 0, y: 0 }], "tree-down");
		expect(down).toEqual({
			x: 100 + NODE_WIDTH + GAP_X,
			y: 200 + NODE_HEIGHT_EST + 2 * GAP_Y,
		});
	});

	it("dropPlacement：父节点样式感知落位（tree-left 覆盖 → 落左侧）", () => {
		const nodes = [
			makeNode("r", null, 0, 0, false, "tree-left"),
			makeNode("a", "r"),
		];
		const p = dropPlacement(nodes, "a", { x: 999, y: 999 }, "tree");
		expect(p.parentId).toBe("a");
		expect(p.x).toBe(-NODE_WIDTH - GAP_X); // 继承祖先 r 的 tree-left 覆盖
	});

	it("layoutTree tree-left：镜像列 x 随深度递减（负坐标）", () => {
		const nodes = [
			makeNode("a", null, 0, 0, false, "tree-left"),
			makeNode("b", "a"),
			makeNode("c", "b"),
		];
		const pos = layoutTree(nodes);
		expect(pos.get("a")!.x).toBe(0);
		expect(pos.get("b")!.x).toBe(-(NODE_WIDTH + GAP_X));
		expect(pos.get("c")!.x).toBe(-2 * (NODE_WIDTH + GAP_X));
	});

	it("layoutTree tree-down：子节点横排在父下方一行，父水平居中于子行", () => {
		const nodes = [
			makeNode("r", null, 0, 0, false, "tree-down"),
			makeNode("b1", "r"),
			makeNode("b2", "r"),
		];
		const pos = layoutTree(nodes);
		expect(pos.get("r")!.y).toBe(0);
		expect(pos.get("b1")).toEqual({ x: 0, y: NODE_HEIGHT_EST + GAP_Y });
		expect(pos.get("b2")).toEqual({
			x: NODE_WIDTH + GAP_X,
			y: NODE_HEIGHT_EST + GAP_Y,
		});
		// 父居中于子行 [0, W+GX+W]：r.x = (行右缘 480 - W) / 2 = (W + GX) / 2
		expect(pos.get("r")!.x).toBe((NODE_WIDTH + GAP_X) / 2);
	});

	it("layoutTree line：子节点与父同高横向排链", () => {
		const nodes = [
			makeNode("r", null, 0, 0, false, "line"),
			makeNode("b1", "r"),
			makeNode("b2", "r"),
		];
		const pos = layoutTree(nodes);
		expect(pos.get("r")).toEqual({ x: 0, y: 0 });
		expect(pos.get("b1")).toEqual({ x: NODE_WIDTH + GAP_X, y: 0 });
		expect(pos.get("b2")).toEqual({ x: 2 * (NODE_WIDTH + GAP_X), y: 0 });
	});

	it("layoutTree bidir：前半子挂右侧、后半挂左侧，父居中于两侧子块", () => {
		const nodes = [
			makeNode("r", null, 0, 0, false, "bidir"),
			makeNode("b1", "r"),
			makeNode("b2", "r"),
			makeNode("b3", "r"),
		];
		const pos = layoutTree(nodes);
		// 3 子：前 2（ceil(3/2)）在右列 x = W+GX，第 3 在左列 x = -(W+GX)
		expect(pos.get("b1")).toEqual({ x: NODE_WIDTH + GAP_X, y: 0 });
		expect(pos.get("b2")).toEqual({ x: NODE_WIDTH + GAP_X, y: NODE_HEIGHT_EST + GAP_Y });
		expect(pos.get("b3")).toEqual({ x: -(NODE_WIDTH + GAP_X), y: 0 });
		// 父 x 不动（0），y 居中于两侧子块 [0, 2H+GAP]
		expect(pos.get("r")).toEqual({ x: 0, y: (2 * NODE_HEIGHT_EST + GAP_Y - NODE_HEIGHT_EST) / 2 });
		// bidir 的子节点继承单侧样式：b1 的孙（map 默认 tree 下仍延续右向 tree）
		const deep = [
			makeNode("r", null, 0, 0, false, "bidir"),
			makeNode("b1", "r"),
			makeNode("c1", "b1"),
		];
		const dp = layoutTree(deep);
		expect(dp.get("c1")!.x).toBe(2 * (NODE_WIDTH + GAP_X)); // 右侧延续而非二次分叉
	});

	it("layoutTree frame：子节点两列网格收纳，孙节点在格右侧展开不压相邻格", () => {
		const nodes = [
			makeNode("r", null, 0, 0, false, "frame"),
			makeNode("b1", "r"),
			makeNode("b2", "r"),
			makeNode("b3", "r"),
			makeNode("c1", "b1"), // b1 的子树（继承 frame）在 b1 右侧展开
		];
		const pos = layoutTree(nodes);
		const fx = NODE_WIDTH + GAP_X; // 网格行首（父右缘一列）
		expect(pos.get("b1")).toEqual({ x: fx, y: 0 });
		// b1 的子节点 c1 在其右侧一列
		expect(pos.get("c1")!.x).toBe(2 * (NODE_WIDTH + GAP_X));
		// b2 被 b1 的整棵子树（含收纳框 padding）推到更右，不压格
		expect(pos.get("b2")!.y).toBe(0);
		expect(pos.get("b2")!.x).toBeGreaterThan(pos.get("c1")!.x + NODE_WIDTH);
		// 第三子换行：回到行首、落在第一行子块下方
		expect(pos.get("b3")!.x).toBe(fx);
		expect(pos.get("b3")!.y).toBeGreaterThan(NODE_HEIGHT_EST);
	});

	it("layoutTree：图默认样式作用于未覆盖节点（mapDefault=line）", () => {
		const nodes = [
			makeNode("r", null),
			makeNode("b1", "r"),
			makeNode("b2", "r"),
		];
		const pos = layoutTree(nodes, "line");
		expect(pos.get("r")).toEqual({ x: 0, y: 0 });
		expect(pos.get("b1")).toEqual({ x: NODE_WIDTH + GAP_X, y: 0 });
		expect(pos.get("b2")).toEqual({ x: 2 * (NODE_WIDTH + GAP_X), y: 0 });
	});

	// ---------- ㉜ XMind 式拖放/整理 ----------

	it("buildChildrenMap：order 优先，缺省回退创建序再回退 id", () => {
		const nodes = [
			{ ...makeNode("a", null), createdAt: 10 },
			{ ...makeNode("b3", "a"), order: 2, createdAt: 30 },
			{ ...makeNode("b1", "a"), order: 0, createdAt: 20 },
			{ ...makeNode("b2", "a"), order: 1, createdAt: 10 },
			{ ...makeNode("n1", "a"), createdAt: 5 }, // 无 order：排有 order 之后，按创建序
			{ ...makeNode("n2", "a"), createdAt: 3 },
		];
		const map = buildChildrenMap(nodes);
		expect(map.get("a")?.map((n) => n.id)).toEqual(["b1", "b2", "b3", "n2", "n1"]);
	});

	it("edgePath tree：子被拖到父左侧时锚点自动镜像（修复连线绕回打结）", () => {
		const mid = NODE_HEIGHT_EST / 2;
		// 子在左（child 右缘 -400 < 父左缘）：起点父左缘 0 → 终点子右缘，dx=clamp(200→160)
		const left = edgePath({ x: 0, y: 0 }, { x: -600, y: 0 }, "tree");
		expect(left).toBe(`M 0 ${mid} C -160 ${mid}, -240 ${mid}, -400 ${mid}`);
	});

	it("edgePath tree-left：子被拖到父右侧时镜像为右接", () => {
		const mid = NODE_HEIGHT_EST / 2;
		const right = edgePath({ x: 0, y: 0 }, { x: 500, y: 0 }, "tree-left");
		expect(right).toBe(
			`M ${NODE_WIDTH} ${mid} C ${NODE_WIDTH + 150} ${mid}, ${500 - 150} ${mid}, 500 ${mid}`,
		);
	});

	it("dropZoneFor：三分区 v/h 两轴；盒外指针自然落入 before/after 侧", () => {
		const box = { x: 0, y: 0, w: 300, h: 90 };
		// v 轴（默认）：上 1/3 before / 中 inside / 下 1/3 after
		expect(dropZoneFor(box, { x: 150, y: 10 })).toBe("before");
		expect(dropZoneFor(box, { x: 150, y: 45 })).toBe("inside");
		expect(dropZoneFor(box, { x: 150, y: 80 })).toBe("after");
		// h 轴（tree-down）：按 x 分区
		expect(dropZoneFor(box, { x: 50, y: 45 }, "h")).toBe("before");
		expect(dropZoneFor(box, { x: 150, y: 10 }, "h")).toBe("inside");
		expect(dropZoneFor(box, { x: 250, y: 45 }, "h")).toBe("after");
		// 盒外（极端拖拽角度）不截断，仍可判侧
		expect(dropZoneFor(box, { x: 150, y: -30 })).toBe("before");
	});

	it("insertOrder：before/after 取相邻中点，端点 ±1；目标缺失防御追加末位", () => {
		const sibs = [
			{ id: "a", order: 0 },
			{ id: "b", order: 1 },
			{ id: "c", order: 2 },
		];
		expect(insertOrder(sibs, "a", "before")).toBe(-1); // 首位之前
		expect(insertOrder(sibs, "c", "after")).toBe(3); // 末位之后
		expect(insertOrder(sibs, "b", "before")).toBe(0.5); // 相邻中点
		expect(insertOrder(sibs, "b", "after")).toBe(1.5);
		expect(insertOrder(sibs, "ghost", "after")).toBe(sibs.length); // 防御
	});

	it("subtreeIds：含自身与全部后代（折叠隐藏也在）；环上安全", () => {
		const nodes = [
			makeNode("r", null),
			makeNode("b", "r"),
			makeNode("c", "b", 0, 0, true), // 折叠隐藏——批量落位仍需要
			makeNode("x", null), // 无关节点不收
		];
		expect(subtreeIds(nodes, "r").sort()).toEqual(["b", "c", "r"]);
		const cyclic = [makeNode("a", "b"), makeNode("b", "a")];
		expect(subtreeIds(cyclic, "a").sort()).toEqual(["a", "b"]); // 不死循环
	});

	it("layoutSubtree：根钉在原位，后代按标准布局相对归位；无关子树不入结果", () => {
		// r 在 (100,200)，两个子节点手工乱放；other 为无关根
		const nodes = [
			makeNode("r", null, 100, 200),
			makeNode("b1", "r", 900, 700),
			makeNode("b2", "r", -50, 900),
			makeNode("other", null, 0, 0),
		];
		const pos = layoutSubtree(nodes, "r");
		expect(pos.get("r")).toEqual({ x: 100, y: 200 }); // 根不动
		expect(pos.has("other")).toBe(false);
		// 子列对齐 r 右缘；子块高 2H+GAP_Y，r 垂直居中 → 整块相对 r 上移 (H+GAP_Y)/2
		const lift = (NODE_HEIGHT_EST + GAP_Y) / 2;
		expect(pos.get("b1")).toEqual({
			x: 100 + NODE_WIDTH + GAP_X,
			y: 200 - lift,
		});
		expect(pos.get("b2")).toEqual({
			x: 100 + NODE_WIDTH + GAP_X,
			y: 200 + NODE_HEIGHT_EST + GAP_Y - lift,
		});
	});

	it("layoutTree：节点实测高参与布局（媒体图节点不再按估值堆叠）", () => {
		const nodes = [
			makeNode("r", null),
			{ ...makeNode("a1", "r"), h: 200 }, // 媒体图节点实测高 200（id 序在前）
			makeNode("a2", "r"),
		];
		const pos = layoutTree(nodes);
		expect(pos.get("a1")).toEqual({ x: NODE_WIDTH + GAP_X, y: 0 });
		expect(pos.get("a2")!.y).toBe(200 + GAP_Y); // 后续兄弟排在实测高底缘 + GAP_Y
	});

	it("restackRoots：首根不动，后续根按子树包围盒紧凑堆叠（保 x）；已标准时空结果", () => {
		// r1 子树块占 y [0, H]；r2 远在 y=1000 → 拉回 H + ROOT_GAP_Y
		const nodes = [
			makeNode("r1", null, 0, 0),
			makeNode("c1", "r1", 400, 0),
			makeNode("r2", null, 500, 1000),
		];
		const moves = restackRoots(nodes);
		expect(moves.get("r1")).toBeUndefined();
		expect(moves.get("c1")).toBeUndefined();
		expect(moves.get("r2")).toEqual({ x: 500, y: NODE_HEIGHT_EST + ROOT_GAP_Y });
		// 已是标准间距：零变动（幂等，applyLayout 只写返回 id）
		const already = [
			makeNode("r1", null, 0, 0),
			makeNode("r2", null, 0, NODE_HEIGHT_EST + ROOT_GAP_Y),
		];
		expect(restackRoots(already).size).toBe(0);
	});

	it("restackRoots：子树整体平移（内部相对位置保留），根序按 order", () => {
		// order 让 r2 排在 r1 前：r2 块不动，r1 整棵子树被推到 r2 下方
		const nodes = [
			{ ...makeNode("r1", null, 0, 0), order: 1 },
			{ ...makeNode("r2", null, 100, 0), order: 0 },
			makeNode("c1", "r1", 400, 50),
		];
		const moves = restackRoots(nodes);
		expect(moves.get("r2")).toBeUndefined(); // 首根（order 0）不动
		// r2 块 [0, H] → r1 块顶 = H + ROOT_GAP_Y；r1 当前顶 0 → dy = H + ROOT_GAP_Y
		expect(moves.get("r1")).toEqual({ x: 0, y: NODE_HEIGHT_EST + ROOT_GAP_Y });
		expect(moves.get("c1")).toEqual({ x: 400, y: 50 + NODE_HEIGHT_EST + ROOT_GAP_Y });
	});
});

describe("autoCollectPlacement 摘录自动入图落点（⑲）", () => {
	/** 带卡片归属的节点工厂（分组判定需要 card.documentId / card.page） */
	function makeCardNode(
		id: string,
		parentId: string | null,
		x: number,
		y: number,
		documentId: string | null,
		page: number | null,
	) {
		return { id, parentId, x, y, collapsed: false, branchStyle: null, card: { documentId, page } };
	}

	it("已有分组节点：摘录卡挂其下并与既有兄弟顺延", () => {
		const nodes = [
			makeCardNode("g", null, 0, 0, "docA", null), // 分组节点
			makeCardNode("k1", "g", NODE_WIDTH + GAP_X, 0, "docA", 5), // 既有摘录子节点
			makeCardNode("other", null, 0, 500, "docB", null), // 另一文档的分组
		];
		const plan = autoCollectPlacement(nodes, { documentId: "docA", page: 6 }, "tree");
		expect(plan.createGroup).toBe(false);
		expect(plan.parentId).toBe("g");
		// 兄弟顺延：k1.y + NODE_HEIGHT_EST + GAP_Y，x 与父右缘同列
		expect(plan.childPos).toEqual({
			x: NODE_WIDTH + GAP_X,
			y: 0 + NODE_HEIGHT_EST + GAP_Y,
		});
	});

	it("尚无分组节点：createGroup 计划，分组卡落根区、首子按图默认样式挂右侧", () => {
		const nodes = [
			makeCardNode("r", null, 0, 0, null, null), // 手工根节点
			makeCardNode("k", "r", NODE_WIDTH + GAP_X, 0, "docA", 3), // docA 的摘录（非分组：page 非空）
		];
		const plan = autoCollectPlacement(nodes, { documentId: "docA", page: 4 }, "tree");
		expect(plan.createGroup).toBe(true);
		expect(plan.parentId).toBeNull();
		// 根区只有 r：分组卡落 r 下方 ROOT_GAP_Y 顺延
		expect(plan.groupPos).toEqual({ x: 0, y: NODE_HEIGHT_EST + ROOT_GAP_Y });
		// 首子：分组卡右侧同 y
		expect(plan.childPos).toEqual({
			x: NODE_WIDTH + GAP_X,
			y: NODE_HEIGHT_EST + ROOT_GAP_Y,
		});
	});

	it("分组判定：同文档摘录卡（page 非空）不算分组，手工卡（documentId null）不误配", () => {
		// docA 只有摘录卡、无分组节点 → 新摘录仍要建分组
		const onlyExcerpt = [makeCardNode("k", null, 0, 0, "docA", 5)];
		expect(autoCollectPlacement(onlyExcerpt, { documentId: "docA", page: 6 }).createGroup).toBe(true);

		// 手工卡 documentId 为 null：即便图里有 documentId=null 的节点也不构成"分组"
		const onlyManual = [makeCardNode("m", null, 0, 0, null, null)];
		const plan = autoCollectPlacement(onlyManual, { documentId: null, page: null });
		expect(plan.createGroup).toBe(true); // 纯函数不预设过滤策略，交视图层把关
		expect(plan.parentId).toBeNull();
	});

	it("已有分组且分组带样式覆盖：子落位方向随分组生效样式", () => {
		const nodes = [
			{ id: "g", parentId: null, x: 0, y: 0, collapsed: false, branchStyle: "tree-left", card: { documentId: "docA", page: null } },
		];
		const plan = autoCollectPlacement(nodes, { documentId: "docA", page: 2 }, "tree");
		expect(plan.parentId).toBe("g");
		// tree-left：子落分组左侧一列
		expect(plan.childPos).toEqual({ x: -(NODE_WIDTH + GAP_X), y: 0 });
	});
});
