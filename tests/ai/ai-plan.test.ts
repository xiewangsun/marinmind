import { describe, expect, it } from "vitest";
import {
	ORGANIZE_GROUP_CAP,
	ORGANIZE_NODE_CAP,
	OUTLINE_GEN_MAX,
	buildOrganizeMessages,
	buildOutlineMessages,
	parseOrganizeGroups,
	parseOutlineTree,
	wouldCycle,
	type OrganizeCandidate,
} from "../../src/ai/ai-plan";
import { planOutlineChapters } from "../../src/mindmap/pdf-outline";

const candidates: OrganizeCandidate[] = [
	{ nodeId: "n1", text: "贝叶斯定理公式" },
	{ nodeId: "n2", text: "条件概率定义" },
	{ nodeId: "n3", text: "光合作用光反应" },
	{ nodeId: "n4", text: "卡尔文循环" },
];

describe("buildOrganizeMessages（100 整理）", () => {
	it("候选以「序号. 摘要」呈现（nodeId 不进 prompt）；输出约束 JSON 数组", () => {
		const messages = buildOrganizeMessages(candidates);
		expect(messages).toHaveLength(2);
		expect(messages[0].content).toContain('"indices"');
		expect(messages[0].content).toContain("每组至少 2 个");
		expect(messages[0].content).toContain("不必强行分配");
		expect(messages[1].content).toContain("0. 贝叶斯定理公式");
		expect(messages[1].content).not.toContain("n1");
	});

	it("约束含分组数与组名长度上限", () => {
		const system = buildOrganizeMessages(candidates)[0].content;
		expect(system).toContain(`至多 ${ORGANIZE_GROUP_CAP} 组`);
		expect(system).toContain("12 字"); // ORGANIZE_NAME_CLIP
	});
});

describe("parseOrganizeGroups", () => {
	it("回映射真实 nodeId；name 透传", () => {
		const raw = JSON.stringify([
			{ name: "概率", indices: [0, 1] },
			{ name: "光合", indices: [2, 3] },
		]);
		const groups = parseOrganizeGroups(raw, candidates);
		expect(groups).toEqual([
			{ name: "概率", nodeIds: ["n1", "n2"] },
			{ name: "光合", nodeIds: ["n3", "n4"] },
		]);
	});

	it("越界/非数下标丢弃；单有效成员的组丢弃（无整理价值）", () => {
		const raw = JSON.stringify([
			{ name: "A", indices: [0, 9, "1", -1] }, // 有效仅 n1 → 组丢弃
			{ name: "B", indices: [2, 3, 99] }, // 有效 n3 n4 → 保留
		]);
		const groups = parseOrganizeGroups(raw, candidates);
		expect(groups).toEqual([{ name: "B", nodeIds: ["n3", "n4"] }]);
	});

	it("跨组重复认领以首组为准", () => {
		const raw = JSON.stringify([
			{ name: "A", indices: [0, 1] },
			{ name: "B", indices: [0, 2, 3] }, // n0 已属 A → B 收 n2 n3
		]);
		const groups = parseOrganizeGroups(raw, candidates);
		expect(groups[0].nodeIds).toEqual(["n1", "n2"]);
		expect(groups[1].nodeIds).toEqual(["n3", "n4"]);
	});

	it("name 缺省/超长：兜底「分组N」并截断", () => {
		const raw = JSON.stringify([
			{ indices: [0, 1] },
			{ name: "很".repeat(30), indices: [2, 3] },
		]);
		const groups = parseOrganizeGroups(raw, candidates);
		expect(groups[0].name).toBe("分组1");
		expect(groups[1].name).toBe(`很`.repeat(12) + "…");
	});

	it("自由文本/空数组返回空（「不需要整理」不是错误）", () => {
		expect(parseOrganizeGroups("这些节点不需要分组", candidates)).toEqual([]);
		expect(parseOrganizeGroups("[]", candidates)).toEqual([]);
	});

	it("超 ORGANIZE_GROUP_CAP 组截断（prompt 约束的兜底）", () => {
		const many: OrganizeCandidate[] = Array.from({ length: ORGANIZE_NODE_CAP }, (_, i) => ({
			nodeId: `x${i}`,
			text: `候选${i}`,
		}));
		const raw = JSON.stringify(
			Array.from({ length: ORGANIZE_GROUP_CAP + 5 }, (_, g) => ({
				name: `组${g}`,
				indices: [g * 2, g * 2 + 1],
			})),
		);
		expect(parseOrganizeGroups(raw, many)).toHaveLength(ORGANIZE_GROUP_CAP);
	});
});

