/**
 * DOM → Markdown 白名单转换（113-A，自研零依赖）：extractArticle 产出的正文
 * 根元素 → markdown 文本。设计要点：
 *
 * - **图片两遍法**：转换期不下载图片，先输出占位符 `![alt](__MMIMG_n__)` 并收集
 *   MdImageRef（URL 已相对 baseUrl 绝对化、data: URI 单列）；服务层下载/落盘后
 *   经 fillImageRefs 把占位符回填为本地相对路径或原远程 URL。转换纯函数化，
 *   网络与 vault 全部外置在 webclip-service。
 * - **白名单渲染**：块级标签逐类映射（标题/段落/列表/引用/代码块/表格/水平线/
 *   figure），行内标签映射（强调/删除线/行内码/链接/图片），未知标签透明穿透
 *   （div/span 类容器按子内容递归）——不试图保真网页排版，产出「干净的阅读版」。
 * - 转义策略：文本节点转义 markdown 特种字符；段落行首的标题/引用/列表标记符
 *   加反斜杠防误解析（正文里恰以 "# " 开头的普通文字不变成标题）。
 *
 * 依赖 DOM Element 接口（运行时 DOMParser 产物；测试 jsdom 直跑同一实现），
 * 模块顶层零 DOM 引用，Node 环境 import 安全。
 */

/** 图片引用记录：占位符 ↔ 解析后的源（url 与 dataUri 二选一，均空则转换期已丢弃） */
export interface MdImageRef {
	/** 占位符主名（如 "__MMIMG_0__"，不含 ![]() 包裹） */
	placeholder: string;
	/** 绝对化后的 http(s) 图片地址（懒加载 data-src 命中同列） */
	url: string | null;
	/** data:image/* 内联图（服务层直接解码落盘，不走网络） */
	dataUri: string | null;
	alt: string;
}

/** 转换上下文（纯函数无模块级状态，重入安全） */
interface ConvertCtx {
	baseUrl: string;
	images: MdImageRef[];
}

/** 块级标签集：命中则中断行内缓冲、按块渲染 */
const BLOCK_TAGS = new Set([
	"ADDRESS",
	"ARTICLE",
	"ASIDE",
	"BLOCKQUOTE",
	"DETAILS",
	"DD",
	"DIV",
	"DL",
	"DT",
	"FIGCAPTION",
	"FIGURE",
	"FOOTER",
	"H1",
	"H2",
	"H3",
	"H4",
	"H5",
	"H6",
	"HEADER",
	"HR",
	"LI",
	"MAIN",
	"NAV",
	"OL",
	"P",
	"PRE",
	"SECTION",
	"TABLE",
	"TBODY",
	"TFOOT",
	"THEAD",
	"TR",
	"UL",
]);

/** 代码块 class 语言的噪声 token（框架高亮类名，非语言名） */
const CODE_CLASS_NOISE = new Set([
	"highlight",
	"hljs",
	"code",
	"prettyprint",
	"linenums",
	"sourcecode",
	"highlighted",
	"codedemo",
]);

/**
 * 从 code/pre 的 class 推断代码语言："language-python" / "lang-py" /
 * "highlight-ruby" 前缀式优先，退单 token 猜测（"python"，噪声黑名单过滤）。
 */
