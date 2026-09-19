/**
 * EPUB 章节净化/渲染会话（㊼；obsidian/browser 耦合，不单测——镜像 md-document
 * 分层先例，纯解析在 epub-document.ts）。
 *
 * 单章管线：entryText → 浏览器 DOMParser（application/xhtml+xml，parsererror
 * 回退 text/html 容错）→ **白名单净化深拷贝**（不引用原树）→ 注入
 * `div.marinmind-epub-chapter.markdown-preview-view`（吃 Obsidian 原生预览排版
 * = 统一主题排版：忽略书籍自带 CSS、剥 style/class，结构语义保留）。
 *
 * blob URL 铁律：同路径复用同一 URL（Map 缓存），close 统一 revoke（幂等）。
 */
import { entryText, resolveZipPath, type EpubBook } from "./epub-document";

/** 章内链接分类（a 点击经 host 级委托回调 reader-view 决定动作） */
export type EpubLinkTarget =
	| { kind: "spine"; spineIndex: number; fragment: string | null }
	| { kind: "external"; url: string }
	/** 162：a 链接指向 zip 内图片条目（非 spine）——reader 弹预览窗（blob 管线复用） */
	| { kind: "image"; path: string }
	| { kind: "unsupported" };

/** 是否图片扩展名（与 imageMimeOf 的扩展集一致；链接分类用） */
function isImagePath(path: string): boolean {
	const ext = path.slice(path.lastIndexOf(".") + 1).toLowerCase();
	return ["svg", "jpg", "jpeg", "png", "gif", "webp"].includes(ext);
}

/**
 * 超长章分段渲染阈值（168）：顶层块数超过该值的章，第 HEAD_BLOCKS 块起
 * 逐块挂 content-visibility:auto（Chromium 原生跳渲染——几十万字的词典类
 * 章渲染/测量可感卡顿的根治方向）。**阈值化零回归面**：普通章（绝大多数）
 * 完全不挂，滚动/定位/高度全保持现状精确；仅病理级长章进入近似模式。
 *
 * 已知取舍（与挂账「分片懒加载完整方案」的差异）：跳渲染块参与高度时用
 * contain-intrinsic-size 估计值，章内深跳/卡片定位在长章内为**近似落点**
 * （滚近后真实高度渐次替换估计值，auto 前缀记忆已渲染尺寸）；区域快照
 * 不受影响（dom-snapshot 的 DENIED_STYLE_PROPS 已剥 content-visibility，
 * 镜像文档全量渲染）。
 */
const LONG_CHAPTER_BLOCKS = 150;
/** 长章前部保持全渲染的块数（首屏与章首定位保持精确） */
const LONG_CHAPTER_HEAD = 40;

/** 章构建后置：超长章对头部之后的顶层块挂浏览器原生跳渲染（见上注释） */
function relaxLongChapter(chapter: HTMLElement): void {
	const blocks = Array.from(chapter.children);
	if (blocks.length <= LONG_CHAPTER_BLOCKS) {
		return;
	}
	for (let i = LONG_CHAPTER_HEAD; i < blocks.length; i++) {
		(blocks[i] as HTMLElement).setCssProps({
			contentVisibility: "auto",
			containIntrinsicSize: "auto 2.5em",
		});
	}
}

/** 整删标签（脚本/样式/嵌入框架/表单控件/音视频——音视频挂账后续优化） */
const DROP_TAGS = new Set([
	"script",
	"style",
	"link",
	"meta",
	"iframe",
	"object",
	"embed",
	"video",
	"audio",
	"source",
	"track",
	"form",
	"input",
	"button",
	"select",
	"textarea",
	"option",
	"optgroup",
	"base",
	"frame",
	"frameset",
]);

/** HTML 结构白名单（统一排版保留语义所需的最小集） */
const HTML_KEEP = new Set([
	"p",
	"h1",
	"h2",
	"h3",
	"h4",
	"h5",
	"h6",
	"ul",
	"ol",
	"li",
	"dl",
	"dt",
	"dd",
	"table",
	"thead",
	"tbody",
	"tfoot",
	"tr",
	"td",
	"th",
	"caption",
	"col",
	"colgroup",
	"img",
	"figure",
	"figcaption",
	"blockquote",
	"pre",
	"code",
	"em",
	"strong",
	"b",
	"i",
	"u",
	"s",
	"small",
	"sub",
	"sup",
	"br",
	"hr",
	"span",
	"div",
	"a",
	"ruby",
	"rt",
	"rp",
	"section",
	"article",
	"aside",
	"header",
	"footer",
	"nav",
	"del",
	"ins",
	"mark",
	"abbr",
	"cite",
	"q",
	"time",
]);