describe("wouldCycle", () => {
	// 父链：c → b → a → null
	const parentOf = new Map<string, string | null>([
		["a", null],
		["b", "a"],
		["c", "b"],
	]);

	it("新父的祖先链含自身即环", () => {
		expect(wouldCycle(parentOf, "a", "c")).toBe(true); // c→b→a
		expect(wouldCycle(parentOf, "b", "c")).toBe(true); // c→b
	});

	it("无亲缘不环；挂 null 不环；自挂/挂到自己后代是环", () => {
		expect(wouldCycle(parentOf, "c", "a")).toBe(false); // a 是 c 的祖先，但 c 不是 a 的祖先——不环
		expect(wouldCycle(parentOf, "a", "b")).toBe(true); // b 是 a 的子级（a→b），a 挂到自己后代下成环
		expect(wouldCycle(parentOf, "c", null)).toBe(false);
		expect(wouldCycle(parentOf, "c", "c")).toBe(true);
	});

	it("既有数据成环（脏数据防御）：按环处理", () => {
		const dirty = new Map<string, string | null>([
			["x", "y"],
			["y", "x"],
			["z", null],
		]);
		expect(wouldCycle(dirty, "z", "x")).toBe(true); // x→y→x 环
	});
});

describe("buildOutlineMessages（100 大纲）", () => {
	it("约束页码只引用标记值、层级与条数上限；user 为带页标记全文", () => {
		const messages = buildOutlineMessages("[第 1 页]\n内容");
		expect(messages[0].content).toContain("禁止编造");
		expect(messages[0].content).toContain("[第 N 页]");
		expect(messages[0].content).toContain(`至多 ${OUTLINE_GEN_MAX} 条`);
		expect(messages[1].content).toBe("[第 1 页]\n内容");
	});
});

describe("parseOutlineTree", () => {
	const validPages = new Set([1, 3, 7]);

	it("嵌套树保持层级（children 挂回父节点，不平铺）", () => {
		const raw = JSON.stringify([
			{
				title: "第一章",
				page: 1,
				children: [{ title: "1.1 节", page: 1, children: [] }],
			},
			{ title: "第二章", page: 3, children: [] },
		]);
		const tree = parseOutlineTree(raw, validPages);
		expect(tree).toHaveLength(2);
		expect(tree[0].children).toEqual([{ title: "1.1 节", page: 1, children: [] }]);
		expect(tree[1].children).toEqual([]);
	});

	it("页码硬校验：不在标记页集合的降级 null（后续走损坏条目跳过路径）", () => {
		const raw = JSON.stringify([{ title: "章", page: 999, children: [] }]);
		const tree = parseOutlineTree(raw, validPages);
		expect(tree[0].page).toBeNull();
	});

	it("降级 null 的条目经 planOutlineChapters 跳过、子级上浮（复用目录建框架语义）", () => {
		const raw = JSON.stringify([
			{
				title: "坏章",
				page: 999,
				children: [{ title: "好节", page: 3, children: [] }],
			},
		]);
		const plan = planOutlineChapters(parseOutlineTree(raw, validPages));
		expect(plan).toEqual([
			expect.objectContaining({ title: "好节", page: 3, parentIndex: null, depth: 0 }),
		]);
	});

	it("空标题/非对象项丢弃；title 截断清洗", () => {
		const raw = JSON.stringify([
			{ title: "  ", page: 1 },
			"杂项",
			{ title: "好".repeat(100), page: 1, children: [] },
		]);
		const tree = parseOutlineTree(raw, validPages);
		expect(tree).toHaveLength(1);
		expect(tree[0].title.length).toBeLessThanOrEqual(61); // 60 + 省略号
	});

	it("深度超 3 层截平（深层子项丢弃）", () => {
		const raw = JSON.stringify([
			{
				title: "1",
				page: 1,
				children: [
					{
						title: "2",
						page: 1,
						children: [
							{
								title: "3",
								page: 1,
								children: [{ title: "4", page: 1, children: [] }],
							},
						],
					},
				],
			},
		]);
		const tree = parseOutlineTree(raw, validPages);
		expect(tree[0].children[0].children[0].children).toEqual([]);
	});

	it("总条数超 OUTLINE_GEN_MAX 截断", () => {
		const list = Array.from({ length: OUTLINE_GEN_MAX + 20 }, (_, i) => ({
			title: `章${i}`,
			page: 1,
			children: [],
		}));
		const flat: number[] = [];
		const count = (nodes: ReturnType<typeof parseOutlineTree>): void => {
			for (const n of nodes) {
				flat.push(1);
				count(n.children);
			}
		};
		count(parseOutlineTree(JSON.stringify(list), validPages));
		expect(flat.length).toBe(OUTLINE_GEN_MAX);
	});

	it("全部无效抛中文错误", () => {
		expect(() => parseOutlineTree("[]", validPages)).toThrow(/未生成有效/);
		expect(() => parseOutlineTree('[{"title":"  ","page":1}]', validPages)).toThrow(
			/未生成有效/,
		);
	});
});