export function codeLanguageOf(className: string | null): string {
	if (!className) {
		return "";
	}
	for (const token of className.split(/\s+/)) {
		const m = /^(?:highlight|language|lang)-([\w+#.-]+)$/i.exec(token);
		if (m) {
			return m[1].toLowerCase();
		}
	}
	for (const token of className.split(/\s+/)) {
		if (/^[\w+#.-]{1,20}$/.test(token) && !CODE_CLASS_NOISE.has(token.toLowerCase())) {
			return token.toLowerCase();
		}
	}
	return "";
}

/** 行内文本转义：特种字符加反斜杠；"<字母" 形态防吞成 HTML；"![" 防伪图片；"~~" 防伪删除线 */
function escapeInlineText(s: string): string {
	return s
		.replace(/([\\`*_[\]])/g, "\\$1")
		.replace(/<(?=[a-zA-Z!/?])/g, "\\<")
		.replace(/!(?=\[)/g, "\\!")
		.replace(/~~/g, "\\~\\~");
}

/** 段落行首标记符转义（正文恰以 "# "/"1. " 开头的普通文字不变成标题/列表） */
function escapeLeadingMarkers(s: string): string {
	return s
		.replace(/^(#{1,6})(\s)/, "\\$1$2")
		.replace(/^([+*-]+)(\s)/, "\\$1$2")
		.replace(/^(>+)(\s?)/, "\\$1$2")
		.replace(/^(\d{1,9})([.)])(\s)/, "$1\\$2$3");
}

/** 折叠行内空白（HTML 语义：连续空白等价单空格） */
function collapseWs(s: string): string {
	return s.replace(/\s+/g, " ");
}

/** 解析为 markdown 后的链接目标：空格百分号化（GFM 链接内空格非法），含括号加 <> 包裹 */
function mdLinkTarget(url: string): string {
	const encoded = url.replace(/ /g, "%20");
	return /[()]/.test(encoded) ? `<${encoded}>` : encoded;
}

/** 图片元素 → 占位符行内片段（无 http(s)/data: 源的图直接丢弃） */
function imgToRef(img: Element, ctx: ConvertCtx): string {
	const src = (img.getAttribute("src") ?? img.getAttribute("data-src") ?? "").trim();
	const alt = (img.getAttribute("alt") ?? "").replace(/[[\]]/g, " ").trim();
	let url: string | null = null;
	let dataUri: string | null = null;
	if (/^data:image\//i.test(src)) {
		dataUri = src;
	} else if (src) {
		try {
			const u = new URL(src, ctx.baseUrl);
			if (u.protocol === "http:" || u.protocol === "https:") {
				url = u.href;
			}
		} catch {
			// 相对路径且 baseUrl 解析失败（如协议不明的 src）→ 丢弃
		}
	}
	if (!url && !dataUri) {
		return "";
	}
	const placeholder = `__MMIMG_${ctx.images.length}__`;
	ctx.images.push({ placeholder, url, dataUri, alt });
	return `![${alt}](${placeholder})`;
}

/** 行内元素集合渲染为单行 markdown 片段（不 trim——由块层决定边界） */
function renderInlineNodes(nodes: ArrayLike<ChildNode>, ctx: ConvertCtx): string {
	let out = "";
	for (const node of Array.from(nodes)) {
		if (node.nodeType === 3 /* TEXT_NODE */) {
			out += escapeInlineText(collapseWs(node.textContent ?? ""));
			continue;
		}
		if (node.nodeType !== 1 /* ELEMENT_NODE */) {
			continue; // 注释等跳过
		}
		const el = node as Element;
		switch (el.tagName) {
			case "BR":
				out += "\n";
				break;
			case "IMG": {
				out += imgToRef(el, ctx);
				break;
			}
			case "A": {
				const text = renderInlineNodes(el.childNodes, ctx).trim();
				const href = (el.getAttribute("href") ?? "").trim();
				if (!href || href.startsWith("#")) {
					out += text; // 锚点/空链接保文字
					break;
				}
				let abs = href;
				try {
					abs = new URL(href, ctx.baseUrl).href;
				} catch {
					// 保持原样
				}
				out +=
					!text || text === abs
						? `<${mdLinkTarget(abs)}>`
						: `[${text}](${mdLinkTarget(abs)})`;
				break;
			}
			case "STRONG":
			case "B": {
				const inner = renderInlineNodes(el.childNodes, ctx).trim();
				out += inner ? `**${inner}**` : "";
				break;
			}
			case "EM":
			case "I":
			case "CITE": {
				const inner = renderInlineNodes(el.childNodes, ctx).trim();
				out += inner ? `*${inner}*` : "";
				break;
			}
			case "DEL":
			case "S":
			case "STRIKE": {
				const inner = renderInlineNodes(el.childNodes, ctx).trim();
				out += inner ? `~~${inner}~~` : "";
				break;
			}
			case "CODE":
			case "KBD":
			case "SAMP": {
				const raw = collapseWs(el.textContent ?? "").trim();
				if (!raw) {
					break;
				}
				// 内容含反引号时升双反引号并留边距（CommonMark 行内码规则）
				out += raw.includes("`") ? "`` " + raw + " ``" : `\`${raw}\``;
				break;
			}
			default:
				// span/sub/sup/mark/abbr/time 等语义弱标签与未知标签：透明穿透
				out += renderInlineNodes(el.childNodes, ctx);
		}
	}
	return out;
}

/** 元素的行内内容（trim 后），标题/段落等单行块共用 */
function inlineOf(el: Element, ctx: ConvertCtx): string {
	return renderInlineNodes(el.childNodes, ctx).trim();
}

/** pre → 围栏代码块（语言 class 推断；内容含围栏时升四反引号） */
function preToMd(pre: Element): string {
	const codeEl = pre.querySelector("code");
	const lang = codeLanguageOf(codeEl?.className ?? pre.className ?? null);
	const content = (pre.textContent ?? "").replace(/\n+$/, "");
	const fence = content.includes("```") ? "````" : "```";
	return `${fence}${lang}\n${content}\n${fence}`;
}

/** 列表（含嵌套）：块级递归渲染后按首行 marker / 续行 pad 重排 */
function listToMd(list: Element, ctx: ConvertCtx, ordered: boolean, indent: string): string[] {
	const lines: string[] = [];
	let index = 1;
	const startAttr = Number.parseInt(list.getAttribute("start") ?? "", 10);
	if (ordered && Number.isFinite(startAttr) && startAttr > 0) {
		index = startAttr;
	}
	for (const li of Array.from(list.children)) {
		if (li.tagName !== "LI") {
			continue;
		}
		const marker = ordered ? `${index}. ` : "- ";
		const pad = `${indent}${" ".repeat(marker.length)}`;
		const blocks = renderBlockChildren(li, ctx);
		if (blocks.length === 0) {
			lines.push(`${indent}${marker.trimEnd()}`); // 空列表项保位（GFM 允许空项）
		} else {
			blocks.forEach((block, blockIdx) => {
				block.split("\n").forEach((line, lineIdx, arr) => {
					// 首块首行顶 marker，其余一律 pad 续行（嵌套列表经此逐级缩进）
					if (blockIdx === 0 && lineIdx === 0) {
						lines.push(`${indent}${marker}${line}`);
					} else if (line === "" && lineIdx === arr.length - 1) {
						// 块尾空行不 pad（避免续行尾随空白）
					} else {
						lines.push(`${pad}${line}`);
					}
				});
			});
		}
		index++;
	}
	return lines.length > 0 ? [lines.join("\n")] : [];
}

/** 一行 tr → 单元格数组（colspan 平铺为重复空格；| 与换行转义） */
function cellsOf(tr: Element, ctx: ConvertCtx): string[] {
	const cells: string[] = [];
	for (const cell of Array.from(tr.children)) {
		const tag = cell.tagName;
		if (tag !== "TD" && tag !== "TH") {
			continue;
		}
		const text = renderInlineNodes(cell.childNodes, ctx).replace(/\s+/g, " ").trim();
		cells.push(text.replace(/\|/g, "\\|"));
		const span = Number.parseInt(cell.getAttribute("colspan") ?? "", 10);
		if (Number.isFinite(span) && span > 1) {
			for (let i = 1; i < span; i++) {
				cells.push("");
			}
		}
	}
	return cells;
}

/** table → GFM 管道表（thead 行为表头，无 thead 取首行；无有效行返回 null 丢弃） */
function tableToMd(table: Element, ctx: ConvertCtx): string | null {
	const rows = Array.from(table.querySelectorAll("tr"));
	if (rows.length === 0) {
		return null;
	}
	const inHead = (tr: Element) => tr.parentElement?.tagName === "THEAD";
	const headerRow = rows.find(inHead) ?? rows[0];
	const headerCells = cellsOf(headerRow, ctx);
	if (headerCells.length === 0) {
		return null;
	}
	const bodyRows = rows.filter((tr) => tr !== headerRow && !inHead(tr));
	const width = Math.max(headerCells.length, ...bodyRows.map((tr) => cellsOf(tr, ctx).length));
	const padRow = (cells: string[]): string[] => {
		const out = cells.slice(0, width);
		while (out.length < width) {
			out.push("");
		}
		return out;
	};
	const line = (cells: string[]): string => `| ${cells.join(" | ")} |`;
	const out = [
		line(padRow(headerCells)),
		line(Array.from({ length: width }, () => "---")),
		...bodyRows.map((tr) => line(padRow(cellsOf(tr, ctx)))),
	];
	return out.join("\n");
}

/** 单个块级元素 → 块字符串数组（空数组 = 丢弃该元素） */
function renderBlockElement(el: Element, ctx: ConvertCtx): string[] {
	switch (el.tagName) {
		case "H1":
		case "H2":
		case "H3":
		case "H4":
		case "H5":
		case "H6": {
			const level = Number.parseInt(el.tagName.slice(1), 10);
			const text = inlineOf(el, ctx);
			return text ? [`${"#".repeat(level)} ${text}`] : [];
		}
		case "P": {
			const text = inlineOf(el, ctx);
			return text ? [escapeLeadingMarkers(text)] : [];
		}
		case "HR":
			return ["---"];
		case "PRE":
			return [preToMd(el)];
		case "BLOCKQUOTE": {
			const inner = renderBlockChildren(el, ctx);
			if (inner.length === 0) {
				return [];
			}
			return [
				inner
					.join("\n\n")
					.split("\n")
					.map((line) => (line ? `> ${line}` : ">"))
					.join("\n"),
			];
		}
		case "UL":
			return listToMd(el, ctx, false, "");
		case "OL":
			return listToMd(el, ctx, true, "");
		case "TABLE": {
			const md = tableToMd(el, ctx);
			return md ? [md] : [];
		}
		case "FIGCAPTION": {
			const text = inlineOf(el, ctx);
			return text ? [`*${text}*`] : [];
		}
		case "DT": {
			const text = inlineOf(el, ctx);
			return text ? [`**${text}**`] : [];
		}
		case "DD": {
			const text = inlineOf(el, ctx);
			return text ? [text] : [];
		}
		default:
			// div/section/article/figure/details/dl 等容器：透明递归
			return renderBlockChildren(el, ctx);
	}
}

/** 子节点序列 → 块数组：连续行内内容积压到缓冲、遇块级元素即冲刷成段落 */
function renderBlockChildren(el: Element, ctx: ConvertCtx): string[] {
	const blocks: string[] = [];
	let buffer = "";
	const flush = () => {
		const text = buffer.replace(/\s+/g, " ").trim();
		buffer = "";
		if (text) {
			blocks.push(escapeLeadingMarkers(text));
		}
	};
	for (const node of Array.from(el.childNodes)) {
		if (node.nodeType === 3 /* TEXT_NODE */) {
			buffer += collapseWs(node.textContent ?? "");
			continue;
		}
		if (node.nodeType !== 1 /* ELEMENT_NODE */) {
			continue;
		}
		const child = node as Element;
		if (BLOCK_TAGS.has(child.tagName)) {
			flush();
			blocks.push(...renderBlockElement(child, ctx));
		} else {
			buffer += renderInlineNodes([child], ctx);
		}
	}
	flush();
	return blocks;
}

/**
 * 正文根元素 → markdown。产出的图片一律为占位符形态，调用方（服务层）下载/
 * 落盘后用 fillImageRefs 回填；blocks 以空行相连（Obsidian 阅读排版标准间隔）。
 */
export function domToMarkdown(
	root: Element,
	opts: { baseUrl: string },
): { markdown: string; images: MdImageRef[] } {
	const ctx: ConvertCtx = { baseUrl: opts.baseUrl, images: [] };
	const blocks = renderBlockChildren(root, ctx);
	return { markdown: blocks.join("\n\n"), images: ctx.images };
}

/**
 * 占位符回填（两遍法第二遍）：resolved 映射「占位符 → 嵌入路径或远程 URL」；
 * 无目标（既未落盘也无远程源）的图片整段抹除。代码围栏内不会出现占位符
 * （代码块走 textContent 原文直收），故替换无围栏误伤。
 * 收尾在围栏外折叠连续空行（多图抹除后的空行堆积），围栏内容逐行原样保留。
 */
export function fillImageRefs(markdown: string, resolved: Record<string, string>): string {
	const replaced = markdown.replace(
		/!\[([^\]]*)\]\((__MMIMG_\d+__)\)/g,
		(_m, alt: string, ph: string) => {
			const target = resolved[ph];
			if (!target) {
				return "";
			}
			// 本地路径保持原字面（CJK 文件名 Obsidian 直解；远程 URL 已是 new URL 的
			// 规范形态），仅 mdLinkTarget 处理空格/括号两个 markdown 链接非法字符
			return `![${alt}](${mdLinkTarget(target)})`;
		},
	);
	return collapseBlankRuns(replaced);
}

/** 折叠连续空行（代码围栏内豁免——围栏开/闭行以 ``` 或 ~~~ 起头） */
function collapseBlankRuns(md: string): string {
	const lines = md.split("\n");
	const out: string[] = [];
	let inFence = false;
	let fenceMarker = "";
	let blankRun = 0;
	for (const line of lines) {
		const fence = /^(\s*)(`{3,}|~{3,})/.exec(line);
		if (inFence) {
			out.push(line);
			if (fence && line.trim().startsWith(fenceMarker)) {
				inFence = false;
			}
			continue;
		}
		if (fence) {
			inFence = true;
			fenceMarker = fence[2].slice(0, 1).repeat(3);
			blankRun = 0;
			out.push(line);
			continue;
		}
		if (line.trim() === "") {
			blankRun++;
			if (blankRun <= 1) {
				out.push(line);
			}
		} else {
			blankRun = 0;
			out.push(line);
		}
	}
	return out.join("\n");
}
