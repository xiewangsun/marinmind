/**
 * md/clip 文本锚重定位（169，重排漂移挂账的读取侧方案）：
 *
 * 问题：md 源被编辑后，卡片归一化 rects 是摘录时刻的**近似锚定**——增删
 * 段落后 y 偏移，跳原文只能到附近。写侧重锚（改存数据）有迁移与写放大
 * 顾虑；本模块取**跳转时现查**：按摘录文本在内容 DOM 里找所在块元素，
 * 命中则以块的真实布局位置为锚（编辑后仍精确），未命中回退存量 rect
 * （宁回落不猜）。与挂账候选方案「文本锚（前后文匹配重定位）」同思路，
 * 落在读取侧故零写入、零迁移。
 *
 * 查找策略：摘录文本与块文本都做空白折叠后**包含匹配**（多行摘录首块
 * 命中即可——行内摘录跨行时块包含首行文本）；探针取摘录前 32 字符
 * （长摘录的尾部可能被用户编辑，头部更稳定）。候选块 = 内容根下
 * p/li/h1-h6/blockquote（与 DOM 版面摘录同集）。
 */

/** 空白折叠（跨行/连续空白 → 单空格）+ trim */
function norm(s: string): string {
	return s.replace(/\s+/g, " ").trim();
}

/** 探针长度（字符）：头部匹配，长摘录尾部可能被编辑 */
const PROBE_LEN = 32;

/** 取元素布局盒（模块内单源；测试注入替换） */
type BoxOf = (el: Element) => { top: number; height: number };

function defaultRect(el: Element): { top: number; height: number } {
	const r = el.getBoundingClientRect();
	return { top: r.top, height: r.height };
}

/**
 * 按摘录文本查所在块，返回块的归一化锚定 y（块顶 / 根高，[0,1]）。
 * 未命中返回 null（调用方回退存量 rect 锚）。getRect 缺省走
 * getBoundingClientRect；测试注入假布局。
 */
export function relocateMdAnchorY(
	root: HTMLElement,
	excerptText: string,
	getRect: BoxOf = defaultRect,
): number | null {
	const probe = norm(excerptText).slice(0, PROBE_LEN);
	if (probe.length < 2) {
		return null; // 探针过短（空/单字符）：误配风险大于收益，回落
	}
	let hit: Element | null = null;
	for (const el of root.querySelectorAll("p,li,h1,h2,h3,h4,h5,h6,blockquote")) {
		if (norm(el.textContent ?? "").includes(probe)) {
			hit = el;
			break; // 文档序首个命中（重排后唯一包含首块的元素）
		}
	}
	if (!hit) {
		return null;
	}
	const rootBox = getRect(root);
	const y = (getRect(hit).top - rootBox.top) / Math.max(1, rootBox.height);
	return Math.min(1, Math.max(0, y));
}
