/**
 * AI 一键摘录（㉓）：基于 pdf.js 文本层的版面内容块检测。
 *
 * 对齐 MN4「自动生成脑图①：使用 AI 模型一键摘录」的语义——该功能的本质是
 * **版面元素识别**（标题/正文/页眉/页脚分类）+ 批量摘录成卡，而非外部大模型。
 * MarinMind 用 pdf.js 的逐项文本几何数据（位置/字号）做等价的规则识别：
 * 文本项 → 行聚类 → 段落合并 → 字号判定标题。纯函数，vitest 覆盖。
 *
 * ㉕ 增强：标题模式识别（章节词/编号/全大写/居中短行——pdf.js 不暴露字体名，
 * "同字号加粗小标题"只能靠文本模式兜底）；CJK 段首缩进切分（相邻段不黏连）；
 * 英文行尾断词合并；isDuplicateBlock 重复检测（重复执行时对已有卡片去重）。
 */
import type { DocRect } from "../types";

/** 版面元素类型（MN4 元素筛选的子集；页眉/页脚直接过滤不入结果） */
export type AutoBlockKind = "heading" | "body";

/** pdf.js 文本项的版面几何（scale=1 视口坐标，y 向下，单位 = PDF pt） */
export interface LayoutItem {
	str: string;
	/** 文本左边界 */
	x: number;
	/** 文本上边界（基线 − 字号近似） */
	yTop: number;
	/** 文本宽度 */
	w: number;
	/** 字号（变换矩阵纵向量模长） */
	h: number;
}

/** 识别出的内容块（一张候选卡） */
export interface AutoBlock {
	kind: AutoBlockKind;
	/** 块文本（行以 \n 拼接） */
	text: string;
	/** 逐行归一化矩形（与划选摘录同构，跳原文精确定位复用） */
	rects: DocRect[];
}

/** 同一行的 y 容差系数（行内容差远小于行间差：基线微抖/上下标） */
const LINE_Y_TOL = 0.6;
/** 行内两项间距超过该系数 × 字号视为词间空格（CJK 字符间几乎零间距） */
const WORD_GAP = 0.25;
/** 段落内行距上限：行盒间距超过该系数 × 行高判定分段 */
const PARAGRAPH_GAP = 0.75;
/** 换列判定：与上一行水平重叠不足窄行宽的该比例 */
const COLUMN_SPLIT = 0.15;
/** 相邻行字号跳变阈值（标题与正文分界） */
const FONT_JUMP = 1.25;
/** 标题字号下限：块中位字号 ≥ 该系数 × 全页正文中位字号 */
const HEADING_SCALE = 1.18;
/** 页眉/页脚带高度占页面比例（上下各一带，落在带内整行丢弃） */
const EDGE_BAND = 0.045;
/** 行 y 容差的地板值（pt；防极小字号下容差趋零） */
const MIN_TOL = 3;
/** 行内 x 间距上限：超过视为换栏/换区域（词距 ≤ 0.25×字号，栏距 ≥ 数十 pt） */
const INTRA_LINE_GAP = 20;
/** 段首缩进判定阈值：行左缘超出所在块左缘该系数 × 行高视为新段起点（CJK 两字符缩进，㉕） */
const INDENT_FACTOR = 1.2;
/** 模式标题的行长上限（编号列表正文行通常更长，作门槛排除误伤，㉕） */
const HEADING_TEXT_MAX = 40;
/** 居中短行标题的行长上限（㉕） */
const CENTERED_TEXT_MAX = 24;
/** 重复判定：块与既有卡片包围盒 IoU 阈值（㉕） */
export const DUPLICATE_IOU = 0.55;

/**
 * 标题文本模式判定（㉕，字号之外的补充信号）。
 *
 * pdf.js 公开 API 不暴露字体名/字重（styles.fontFamily 是内部 id），"与正文同字号
 * 仅加粗的小标题"无法从字号分辨——用文本模式兜底：中文章节词 / Chapter 等英文
 * 序词 / 数字·中文编号 / 全大写拉丁短行。编号模式配"短行且非句末标点收尾"门槛
 * 降低正文编号列表的误伤。
 */
