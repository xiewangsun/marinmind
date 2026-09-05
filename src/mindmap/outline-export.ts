/**
 * 脑图导出 Markdown 大纲（54，纯函数，零 obsidian 依赖，vitest 直接覆盖）。
 *
 * 脑图树 → 嵌套无序列表（两空格缩进，层级与画布一致）；每行默认纯标题
 * （cardTitle 同源：标题→批注→摘录文字→形态占位），linkOf 返回该卡的
 * wikilink 时替换为 `[[MarinMind/书#^card-id|标题]]`——点击即跳书文件卡片锚点。
 * 根按 compareSiblings 序（与画布堆叠顺序一致）；DFS 带 visited 防脏数据成环悬挂。
 */

import type { Card } from "../types";
import { buildChildrenMap, type GraphNode } from "./mindmap-graph";
import { cardTitle } from "../review/map-context";

/** 大纲单行文本上限（超长截断加省略号，列表行过长阅读器里反而难扫） */
const LINE_LIMIT = 120;

/** 大纲节点 = 图节点 + 携带卡片（视图直接传 MindmapNodeWithCard） */
export interface OutlineGraphNode extends GraphNode {
	card: Card;
}

/** 大纲行文本：cardTitle 同源，首行单行化（多行批注只取首行）+ 限长 */
export function outlineLineText(card: Card): string {
	const raw = cardTitle(card);
	const firstLine = raw.split(/\r?\n/, 1)[0].trim() || "（空白卡片）";
	return firstLine.length > LINE_LIMIT ? `${firstLine.slice(0, LINE_LIMIT)}…` : firstLine;
}

/**
 * 构建整图 Markdown 大纲。linkOf 每卡调用一次：返回完整 wikilink 文本
 * （调用方经 buildCardCopyText 构造）或 null（纯标题降级——fs 数据根/隐藏
 * 目录/无书归属卡片）。空图返回空字符串。
 */
export function buildOutlineMarkdown(
	nodes: OutlineGraphNode[],
	linkOf: (card: Card) => string | null,
): string {
	if (nodes.length === 0) {
		return "";
	}
	const childrenMap = buildChildrenMap(nodes);
	// buildChildrenMap 返回 GraphNode[]（分组丢失 card 字段的静态类型）——
	// Map 存的是入参数组同一批引用，运行时必为 OutlineGraphNode，收窄转型安全
	const roots = (childrenMap.get(null) ?? []) as OutlineGraphNode[];
	const lines: string[] = [];
	const visited = new Set<string>(); // 全局防环（一图一卡：正常数据每节点只到达一次）
	const walk = (node: OutlineGraphNode, depth: number): void => {
		if (visited.has(node.id)) {
			return;
		}
		visited.add(node.id);
		const link = linkOf(node.card);
		lines.push(`${"  ".repeat(depth)}- ${link ?? outlineLineText(node.card)}`);
		for (const child of (childrenMap.get(node.id) ?? []) as OutlineGraphNode[]) {
			walk(child, depth + 1);
		}
	};
	for (const root of roots) {
		walk(root, 0);
	}
	return lines.join("\n") + "\n";
}

/**
 * XML 1.0 属性值转义（OPML text/title 属性承载卡片标题/图名）。
 * 五个预定义实体之外，顺手剥离 XML 非法控制字符（U+0000-0008/000B/000C/
 * 000E-001F——正文混入一个即整份 OPML 无法解析，dom-snapshot ㊽-2 同教训；
 * fromCharCode 组装避免源码嵌字面控制字符）。
 */
const INVALID_XML_CHARS_RE = new RegExp(
	"[" +
		String.fromCharCode(0) +
		"-" +
		String.fromCharCode(8) +
		String.fromCharCode(11) +
		String.fromCharCode(12) +
		String.fromCharCode(14) +
		"-" +
		String.fromCharCode(31) +
		"]",
	"g",
);

function escapeXmlAttr(value: string): string {
	return value
		.replace(INVALID_XML_CHARS_RE, "")
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;")
		.replace(/'/g, "&apos;");
}

/**
 * 构建整图 OPML 2.0 大纲（63）：与 buildOutlineMarkdown 同一棵树同一次遍历
 * （buildChildrenMap 已按 compareSiblings 排序 + visited 防环），节点文本 =
 * outlineLineText 同源（OPML 是纯文本大纲交换格式，不承载 wikilink——外部
 * 工具不认识 Obsidian 链接，降级即常态）。嵌套 `<outline text="…">` 承载
 * 父子层级，可导入 XMind/WorkFlowy/dynalist 等大纲工具。空图仍产出合法的
 * 空 body 文档（调用方已有"画布为空"守卫，此处防御）。
 */
export function buildOutlineOpml(nodes: OutlineGraphNode[], mapTitle: string): string {
	const childrenMap = buildChildrenMap(nodes);
	const roots = (childrenMap.get(null) ?? []) as OutlineGraphNode[];
	const lines: string[] = ['<?xml version="1.0" encoding="UTF-8"?>'];
	const walk = (node: OutlineGraphNode, depth: number): void => {
		if (visited.has(node.id)) {
			return;
		}
		visited.add(node.id);
		const pad = "\t".repeat(depth);
		const kids = (childrenMap.get(node.id) ?? []) as OutlineGraphNode[];
		const text = escapeXmlAttr(outlineLineText(node.card));
		// 有子级用开合标签承载嵌套；叶子自闭合（无空白文本节点，外部工具解析干净）
		lines.push(
			kids.length > 0 ? `${pad}<outline text="${text}">` : `${pad}<outline text="${text}"/>`,
		);
		for (const child of kids) {
			walk(child, depth + 1);
		}
		if (kids.length > 0) {
			lines.push(`${pad}</outline>`);
		}
	};
	const visited = new Set<string>(); // 全局防环（与 buildOutlineMarkdown 同语义）
	lines.push('<opml version="2.0">');
	lines.push("\t<head>");
	lines.push(`\t\t<title>${escapeXmlAttr(mapTitle)}</title>`);
	lines.push("\t</head>");
	lines.push("\t<body>");
	for (const root of roots) {
		walk(root, 2);
	}
	lines.push("\t</body>");
	lines.push("</opml>");
	return lines.join("\n") + "\n";
}
