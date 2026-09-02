import type { DocRect, NormPoint } from "../types";
import { cropRegionSnapshot, pixelRect, type PixelRect, type SnapshotImage } from "./region-snapshot";

/**
 * reflow 文档（㊻-B md / ㊼ epub）的区域/套索内容快照（㊽）：把页容器 DOM 栅格化
 * 为图片——脑图节点/复习正面/主页预览据此显示"选择的区域内容"而非占位文字。
 *
 * 技术：SVG foreignObject 序列化（dom-to-image 同思路，自研零依赖）——
 * 克隆页容器子树 → 逐元素内联 getComputedStyle 计算值（镜像文档没有样式表，
 * .markdown-preview-view 主题观感全靠计算值烘焙）→ 图片从活 DOM 已加载元素经
 * canvas 取像素转 data URL（blob:/外链引用在 SVG 镜像文档里不可加载，也绕开
 * fetch 的 CSP connect-src 管控）→ 包进 <svg><foreignObject> 以 data URL 加载
 * 为 Image 画到 canvas。
 *
 * 加载与画布的两个 Chromium 铁律（㊽-2 无头浏览器实测，与内容无关 100% 复现）：
 * 1. img.decode() 对含 foreignObject 的 SVG 图必然 reject（"The source image
 *    cannot be decoded."——位图解码器不处理 HTML 内容），就绪信号只能用 onload；
 * 2. blob: URL 的 foreignObject SVG 画上 canvas 必污染画布（后续 toBlob 抛
 *    SecurityError），data: URL 则永不污染——dom-to-image 系库全用 data URL
 *    即为此。故此处用 encodeURIComponent 的 data URL 承载镜像 XML。
 *
 * 窗口化（关键决策）：只栅格化摘录矩形窗口（viewBox 取景 + foreignObject 负偏移
 * 承载全宽宿主、换行不变），而非整章位图——超长章（820×20000px）整页栅格化会撞
 * iOS WKWebView canvas 边长上限静默出空白图、面积超 16M 还被迫降采样模糊。
 *
 * 出图复用 pdf 快照的 cropRegionSnapshot 管线（窗口 canvas + unit rect + 重映射
 * 多边形 = 套索 clip + WebP 编码，iOS 回退 PNG）；全路径失败返回 null——调用方
 * 降级为无快照建卡（现状行为），回填机制稍后重试。
 *
 * 已知降级（挂账 docs/后续优化方向.md）：@font-face 自定义字体回退系统字体
 * （默认系统字体栈不受影响，极端情况换行微移）、::before/::after 伪元素内容丢失
 * （md callout 图标）、md 外链图片/未加载 lazy 图留白、md 内嵌 canvas/iframe 空白。
 */

/** SVG 命名空间 */
const SVG_NS = "http://www.w3.org/2000/svg";

/** 镜像 SVG 图加载超时（毫秒）：防加载悬挂拖死建卡/回填流程 */
const SVG_IMAGE_TIMEOUT_MS = 3000;

/**
 * 镜像 XML 字符数上限：iOS WKWebView 对超长 data URL 有限制，超限直接放弃
 * （宁拒不赌，降级为无快照建卡）；桌面实测 2.6MB 字符 10ms 内加载完成
 */
const MAX_MIRROR_XML_CHARS = 8_000_000;

/** 快照 canvas 总像素上限（对齐 pdf-document 渲染的 16M 钳制） */
const MAX_SNAPSHOT_PIXELS = 16_000_000;

/** 快照 canvas 单边像素上限（iOS WKWebView 画布边长约 4096-8192，超限静默空白） */
const MAX_SNAPSHOT_SIDE = 8192;

/** 章内图片内联的最大长边（像素）：显示列宽 ≤820，2 倍清晰度足够，防巨图撑爆镜像 XML */
const MAX_IMAGE_INLINE_SIDE = 1600;

