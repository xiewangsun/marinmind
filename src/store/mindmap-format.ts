import {
	isBranchStyle,
	type Mindmap,
	type MindmapNode,
} from "../types";
import { compareSiblings } from "../mindmap/mindmap-graph";
import { newId } from "../utils";
import { MM_COMMENT_PREFIX, sanitizeFileName } from "./book-format";

/**
 * 脑图文件（`脑图/<图名>.md`）的 Markdown 序列化纯函数（㉚）。
 *
 * - **嵌套列表 = 父子树**：缩进 2 空格一级；节点行 = wikilink（指向书文件里卡片的
 *   `^card-<id>` 块锚点）+ 行内机器注释（坐标/折叠/分支样式/创建时间）。
 * - wikilink 的文件名与显示标题仅是展示层——解析只取 `#^card-<id>` 里的 cardId
 *   （标题渲染时由卡片数据实时计算，用户改显示文字不影响数据）。
 * - 手动新增不带机器注释的列表行会被忽略（v1 不支持手编建节点）。
 * - **兄弟顺序（㉜）由列表顺序承载**：序列化按 (order, createdAt, id) 排（与
 *   mindmap-graph 的 compareSiblings 同源），解析按同父下标赋 order——order 不进
 *   JSON，旧版插件读写无感知；旧文件首次解析即获得稳定序（原顺序保持）。
 * - 序列化确定性：同数据两次序列化字节相同。
 */

/** parseMindmapMd 的返回 */
export interface ParsedMindmapFile {
	/** 是否为 MarinMind 脑图文件（frontmatter `marinmind: mindmap`）——扫描目录时用于认领 */
	claimed: boolean;
	map: Mindmap;
	nodes: MindmapNode[];
	/** 未知 frontmatter 行（原样保留，序列化时回写） */
	extraFrontmatter: string[];
	warnings: string[];
}

/** parseMindmapMd 可选入参 */
export interface ParseMindmapOptions {
	/** 所在文件名（缺 name 时兜底取名） */
	fileName?: string;
}

/** 序列化时解析卡片 wikilink 的上下文（由 store 注入：cardId → 书文件与标题） */
export interface MindmapSerializeContext {
	resolveCard(cardId: string): { fileBase: string; title: string } | undefined;
}

/** 脑图 frontmatter 的已知字段（其余 key:value 行原样保留往返） */
const KNOWN_MINDMAP_FM_KEYS = new Set([
	"marinmind",
	"id",
	"name",
	"document_id",
	"fixed_root",
	"default_branch_style",
	"created_at",
	"updated_at",
]);

