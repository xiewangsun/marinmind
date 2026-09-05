/**
 * EPUB 解析纯函数（㊼ EPUB 文档支持；fflate + epub-xml，零 obsidian 依赖）。
 *
 * EPUB = zip 容器：META-INF/container.xml → OPF（manifest/spine/元数据）→
 * nav.xhtml（EPUB3）或 NCX toc.ncx（EPUB2）目录。结构问题抛中文 Error
 * （reader 统一 showTip）；**章=页模型**：page = spine 序号 + 1，
 * totalPages = spine.length，摘录/回链/复习链路的 page 语义直接复用。
 * 章节内容的净化/渲染在 epub-session.ts（浏览器耦合不单测）。
 */
import { strFromU8, unzipSync } from "fflate";
import {
	elementAttr,
	elementText,
	findElements,
	firstElement,
	parseXml,
	type XmlElement,
} from "./epub-xml";
import type { OutlineEntry } from "./pdf-document";

/** spine 阅读项（href 已 resolveZipPath 归一为 zip 内路径） */
export interface EpubSpineItem {
	href: string;
	idref: string;
}

/** 目录节点：spineIndex 为 -1 表示目标不在 spine（条目置灰，子级仍可导航） */
export interface EpubTocNode {
	title: string;
	/** 归一后的目标 zip 路径；纯分组节点（无链接）为空串 */
	href: string;
	/** 0 基 spine 序号；非 spine 资源 = -1 */
	spineIndex: number;
	/** 章内锚点 id（href#frag），无则 null */
	fragment: string | null;
	children: EpubTocNode[];
}

/**
 * 解析产物。E2 懒解压：不持有解压条目，改经 readEntry 按需单条目解压
 * （压缩字节常驻 + 解压缓存 LRU，见 makeEntryReader）。
 */
export interface EpubBook {
	/** OPF dc:title；缺失为 null（调用方 basename 兜底） */
	title: string | null;
	/** EPUB3 properties 含 cover-image 或 EPUB2 meta[name=cover] 双形态归一结果 */
	coverHref: string | null;
	/** 阅读顺序（含 linear="no"——过滤会丢封面页且破坏页码稳定性） */
	spine: EpubSpineItem[];
	toc: EpubTocNode[];
	/** 按需读取 zip 条目（章节 XHTML/图片等）；条目不存在或 zip 局部损坏返回 null */
	readonly readEntry: (path: string) => Uint8Array | null;
}

/**
 * 归一 zip 内路径引用：剥 fragment（#）与 query（?）、URL 解码（畸形 % 原样保留）、
 * 按 / 分段处理 . 与 ..（越根钳制：弹空即忽略）。basePath = 引用所在文件的完整
 * zip 路径；href 为空路径（纯 #frag 或空串）指向 basePath 自身（同文档锚点）。
 */
export function resolveZipPath(
	basePath: string,
	href: string,
): { path: string; fragment: string | null } {
	let rest = href;
	let fragment: string | null = null;
	const hashAt = rest.indexOf("#");
	if (hashAt >= 0) {
		fragment = rest.slice(hashAt + 1);
		rest = rest.slice(0, hashAt);
	}
	const queryAt = rest.indexOf("?");
	if (queryAt >= 0) {
		rest = rest.slice(0, queryAt);
	}
	let decoded = rest;
	try {
		decoded = decodeURIComponent(rest);
	} catch {
		// 畸形 % 序列原样保留：条目查不中由调用方按缺失降级（宁拒不赌）
	}
	if (decoded === "") {
		// 纯 fragment / 空 href：基准文件自身（同文档锚点）
		return { path: basePath, fragment: fragment || null };
	}
	const stack: string[] = [];
	const push = (seg: string): void => {
		if (seg === "" || seg === ".") {
			return;
		}
		if (seg === "..") {
			stack.pop(); // 越根钳制：根之上忽略
			return;
		}
		stack.push(seg);
	};
	if (decoded.startsWith("/")) {
		// 绝对路径（自 zip 根）：忽略基准目录
		decoded.slice(1).split("/").forEach(push);
	} else {
		basePath.split("/").slice(0, -1).forEach(push); // 基准文件所在目录
		decoded.split("/").forEach(push);
	}
	return { path: stack.join("/"), fragment: fragment || null };
}