/** 内联计算样式时跳过的属性（镜像文档里无意义或有害；顺手在遍历里判，免二次删除） */
const DENIED_STYLE_PROPS = new Set([
	// 镜像文档要整树展开渲染，折叠/containment 语义不适用
	"content-visibility",
	"contain",
	"contain-intrinsic-size",
	"contain-intrinsic-width",
	"contain-intrinsic-height",
	// 动效与交互在静态快照里无意义（且可能携带耗时值）
	"transition",
	"transition-delay",
	"transition-duration",
	"transition-property",
	"transition-timing-function",
	"transition-behavior",
	"animation",
	"animation-delay",
	"animation-direction",
	"animation-duration",
	"animation-fill-mode",
	"animation-iteration-count",
	"animation-name",
	"animation-play-state",
	"animation-timing-function",
	"animation-composition",
	"cursor",
	"pointer-events",
	"will-change",
	"scroll-behavior",
	// 页容器阴影画在盒外，canvas 取景窗反正裁掉
	"box-shadow",
]);

/** 克隆属性保洁：镜像文档里会坏事（srcset/sizes 盖过内联 src；lazy 在镜像里可能永不加载） */
const HARMFUL_ATTRS = new Set(["srcset", "sizes", "loading", "decoding"]);

/**
 * XML 1.0 非法控制字符类（U+0000-0008 / 000B / 000C / 000E-001F）：XMLSerializer
 * 不转义它们，正文里混入一个整份镜像 XML 即解析失败（㊽-2 无头浏览器实测
 * "PCDATA invalid Char value 2"）。用 fromCharCode 组装而非字面转义——
 * 源码文件里嵌入字面控制字符会被部分工具链静默破坏。
 */
const INVALID_XML_CHARS_RE = new RegExp(
	"[" + String.fromCharCode(0) + "-" + String.fromCharCode(8) +
		String.fromCharCode(11) + String.fromCharCode(12) +
		String.fromCharCode(14) + "-" + String.fromCharCode(31) + "]",
	"g",
);

/** 串行队列尾：并发栅格化排队执行（多个 epub IO 进入交错时防内存尖峰） */
let rasterQueue: Promise<unknown> = Promise.resolve();

/**
 * 克隆选项（63 PNG 导出扩展）：脑图整图导出与阅读器快照共用 buildStyleClone，
 * 差异经选项注入——缺省 = 阅读器旧行为（page-view 调用方零改动）。
 */
export interface CloneOptions {
	/** 克隆树中删除的选择器（默认 overlay/textLayer 之外追加；原树遍历同步跳过保持配对一致） */
	excludeSelectors?: string[];
	/** 瞬态状态类（selected/flash/dragging 等）：捕获前从原树临时摘除、算完恢复——
	 * 只删克隆树 class 属性无用（计算值已带着高亮态烘焙进 cssText） */
	stripClasses?: string[];
	/** 克隆根背景色（缺省 = 原根背景色，透明烘焙 #ffffff） */
	rootBackground?: string;
	/** 剥除克隆根 transform（world 容器的 translate/scale 是视口平移不是内容
	 * 的一部分，不剥则镜像内整图二次位移——transform 不在 DENIED_STYLE_PROPS） */
	stripRootTransform?: boolean;
}

/** 默认删除选择器：高亮/文本层不得入镜（pdf 快照来自无高亮的干净位图） */
const DEFAULT_EXCLUDE_SELECTORS = [".marinmind-pdf-overlay", ".marinmind-text-layer"];

/**
 * 把页容器 DOM 的摘录区域栅格化为快照（foreignObject 窗口化技术）。
 * el 为归一化坐标的基准盒（pv.el）；任何失败返回 null（宁拒不赌）。
 */
export function snapshotDomRegion(
	el: HTMLElement,
	rect: DocRect,
	polygon: NormPoint[] | null,
): Promise<SnapshotImage | null> {
	const run = rasterQueue.then(() => captureDomRegion(el, rect, polygon));
	// 队列尾只关心完成与否，吞掉结果保持链条不断（capture 自身不再抛出）
	rasterQueue = run.catch(() => undefined);
	return run;
}

