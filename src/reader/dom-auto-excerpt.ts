import type { DocRect } from "../types";
import type { AutoBlock } from "./auto-excerpt";

/**
 * 可重排文档（md/clip/epub）的 AI 一键摘录——DOM 版面分析（164）。
 *
 * pdf 版走文本几何聚类（auto-excerpt.ts：字号/行距/模式推断标题）；DOM 版
 * 天然带结构语义——h1-h6 即标题、p/li 即正文段落，**无推断误判**（挂账
 * 「EPUB 章节 DOM 结构化程度更高，可行性反而更好」的落地）。产物复用
 * AutoBlock 形状（kind/text/rects），建卡与跳原文链路同构。
 *
 * 坐标基准：归一化矩形相对**页容器**（pv.el，与划选摘录同基准——跳原文
 * 闪烁定位复用）；md/clip = 第 1 页内容根，epub = 当前已渲染章（懒渲染的
 * 未来章无 DOM，按「当前页」语义只分析当前章）。
 */

/** 候选上限：防超长 md 千段全列撑爆弹窗；超出截断并由弹窗提示 */
export const DOM_BLOCK_CAP = 300;

/** 结构走查候选（纯 DOM 结构不做布局——jsdom 可测；rect 换算另步） */
export interface DomBlockEl {
	kind: "heading" | "body";
	text: string;
	el: Element;
}

/** 不入候选的祖先标签：代码/表格/脚本整族跳过（不宜整段成卡或无正文语义） */
const SKIP_ANCESTORS = new Set(["PRE", "CODE", "TABLE", "SCRIPT", "STYLE", "SVG"]);

/**
 * 收集标题/正文候选（文档序）：
 * - h1-h6 → heading；p / li → body；
 * - 松散列表 li 内嵌的 p 跳过（li 已整体收集，p 再入会重复）；
 * - 空白/单字符文本跳过；pre/code/table/svg 子树整族跳过。
 */
export function collectDomBlocks(root: Element): DomBlockEl[] {
	const out: DomBlockEl[] = [];
	for (const el of root.querySelectorAll("h1,h2,h3,h4,h5,h6,p,li")) {
		let skipped = false;
		for (let a = el.parentElement; a && a !== root.parentElement; a = a.parentElement) {
			if (SKIP_ANCESTORS.has(a.tagName)) {
				skipped = true;
				break;
			}
		}
		if (skipped) {
			continue;
		}
		if (el.tagName === "P" && el.parentElement?.tagName === "LI") {
			continue; // 松散列表：li 整体已收集
		}
		const text = (el.textContent ?? "").replace(/\s+/g, " ").trim();
		if (text.length < 2) {
			continue;
		}
		out.push({
			kind: /^H[1-6]$/.test(el.tagName) ? "heading" : "body",
			text,
			el,
		});
	}
	return out;
}

/** clamp 到 [0,1] */
function clamp01(v: number): number {
	return Math.min(1, Math.max(0, v));
}

/**
 * 候选 → AutoBlock（布局换算：归一化矩形相对 baseBox，与划选摘录同基准）。
 * 返回截断标记（超 DOM_BLOCK_CAP 截断，弹窗提示）。纯数学可测。
 */
export function domBlocksToAuto(
	blocks: readonly DomBlockEl[],
	baseBox: { left: number; top: number; width: number; height: number },
	getBox: (el: Element) => { left: number; top: number; width: number; height: number },
	cap: number = DOM_BLOCK_CAP,
): { blocks: AutoBlock[]; truncated: boolean } {
	const truncated = blocks.length > cap;
	const w = Math.max(1, baseBox.width);
	const h = Math.max(1, baseBox.height);
	const out: AutoBlock[] = [];
	for (const b of truncated ? blocks.slice(0, cap) : blocks) {
		const box = getBox(b.el);
		const rect: DocRect = {
			x: clamp01((box.left - baseBox.left) / w),
			y: clamp01((box.top - baseBox.top) / h),
			w: clamp01(box.width / w),
			h: clamp01(box.height / h),
		};
		out.push({ kind: b.kind, text: b.text, rects: [rect] });
	}
	return { blocks: out, truncated };
}
