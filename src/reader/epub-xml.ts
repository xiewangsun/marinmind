/**
 * 迷你 XML 解析器（㊼ EPUB 支持，纯 TS 零依赖）。
 *
 * 为什么自研而不用 DOMParser：测试环境为纯 Node（无 jsdom），而 EPUB 结构文件
 * （container.xml / OPF / NCX / nav）的解析逻辑需要 vitest 直测——运行时与测试
 * 共用同一实现，测试的就是生产代码。本模块只服务上述结构文件：规范上必须是
 * 良构 XML，畸形一律返回 null（宁拒不赌，由上层转中文错误），不做 HTML 式容错
 * 恢复——章节 XHTML 的容错解析走浏览器 DOMParser（见 epub-session.ts）。
 */

/** 元素节点：tag/属性名均小写归一（命名空间前缀保留，如 dc:title） */
export interface XmlElement {
	tag: string;
	/** 属性名小写归一；值已解码实体 */
	attrs: Record<string, string>;
	/** 子元素与文本节点按文档顺序混排 */
	children: XmlNode[];
}

/** 文本节点（实体已解码）或元素节点 */
export type XmlNode = XmlElement | string;

/** 解析上下文：字符串 + 游标（模块内部使用） */
interface ParseCtx {
	s: string;
	i: number;
}

const WS = " \t\r\n";

/** XML 名字字符：字母/数字/_-.: + 非 ASCII 宽松放行（带音标/CJK） */
function isNameChar(ch: string | undefined): boolean {
	if (ch === undefined) {
		return false;
	}
	const code = ch.charCodeAt(0);
	if (code >= 0x80) {
		return true;
	}
	return /[A-Za-z0-9_\-.:]/.test(ch);
}

function skipWs(c: ParseCtx): void {
	while (c.i < c.s.length && WS.includes(c.s[c.i])) {
		c.i++;
	}
}

/** 从当前游标跳过 marker（含自身）；找不到返回 false（整体判畸形） */
function skipUntil(c: ParseCtx, marker: string): boolean {
	const at = c.s.indexOf(marker, c.i);
	if (at < 0) {
		return false;
	}
	c.i = at + marker.length;
	return true;
}

/**
 * 跳过 `<!…>` 杂项（DOCTYPE 可带内部子集 [ ]，按括号深度感知扫到 `>`）。
 * 调用方保证当前处于 `<!` 且已排除注释/CDATA（它们有专属终止符）。
 */
function skipDoctype(c: ParseCtx): boolean {
	let depth = 0;
	c.i += 2; // 跳过 "<!"
	while (c.i < c.s.length) {
		const ch = c.s[c.i];
		if (ch === "[") {
			depth++;
		} else if (ch === "]") {
			depth--;
		} else if (ch === ">" && depth <= 0) {
			c.i++;
			return true;
		}
		c.i++;
	}
	return false;
}

/**
 * 解析 XML 文本，返回根元素。
 * 顶层允许 XML 声明/注释/DOCTYPE 等杂项与唯一根元素；任何结构性畸形
 * （标签不闭合、开闭不匹配、属性残缺、多根）返回 null。
 */
export function parseXml(text: string): XmlElement | null {
	// 防御 BOM（entryText 走 TextDecoder 已剥，此处兜底直接接收字符串的调用方）
	const c: ParseCtx = { s: text.replace(/^﻿/, ""), i: 0 };
	let root: XmlElement | null = null;
	for (;;) {
		skipWs(c);
		if (c.i >= c.s.length) {
			break;
		}
		if (!c.s.startsWith("<", c.i)) {
			return null; // 顶层游离文本（XML 不允许）
		}
		if (c.s.startsWith("<?", c.i)) {
			if (!skipUntil(c, "?>")) return null;
			continue;
		}
		if (c.s.startsWith("<!--", c.i)) {
			if (!skipUntil(c, "-->")) return null;
			continue;
		}
		if (c.s.startsWith("<![CDATA[", c.i)) {
			return null; // 顶层 CDATA 无意义，判畸形
		}
		if (c.s.startsWith("<!", c.i)) {
			if (!skipDoctype(c)) return null;
			continue;
		}
		if (c.s.startsWith("</", c.i)) {
			return null; // 顶层闭标签
		}
		const el = parseElement(c);
		if (!el) {
			return null;
		}
		if (root) {
			return null; // 多根元素
		}
		root = el;
	}
	return root;
}