export function isHeadingText(text: string): boolean {
	const t = text.trim();
	if (t === "" || t.length > HEADING_TEXT_MAX) {
		return false;
	}
	// 全大写拉丁短行（INTRODUCTION / PART I；标题排版惯例）
	if (/^[A-Z][A-Z0-9 ,.&'()\-]{2,}$/.test(t)) {
		return true;
	}
	if (
		/^第[0-9０-９一二三四五六七八九十百千]+[章节篇部卷讲回]/.test(t) ||
		/^(?:chapter|section|part|appendix)\s+[0-9ivxlcm]/i.test(t)
	) {
		return true;
	}
	// 编号行（1. / 1.2 / 一、）：不带句末标点才算标题（列表项通常以句读收尾）
	if (
		(/^[0-9]{1,2}(?:[.．][0-9]{1,2}){0,3}[、.．:：)）\s]/.test(t) ||
			/^[一二三四五六七八九十]{1,3}[、.．]/.test(t)) &&
		!/[。！？；;．。]$/.test(t)
	) {
		return true;
	}
	return false;
}

/** 居中短行判定（章节大标题常独立居中；图注/表注以 图/表/Figure/Table 起头排除，㉕） */
function isCenteredHeading(line: Line, pageW: number): boolean {
	if (line.text.length > CENTERED_TEXT_MAX || /^(?:[图表例]|Figure|Fig\.?|Table)/i.test(line.text)) {
		return false;
	}
	if (line.x1 - line.x0 > 0.7 * pageW) {
		return false;
	}
	return Math.abs((line.x0 + line.x1) / 2 - pageW / 2) <= 0.05 * pageW;
}

/** 中位数（偶数个取中间两值均值；字号统计对标题不敏感） */
function median(values: number[]): number {
	if (values.length === 0) {
		return 0;
	}
	const sorted = [...values].sort((a, b) => a - b);
	const mid = Math.floor(sorted.length / 2);
	return sorted.length % 2 === 1
		? sorted[mid]
		: (sorted[mid - 1] + sorted[mid]) / 2;
}

/** 聚类后的一行（成员按 x 排序已合并） */
interface Line {
	text: string;
	x0: number;
	x1: number;
	yTop: number;
	yBot: number;
	h: number;
}

/** 文本项按 y 聚类成行（容差取行内最大字号的比例值；阅读序 y 后 x） */
function clusterLines(items: LayoutItem[]): Line[] {
	const sorted = [...items].sort((a, b) => a.yTop - b.yTop || a.x - b.x);
	const groups: LayoutItem[][] = [];
	let cur: LayoutItem[] = [];
	let curYc = 0;
	let curH = 0;
	for (const it of sorted) {
		const yc = it.yTop + it.h / 2;
		const tol = Math.max(MIN_TOL, curH * LINE_Y_TOL);
		if (cur.length > 0 && Math.abs(yc - curYc) <= tol) {
			cur.push(it);
			curH = Math.max(curH, it.h);
		} else {
			if (cur.length > 0) {
				groups.push(cur);
			}
			cur = [it];
			curYc = yc;
			curH = it.h;
		}
	}
	if (cur.length > 0) {
		groups.push(cur);
	}
	// 同一 y 带内按 x 切分：双栏/多栏版面同一水平线上有两条独立文字，
	// 栏间距（数十 pt）远大于词距（≤ 0.25×字号），超过阈值另起一行
	const runs: LayoutItem[][] = [];
	for (const group of groups) {
		const row = [...group].sort((a, b) => a.x - b.x);
		let run: LayoutItem[] = [];
		let prevEnd = -Infinity;
		let runH = 0;
		for (const it of row) {
			if (run.length > 0 && it.x - prevEnd > Math.max(INTRA_LINE_GAP, 2 * it.h)) {
				runs.push(run);
				run = [];
				runH = 0;
			}
			run.push(it);
			prevEnd = it.x + it.w;
			runH = Math.max(runH, it.h);
		}
		if (run.length > 0) {
			runs.push(run);
		}
	}
	return runs.map((members) => {
		const row = [...members].sort((a, b) => a.x - b.x);
		let text = "";
		let prevEnd = row[0].x;
		let h = 0;
		for (const it of row) {
			// 词间空格：间距显著（latin 词距）才补空格，CJK 字符间零间距自然直连
			if (text && it.x - prevEnd > WORD_GAP * Math.max(it.h, h)) {
				text += " ";
			}
			text += it.str;
			prevEnd = it.x + it.w;
			h = Math.max(h, it.h);
		}
		return {
			text: text.replace(/\s+/g, " ").trim(),
			x0: Math.min(...row.map((it) => it.x)),
			x1: Math.max(...row.map((it) => it.x + it.w)),
			yTop: Math.min(...row.map((it) => it.yTop)),
			yBot: Math.max(...row.map((it) => it.yTop + it.h)),
			h,
		};
	}).filter((line) => line.text !== "");
}