/** OPF 解析中间产物（manifest 以 id 为键归一） */
interface OpfManifestItem {
	href: string;
	/** 空格分隔的 properties 原文（EPUB3 nav/cover-image 标记） */
	properties: string;
	mediaType: string;
}

interface OpfInfo {
	title: string | null;
	coverHref: string | null;
	manifest: Map<string, OpfManifestItem>;
	spine: EpubSpineItem[];
	/** spine@toc 指向的 NCX（含 media-type 回退探测） */
	ncxHref: string | null;
	/** properties 含 nav 的 EPUB3 目录文档 */
	navHref: string | null;
}

/** container.xml → 首个带 full-path 的 rootfile 路径；缺失 null */
function containerRootfilePath(containerXml: string): string | null {
	const root = parseXml(containerXml);
	if (!root) {
		return null;
	}
	for (const rf of findElements(root, "rootfile")) {
		const full = elementAttr(rf, "full-path");
		if (full) {
			return full;
		}
	}
	return null;
}

/** 解析 OPF 文本（opfPath = OPF 在 zip 内的完整路径，href 归一基准） */
function parseOpfText(opfXml: string, opfPath: string): OpfInfo {
	const root = parseXml(opfXml);
	if (!root) {
		throw new Error("EPUB 结构损坏：OPF 解析失败");
	}
	// 元数据：dc:title 取首个非空（xml:lang 重复声明时第一份即主标题）
	let title: string | null = null;
	for (const el of findElements(root, "dc:title")) {
		const t = elementText(el);
		if (t) {
			title = t;
			break;
		}
	}
	const manifest = new Map<string, OpfManifestItem>();
	for (const el of findElements(root, "item")) {
		const id = elementAttr(el, "id");
		const href = elementAttr(el, "href");
		if (!id || !href) {
			continue;
		}
		manifest.set(id, {
			href: resolveZipPath(opfPath, href).path,
			properties: elementAttr(el, "properties") ?? "",
			mediaType: elementAttr(el, "media-type") ?? "",
		});
	}
	// 封面双形态：EPUB3 properties 含 cover-image 优先，EPUB2 meta[name=cover] 兜底
	let coverHref: string | null = null;
	for (const item of manifest.values()) {
		if (item.properties.split(/\s+/).includes("cover-image")) {
			coverHref = item.href;
			break;
		}
	}
	if (!coverHref) {
		for (const el of findElements(root, "meta")) {
			if (elementAttr(el, "name") !== "cover") {
				continue;
			}
			const content = elementAttr(el, "content");
			const item = content ? manifest.get(content) : undefined;
			if (item) {
				coverHref = item.href;
				break;
			}
		}
	}
	const spineEl = firstElement(root, "spine");
	const spine: EpubSpineItem[] = [];
	if (spineEl) {
		for (const ref of findElements(spineEl, "itemref")) {
			const idref = elementAttr(ref, "idref");
			if (!idref) {
				continue;
			}
			const item = manifest.get(idref);
			if (!item) {
				continue; // 悬空引用跳过：页码按渲染顺序保持一致
			}
			spine.push({ idref, href: item.href });
		}
	}
	// NCX：spine@toc 指定优先；缺省按 media-type 探测（真实书有漏写 toc 属性的）
	let ncxHref: string | null = null;
	const tocId = spineEl ? elementAttr(spineEl, "toc") : null;
	if (tocId) {
		ncxHref = manifest.get(tocId)?.href ?? null;
	}
	if (!ncxHref) {
		for (const item of manifest.values()) {
			if (item.mediaType === "application/x-dtbncx+xml") {
				ncxHref = item.href;
				break;
			}
		}
	}
	// EPUB3 nav 文档
	let navHref: string | null = null;
	for (const item of manifest.values()) {
		if (item.properties.split(/\s+/).includes("nav")) {
			navHref = item.href;
			break;
		}
	}
	return { title, coverHref, manifest, spine, ncxHref, navHref };
}

