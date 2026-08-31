import type { OutlineEntry } from "./pdf-document";

/**
 * md 标题目录纯函数（㊻-B，零 obsidian 依赖；outlineFromHeadings 纯数据 vitest 覆盖）。
 * obsidian 耦合的渲染会话在 md-document.ts；分层先例：auto-excerpt / map-context。
 */

/** 标题的扁平采集结果（outlineFromHeadings 的输入） */
export interface HeadingItem {
	/** 标题级别 1-6（h1=1） */
	level: number;
	/** 标题文本（trim 后；空标题跳过） */
	text: string;
}

/**
 * 标题序列 → 层级树。
 * 规则：级别回落（如 h3 后遇 h2）时沿栈上溯找最近祖先；级别跳跃（h1 直接到 h4）
 * 按文档顺序挂前一个标题下（不要求严格逐级递增——md 手写大纲常见跳跃）。
 */
export function outlineFromHeadings(headings: HeadingItem[]): OutlineEntry[] {
	const roots: OutlineEntry[] = [];
	/** 栈底到栈顶 = 根 → 当前最深标题；每层存 { entry, level } */
	const stack: { entry: OutlineEntry; level: number }[] = [];
	for (const h of headings) {
		const text = h.text.trim();
		if (!text) continue;
		const entry: OutlineEntry = { title: text, page: 1, children: [] };
		// 弹掉级别 ≥ 自身的层（同级或回落都让位）
		while (stack.length > 0 && stack[stack.length - 1].level >= h.level) {
			stack.pop();
		}
		if (stack.length === 0) {
			roots.push(entry);
		} else {
			stack[stack.length - 1].entry.children.push(entry);
		}
		stack.push({ entry, level: h.level });
	}
	return roots;
}

/**
 * 从渲染完成的 DOM 抽标题树（h1-h6 文本顺序即文档顺序）。
 * page 恒 1（md 单页长文）；anchor 指向标题元素供目录点击滚动定位。
 * 前序遍历回填 anchor（= 文档顺序，广度展开会打乱与采集序列的索引对齐）。
 */
export function outlineFromDom(root: ParentNode): OutlineEntry[] {
	// 空白标题两侧同步剔除（只剔除一侧会打乱 els 与 headings 的索引对齐）
	const picked: { level: number; text: string; el: HTMLElement }[] = [];
	for (const el of Array.from(root.querySelectorAll("h1,h2,h3,h4,h5,h6"))) {
		const text = el.textContent ?? "";
		if (!text.trim()) continue;
		picked.push({ level: Number(el.tagName.slice(1)), text, el: el as HTMLElement });
	}
	const tree = outlineFromHeadings(picked);
	const flatOrder: OutlineEntry[] = [];
	const walk = (entry: OutlineEntry): void => {
		flatOrder.push(entry);
		entry.children.forEach(walk);
	};
	tree.forEach(walk);
	flatOrder.forEach((entry, idx) => {
		entry.anchor = picked[idx].el;
	});
	return tree;
}