/**
 * 元素像素窗口快照单入口（63 PNG 导出）：与 snapshotDomRegion 的差异——
 * win 由调用方直供像素窗口（脑图 = edgesSvg viewBox，drawEdges 每次重画同步
 * 维护可见包围盒，调用方复刻 bbox 逻辑必漂移）、返回裸 canvas 不做编码
 * （调用方自选 PNG/WebP）、opts 透传 buildStyleClone（脑图剥 world transform /
 * 摘瞬态状态类 / 换主题底色）。rasterQueue 串行共享不旁路——导出与摘录快照
 * 并发正是队列要防的内存尖峰。任何失败返回 null（宁拒不赌）。
 */
export async function snapshotElementRegion(
	el: HTMLElement,
	win: PixelRect,
	opts?: CloneOptions,
): Promise<{ canvas: HTMLCanvasElement; scale: number } | null> {
	const run = rasterQueue.then(() => captureElementRegion(el, win, opts));
	rasterQueue = run.then(
		() => undefined,
		() => undefined,
	);
	return run;
}

async function captureElementRegion(
	el: HTMLElement,
	win: PixelRect,
	opts?: CloneOptions,
): Promise<{ canvas: HTMLCanvasElement; scale: number } | null> {
	if (!el.isConnected) {
		return null; // 视图刚关闭的残留调用：计算值全空，防垃圾图
	}
	try {
		if (win.sw <= 0 || win.sh <= 0) {
			return null;
		}
		const s = rasterScale(win.sw, win.sh);
		const cw = Math.max(1, Math.round(win.sw * s));
		const ch = Math.max(1, Math.round(win.sh * s));
		// 脑图语义：world 是 0×0 transform 容器，子元素绝对定位于世界坐标——
		// 克隆根钉窗口盒 + foreignObject 以 -sx/-sy 负偏移承载窗口坐标系
		// （fo 视口恰与 viewBox 重合，窗外内容被 SVG 视口天然裁掉）
		const clone = buildStyleClone(el, win.sw, win.sh, opts);
		const xml = buildMirrorSvg(clone, win, win.sw, win.sh, cw, ch);
		if (xml.length > MAX_MIRROR_XML_CHARS) {
			return null; // 内容过大（iOS data URL 限制）：宁拒不赌
		}
		const canvas = await rasterizeWindow(xml, cw, ch);
		return canvas ? { canvas, scale: s } : null;
	} catch (err) {
		console.warn("[MarinMind] 元素区域快照失败", err);
		return null;
	}
}

async function captureDomRegion(
	el: HTMLElement,
	rect: DocRect,
	polygon: NormPoint[] | null,
): Promise<SnapshotImage | null> {
	if (!el.isConnected) {
		return null; // 换文档瞬间的旧页视图已脱树：计算值全空，防垃圾快照
	}
	// epub 预渲染区的章处于 content-visibility:auto 折叠态：先强制展开再读尺寸/样式
	// （页已有 contain-intrinsic-size 实测高度，展开不改总高、不跳滚动条）
	const prevVisibility = el.style.getPropertyValue("content-visibility");
	if (prevVisibility !== "visible") {
		el.style.setProperty("content-visibility", "visible");
	}
	try {
		const w = el.clientWidth;
		const h = el.offsetHeight;
		if (w <= 0 || h <= 0) {
			return null;
		}
		// 摘录窗口（宿主 CSS 像素；钳制/取整/最小 1px 复用 pdf 管线）
		const win = pixelRect(rect, w, h);
		const s = rasterScale(win.sw, win.sh);
		const cw = Math.max(1, Math.round(win.sw * s));
		const ch = Math.max(1, Math.round(win.sh * s));
		const clone = buildStyleClone(el, w, h);
		const xml = buildMirrorSvg(clone, win, w, h, cw, ch);
		if (xml.length > MAX_MIRROR_XML_CHARS) {
			return null; // 超长章防御（iOS data URL 限制）：宁拒不赌，降级为无快照建卡
		}
		const regionCanvas = await rasterizeWindow(xml, cw, ch);
		if (!regionCanvas) {
			return null;
		}
		// 套索轮廓重映射到窗口坐标，unit rect 复用 cropRegionSnapshot 做 clip + 编码
		const remapped =
			polygon && polygon.length >= 3
				? polygon.map((p) => ({
						x: (p.x * w - win.sx) / win.sw,
						y: (p.y * h - win.sy) / win.sh,
					}))
				: null;
		return await cropRegionSnapshot(regionCanvas, { x: 0, y: 0, w: 1, h: 1 }, remapped);
	} catch (err) {
		// warn 而非 debug：此模块失败历史上难排查（㊽-2 教训），控制台留痕便于回报
		console.warn("[MarinMind] DOM 区域快照失败（卡片仍会创建，稍后回填）", err);
		return null;
	} finally {
		if (prevVisibility !== "visible") {
			if (prevVisibility === "") {
				el.style.removeProperty("content-visibility");
			} else {
				el.style.setProperty("content-visibility", prevVisibility);
			}
		}
	}
}

