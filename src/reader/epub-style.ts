/**
 * epub 书籍自带内联样式白名单过滤（170，「部分尊重」挂账的落地）：
 *
 * 统一主题排版刻意忽略书籍样式（观感一致），但**排版语义类**的内联属性
 * 丢失会伤内容表达（诗歌缩进/居中悼词/斜体术语）——净化层对书源元素的
 * style 属性按白名单过滤保留：text-indent（缩进）/ text-align（对齐）/
 * font-style（斜体强调）。其余一律剥除（颜色/字体族/字号与主题打架，
 * position/display 等有布局安全风险）。
 *
 * 纯函数（vitest 覆盖）；epub-session 净化层接线。书源 <style> 元素与
 * 外链样式表仍整删（选择器级支持不在「内联白名单」方案范围）。
 */

/** 白名单属性（小写；值原样保留但限长防滥用） */
const ALLOWED_PROPS = new Set(["text-indent", "text-align", "font-style"]);

/** 单条声明值的长度上限（正常缩进/对齐值远小于此） */
const MAX_VALUE_LEN = 100;

/**
 * 过滤一条 style 属性文本：保留白名单声明的 `prop: value` 子集，重组为
 * cssText；无任何存活声明返回 null（调用方不设 style 属性）。
 * 解析按分号切分（CSS 声明值在白名单属性下不含分号；畸形段静默丢弃）。
 */
export function filterInlineStyle(style: string): string | null {
	const kept: string[] = [];
	for (const decl of style.split(";")) {
		const at = decl.indexOf(":");
		if (at <= 0) {
			continue;
		}
		const prop = decl.slice(0, at).trim().toLowerCase();
		const value = decl.slice(at + 1).trim();
		if (!ALLOWED_PROPS.has(prop) || !value || value.length > MAX_VALUE_LEN) {
			continue;
		}
		kept.push(`${prop}: ${value}`);
	}
	return kept.length > 0 ? kept.join("; ") : null;
}
