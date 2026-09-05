import type { MindmapNodeWithCard } from "../types";
import { isBranchStyle, type BranchStyle } from "../types";
import { cardTitle } from "./map-context";
import {
	buildChildrenMap,
	edgePath,
	effectiveBranchStyle,
	frameRectFor,
	NODE_HEIGHT_EST,
	NODE_WIDTH,
	visibleNodes,
} from "../mindmap/mindmap-graph";

/**
 * 脑图位置缩略图（71 溯源上下文进阶，纯函数出 SVG 字符串——零 DOM 零 obsidian，
 * vitest 直测）。镜像 drawEdges 取景法：可见节点包围盒直映 viewBox，节点 =
 * rect + 单行截断标题（cardTitle 同源），父子边 = edgePath 按父节点生效样式，
 * frame 父补收纳框背景。
 *
 * **h 估值仅示意**（listNodes 不带实测高，全部按 NODE_HEIGHT_EST 排）：
 * 缩略图是定位性质的路标——点击跳真实视图后以真实布局为权威（注释与文档写明）。
 * 颜色全部走 CSS 变量（注入 Obsidian DOM 后自动解析深浅主题），由 style 属性承载
 * （SVG 属性值不认 var()，dom-snapshot 同款约束）。
 */

/** 缩略图节点标题截断长度（200px 宽 / 13px 字号约容纳 14 个全角字符） */
const TITLE_MAX = 14;
/** viewBox 外扩边距（镜像 drawEdges 的包围盒 PAD 取景）；导出供测试数值断言 */
export const VIEW_PAD = 12;

/** XML 属性/文本五实体转义（dom-snapshot ㊽-2 同教训：标题含 & < > 即整份 XML 报废） */
function esc(s: string): string {
	return s.replace(/[&<>"']/g, (ch) =>
		ch === "&"
			? "&amp;"
			: ch === "<"
				? "&lt;"
				: ch === ">"
					? "&gt;"
					: ch === '"'
						? "&quot;"
						: "&#39;",
	);
}

/** 节点标题单行化 + 截断（换行/空白折叠为单空格） */
function thumbTitle(card: MindmapNodeWithCard["card"]): string {
	const t = cardTitle(card).replace(/\s+/g, " ").trim();
	return t.length > TITLE_MAX ? `${t.slice(0, TITLE_MAX)}…` : t;
}

/**
 * 构建缩略图 SVG：无可见节点（空图）返回 ""——调用方跳过缩略图块。
 * mapDefault = 图默认分支样式（缺省 "tree"，非法值归一——镜像视图读取语义）。
 */
export function buildMapThumbnailSvg(
	nodes: MindmapNodeWithCard[],
	highlightCardId: string | null,
	mapDefault: BranchStyle = "tree",
): string {
	const safeDefault: BranchStyle = isBranchStyle(mapDefault) ? mapDefault : "tree";
	const visible = visibleNodes(nodes);
	const vis = nodes.filter((n) => visible.has(n.id));
	if (vis.length === 0) {
		return "";
	}
	const childrenMap = buildChildrenMap(nodes);
	const byId = new Map(nodes.map((n) => [n.id, n]));
	// listNodes 产物无实测高（GraphNode.h 只在视图 measuredNodes 里）——恒用估值，
	// 缩略图定位性质可接受（跳转后真实视图为权威）。参数用结构最小类型
	// （buildChildrenMap 的 Map 值按 GraphNode 收敛，不复述完整节点类型）
	const nodeRect = (n: { x: number; y: number }) => ({
		x: n.x,
		y: n.y,
		w: NODE_WIDTH,
		h: NODE_HEIGHT_EST,
	});

	// 边按父节点生效样式；frame 父不画线只补收纳框（一父一框，可见子并集）
	const frameRects: Array<ReturnType<typeof frameRectFor>> = [];
	const edges: string[] = [];
	const framedParents = new Set<string>();
	for (const child of vis) {
		const parent = child.parentId == null ? undefined : byId.get(child.parentId);
		if (!parent || !visible.has(parent.id)) {
			continue; // 根节点 / 折叠隐藏的父（脏数据孤儿同视）
		}
		const style = effectiveBranchStyle(nodes, parent.id, safeDefault);
		if (style === "frame") {
			if (!framedParents.has(parent.id)) {
				framedParents.add(parent.id);
				const visChildren = (childrenMap.get(parent.id) ?? []).filter((c) =>
					visible.has(c.id),
				);
				frameRects.push(frameRectFor(nodeRect(parent), visChildren.map(nodeRect)));
			}
			continue; // frame 不画连线（edgePath 对 frame 也返回 null，双保险省一次调用）
		}
		const d = edgePath(parent, child, style);
		if (d) {
			edges.push(d);
		}
	}

	// 包围盒 = 可见节点 + 收纳框并集（viewBox 直映世界坐标，镜像 drawEdges 取景法）
	let minX = Infinity;
	let minY = Infinity;
	let maxX = -Infinity;
	let maxY = -Infinity;
	for (const n of vis) {
		minX = Math.min(minX, n.x);
		minY = Math.min(minY, n.y);
		maxX = Math.max(maxX, n.x + NODE_WIDTH);
		maxY = Math.max(maxY, n.y + NODE_HEIGHT_EST);
	}
	for (const f of frameRects) {
		if (!f) continue;
		minX = Math.min(minX, f.x);
		minY = Math.min(minY, f.y);
		maxX = Math.max(maxX, f.x + f.w);
		maxY = Math.max(maxY, f.y + f.h);
	}
	const viewBox = `${minX - VIEW_PAD} ${minY - VIEW_PAD} ${maxX - minX + VIEW_PAD * 2} ${maxY - minY + VIEW_PAD * 2}`;

	// 组装（顺序：收纳框 → 边 → 节点——节点压在边上方，与真实画布 z 序一致）
	let svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${viewBox}" class="marinmind-map-thumb-svg">`;
	for (const f of frameRects) {
		if (!f) continue;
		svg += `<rect x="${f.x}" y="${f.y}" width="${f.w}" height="${f.h}" rx="8" style="fill: var(--background-modifier-hover); stroke: var(--background-modifier-border)" />`;
	}
	if (edges.length > 0) {
		svg += `<path d="${edges.join(" ")}" style="fill: none; stroke: var(--text-faint)" />`;
	}
	for (const n of vis) {
		const isHit = n.cardId === highlightCardId;
		svg += `<rect x="${n.x}" y="${n.y}" width="${NODE_WIDTH}" height="${NODE_HEIGHT_EST}" rx="6" style="fill: ${isHit ? "var(--background-modifier-hover)" : "var(--background-secondary)"}; stroke: ${isHit ? "var(--interactive-accent)" : "var(--background-modifier-border)"}; stroke-width: ${isHit ? 2.5 : 1}"${isHit ? ' data-hit="1"' : ""} />`;
		svg += `<text x="${n.x + NODE_WIDTH / 2}" y="${n.y + NODE_HEIGHT_EST / 2}" text-anchor="middle" dominant-baseline="central" style="fill: ${isHit ? "var(--text-normal)" : "var(--text-muted)"}; font-size: 13px"${isHit ? ' data-hit-text="1"' : ""}>${esc(thumbTitle(n.card))}</text>`;
	}
	svg += "</svg>";
	return svg;
}