/**
 * 构建内联了计算样式的克隆树：
 * - 删除排除选择器命中的子树（默认 overlay/textLayer + opts.excludeSelectors；
 *   原树遍历同步跳过，与克隆删法一致——见 collectPairs）
 * - 属性保洁：带冒号且无命名空间的字面属性（epub-session setAttribute
 *   ("xlink:href") 产物）序列化后缺 xmlns:xlink 声明、整份 SVG 加载失败——
 *   href 语义值搬进平 href 后删除
 * - 原树/克隆树同序配对（原树遍历跳过排除子树，与克隆删法一致），
 *   逐元素内联计算值；图片（img / svg image）换成 data URL
 * - stripClasses 瞬态类从原树临时摘除（同步 remove → 读计算值 → finally 恢复，
 *   同一任务内完成不触发可见重绘），导出图不带选中/闪烁等操作痕迹
 */
function buildStyleClone(el: HTMLElement, w: number, h: number, opts?: CloneOptions): HTMLElement {
	const exclude = DEFAULT_EXCLUDE_SELECTORS.concat(opts?.excludeSelectors ?? []);
	const stripped: Array<[Element, string]> = [];
	for (const cls of opts?.stripClasses ?? []) {
		for (const node of [el, ...el.querySelectorAll("*")]) {
			if (node.classList.contains(cls)) {
				node.classList.remove(cls);
				stripped.push([node, cls]);
			}
		}
	}
	try {
		const clone = el.cloneNode(true) as HTMLElement;
		if (exclude.length > 0) {
			for (const extra of clone.querySelectorAll<HTMLElement>(exclude.join(", "))) {
				extra.remove();
			}
		}
		sanitizeCloneAttributes(clone);
		const pairs = collectPairs(el, clone, exclude);
		for (const [orig, dest] of pairs) {
			// HTMLElement 与 SVGElement 都有 style（Element 基类没有），窄化取用
			const destStyle = (dest as HTMLElement).style;
			destStyle.cssText = computedStyleText(orig);
			if (destStyle.position === "fixed" || destStyle.position === "sticky") {
				destStyle.setProperty("position", "static"); // 脱离取景窗的定位归一
			}
			if (orig.tagName === "IMG" || orig.localName === "image") {
				inlineImagePixels(orig, dest);
			}
		}
		// 克隆根钉盒：与原树显示盒同尺寸（阅读器路径——.marinmind-pdf-page 无边框
		// 无 padding，clientWidth==offsetWidth）；脑图路径传窗口盒（world 是 0×0
		// transform 容器无自有布局尺寸，见 snapshotElementRegion）。背景显式烘焙保文字可读
		const bg = opts?.rootBackground ?? getComputedStyle(el).backgroundColor;
		clone.style.width = `${w}px`;
		clone.style.height = `${h}px`;
		clone.style.margin = "0";
		clone.style.boxSizing = "border-box";
		clone.style.backgroundColor = isTransparentColor(bg) ? "#ffffff" : bg;
		if (opts?.stripRootTransform) {
			// transform 及 CSS Transforms L2 独立属性一并归零（setProperty 防 lib 差异）
			clone.style.setProperty("transform", "none");
			clone.style.setProperty("translate", "none");
			clone.style.setProperty("rotate", "none");
			clone.style.setProperty("scale", "none");
		}
		return clone;
	} finally {
		// 原树瞬态类恢复（同步区间内完成，用户不可见）
		for (const [node, cls] of stripped) {
			node.classList.add(cls);
		}
	}
}

