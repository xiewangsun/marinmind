import { describe, expect, it } from "vitest";
import type { Mindmap, MindmapNode } from "../../src/types";
import {
	mindmapFileName,
	parseMindmapMd,
	serializeMindmapMd,
} from "../../src/store/mindmap-format";

/** 卡片wikilink 解析上下文（模拟 store 注入） */
function resolver(titles: Record<string, string>) {
	return {
		resolveCard(cardId: string) {
			const title = titles[cardId];
			return title === undefined ? undefined : { fileBase: "书籍A", title };
		},
	};
}

function map(partial: Partial<Mindmap> = {}): Mindmap {
	return {
		id: "mm111111-0000-4000-8000-000000000001",
		name: "学习图",
		defaultBranchStyle: "tree",
		documentId: null,
		fixedRootNodeId: null,
		createdAt: 1700000000000,
		updatedAt: 1700000100000,
		...partial,
	};
}

function node(partial: Partial<MindmapNode> & Pick<MindmapNode, "id" | "cardId">): MindmapNode {
	return {
		mapId: map().id,
		parentId: null,
		x: 0,
		y: 0,
		collapsed: false,
		branchStyle: null,
		childMapId: null, // 61 子脑图（可被 partial 覆盖为 portal）
		order: 0, // ㉜ 兄弟序（可被 partial 覆盖；undefined 显式传入 = 旧数据形态）
		createdAt: 1700000001000,
		...partial,
	};
}