/** 解析一个脑图文件 */
export function parseMindmapMd(
	text: string,
	opts: ParseMindmapOptions = {},
): ParsedMindmapFile {
	const warnings: string[] = [];
	const lines = text.split(/\r?\n/);

	// --- frontmatter ---
	const fm = new Map<string, string>();
	const extraFrontmatter: string[] = [];
	let bodyStart = 0;
	if (lines[0]?.trim() === "---") {
		const end = lines.findIndex((l, idx) => idx > 0 && l.trim() === "---");
		if (end < 0) {
			warnings.push("frontmatter 未闭合，按无 frontmatter 解析");
			bodyStart = 1;
		} else {
			for (let j = 1; j < end; j++) {
				const m = /^([A-Za-z0-9_]+):\s?(.*)$/.exec(lines[j]);
				if (m && KNOWN_MINDMAP_FM_KEYS.has(m[1])) fm.set(m[1], m[2]);
				else extraFrontmatter.push(lines[j]); // 未知字段/非常规行原样保留
			}
			bodyStart = end + 1;
		}
	}

	const rawStyle = fm.get("default_branch_style") ?? "tree";
	const style = isBranchStyle(rawStyle) ? rawStyle : "tree";
	if (!isBranchStyle(rawStyle)) {
		warnings.push(`default_branch_style 非法（${rawStyle}），已归一为 tree`);
	}

	const mapId = fm.get("id")?.trim() || "";
	if (!mapId) warnings.push("frontmatter 缺 id（已自动生成，下次写入修复）");

	const unquote = (v: string | undefined): string | null => {
		const raw = v ?? "";
		if (!raw) return null;
		if (raw.startsWith('"') && raw.endsWith('"')) {
			try {
				const parsed = JSON.parse(raw);
				return typeof parsed === "string" ? parsed : raw;
			} catch {
				return raw;
			}
		}
		return raw;
	};

	const map: Mindmap = {
		id: mapId || newId(),
		name: unquote(fm.get("name")) ?? opts.fileName?.replace(/\.md$/, "") ?? "未命名脑图",
		defaultBranchStyle: style,
		documentId: unquote(fm.get("document_id")),
		fixedRootNodeId: unquote(fm.get("fixed_root")),
		createdAt: Number(fm.get("created_at")) || 0,
		updatedAt: Number(fm.get("updated_at")) || 0,
	};

	// 类型不符按空图返回——由 warnings 说明
	const kind = fm.get("marinmind");
	if (kind !== undefined && kind !== "mindmap") {
		warnings.push(`marinmind frontmatter 应为 mindmap，实际为 ${kind}，按空图解析`);
		return { claimed: false, map, nodes: [], extraFrontmatter, warnings };
	}

	// --- 列表行游走：嵌套深度 → 父节点 ---
	const nodes: MindmapNode[] = [];
	const seenCards = new Set<string>();
	/** 栈元素：[深度, 节点]；列表行的父 = 深度恰小 1 的最近前驱 */
	const stack: Array<{ depth: number; node: MindmapNode }> = [];

	for (let j = bodyStart; j < lines.length; j++) {
		const line = lines[j];
		const m = /^(\s*)-\s+(.*)$/.exec(line);
		if (!m) continue;
		const depth = Math.floor(m[1].length / 2);
		const rest = m[2];

		// wikilink + 机器注释
		const linkMatch = /\[\[([^\]]*)#(\^card-[^\s|\]]+)(?:\|([^\]]*))?\]\]/.exec(rest);
		const commentIdx = rest.indexOf(MM_COMMENT_PREFIX);
		if (commentIdx < 0 || !rest.endsWith("-->")) {
			warnings.push(`第 ${j + 1} 行：列表项缺机器注释（不支持手编建节点），已忽略`);
			continue;
		}
		if (!linkMatch) {
			warnings.push(`第 ${j + 1} 行：机器注释缺卡片 wikilink，已忽略`);
			continue;
		}
		const cardId = linkMatch[2].slice("^card-".length);
		if (seenCards.has(cardId)) {
			warnings.push(`第 ${j + 1} 行：卡片 ${cardId} 在本图重复（一图一卡），已忽略后者`);
			continue;
		}

		let json: Record<string, unknown>;
		try {
			json = JSON.parse(
				rest.slice(commentIdx + MM_COMMENT_PREFIX.length, -3),
			) as Record<string, unknown>;
		} catch {
			warnings.push(`第 ${j + 1} 行：节点机器注释 JSON 损坏，已跳过`);
			continue;
		}
		const nodeId = typeof json.id === "string" ? json.id : "";
		if (!nodeId) {
			warnings.push(`第 ${j + 1} 行：节点机器注释缺 id，已跳过`);
			continue;
		}

		// 弹栈到父层级：父 = 深度恰小 1 的最近前驱；跨级跳跃按根处理（防御手编）
		while (stack.length > 0 && stack[stack.length - 1].depth >= depth) stack.pop();
		const parent = stack.length > 0 && stack[stack.length - 1].depth === depth - 1
			? stack[stack.length - 1].node
			: null;
		if (depth > 0 && !parent) {
			warnings.push(`第 ${j + 1} 行：缩进层级跳级，节点按根节点处理`);
		}

		const node: MindmapNode = {
			id: nodeId,
			mapId: map.id,
			cardId,
			parentId: parent ? parent.id : null,
			x: typeof json.x === "number" ? json.x : 0,
			y: typeof json.y === "number" ? json.y : 0,
			collapsed: json.col === 1,
			branchStyle: typeof json.style === "string" && isBranchStyle(json.style) ? json.style : null,
			// 61 子脑图：sub = 子图 id（悬空引用原样保留，读取侧 get 守卫自愈）
			childMapId: typeof json.sub === "string" ? json.sub : null,
			createdAt: typeof json.created === "number" ? json.created : 0,
		};
		nodes.push(node);
		seenCards.add(cardId);
		stack.push({ depth, node });
	}

	// ㉜ 兄弟序 = 列表顺序（同父下标；根集合同键 null）——与序列化端的
	// compareSiblings 排序互为逆操作，顺序即数据（order 不落 JSON）
	const orderCursor = new Map<string | null, number>();
	for (const n of nodes) {
		const next = orderCursor.get(n.parentId) ?? 0;
		n.order = next;
		orderCursor.set(n.parentId, next + 1);
	}

	return { claimed: kind === "mindmap", map, nodes, extraFrontmatter, warnings };
}

/** 序列化脑图文件（确定性输出：同输入两次序列化字节相同） */
export function serializeMindmapMd(
	map: Mindmap,
	nodes: MindmapNode[],
	ctx: MindmapSerializeContext,
	extraFrontmatter: string[] = [],
): string {
	const out: string[] = [];

	// frontmatter
	out.push("---");
	out.push("marinmind: mindmap");
	out.push(`id: ${map.id}`);
	out.push(`name: ${quoteYaml(map.name)}`);
	if (map.documentId) out.push(`document_id: ${map.documentId}`);
	if (map.fixedRootNodeId) out.push(`fixed_root: ${map.fixedRootNodeId}`);
	out.push(`default_branch_style: ${map.defaultBranchStyle}`);
	out.push(`created_at: ${map.createdAt}`);
	out.push(`updated_at: ${map.updatedAt}`);
	for (const line of extraFrontmatter) out.push(line);
	out.push("---");

	// 子女表 + 根集合（父缺失的孤儿节点按根序列化——防御中间态）
	const children = new Map<string | null, MindmapNode[]>();
	for (const n of nodes) {
		const key = n.parentId;
		const bucket = children.get(key);
		if (bucket) bucket.push(n);
		else children.set(key, [n]);
	}
	const ids = new Set(nodes.map((n) => n.id));
	const roots = (children.get(null) ?? []).concat(
		nodes.filter((n) => n.parentId !== null && !ids.has(n.parentId)),
	);

	// ㉜ 列表顺序即兄弟序：与 mindmap-graph 的显示堆叠同源排序（order → 创建序 → id）
	const orderNodes = (list: MindmapNode[]): MindmapNode[] => list.sort(compareSiblings);

	const emit = (node: MindmapNode, depth: number): void => {
		const kids = orderNodes(children.get(node.id) ?? []);
		const resolved = ctx.resolveCard(node.cardId);
		if (resolved) {
			const indent = "  ".repeat(depth);
			const machine: Record<string, unknown> = { id: node.id, x: node.x, y: node.y };
			if (node.collapsed) machine.col = 1;
			if (node.branchStyle) machine.style = node.branchStyle;
			if (node.childMapId) machine.sub = node.childMapId; // 61 子脑图（null 省键零写入契约）
			machine.created = node.createdAt;
			const link = `[[${resolved.fileBase}#^card-${node.cardId}|${escapeWikiTitle(resolved.title)}]]`;
			out.push(`${indent}- ${link} ${MM_COMMENT_PREFIX}${JSON.stringify(machine)} -->`);
		}
		// 卡片已不存在的中间态节点：自身跳过，子树浮到同级继续序列化（重析后归为根）
		const childDepth = depth + (resolved ? 1 : 0);
		for (const child of kids) emit(child, childDepth);
	};
	for (const root of orderNodes(roots)) emit(root, 0);

	out.push("");
	return out.join("\n");
}

/** YAML 值加引号（图名可能含冒号等危险字符） */
function quoteYaml(v: string): string {
	if (/[:#\[\]{}&*!|>'"%@`]/.test(v) || /^\s|\s$/.test(v) || v === "") {
		return JSON.stringify(v);
	}
	return v;
}

/** wikilink 显示文本转义（方括号换全角、换行压空格——不破坏链接语法；㊻ 起导出供卡片互链复用） */
export function escapeWikiTitle(title: string): string {
	return title.replace(/\[/g, "［").replace(/\]/g, "］").replace(/\r?\n/g, " ");
}

/** 脑图文件名（数据根相对：脑图/<净化图名>.md，冲突处理由 store 负责） */
export function mindmapFileName(name: string): string {
	return `${sanitizeFileName(name)}.md`;
}