/** 相邻行水平重叠量（0 = 不相交） */
function overlap(a: Line, b: Line): number {
	return Math.min(a.x1, b.x1) - Math.max(a.x0, b.x0);
}

/**
 * 版面块检测主入口。
 *
 * @param items 某页全部文本项（scale=1 视口几何）
 * @param pageW / pageH 该页基准尺寸（scale=1）
 * @returns 内容块列表（阅读序：按块首行 y 升序）；页眉/页脚行已过滤
 */
export function detectBlocks(items: LayoutItem[], pageW: number, pageH: number): AutoBlock[] {
	const usable = items.filter((it) => it.str.trim() !== "");
	if (usable.length === 0 || pageW <= 0 || pageH <= 0) {
		return [];
	}
	const allLines = clusterLines(usable);
	// 页眉/页脚：行中心落在上下边缘带内整行丢弃（页码、书眉、版权行）
	const band = EDGE_BAND * pageH;
	const lines = allLines.filter((line) => {
		const yc = (line.yTop + line.yBot) / 2;
		return yc > band && yc < pageH - band;
	});
	if (lines.length === 0) {
		return [];
	}
	// 全页正文中位字号（中位数对少量标题行不敏感）
	const bodyH = median(lines.map((l) => l.h));

	// 行 → 块：回看最近几个块的尾行找水平同栏者再判段距/字号（双栏交错的
	// 阅读序里，"上一行"属于另一栏——只看相邻行会把每行都切成独立块）
	const LOOKBACK = 8;
	const blocks: Line[][] = [];
	for (const line of lines) {
		// 标题模式行独立成块（㉕）：同字号加粗小标题无法从字号分辨，靠文本模式；
		// 也不与前后正文合并（编号列表项误判为标题时，预览中取消勾选即可）
		if (isHeadingText(line.text)) {
			blocks.push([line]);
			continue;
		}
		let merged = false;
		for (let i = blocks.length - 1; i >= 0 && i >= blocks.length - LOOKBACK; i--) {
			if (isHeadingText(blocks[i][0].text)) {
				continue; // 标题块不吞并后续正文
			}
			const prev = blocks[i][blocks[i].length - 1];
			const maxH = Math.max(prev.h, line.h);
			const minW = Math.min(prev.x1 - prev.x0, line.x1 - line.x0);
			if (overlap(prev, line) < COLUMN_SPLIT * minW) {
				continue; // 不同栏/不同区域
			}
			// 段首缩进切分（㉕）：本行左缘明显超出所在块左缘（≥ 1.2×行高，CJK
			// 书籍两字符缩进）→ 新段落起点，不并入——修复相邻段黏成一坨
			const leftEdge = Math.min(...blocks[i].map((r) => r.x0));
			if (line.x0 - leftEdge > INDENT_FACTOR * maxH) {
				continue;
			}
			if (line.yTop - prev.yBot > PARAGRAPH_GAP * maxH) {
				continue; // 同栏但段间距过大 → 该块已结束，不允许远距离续接
			}
			if (maxH / Math.min(prev.h, line.h) > FONT_JUMP) {
				continue; // 字号跳变（标题 ↔ 正文）
			}
			blocks[i].push(line);
			merged = true;
			break;
		}
		if (!merged) {
			blocks.push([line]);
		}
	}

	return blocks.map((rows) => {
		// 英文断词合并（㉕）：PDF 排版在行尾连字符处断词，前尾 "-" + 后续小写
		// 起头 → 直接拼接（去掉连字符），避免 "pow-\nered" 式破碎文本
		const parts: string[] = [];
		for (const l of rows) {
			const last = parts[parts.length - 1];
			if (last !== undefined && /[A-Za-z]-$/.test(last) && /^[a-z]/.test(l.text)) {
				parts[parts.length - 1] = last.slice(0, -1) + l.text;
			} else {
				parts.push(l.text);
			}
		}
		const text = parts.join("\n");
		// 标题判定（㉕）：字号信号（中位 ≥ 1.18×正文中位）或 首行模式 或 居中短行
		const kind: AutoBlockKind =
			median(rows.map((l) => l.h)) >= HEADING_SCALE * bodyH ||
			isHeadingText(rows[0].text) ||
			(rows.length === 1 && isCenteredHeading(rows[0], pageW))
				? "heading"
				: "body";
		const rects: DocRect[] = rows.map((l) => ({
			x: l.x0 / pageW,
			y: l.yTop / pageH,
			w: (l.x1 - l.x0) / pageW,
			h: l.h / pageH,
		}));
		return { kind, text, rects };
	});
}