describe("mindmap-format 序列化与解析", () => {
	it("嵌套树往返：父子结构、坐标、折叠、样式还原；二次序列化字节相同", () => {
		const root = node({ id: "n1", cardId: "c1", x: 10, y: 0 });
		const child = node({
			id: "n2",
			cardId: "c2",
			parentId: "n1",
			x: 220,
			y: 40,
			createdAt: 1700000002000,
		});
		const grand = node({
			id: "n3",
			cardId: "c3",
			parentId: "n2",
			x: 440,
			y: 80,
			collapsed: true,
			branchStyle: "line",
		});
		const root2 = node({
			id: "n4",
			cardId: "c4",
			x: 0,
			y: 300,
			createdAt: 1700000003000,
			order: 1,
		});
		const nodes = [root, child, grand, root2];
		const ctx = resolver({ c1: "根节点", c2: "子节点", c3: "[带括号] 标题", c4: "第二根" });

		const text = serializeMindmapMd(map(), nodes, ctx);
		expect(text).toContain("marinmind: mindmap");
		expect(text).toContain(`name: ${map().name}`);
		expect(text).toContain("- [[书籍A#^card-c1|根节点]]");
		expect(text).toContain("  - [[书籍A#^card-c2|子节点]]");
		// 显示文本中的方括号被转义为全角，不破坏链接语法
		expect(text).toContain("|［带括号］ 标题]]");

		const parsed = parseMindmapMd(text, { fileName: "学习图.md" });
		expect(parsed.warnings).toEqual([]);
		expect(parsed.map).toEqual(map());
		expect(parsed.nodes).toEqual(nodes);

		const again = serializeMindmapMd(parsed.map, parsed.nodes, ctx, parsed.extraFrontmatter);
		expect(again).toBe(text);
	});

	it("书籍默认图字段与固定根往返", () => {
		const m = map({
			name: "图: 含冒号",
			documentId: "doc-1",
			fixedRootNodeId: "n2",
			defaultBranchStyle: "frame",
		});
		const nodes = [
			node({ id: "n1", cardId: "c1" }),
			node({ id: "n2", cardId: "c2", parentId: "n1" }),
		];
		const ctx = resolver({ c1: "A", c2: "B" });
		const parsed = parseMindmapMd(serializeMindmapMd(m, nodes, ctx));
		expect(parsed.map).toEqual(m);
		expect(parsed.nodes).toEqual(nodes);
	});

	it("改 wikilink 显示文字不影响解析（cardId 为准）", () => {
		const nodes = [node({ id: "n1", cardId: "c1" })];
		const ctx = resolver({ c1: "原标题" });
		const text = serializeMindmapMd(map(), nodes, ctx).replace("|原标题]]", "|用户随手改的]]");
		const parsed = parseMindmapMd(text);
		expect(parsed.nodes[0].cardId).toBe("c1");
		expect(parsed.warnings).toEqual([]);
	});

	it("跨级缩进按根处理并警告；无注释列表行忽略", () => {
		const text = [
			"---",
			"marinmind: mindmap",
			`id: ${map().id}`,
			"name: 学习图",
			"default_branch_style: tree",
			"created_at: 1700000000000",
			"updated_at: 1700000100000",
			"---",
			"",
			'- [[书籍A#^card-c1|根]] <!--mm {"id":"n1","x":0,"y":0,"created":1} -->',
			'    - [[书籍A#^card-c2|跳级]] <!--mm {"id":"n2","x":1,"y":1,"created":2} -->',
			"- 手写的行没有机器注释",
			"",
		].join("\n");
		const parsed = parseMindmapMd(text);
		expect(parsed.nodes).toHaveLength(2);
		expect(parsed.nodes[1].parentId).toBeNull(); // 4 空格 = 深度 2，跳级 → 根
		expect(parsed.warnings.some((w) => w.includes("跳级"))).toBe(true);
		expect(parsed.warnings.some((w) => w.includes("手编建节点"))).toBe(true);
	});

	it("一图一卡：重复 cardId 忽略后者并警告", () => {
		const text = [
			"---",
			"marinmind: mindmap",
			`id: ${map().id}`,
			"name: 学习图",
			"default_branch_style: tree",
			"created_at: 1",
			"updated_at: 1",
			"---",
			"",
			'- [[书籍A#^card-c1|一]] <!--mm {"id":"n1","x":0,"y":0} -->',
			'- [[书籍A#^card-c1|二]] <!--mm {"id":"n2","x":0,"y":1} -->',
			"",
		].join("\n");
		const parsed = parseMindmapMd(text);
		expect(parsed.nodes).toHaveLength(1);
		expect(parsed.nodes[0].id).toBe("n1");
		expect(parsed.warnings.some((w) => w.includes("重复"))).toBe(true);
	});

	it("节点机器注释损坏：跳过该节点，子树浮为根", () => {
		const nodes = [
			node({ id: "n1", cardId: "c1" }),
			node({ id: "n2", cardId: "c2", parentId: "n1", x: 5, y: 5 }),
		];
		const ctx = resolver({ c1: "A", c2: "B" });
		const text = serializeMindmapMd(map(), nodes, ctx).replace(
			/<!--mm \{"id":"n1"[^>]*-->/,
			"<!--mm broken -->",
		);
		const parsed = parseMindmapMd(text);
		expect(parsed.nodes).toHaveLength(1);
		expect(parsed.nodes[0].id).toBe("n2");
		expect(parsed.nodes[0].parentId).toBeNull();
	});

	it("序列化时卡片缺失（中间态）：节点跳过、子树浮到同级", () => {
		const nodes = [
			node({ id: "n1", cardId: "c-gone" }),
			node({ id: "n2", cardId: "c2", parentId: "n1" }),
		];
		const ctx = resolver({ c2: "子" });
		const text = serializeMindmapMd(map(), nodes, ctx);
		expect(text).not.toContain("c-gone");
		expect(text).toContain("- [[书籍A#^card-c2|子]]");
		expect((text.match(/- \[\[/g) ?? []).length).toBe(1);
		// 重析后子节点成根
		const parsed = parseMindmapMd(text);
		expect(parsed.nodes[0].parentId).toBeNull();
	});

	it("非法 default_branch_style 归一为 tree 并警告；未知 frontmatter 保留", () => {
		const nodes = [node({ id: "n1", cardId: "c1" })];
		const ctx = resolver({ c1: "A" });
		const text = serializeMindmapMd(map(), nodes, ctx)
			.replace("default_branch_style: tree", "default_branch_style: bogus")
			.replace("---\nmarinmind:", "---\ncssclasses: [wide]\nmarinmind:");
		const parsed = parseMindmapMd(text);
		expect(parsed.map.defaultBranchStyle).toBe("tree");
		expect(parsed.warnings.some((w) => w.includes("bogus"))).toBe(true);
		expect(parsed.extraFrontmatter).toContain("cssclasses: [wide]");
	});

	it("兄弟顺序（㉜）：序列化按 order 排输出，解析按下标赋值——重排后文件顺序即新顺序", () => {
		// n1 下三子，order 重排为 c1(0) → c3(1) → c2(2)
		const nodes = [
			node({ id: "n1", cardId: "c0" }),
			node({ id: "n2", cardId: "c1", parentId: "n1", order: 0 }),
			node({ id: "n3", cardId: "c3", parentId: "n1", order: 1 }),
			node({ id: "n4", cardId: "c2", parentId: "n1", order: 2 }),
		];
		const ctx = resolver({ c0: "根", c1: "一", c2: "二", c3: "三" });
		const text = serializeMindmapMd(map(), nodes, ctx);
		// 文件列表顺序 = order 顺序（而非数组/坐标顺序）
		const idx = (cid: string) => text.indexOf(`^card-${cid}`);
		expect(idx("c1")).toBeLessThan(idx("c3"));
		expect(idx("c3")).toBeLessThan(idx("c2"));
		// 解析按同父下标重赋 order，与写入值一致（0/1/2）
		const parsed = parseMindmapMd(text);
		const byId = new Map(parsed.nodes.map((n) => [n.id, n]));
		expect(byId.get("n2")?.order).toBe(0);
		expect(byId.get("n3")?.order).toBe(1);
		expect(byId.get("n4")?.order).toBe(2);
	});

	it("旧数据无 order：按创建序输出，解析赋下标序（升级零感知）", () => {
		const nodes = [
			node({ id: "n1", cardId: "c0" }),
			node({
				id: "n2",
				cardId: "c1",
				parentId: "n1",
				createdAt: 1700000002000,
				order: undefined,
			}),
			node({
				id: "n3",
				cardId: "c2",
				parentId: "n1",
				createdAt: 1700000001000,
				order: undefined,
			}),
		];
		const ctx = resolver({ c0: "根", c1: "晚", c2: "早" });
		const text = serializeMindmapMd(map(), nodes, ctx);
		// 创建早的（c2）排在文件前面
		expect(text.indexOf("^card-c2")).toBeLessThan(text.indexOf("^card-c1"));
		const parsed = parseMindmapMd(text);
		const byId = new Map(parsed.nodes.map((n) => [n.id, n]));
		expect(byId.get("n3")?.order).toBe(0); // 文件首 = 下标 0
		expect(byId.get("n2")?.order).toBe(1);
	});

	// ---------- 61 子脑图 sub 键 ----------

	it("sub 键往返：childMapId 序列化落键、解析还原；二次序列化字节相同", () => {
		const nodes = [
			node({ id: "n1", cardId: "c1", childMapId: "mm222222-0000-4000-8000-000000000009" }),
			node({ id: "n2", cardId: "c2", parentId: "n1" }),
		];
		const ctx = resolver({ c1: "portal", c2: "子" });
		const text = serializeMindmapMd(map(), nodes, ctx);
		expect(text).toContain('"sub":"mm222222-0000-4000-8000-000000000009"');

		const parsed = parseMindmapMd(text);
		const byId = new Map(parsed.nodes.map((n) => [n.id, n]));
		expect(byId.get("n1")?.childMapId).toBe("mm222222-0000-4000-8000-000000000009");
		expect(byId.get("n2")?.childMapId).toBeNull();

		expect(serializeMindmapMd(parsed.map, parsed.nodes, ctx)).toBe(text); // 字节相同
	});

	it("零写入契约：childMapId 全 null 的图不含 sub 键（存量文件字节不变）", () => {
		const plain = [
			node({ id: "n1", cardId: "c1" }),
			node({ id: "n2", cardId: "c2", parentId: "n1" }),
		];
		const withNull = [
			node({ id: "n1", cardId: "c1", childMapId: null }),
			node({ id: "n2", cardId: "c2", parentId: "n1", childMapId: null }),
		];
		const ctx = resolver({ c1: "根", c2: "子" });
		const a = serializeMindmapMd(map(), plain, ctx);
		const b = serializeMindmapMd(map(), withNull, ctx);
		expect(b).not.toContain('"sub"');
		expect(a).toBe(b); // null 与缺省字节一致
	});

	it("悬空 sub 引用原样保留（读取侧 get 守卫自愈，序列化不丢引用）", () => {
		const nodes = [
			node({ id: "n1", cardId: "c1", childMapId: "mm333333-0000-4000-8000-000000000001" }),
		];
		const ctx = resolver({ c1: "portal" });
		const text = serializeMindmapMd(map(), nodes, ctx);
		const parsed = parseMindmapMd(text);
		expect(parsed.nodes[0].childMapId).toBe("mm333333-0000-4000-8000-000000000001");
		// 指向不存在的图：解析层不清洗（delete 清扫负责正常路径），再次序列化保持
		expect(serializeMindmapMd(parsed.map, parsed.nodes, ctx)).toBe(text);
	});
});

describe("mindmapFileName", () => {
	it("图名净化 + .md 后缀", () => {
		expect(mindmapFileName("学习: 图/一")).toBe("学习 图 一.md");
	});
});
