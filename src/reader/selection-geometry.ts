import type { ViewportRect } from "./rect-utils";

/**
 * 划选文字的选区几何纯函数（139-D 自 reader-view 下沉，零视图状态——
 * 只依赖 DOM Range/NodeIterator，jsdom + 假布局可测）：
 * 逐字符测量按行聚类、行盒并集、选区首尾空白修剪、行盒按中心点归页。
 * 归页回调 pageAt 由视图注入（pageByPoint 的页号投影），本模块不持有页面表。
 */

/** 逐字符测量的选区规模上限：超过退回端点修剪老路径（防超大选区逐字测量卡顿） */
export const MAX_MEASURE_CHARS = 3000;

/** 选区按行拆分的产物：行文本（行内空白已折叠、首尾空白已去）+ 行盒（viewport 坐标） */
export interface SelectionLine {
	text: string;
	box: ViewportRect;
}

/** 选区内单个字符的定位与测量（box 为 null 表示零尺寸字符如 \n） */
interface CharBox {
	node: Text;
	offset: number;
	ch: string;
	box: ViewportRect | null;
}

/**
 * 选区逐行拆分（多行文字摘录的关键修正）：
 * PDF 文本层每行行尾常带成段空白，整段 Range 的 getClientRects 会把它们一并
 * 圈进高亮——改为逐字符测量单字盒，按 y 中心聚类成行（容差 0.6×行高，
 * 同 y 但 x 大幅回退视为换列另起一行），每行收缩到首/末非空白字符。
 * 行文本空白折叠、行间以 \n 拼接；行盒取首末字符子 Range 的 rects 并集。
 * 返回 null = 选区为空或过大，调用方应退回老路径。
 */
export function collectSelectionLines(range: Range): SelectionLine[] | null {
	const pieces: Array<{ node: Text; start: number; end: number }> = [];
	let text = "";
	// NodeIterator（非 TreeWalker）：迭代集合包含根节点自身——选区落在单个 span 内
	// 时 commonAncestor 是 Text 节点，TreeWalker.nextNode() 永远不返回根，会静默丢卡
	const iter = document.createNodeIterator(range.commonAncestorContainer, NodeFilter.SHOW_TEXT);
	for (let n = iter.nextNode(); n; n = iter.nextNode()) {
		const t = n as Text;
		if (!range.intersectsNode(t)) {
			continue;
		}
		const s = t === range.startContainer ? range.startOffset : 0;
		const e = t === range.endContainer ? range.endOffset : t.length;
		if (e > s) {
			pieces.push({ node: t, start: s, end: e });
			text += t.data.slice(s, e);
		}
	}
	if (pieces.length === 0 || text.length > MAX_MEASURE_CHARS) {
		return null;
	}
	// 1) 逐字符测量单字盒（probe 复用一个 Range；零尺寸字符如 \n 记 null 随行）
	const chars: CharBox[] = [];
	const probe = document.createRange();
	for (const p of pieces) {
		for (let i = p.start; i < p.end; i++) {
			let box: ViewportRect | null = null;
			try {
				probe.setStart(p.node, i);
				probe.setEnd(p.node, i + 1);
				const r = probe.getBoundingClientRect();
				if (r.width > 0 && r.height > 0) {
					box = { left: r.left, top: r.top, width: r.width, height: r.height };
				}
			} catch {
				// 单字 Range 异常（罕见）按零尺寸处理
			}
			chars.push({ node: p.node, offset: i, ch: p.node.data[i], box });
		}
	}
	// 2) 聚类成行：行内容差（上标/基线微抖）远小于行间差
	const lines: CharBox[][] = [];
	let cur: CharBox[] = [];
	let curY = 0;
	let curH = 0;
	let prevRight = 0;
	for (const cb of chars) {
		if (!cb.box) {
			if (cur.length > 0) {
				cur.push(cb); // 零尺寸字符归属当前行
			}
			continue;
		}
		const yc = cb.box.top + cb.box.height / 2;
		const tol = Math.max(3, curH * 0.6);
		if (cur.length === 0 || Math.abs(yc - curY) > tol || cb.box.left < prevRight - 20) {
			lines.push(cur);
			cur = [cb];
			curY = yc;
			curH = cb.box.height;
		} else {
			cur.push(cb);
			curH = Math.max(curH, cb.box.height);
		}
		prevRight = cb.box.left + cb.box.width;
	}
	if (cur.length > 0) {
		lines.push(cur);
	}
	// 3) 每行收缩到首/末非空白字符（整行空白直接丢弃——行尾空行不再入卡）
	const result: SelectionLine[] = [];
	for (const line of lines) {
		let s = -1;
		let e = -1;
		for (let i = 0; i < line.length; i++) {
			if (/\S/.test(line[i].ch)) {
				if (s < 0) {
					s = i;
				}
				e = i;
			}
		}
		if (s < 0) {
			continue;
		}
		const seg = line.slice(s, e + 1);
		const lineText = seg
			.map((c) => c.ch)
			.join("")
			.replace(/\s+/g, " ")
			.trim();
		if (!lineText) {
			continue;
		}
		const box = unionRangeBox(seg[0], seg[seg.length - 1]);
		if (!box) {
			continue;
		}
		result.push({ text: lineText, box });
	}
	return result;
}