/** 解析单个元素（调用方保证当前处于 `<` 且非杂项/闭标签前缀） */
function parseElement(c: ParseCtx): XmlElement | null {
	c.i++; // 跳过 "<"
	const nameStart = c.i;
	while (isNameChar(c.s[c.i])) {
		c.i++;
	}
	const tag = c.s.slice(nameStart, c.i).toLowerCase();
	if (!tag) {
		return null;
	}
	const attrs: Record<string, string> = {};
	const children: XmlNode[] = [];
	// 属性区：读至 ">"（开标签结束）或 "/>"（自闭合）
	for (;;) {
		skipWs(c);
		const ch = c.s[c.i];
		if (ch === undefined) {
			return null;
		}
		if (ch === ">") {
			c.i++;
			break;
		}
		if (ch === "/") {
			if (c.s[c.i + 1] === ">") {
				c.i += 2;
				return { tag, attrs, children }; // 自闭合：无子内容
			}
			return null;
		}
		// 属性 = 名字 = 引号值（XML 强制带引号；无值属性/裸值一律判畸形）
		const aStart = c.i;
		while (isNameChar(c.s[c.i])) {
			c.i++;
		}
		const attrName = c.s.slice(aStart, c.i).toLowerCase();
		if (!attrName) {
			return null;
		}
		skipWs(c);
		if (c.s[c.i] !== "=") {
			return null;
		}
		c.i++;
		skipWs(c);
		const quote = c.s[c.i];
		if (quote !== '"' && quote !== "'") {
			return null;
		}
		c.i++;
		const vStart = c.i;
		while (c.i < c.s.length && c.s[c.i] !== quote) {
			c.i++;
		}
		if (c.i >= c.s.length) {
			return null; // 引号未闭合
		}
		const rawValue = c.s.slice(vStart, c.i);
		c.i++; // 跳过闭引号
		if (Object.prototype.hasOwnProperty.call(attrs, attrName)) {
			return null; // 重复属性（XML 规范禁止）
		}
		attrs[attrName] = decodeEntities(rawValue);
	}
	// 子内容：文本/CDATA/注释/PI/子元素混排，直至匹配的闭标签
	for (;;) {
		const lt = c.s.indexOf("<", c.i);
		if (lt < 0) {
			return null; // 缺闭标签
		}
		if (lt > c.i) {
			children.push(decodeEntities(c.s.slice(c.i, lt)));
		}
		c.i = lt;
		if (c.s.startsWith("<![CDATA[", c.i)) {
			// CDATA 内容原样保留（不解码实体、不解析标签）
			const end = c.s.indexOf("]]>", c.i + 9);
			if (end < 0) {
				return null;
			}
			children.push(c.s.slice(c.i + 9, end));
			c.i = end + 3;
			continue;
		}
		if (c.s.startsWith("<!--", c.i)) {
			if (!skipUntil(c, "-->")) return null;
			continue;
		}
		if (c.s.startsWith("<?", c.i)) {
			if (!skipUntil(c, "?>")) return null;
			continue;
		}
		if (c.s.startsWith("</", c.i)) {
			c.i += 2;
			const closeStart = c.i;
			while (isNameChar(c.s[c.i])) {
				c.i++;
			}
			const closeTag = c.s.slice(closeStart, c.i).toLowerCase();
			skipWs(c);
			if (c.s[c.i] !== ">") {
				return null;
			}
			c.i++;
			if (closeTag !== tag) {
				return null; // 开闭不匹配
			}
			return { tag, attrs, children };
		}
		const child = parseElement(c);
		if (!child) {
			return null;
		}
		children.push(child);
	}
}

/**
 * 常用命名实体表（HTML Latin-1 全集 + 常用排版符号）。
 * 真实 EPUB 的 nav.xhtml/NCX 常混 HTML 实体（XHTML DTD 允许），未知命名实体
 * 原样保留（宽容显示，不判畸形）。
 */