/** 原树（跳过排除子树）与克隆树同序配对；结构不一致视为竞态直接抛 */
function collectPairs(
	el: HTMLElement,
	clone: HTMLElement,
	excludeSelectors: string[],
): Array<[Element, Element]> {
	const excluded = (node: Element): boolean => {
		for (const sel of excludeSelectors) {
			if (node.matches(sel)) {
				return true;
			}
		}
		return false;
	};
	const originals: Element[] = [el];
	const walker = document.createTreeWalker(el, NodeFilter.SHOW_ELEMENT, {
		acceptNode: (node) =>
			excluded(node as Element) ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT,
	});
	for (let n = walker.nextNode(); n; n = walker.nextNode()) {
		originals.push(n as Element);
	}
	const clones: Element[] = [clone, ...clone.querySelectorAll("*")];
	if (originals.length !== clones.length) {
		throw new Error("克隆树与原树结构不一致（DOM 中途被改动）");
	}
	return originals.map((orig, i) => [orig, clones[i]] as [Element, Element]);
}

function sanitizeCloneAttributes(clone: HTMLElement): void {
	const nodes: Element[] = [clone, ...clone.querySelectorAll("*")];
	for (const node of nodes) {
		for (const attr of Array.from(node.attributes)) {
			if (attr.namespaceURI === null && attr.name.includes(":")) {
				// 字面冒号属性（无命名空间）：镜像 XML 非法的根源；href 语义搬进平属性再删
				if (attr.name.toLowerCase().endsWith("href") && !node.hasAttribute("href")) {
					node.setAttribute("href", attr.value);
				}
				node.removeAttribute(attr.name);
			} else if (HARMFUL_ATTRS.has(attr.name)) {
				node.removeAttribute(attr.name);
			}
		}
	}
}

/**
 * 计算样式 → 内联 cssText：全量遍历逐属性拼接（style.item/getPropertyValue
 * 跨引擎可靠——computed cssText 在部分 WebKit 返回空串）。刻意不用精选属性
 * 清单：box-sizing / line-height / CJK 断行（word-break/overflow-wrap）等漏一项
 * 就换行错位、裁错行，是坐标正确性问题；拒绝属性在遍历中顺手跳过。
 */
function computedStyleText(el: Element): string {
	const style = window.getComputedStyle(el);
	const parts: string[] = [];
	for (let i = 0; i < style.length; i++) {
		const prop = style.item(i);
		if (DENIED_STYLE_PROPS.has(prop)) {
			continue;
		}
		const value = style.getPropertyValue(prop);
		if (value !== "") {
			parts.push(`${prop}: ${value};`);
		}
	}
	return parts.join(" ");
}

/**
 * 图片内联：从活 DOM 里已加载完的原图元素经 canvas 取像素转 data URL——
 * blob:（epub 章图全为此类，同文档同源不污染画布）与 data: 都能取到；外链
 * http(s) 污染画布抛 SecurityError、未加载（章内 lazy 图在折叠线下）→ 删引用留白。
 */
function inlineImagePixels(orig: Element, dest: Element): void {
	const probe = orig as HTMLImageElement;
	if (!probe.complete || (probe.naturalWidth ?? 0) <= 0) {
		clearImageRef(dest);
		return;
	}
	const nw = probe.naturalWidth;
	const nh = probe.naturalHeight;
	const k = Math.min(1, MAX_IMAGE_INLINE_SIDE / Math.max(nw, nh));
	const canvas = document.createElement("canvas");
	canvas.width = Math.max(1, Math.round(nw * k));
	canvas.height = Math.max(1, Math.round(nh * k));
	const ctx = canvas.getContext("2d");
	if (!ctx) {
		clearImageRef(dest);
		return;
	}
	try {
		ctx.drawImage(probe as CanvasImageSource, 0, 0, canvas.width, canvas.height);
		// WebP 优先（环境不支持编码时 toDataURL 自动回退 PNG，前缀即实际格式）
		const dataUrl = canvas.toDataURL("image/webp", 0.85);
		if (dest.tagName === "IMG") {
			dest.setAttribute("src", dataUrl);
		} else {
			dest.setAttribute("href", dataUrl); // svg <image>：保洁后只剩平 href
		}
	} catch {
		clearImageRef(dest);
	}
}