/** SVG 子集白名单（svg 进入后按此表过滤；defs 内渐变等不在表内按 unwrap 处理） */
const SVG_KEEP = new Set([
	"svg",
	"g",
	"image",
	"path",
	"rect",
	"circle",
	"ellipse",
	"line",
	"polyline",
	"polygon",
	"text",
	"tspan",
	"use",
	"defs",
]);

/** 通用保留属性（style/class/on* 一律剥；src/href/xlink:href 逐个处理） */
const KEEP_ATTRS = new Set([
	"id",
	"alt",
	"title",
	"colspan",
	"rowspan",
	"lang",
	"dir",
	"datetime",
	// SVG 几何/绘制属性（SVG 不吃主题变量，语义保留所需）
	"viewbox",
	"width",
	"height",
	"x",
	"y",
	"cx",
	"cy",
	"r",
	"rx",
	"ry",
	"x1",
	"x2",
	"y1",
	"y2",
	"points",
	"d",
	"fill",
	"stroke",
	"stroke-width",
	"transform",
	"opacity",
	"preserveaspectratio",
	"text-anchor",
	"font-size",
	"font-family",
	"font-weight",
	"dx",
	"dy",
]);

const SVG_NS = "http://www.w3.org/2000/svg";

/** 扩展名 → MIME（svg 必须显式类型才会在 <img> 渲染；位图靠 img 嗅探可省，仍给出更稳）；
 * 162 起导出——reader 图片直链预览的 blob 类型共用同源 */
export function imageMimeOf(path: string): string {
	const ext = path.slice(path.lastIndexOf(".") + 1).toLowerCase();
	if (ext === "svg") return "image/svg+xml";
	if (ext === "jpg" || ext === "jpeg") return "image/jpeg";
	if (ext === "png") return "image/png";
	if (ext === "gif") return "image/gif";
	if (ext === "webp") return "image/webp";
	if (ext === "bmp") return "image/bmp";
	return "application/octet-stream";
}

/** 绝对 URL / 带协议前缀判定（http 外的协议 javascript:/data:/mailto: 等一律不透传） */
function hasUrlScheme(href: string): boolean {
	return /^[a-z][a-z0-9+.-]*:/i.test(href);
}

/**
 * EPUB 渲染会话：一章一 host，懒渲染幂等（isRendered 判定），host 级点击委托
 * 单 listener。close 幂等：revoke 全部 blob URL + 移除委托 listener。
 */
export class EpubSession {
	private readonly spineIndexByHref: Map<string, number>;
	private readonly blobUrls = new Map<string, string>();
	private readonly rendered = new Set<number>();
	private readonly hosts = new Set<HTMLElement>();
	private closed = false;

	constructor(
		private readonly book: EpubBook,
		private readonly onNavigate: (target: EpubLinkTarget, evt: MouseEvent) => void,
	) {
		this.spineIndexByHref = new Map<string, number>();
		book.spine.forEach((item, i) => {
			if (!this.spineIndexByHref.has(item.href)) {
				this.spineIndexByHref.set(item.href, i);
			}
		});
	}

	/** 章节是否已渲染（幂等判定，reader-view 的 IO 懒渲染入口） */
	isRendered(spineIndex: number): boolean {
		return this.rendered.has(spineIndex);
	}