/** 直接子元素按标签过滤（嵌套结构逐层递归用，深搜会重复收集孙级） */
function childElements(el: XmlElement, tag: string): XmlElement[] {
	return el.children.filter((n): n is XmlElement => typeof n !== "string" && n.tag === tag);
}

/** 直接子元素中首个指定标签（ol>li>a 嵌套解析用，深搜会误入孙级） */
function firstChildElement(el: XmlElement, tag: string): XmlElement | null {
	return childElements(el, tag)[0] ?? null;
}

/** href → spineIndex 反查表（同 href 多次入 spine 取首个） */
function buildSpineIndex(spine: readonly EpubSpineItem[]): Map<string, number> {
	const map = new Map<string, number>();
	spine.forEach((item, i) => {
		if (!map.has(item.href)) {
			map.set(item.href, i);
		}
	});
	return map;
}

/** 链接 href → 目录节点（title/fragment/children 就地组装） */
function makeTocNode(
	baseFile: string,
	title: string,
	href: string,
	children: EpubTocNode[],
	spineIndexByHref: Map<string, number>,
): EpubTocNode {
	const { path, fragment } = resolveZipPath(baseFile, href);
	return {
		title,
		href: path,
		spineIndex: spineIndexByHref.get(path) ?? -1,
		fragment,
		children,
	};
}

/** 纯分组节点（无链接，仅承载子级；EPUB3 li>span + ol 形态） */
function groupTocNode(title: string, children: EpubTocNode[]): EpubTocNode {
	return { title, href: "", spineIndex: -1, fragment: null, children };
}

/** EPUB3 nav：ol > li > (a|span) + 嵌套 ol 递归 */
function parseNavOl(ol: XmlElement, navFile: string, idx: Map<string, number>): EpubTocNode[] {
	const out: EpubTocNode[] = [];
	for (const li of childElements(ol, "li")) {
		// li 的直接子 a（深搜会误取嵌套子 li 的 a）
		const a = firstChildElement(li, "a");
		const nested = firstChildElement(li, "ol");
		const children = nested ? parseNavOl(nested, navFile, idx) : [];
		if (a) {
			const href = elementAttr(a, "href");
			const title = elementText(a) || "(无标题)";
			if (href) {
				out.push(makeTocNode(navFile, title, href, children, idx));
			} else if (children.length) {
				out.push(groupTocNode(title, children));
			}
			continue;
		}
		const span = firstChildElement(li, "span");
		const title = span ? elementText(span) : "";
		if (children.length) {
			out.push(groupTocNode(title || "(无标题)", children));
		}
	}
	return out;
}

/** EPUB2 NCX：navMap > navPoint 递归（navLabel>text 标题 + content@src 链接） */
function parseNavPoints(
	parent: XmlElement,
	ncxFile: string,
	idx: Map<string, number>,
): EpubTocNode[] {
	const out: EpubTocNode[] = [];
	for (const np of childElements(parent, "navpoint")) {
		const label = firstElement(np, "navlabel");
		const title = label ? elementText(label) : "";
		const content = firstElement(np, "content");
		const src = content ? elementAttr(content, "src") : null;
		const children = parseNavPoints(np, ncxFile, idx);
		if (src) {
			out.push(makeTocNode(ncxFile, title || "(无标题)", src, children, idx));
		} else if (children.length) {
			out.push(groupTocNode(title || "(无标题)", children));
		}
	}
	return out;
}

/** E2 readEntry 解压缓存上限（总字节）：超过按插入序淘汰最旧（≈64MB 封顶） */
const MAX_DECODED_BYTES = 64 * 1024 * 1024;

/**
 * 单趟 filter 限次解压（E2 懒解压）：只 inflate 白名单条目——每趟扫描
 * central directory 成本 O(条目数) 而非 O(解压体积)，与 epubCoverBytes 同法。
 */
function unzipEntries(bytes: Uint8Array, names: readonly string[]): Record<string, Uint8Array> {
	const allow = new Set(names);
	try {
		return unzipSync(bytes, { filter: (f) => allow.has(f.name) });
	} catch {
		throw new Error("不是有效的 EPUB 文件（无法解压）");
	}
}