const NAMED_ENTITIES: Record<string, string> = {
	amp: "&",
	lt: "<",
	gt: ">",
	quot: '"',
	apos: "'",
	nbsp: " ",
	iexcl: "¡",
	cent: "¢",
	pound: "£",
	curren: "¤",
	yen: "¥",
	brvbar: "¦",
	sect: "§",
	uml: "¨",
	copy: "©",
	ordf: "ª",
	laquo: "«",
	not: "¬",
	shy: "­",
	reg: "®",
	macr: "¯",
	deg: "°",
	plusmn: "±",
	sup2: "²",
	sup3: "³",
	acute: "´",
	micro: "µ",
	para: "¶",
	middot: "·",
	cedil: "¸",
	sup1: "¹",
	ordm: "º",
	raquo: "»",
	frac14: "¼",
	frac12: "½",
	frac34: "¾",
	iquest: "¿",
	Agrave: "À",
	Aacute: "Á",
	Acirc: "Â",
	Atilde: "Ã",
	Auml: "Ä",
	Aring: "Å",
	AElig: "Æ",
	Ccedil: "Ç",
	Egrave: "È",
	Eacute: "É",
	Ecirc: "Ê",
	Euml: "Ë",
	Igrave: "Ì",
	Iacute: "Í",
	Icirc: "Î",
	Iuml: "Ï",
	ETH: "Ð",
	Ntilde: "Ñ",
	Ograve: "Ò",
	Oacute: "Ó",
	Ocirc: "Ô",
	Otilde: "Õ",
	Ouml: "Ö",
	Oslash: "Ø",
	Ugrave: "Ù",
	Uacute: "Ú",
	Ucirc: "Û",
	Uuml: "Ü",
	Yacute: "Ý",
	THORN: "Þ",
	szlig: "ß",
	agrave: "à",
	aacute: "á",
	acirc: "â",
	atilde: "ã",
	auml: "ä",
	aring: "å",
	aelig: "æ",
	ccedil: "ç",
	egrave: "è",
	eacute: "é",
	ecirc: "ê",
	euml: "ë",
	igrave: "ì",
	iacute: "í",
	icirc: "î",
	iuml: "ï",
	eth: "ð",
	ntilde: "ñ",
	ograve: "ò",
	oacute: "ó",
	ocirc: "ô",
	otilde: "õ",
	ouml: "ö",
	oslash: "ø",
	ugrave: "ù",
	uacute: "ú",
	ucirc: "û",
	uuml: "ü",
	yacute: "ý",
	thorn: "þ",
	yuml: "ÿ",
	times: "×",
	divide: "÷",
	ndash: "–",
	mdash: "—",
	lsquo: "‘",
	rsquo: "’",
	ldquo: "“",
	rdquo: "”",
	hellip: "…",
	bull: "•",
	dagger: "†",
	Dagger: "‡",
	permil: "‰",
	prime: "′",
	Prime: "″",
	euro: "€",
	trade: "™",
};

/** 数字码位文本（digits 按 radix 解析）；非法码位返回完整实体原文 whole */
function codePointText(digits: string, radix: number, whole: string): string {
	const code = parseInt(digits, radix);
	// 码位合法性：>0、≤0x10FFFF、非代理区；非法原样保留
	if (
		!Number.isFinite(code) ||
		code <= 0 ||
		code > 0x10ffff ||
		(code >= 0xd800 && code <= 0xdfff)
	) {
		return whole;
	}
	return String.fromCodePoint(code);
}

/** 解码文本中的实体（元素文本与属性值共用；无 & 快速路径） */
function decodeEntities(s: string): string {
	if (!s.includes("&")) {
		return s;
	}
	return s.replace(
		/&(#x[0-9a-fA-F]+|#X[0-9a-fA-F]+|#[0-9]+|[A-Za-z][A-Za-z0-9]*);/g,
		(whole, body: string) => {
			if (body.startsWith("#x") || body.startsWith("#X")) {
				return codePointText(body.slice(2), 16, whole);
			}
			if (body.startsWith("#")) {
				return codePointText(body.slice(1), 10, whole);
			}
			const named = NAMED_ENTITIES[body];
			return named !== undefined ? named : whole; // 未知命名实体原样保留
		},
	);
}

/** 深度优先收集全部指定标签元素（子树含后代；tag 需小写） */
export function findElements(root: XmlElement | null, tag: string): XmlElement[] {
	const out: XmlElement[] = [];
	if (!root) {
		return out;
	}
	const walk = (el: XmlElement): void => {
		for (const node of el.children) {
			if (typeof node === "string") {
				continue;
			}
			if (node.tag === tag) {
				out.push(node);
			}
			walk(node);
		}
	};
	walk(root);
	return out;
}

/** 首个命中的指定标签元素（文档序），无则 null */
export function firstElement(root: XmlElement | null, tag: string): XmlElement | null {
	return findElements(root, tag)[0] ?? null;
}

/** 递归拼接元素内全部文本并 trim（dc:title、navLabel/text、a 文本用） */
export function elementText(el: XmlElement): string {
	let out = "";
	const walk = (node: XmlNode): void => {
		if (typeof node === "string") {
			out += node;
			return;
		}
		node.children.forEach(walk);
	};
	el.children.forEach(walk);
	return out.trim();
}

/** 取属性值（名小写归一），不存在返回 null */
export function elementAttr(el: XmlElement, name: string): string | null {
	const v = el.attrs[name.toLowerCase()];
	return v === undefined ? null : v;
}