	/**
	 * 渲染第 spineIndex 章（0 基）到 host。已渲染 no-op；章节缺失/解析两级皆败
	 * 注入占位文案（保留页码语义，宁拒不赌不抛）。
	 */
	renderChapterInto(spineIndex: number, host: HTMLElement): void {
		if (this.closed || this.rendered.has(spineIndex)) {
			return;
		}
		const item = this.book.spine[spineIndex];
		const chapter = document.createElement("div");
		chapter.className = "marinmind-epub-chapter markdown-preview-view";
		const text = item ? entryText(this.book, item.href) : null;
		const body = text !== null ? parseChapterDom(text) : null;
		if (body) {
			// 166 章内图片单趟批量预热：sanitize 逐 img 解析 blob 时每图一趟
			// filter 解压——插图多的章滚入视口逐图卡顿；渲染前按原始 DOM 收集
			// 本章图片路径（跳过 fragment/带 scheme 引用），一趟全解压入 LRU
			const imgPaths = new Set<string>();
			for (const el of body.querySelectorAll("img, image")) {
				const raw = el.getAttribute("src") ?? el.getAttribute("xlink:href") ?? "";
				if (!raw || raw.startsWith("#") || /^[a-z][a-z0-9+.-]*:/i.test(raw)) {
					continue;
				}
				imgPaths.add(resolveZipPath(item!.href, raw).path);
			}
			if (imgPaths.size > 0) {
				this.book.warmEntries([...imgPaths]);
			}
			for (const node of Array.from(body.childNodes)) {
				this.sanitizeNode(node, chapter, item!.href, spineIndex, false);
			}
			relaxLongChapter(chapter);
		} else {
			chapter.textContent = item ? "本章内容无法解析" : "本章内容缺失";
		}
		if (!this.hosts.has(host)) {
			this.hosts.add(host);
			host.addEventListener("click", this.hostClick);
		}
		host.appendChild(chapter);
		this.rendered.add(spineIndex);
	}

	/** 关闭会话：revoke 全部图片 blob URL、移除委托 listener（幂等） */
	close(): void {
		if (this.closed) {
			return;
		}
		this.closed = true;
		for (const url of this.blobUrls.values()) {
			URL.revokeObjectURL(url);
		}
		this.blobUrls.clear();
		for (const host of this.hosts) {
			host.removeEventListener("click", this.hostClick);
		}
		this.hosts.clear();
		this.rendered.clear();
	}

	/** host 级点击委托：a[data-mm-link] 拦截（每 host 单 listener） */
	private hostClick = (evt: MouseEvent): void => {
		const anchor = (evt.target as Element | null)?.closest?.("a[data-mm-link]");
		if (!anchor) {
			return;
		}
		evt.preventDefault();
		let target: EpubLinkTarget | null;
		try {
			target = JSON.parse(anchor.getAttribute("data-mm-link") ?? "") as EpubLinkTarget;
		} catch {
			target = null;
		}
		if (target) {
			this.onNavigate(target, evt);
		}
	};

	/** 同路径复用同一 blob URL（Map 缓存）；条目缺失返回 null（alt 兜底不阻塞） */
	private blobUrlFor(path: string): string | null {
		const cached = this.blobUrls.get(path);
		if (cached) {
			return cached;
		}
		// E2 懒解压：readEntry 首次访问才解压该条目（章节/图片不整包展开）
		const bytes = this.book.readEntry(path);
		if (!bytes) {
			return null;
		}
		// slice 拷贝既满足 TS 的 BlobPart 泛型（ArrayBufferLike→ArrayBuffer），也隔离 zip 原字节
		const url = URL.createObjectURL(new Blob([bytes.slice()], { type: imageMimeOf(path) }));
		this.blobUrls.set(path, url);
		return url;
	}

	/** 链接三分类：章内/跨章 spine｜外链 http(s)｜非 spine 相对（unsupported） */
	private classifyLink(
		href: string,
		chapterFile: string,
		spineIndex: number,
	): EpubLinkTarget | null {
		if (href.startsWith("#")) {
			return { kind: "spine", spineIndex, fragment: href.slice(1) || null };
		}
		if (/^https?:\/\//i.test(href) || href.startsWith("//")) {
			return { kind: "external", url: href };
		}
		if (hasUrlScheme(href)) {
			return null; // javascript:/data:/mailto: 等一律剥（宁拒不赌）
		}
		const { path, fragment } = resolveZipPath(chapterFile, href);
		const idx = this.spineIndexByHref.get(path);
		if (idx === undefined) {
			// 162：非 spine 但指向 zip 内图片 → 预览（存在性由点击时 readEntry 判定）
			if (isImagePath(path)) {
				return { kind: "image", path };
			}
			return { kind: "unsupported" };
		}
		return { kind: "spine", spineIndex: idx, fragment };
	}