/**
 * 惰性条目读取器（E2）：压缩字节常驻，条目首次访问才单条目解压并缓存
 * （插入序 LRU，总字节超上限淘汰）。缓存可激进淘汰的安全性：章节文本经
 * EpubSession.rendered 幂等只解码一次；图片进 Blob 时已 slice 独立拷贝。
 */
function makeEntryReader(bytes: Uint8Array): (path: string) => Uint8Array | null {
	const cache = new Map<string, Uint8Array>();
	let total = 0;
	return (path) => {
		const hit = cache.get(path);
		if (hit) {
			cache.delete(path);
			cache.set(path, hit); // LRU 触碰（重排插入序）
			return hit;
		}
		let entry: Uint8Array | undefined;
		try {
			entry = unzipSync(bytes, { filter: (f) => f.name === path })[path];
		} catch {
			return null; // zip 局部损坏：按条目缺失降级（打开时的趟已验证整体结构）
		}
		if (!entry) {
			return null;
		}
		cache.set(path, entry);
		total += entry.byteLength;
		while (total > MAX_DECODED_BYTES) {
			const oldest = cache.keys().next().value;
			if (oldest === undefined) {
				break;
			}
			const evicted = cache.get(oldest);
			cache.delete(oldest);
			total -= evicted?.byteLength ?? 0;
		}
		return entry;
	};
}

/**
 * 解析 EPUB 字节为结构化书籍。失败抛中文 Error；DRM（encryption.xml 存在）
 * 一律拒——不区分 Adobe DRM 与 IDPF 字体混淆（解混淆挂账后续优化方向）。
 * E2 懒解压：结构文件走三趟 filter 限次解压（container+encryption → OPF →
 * nav/ncx），章节正文/图片不随打开解压——大书打开不再整包 inflate 长阻塞，
 * 全量解压字节也不再常驻内存（只留压缩原文 + ≤64MB 解压缓存）。
 */
export function parseEpub(bytes: Uint8Array): EpubBook {
	const metaPass = unzipEntries(bytes, ["META-INF/container.xml", "META-INF/encryption.xml"]);
	if (metaPass["META-INF/encryption.xml"] !== undefined) {
		throw new Error("该 EPUB 含加密内容（DRM 或字体混淆），暂不支持");
	}
	const containerBytes = metaPass["META-INF/container.xml"];
	if (!containerBytes) {
		throw new Error("EPUB 结构损坏：缺少 META-INF/container.xml");
	}
	const opfPath = containerRootfilePath(strFromU8(containerBytes));
	if (!opfPath) {
		throw new Error("EPUB 结构损坏：container.xml 缺少 rootfile full-path");
	}
	const opfBytes = unzipEntries(bytes, [opfPath])[opfPath];
	if (!opfBytes) {
		throw new Error(`EPUB 结构损坏：找不到 OPF 文件（${opfPath}）`);
	}
	const opf = parseOpfText(strFromU8(opfBytes), opfPath);
	if (opf.spine.length === 0) {
		throw new Error("EPUB 没有可读章节（spine 为空）");
	}
	// 目录：EPUB3 nav 优先，空结果回退 NCX，皆无 toc=[]（reader 兜底「第 N 章」平铺）
	const idx = buildSpineIndex(opf.spine);
	let toc: EpubTocNode[] = [];
	const tocHrefs = [opf.navHref, opf.ncxHref].filter((h): h is string => h != null);
	const tocPass = tocHrefs.length > 0 ? unzipEntries(bytes, tocHrefs) : {};
	if (opf.navHref) {
		const navBytes = tocPass[opf.navHref];
		if (navBytes) {
			const navRoot = parseXml(strFromU8(navBytes));
			const navs = navRoot ? findElements(navRoot, "nav") : [];
			const nav =
				navs.find((n) =>
					(elementAttr(n, "epub:type") ?? "").split(/\s+/).includes("toc"),
				) ?? navs[0];
			const ol = nav ? firstElement(nav, "ol") : null;
			if (ol) {
				toc = parseNavOl(ol, opf.navHref, idx);
			}
		}
	}
	if (toc.length === 0 && opf.ncxHref) {
		const ncxBytes = tocPass[opf.ncxHref];
		if (ncxBytes) {
			const ncxRoot = parseXml(strFromU8(ncxBytes));
			const navMap = ncxRoot ? firstElement(ncxRoot, "navmap") : null;
			if (navMap) {
				toc = parseNavPoints(navMap, opf.ncxHref, idx);
			}
		}
	}
	return {
		title: opf.title,
		coverHref: opf.coverHref,
		spine: opf.spine,
		toc,
		readEntry: makeEntryReader(bytes),
	};
}

