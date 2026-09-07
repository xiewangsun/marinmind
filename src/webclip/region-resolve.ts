/**
 * 框选剪藏区域解析（116，纯函数层）：拖框/单击 → iframe 预览文档内的目标元素。
 *
 * 坐标系约定：RegionRect 一律取 iframe **视口坐标**（与 elementFromPoint /
 * getBoundingClientRect 同系）——框选覆盖层与 iframe 1:1 对齐且选择期滚动冻结，
 * 视口坐标即文档坐标，免去 scroll 换算。jsdom 无布局引擎（getBoundingClientRect
 * 恒零）、elementFromPoint 未实现，测试以逐元素 rect 桩 + document 级命中桩注入，
 * 几何判定逻辑（rectContainment）完全独立可直测。
 *
 * - 单击（拖动 <5px）：直取命中的最深元素（elementFromPoint 结果）；
 * - 拖框：自命中元素沿祖先上溯，取首个**覆盖拖框 ≥95%** 的元素（段落命中 →
 *   上溯到 article/正文容器）；无则自然落到 body（覆盖全视口）；
 * - 空白命中（elementFromPoint null）→ body 兜底。
 *
 * 模块顶层零 DOM 引用（Node 环境 import 安全），DOM 只在函数体内使用。
 */

/** 视口坐标矩形（x/y 为左上角） */
export interface RegionRect {
	x: number;
	y: number;
	w: number;
	h: number;
}

/** 单击判定阈值（px）：宽高均低于此值视为单击而非拖框 */
export const CLICK_THRESHOLD = 5;

/** 拖框祖先采纳阈值：元素覆盖拖框面积比达到此值即认定为「完整包含」 */
export const CONTAIN_RATIO = 0.95;

/** 单击手势判定（宽高均 <5px） */
export function isClickGesture(rect: RegionRect): boolean {
	return rect.w < CLICK_THRESHOLD && rect.h < CLICK_THRESHOLD;
}

/**
 * box 覆盖 rect 的面积比（交集面积 / rect 面积）：矩形为空（零面积）返回 0，
 * 全包含返回 1，半覆盖 0.5。
 */
export function rectContainment(rect: RegionRect, box: RegionRect): number {
	const rectArea = rect.w * rect.h;
	if (rectArea <= 0) {
		return 0;
	}
	const x = Math.max(rect.x, box.x);
	const y = Math.max(rect.y, box.y);
	const w = Math.min(rect.x + rect.w, box.x + box.w) - x;
	const h = Math.min(rect.y + rect.h, box.y + box.h) - y;
	if (w <= 0 || h <= 0) {
		return 0;
	}
	return (w * h) / rectArea;
}

/** 元素视口矩形 → RegionRect（getBoundingClientRect 形状适配） */
function rectOf(el: Element): RegionRect {
	const r = el.getBoundingClientRect();
	return { x: r.left, y: r.top, w: r.width, h: r.height };
}

/**
 * 解析框选目标元素。
 * @param doc iframe 预览文档（sandbox allow-same-origin，可访问 DOM）
 * @param rect 视口坐标拖框/单击矩形
 * @returns 目标元素；文档无 body 且无命中时 null
 */
export function resolveRegionElement(doc: Document, rect: RegionRect): Element | null {
	const point = doc.elementFromPoint;
	if (typeof point !== "function") {
		return doc.body ?? null;
	}
	// 命中点取矩形中心（单击矩形 <5px，中心与左上偏差 <2.5px，可忽略）
	const hit = point.call(doc, rect.x + rect.w / 2, rect.y + rect.h / 2);
	if (!hit) {
		return doc.body ?? null;
	}
	if (isClickGesture(rect)) {
		return hit; // 单击直取命中最深元素
	}
	// 拖框：自命中元素上溯，取首个覆盖拖框 ≥95% 的祖先（body 覆盖全视口，天然终点）
	let el: Element | null = hit;
	while (el) {
		if (rectContainment(rect, rectOf(el)) >= CONTAIN_RATIO) {
			return el;
		}
		el = el.parentElement;
	}
	return doc.body ?? null;
}

/** 标签提示文本（选择命中后展示）："div.article-content#main" 形态，类名截断防溢出 */
export function describeElement(el: Element): string {
	let name = el.tagName.toLowerCase();
	const cls = typeof el.className === "string" ? el.className.trim().split(/\s+/)[0] : "";
	if (cls) {
		name += `.${cls.slice(0, 24)}`;
	}
	if (el.id) {
		name += `#${el.id.slice(0, 24)}`;
	}
	return name;
}

/**
 * 注入 `<base href target="_blank">`（srcdoc 预览必需）：
 * - href：相对 CSS/图片按原站地址解析（否则相对资源以 srcdoc 空源为基准全部 404）；
 * - target="_blank"：预览态点击链接尝试新开窗口——sandbox 未授权 allow-popups
 *   时被浏览器静默拦截，预览不会被链接导航带离（带离后 contentDocument 跨源，
 *   框选解析必败）。
 * head 开标签后插入；无 head 时插到 body 开标签后；均无则前置。URL 属性转义。
 */
export function injectBaseHref(html: string, baseUrl: string): string {
	const escaped = baseUrl.replace(/&/g, "&amp;").replace(/"/g, "&quot;");
	const tag = `<base href="${escaped}" target="_blank">`;
	if (/<head[^>]*>/i.test(html)) {
		return html.replace(/<head[^>]*>/i, (m) => `${m}${tag}`);
	}
	if (/<body[^>]*>/i.test(html)) {
		return html.replace(/<body[^>]*>/i, (m) => `${m}${tag}`);
	}
	return `${tag}${html}`;
}