	/**
	 * 净化单节点深拷贝到 target：DROP 整删 / 白名单重建（属性过滤）/ 其余
	 * unwrap 剥壳保子节点（防丢正文）。inSvg 标记 SVG 子树（NS 创建元素）。
	 */
	private sanitizeNode(
		node: Node,
		target: Element,
		chapterFile: string,
		spineIndex: number,
		inSvg: boolean,
	): void {
		if (node.nodeType === Node.TEXT_NODE) {
			target.appendChild(document.createTextNode(node.textContent ?? ""));
			return;
		}
		if (node.nodeType !== Node.ELEMENT_NODE) {
			return; // 注释等杂项丢弃
		}
		const el = node as Element;
		const tag = el.tagName.toLowerCase();
		if (DROP_TAGS.has(tag)) {
			return;
		}
		const svgBoundary = tag === "svg" && !inSvg;
		const keep = svgBoundary || inSvg ? SVG_KEEP.has(tag) : HTML_KEEP.has(tag);
		if (!keep) {
			// unwrap：不建元素，子节点并入当前 target（保正文）
			for (const child of Array.from(el.childNodes)) {
				this.sanitizeNode(child, target, chapterFile, spineIndex, inSvg);
			}
			return;
		}
		const created =
			svgBoundary || inSvg
				? document.createElementNS(SVG_NS, tag)
				: document.createElement(tag);
		this.copyAttrs(el, created, chapterFile, spineIndex, tag);
		target.appendChild(created);
		for (const child of Array.from(el.childNodes)) {
			this.sanitizeNode(child, created, chapterFile, spineIndex, svgBoundary || inSvg);
		}
	}

	/** 属性过滤拷贝：style/class/on* 剥；id 保留；src/href/xlink:href 逐个处理 */
	private copyAttrs(
		source: Element,
		dest: Element,
		chapterFile: string,
		spineIndex: number,
		tag: string,
	): void {
		const linkAttrs: string[] = [];
		for (const attr of Array.from(source.attributes)) {
			const lname = attr.name.toLowerCase();
			if (lname.startsWith("on") || lname === "style" || lname === "class") {
				continue;
			}
			if (lname === "href" || lname === "src" || lname === "xlink:href") {
				linkAttrs.push(attr.name); // 原名（SVG xlink:href 大小写敏感）
				continue;
			}
			if (KEEP_ATTRS.has(lname)) {
				dest.setAttribute(attr.name, attr.value);
			}
		}
		for (const name of linkAttrs) {
			const value = source.getAttribute(name) ?? "";
			if (tag === "a" && name.toLowerCase() === "href") {
				this.wireAnchor(dest, value, chapterFile, spineIndex);
				continue;
			}
			// img / svg image 的资源引用：纯 fragment（use 引用内部元素）保留，其余解析为 blob
			if (value.startsWith("#")) {
				dest.setAttribute(name, value);
				continue;
			}
			if (hasUrlScheme(value)) {
				continue; // 外部资源一律不透传（统一主题排版 + 防外联）
			}
			const { path } = resolveZipPath(chapterFile, value);
			const url = this.blobUrlFor(path);
			if (url) {
				if (name.toLowerCase() === "xlink:href") {
					// 老 SVG image 双写（现代 Chromium 认 href，旧内容认 xlink:href）
					dest.setAttribute("href", url);
					dest.setAttribute("xlink:href", url);
				} else {
					dest.setAttribute(name, url);
				}
				if (tag === "img") {
					dest.setAttribute("loading", "lazy");
					dest.setAttribute("decoding", "async");
				}
			}
			// 解析失败：不设 src（避免相对路径打到 Obsidian 应用源），alt 兜底
		}
	}

	/** a href：三分类结果挂 data-mm-link（点击委托消费）；不可用链接剥 href */
	private wireAnchor(dest: Element, href: string, chapterFile: string, spineIndex: number): void {
		if (!href) {
			return;
		}
		const target = this.classifyLink(href, chapterFile, spineIndex);
		if (!target) {
			return; // javascript:/data: 等：死链接（无 href 不响应点击）
		}
		dest.setAttribute("data-mm-link", JSON.stringify(target));
		dest.setAttribute("href", "#"); // 保留链接外观/手型，跳转由委托拦截
	}
}

/**
 * 章节文档解析：XHTML 严格模式优先（规范形态），parsererror 回退 text/html
 * 容错（真实书 XHTML 常有未转义 & 等）。text/html 恒产出 body（空章=空内容，
 * 占位仅在两级结构皆异常时由调用方兜底不适用——空章照常翻页）。
 */
function parseChapterDom(text: string): HTMLElement | null {
	try {
		const strict = new DOMParser().parseFromString(text, "application/xhtml+xml");
		if (strict.getElementsByTagName("parsererror").length === 0) {
			const body = strict.getElementsByTagName("body")[0];
			if (body) {
				return body as HTMLElement;
			}
		}
	} catch {
		// 极端环境 XHTML 模式直接抛：走容错
	}
	return new DOMParser().parseFromString(text, "text/html").body;
}