function clearImageRef(dest: Element): void {
	dest.removeAttribute("src");
	dest.removeAttribute("href");
}

function isTransparentColor(color: string): boolean {
	return !color || color === "transparent" || color === "rgba(0, 0, 0, 0)";
}

/** 窗口栅格化倍率：dpr 上限 2 清晰度优先，总面积 16M / 单边 8192 钳制（可小于 1） */
function rasterScale(sw: number, sh: number): number {
	const byArea = Math.sqrt(MAX_SNAPSHOT_PIXELS / (sw * sh));
	const bySide = Math.min(MAX_SNAPSHOT_SIDE / sw, MAX_SNAPSHOT_SIDE / sh);
	return Math.min(2, window.devicePixelRatio || 1, byArea, bySide);
}

/**
 * 组装取景镜像：viewBox 圈定摘录窗口，foreignObject 以负偏移承载全宽宿主
 * （布局宽度不变 → 换行与阅读器一致，窗口内容与所见即所得）。
 */
function buildMirrorSvg(
	clone: HTMLElement,
	win: PixelRect,
	w: number,
	h: number,
	cw: number,
	ch: number,
): string {
	const svg = document.createElementNS(SVG_NS, "svg");
	svg.setAttribute("width", String(cw));
	svg.setAttribute("height", String(ch));
	svg.setAttribute("viewBox", `0 0 ${win.sw} ${win.sh}`);
	const fo = document.createElementNS(SVG_NS, "foreignObject");
	fo.setAttribute("x", String(-win.sx));
	fo.setAttribute("y", String(-win.sy));
	fo.setAttribute("width", String(w));
	fo.setAttribute("height", String(h));
	fo.appendChild(clone);
	svg.appendChild(fo);
	// 前置 XML 声明：data URL 从 JS 字符串构造天然 UTF-8，非 ASCII 文本需显式声明编码；
	// 末尾剥离 XML 非法控制字符（XMLSerializer 不转义，含一个整份 XML 报废）
	return `<?xml version="1.0" encoding="UTF-8"?>${new XMLSerializer().serializeToString(svg)}`.replace(
		INVALID_XML_CHARS_RE,
		"",
	);
}

/** 加载镜像 SVG 为图片并画到 cw×ch 窗口 canvas；失败/超时返回 null */
async function rasterizeWindow(
	xml: string,
	cw: number,
	ch: number,
): Promise<HTMLCanvasElement | null> {
	// data URL 承载：blob: 的 foreignObject SVG 画上 canvas 必污染画布（见模块头）；
	// encodeURIComponent 对以 CSS 计算值为主的 ASCII 大头膨胀远小于 ×3
	const url = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(xml)}`;
	const img = await loadMirrorImage(url);
	const canvas = document.createElement("canvas");
	canvas.width = cw;
	canvas.height = ch;
	const ctx = canvas.getContext("2d");
	if (!ctx) {
		return null;
	}
	ctx.drawImage(img, 0, 0, cw, ch);
	return canvas;
}

/**
 * 加载镜像图：onload 为唯一就绪信号——img.decode() 对含 foreignObject 的 SVG
 * 必然 reject（位图解码器不处理 HTML 内容，㊽-2 实测），不能作主信号。
 */
function loadMirrorImage(url: string): Promise<HTMLImageElement> {
	return new Promise((resolve, reject) => {
		const img = new Image();
		let settled = false;
		const ok = (): void => {
			if (!settled) {
				settled = true;
				window.clearTimeout(timer);
				resolve(img);
			}
		};
		const fail = (err: Error): void => {
			if (!settled) {
				settled = true;
				window.clearTimeout(timer);
				reject(err);
			}
		};
		// 钩子就位后才赋 src（先挂后载，防漏网竞态）
		img.onload = () => ok();
		img.onerror = () => fail(new Error("SVG 镜像图加载失败"));
		const timer = window.setTimeout(() => fail(new Error("SVG 镜像图加载超时")), SVG_IMAGE_TIMEOUT_MS);
		img.src = url;
	});
}