/** 首末字符子 Range 的 client rects 并集（子 Range 异常时退回首末字符盒近似） */
function unionRangeBox(first: CharBox, last: CharBox): ViewportRect | null {
	const rects: ViewportRect[] = [];
	try {
		const r = document.createRange();
		r.setStart(first.node, first.offset);
		r.setEnd(last.node, last.offset + 1);
		for (const cr of Array.from(r.getClientRects())) {
			if (cr.width > 0 && cr.height > 0) {
				rects.push({ left: cr.left, top: cr.top, width: cr.width, height: cr.height });
			}
		}
	} catch {
		// 跨节点边界异常：退回已测字符盒
	}
	if (rects.length === 0) {
		if (first.box) {
			rects.push(first.box);
		}
		if (last.box) {
			rects.push(last.box);
		}
	}
	if (rects.length === 0) {
		return null;
	}
	let l = Infinity;
	let t = Infinity;
	let r2 = -Infinity;
	let b = -Infinity;
	for (const box of rects) {
		l = Math.min(l, box.left);
		t = Math.min(t, box.top);
		r2 = Math.max(r2, box.left + box.width);
		b = Math.max(b, box.top + box.height);
	}
	return { left: l, top: t, width: r2 - l, height: b - t };
}

/**
 * 就地收缩 Range 到首个/末个非空白字符（就地修改 live 选区，视觉同步收紧）。
 * 遍历选区内相交文本节点拼接全文，定位非空白边界后回写 setStart/setEnd。
 * 返回 false = 选区全空白（调用方应清空选区放弃建卡）。
 */
export function trimRangeToBounds(range: Range): boolean {
	// NodeIterator 含根节点（TreeWalker.nextNode() 不返回根，单 span 选区会漏遍历，见上）
	const iter = document.createNodeIterator(range.commonAncestorContainer, NodeFilter.SHOW_TEXT);
	const pieces: Array<{ node: Text; start: number; end: number }> = [];
	let text = "";
	for (let n = iter.nextNode(); n; n = iter.nextNode()) {
		const t = n as Text;
		if (!range.intersectsNode(t)) {
			continue;
		}
		const s = t === range.startContainer ? range.startOffset : 0;
		const e = t === range.endContainer ? range.endOffset : t.length;
		if (e > s) {
			pieces.push({ node: t, start: s, end: e });
			text += t.data.slice(s, e);
		}
	}
	const first = text.search(/\S/);
	if (first < 0) {
		return false;
	}
	let last = text.length;
	while (last > first && /\s/.test(text[last - 1])) {
		last--;
	}
	// 全局字符下标 → (node, offset)；pieces 为文档序，累减定位
	const locate = (idx: number): { node: Text; offset: number } | null => {
		for (const p of pieces) {
			const len = p.end - p.start;
			if (idx < len) {
				return { node: p.node, offset: p.start + idx };
			}
			idx -= len;
		}
		return null;
	};
	const begin = locate(first);
	const end = locate(last - 1); // 末个非空白字符（Range 边界为排他，需 +1）
	if (!begin || !end) {
		return false;
	}
	try {
		range.setStart(begin.node, begin.offset);
		range.setEnd(end.node, end.offset + 1);
	} catch {
		return false; // 跨节点边界异常兜底：放弃修剪，保留原选区
	}
	return true;
}

/**
 * 行盒/选区盒按中心点归属页（建卡与文字遮罩共用的归页单源，139-D 自两处
 * 视图方法收敛）：零尺寸盒跳过（getClientRects 可能产生零尺寸行），
 * pageAt 返回 null 的盒（中心点不落任何页）跳过。
 */
export function attributeBoxesToPages(
	boxes: readonly ViewportRect[],
	pageAt: (cx: number, cy: number) => number | null,
): Map<number, ViewportRect[]> {
	const rectsByPage = new Map<number, ViewportRect[]>();
	for (const box of boxes) {
		if (box.width <= 0 || box.height <= 0) {
			continue;
		}
		const page = pageAt(box.left + box.width / 2, box.top + box.height / 2);
		if (page === null) {
			continue;
		}
		const list = rectsByPage.get(page) ?? [];
		list.push(box);
		rectsByPage.set(page, list);
	}
	return rectsByPage;
}