/** 与既有卡片做重复判定所需的最小信息（Card 的结构子集，字段名与 Card 对齐） */
export interface ExistingCardLike {
	page: number | null;
	rects: DocRect[];
	excerptText: string | null;
}

/** 归一化矩形 IoU（交并比；归一化坐标下 w/h 均为比例） */
function rectIoU(a: DocRect, b: DocRect): number {
	const ix = Math.max(0, Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x));
	const iy = Math.max(0, Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y));
	const inter = ix * iy;
	if (inter <= 0) {
		return 0;
	}
	const union = a.w * a.h + b.w * b.h - inter;
	return union > 0 ? inter / union : 0;
}

/** 多矩形的外包围盒（空列表返回 null） */
function bboxOf(rects: DocRect[]): DocRect | null {
	if (rects.length === 0) {
		return null;
	}
	let x0 = Infinity;
	let y0 = Infinity;
	let x1 = -Infinity;
	let y1 = -Infinity;
	for (const r of rects) {
		x0 = Math.min(x0, r.x);
		y0 = Math.min(y0, r.y);
		x1 = Math.max(x1, r.x + r.w);
		y1 = Math.max(y1, r.y + r.h);
	}
	return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

/**
 * 块与既有卡片是否重复（㉕）：同页 且（空白折叠后文本一致 或 包围盒 IoU ≥ 0.55）。
 * 文本一致覆盖"重复执行 AI 摘录"与"手动划选过同段"两种来源；
 * 位置重叠覆盖无文字形态差异的场景。纯函数，vitest 覆盖。
 */
export function isDuplicateBlock(block: AutoBlock, page: number, card: ExistingCardLike): boolean {
	if (card.page !== page) {
		return false;
	}
	const fold = (t: string): string => t.replace(/\s+/g, "");
	const cardText = card.excerptText == null ? "" : fold(card.excerptText);
	if (cardText !== "" && cardText === fold(block.text)) {
		return true;
	}
	const a = bboxOf(block.rects);
	const b = bboxOf(card.rects);
	return a !== null && b !== null && rectIoU(a, b) >= DUPLICATE_IOU;
}