/** 取条目文本（UTF-8，TextDecoder 天然剥 BOM）；路径不存在返回 null */
export function entryText(book: EpubBook, path: string): string | null {
	const bytes = book.readEntry(path);
	return bytes ? strFromU8(bytes) : null;
}

/**
 * 封面专用提取（㊼ 主页书架批量出封面）：fflate filter 限次解压
 * （container.xml → OPF → 仅封面条目三趟），不整包解压。任何失败归 null
 * （封面是增强不是依赖，契约永不抛）。
 */
export function epubCoverBytes(bytes: Uint8Array): { href: string; bytes: Uint8Array } | null {
	try {
		const containerPass = unzipSync(bytes, {
			filter: (f) => f.name === "META-INF/container.xml",
		});
		const containerBytes = containerPass["META-INF/container.xml"];
		if (!containerBytes) {
			return null;
		}
		const opfPath = containerRootfilePath(strFromU8(containerBytes));
		if (!opfPath) {
			return null;
		}
		const opfPass = unzipSync(bytes, { filter: (f) => f.name === opfPath });
		const opfBytes = opfPass[opfPath];
		if (!opfBytes) {
			return null;
		}
		const { coverHref } = parseOpfText(strFromU8(opfBytes), opfPath);
		if (!coverHref) {
			return null;
		}
		const coverPass = unzipSync(bytes, { filter: (f) => f.name === coverHref });
		const cover = coverPass[coverHref];
		if (!cover) {
			return null;
		}
		return { href: coverHref, bytes: cover };
	} catch {
		return null;
	}
}

/**
 * 目录树 → 阅读器 OutlineEntry 转换：page = spineIndex + 1（-1 → null 走
 * is-dead 置灰既有语义）；fragment 供章内精定位。无 toc 时兜底「第 N 章」
 * 平铺（spine 顺序即阅读顺序）。
 */
export function epubOutline(book: EpubBook): OutlineEntry[] {
	const conv = (n: EpubTocNode): OutlineEntry => ({
		title: n.title,
		page: n.spineIndex >= 0 ? n.spineIndex + 1 : null,
		fragment: n.fragment,
		children: n.children.map(conv),
	});
	if (book.toc.length === 0) {
		return book.spine.map((_, i) => ({
			title: `第 ${i + 1} 章`,
			page: i + 1,
			fragment: null,
			children: [],
		}));
	}
	return book.toc.map(conv);
}

/**
 * 章节标题（㊼ epub 书签默认标题）：扁平扫描目录，取 spineIndex ≤ 当前章的
 * 最近节点；同章更深/更靠后的节点胜出（章内小节比章名更具体）。
 */
export function epubChapterTitleOf(book: EpubBook, spineIndexZeroBased: number): string | null {
	let bestIdx = -1;
	let bestTitle: string | null = null;
	const walk = (nodes: readonly EpubTocNode[]): void => {
		for (const n of nodes) {
			// 文档序靠后者更具体（同章小节覆盖章名）；> 判定放宽为 >= 保证平级后者胜出
			if (
				n.spineIndex >= 0 &&
				n.spineIndex <= spineIndexZeroBased &&
				n.spineIndex >= bestIdx
			) {
				bestIdx = n.spineIndex;
				bestTitle = n.title;
			}
			walk(n.children);
		}
	};
	walk(book.toc);
	return bestTitle;
}
