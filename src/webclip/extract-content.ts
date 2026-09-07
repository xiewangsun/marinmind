/**
 * 网页正文提取（113-A readability-lite 自研；115 修复四缺陷）：
 * 1. 剥噪声（script/style/nav/aside/footer 等整块移除；115 追加隐藏 UI——
 *    modal/dialog/popup/dropdown/drawer/hidden/aria-hidden，gitee 案例的服务端
 *    HTML 带整排隐藏弹窗模板文本，不剥会全数混入产物）；
 * 2. 候选池 = 语义标签（article/main/[role=main]/[itemprop=articleBody]）+
 *    div/section/td + body。115 起语义候选**不再首个达标即早退**——与全量候选
 *    同台评分（多 article 站点的侧栏推荐卡/评论卡不再抢跑，正文大 article 必胜）；
 * 3. 评分 = 文本量（封顶防长页独裁）+ 段落数 + 类名正向关键词 - **负向关键词强扣**
 *    （115 新增：sidebar/side-/comment/recommend 等；负向优先于正向——
 *    side-content 判负，不再被子串命中误加分）- 链接密度惩罚 + 文本密度小额加分；
 * 4. 115 质量门槛：按分降序依次取首个「成段正文足量」（p/blockquote/pre 文本
 *    ≥ 120 字）的候选；全不过返回 null——正文缺失的整页壳（面板/弹窗农场，
 *    gitee 形态）诚实报错而非落盘 14K 垃圾。
 * 正文文本 < 80 字符视为 SPA 空壳同样返回 null（上层转中文 Notice，不写半截文件）。
 *
 * DOMParser 只在函数体内使用（模块顶层零 DOM 引用，Node 环境 import 安全；
 * 运行时先例 epub-session.ts:446 容错解析；测试 jsdom 环境直跑同一实现）。
 */

/** 正文最短文本量（规范化空白后字符数）：低于此值按 SPA/空页处理 */
const MIN_CONTENT_LENGTH = 80;

/** 成段正文门槛（115）：p/blockquote/pre 文本合计低于此值的候选视为「壳容器」 */
const MIN_PARAGRAPH_TEXT = 120;

/** 整块剥离的噪声标签（script/style 类不可见元素 + 导航/页脚类结构噪声） */
const STRIP_SELECTORS = [
	"script",
	"style",
	"noscript",
	"iframe",
	"svg",
	"canvas",
	"template",
	"link",
	"meta",
	"button",
	"form",
	"input",
	"select",
	"textarea",
	"nav",
	"aside",
	"footer",
	// 115 隐藏 UI 剥离（gitee 案例整排隐藏弹窗/下拉模板）
	'[class*="modal"]',
	'[class*="dialog"]',
	'[class*="popup"]',
	'[class*="dropdown"]',
	'[class*="drawer"]',
	"[hidden]",
	'[aria-hidden="true"]',
];

/** 语义化正文容器（115 起作为候选池加分项参与统一评分，不再早退） */
const SEMANTIC_SELECTORS = ["article", "main", '[role="main"]', '[itemprop="articleBody"]'];

/** 语义命中加分（115）：大于负向扣分——语义正文容器即使类名带噪声词也胜出 */
const SEMANTIC_BONUS = 2600;

/** 负向关键词扣分（115）：足以压掉正向加分（400）与段落差 */
const NEGATIVE_PENALTY = 1500;

/** 类名/ID 关键词命中加分（readability 的 REGEXPS 类） */
const POSITIVE_PATTERN = /article|content|post|entry|main|blog|story|text|body/i;

/** 负向关键词（115）：子串匹配，词形带边界防护（share[-_] 不误伤 shareholders、toc[-_] 不误伤 stock） */
const NEGATIVE_PATTERN =
	/sidebar|side[-_]|menu|comment|related|recommend|promo|advert|banner|share[-_]|breadcrumb|toc[-_]|pagination|widget|rank|copyright|subscribe|newsletter/i;

/** 块级元素标签集（文本密度统计用：块级子元素越多版面越碎） */
const BLOCK_TAGS = new Set([
	"DIV",
	"SECTION",
	"ARTICLE",
	"MAIN",
	"P",
	"UL",
	"OL",
	"LI",
	"BLOCKQUOTE",
	"PRE",
	"TABLE",
	"H1",
	"H2",
	"H3",
	"H4",
	"H5",
	"H6",
	"FIGURE",
	"HEADER",
	"ASIDE",
	"NAV",
	"FOOTER",
]);

/** 提取结果：title 为页面 <title>（可空，engine 层负责回退），root 为正文根元素 */
export interface ExtractedArticle {
	title: string;
	root: Element;
}

/** 规范化文本（折叠空白）与长度 */
function textOf(el: Element): string {
	return (el.textContent ?? "").replace(/\s+/g, " ").trim();
}

/** 链接文本占比（>0.5 视为导航壳）：readability 经典启发式 */
function linkDensity(el: Element): number {
	const total = textOf(el).length;
	if (total === 0) {
		return 1;
	}
	let linkLen = 0;
	for (const a of Array.from(el.querySelectorAll("a"))) {
		linkLen += textOf(a).length;
	}
	return linkLen / total;
}

/** 成段正文文本量（115 质量门槛主信号）：壳容器的文本散落在 div/span/链接里，正文成段 */
function paragraphTextLen(el: Element): number {
	let total = 0;
	for (const node of Array.from(el.querySelectorAll("p, blockquote, pre"))) {
		total += textOf(node).length;
	}
	return total;
}

/** 候选评分：文本量（封顶防长页独裁）+ 段落数 + 类名关键词 + 语义加分 - 负向强扣 - 链接密度惩罚 */
function scoreCandidate(el: Element): number {
	const textLen = textOf(el).length;
	if (textLen < MIN_CONTENT_LENGTH) {
		return -1;
	}
	const density = linkDensity(el);
	// 链接占比过半直接出局（导航/目录壳），否则按占比线性惩罚
	if (density > 0.5) {
		return -1;
	}
	const hints = [el.className, el.id]
		.filter((v): v is string => typeof v === "string" && v.length > 0)
		.join(" ");
	const keywordBonus = POSITIVE_PATTERN.test(hints) ? 400 : 0;
	// 115 负向优先于正向（side-content 判负）
	const negativePenalty = NEGATIVE_PATTERN.test(hints) ? NEGATIVE_PENALTY : 0;
	// 115 语义候选并入评分竞争（多 article 同台，正文大者胜）
	const semanticBonus = SEMANTIC_SELECTORS.some((sel) => el.matches(sel)) ? SEMANTIC_BONUS : 0;
	const paraCount = el.querySelectorAll("p").length;
	// 文本密度（文本量/块级子元素数）小额加分：同文本量下版面更整的容器更可能是正文
	return (
		Math.min(textLen, 12000) +
		paraCount * 60 +
		keywordBonus +
		semanticBonus -
		negativePenalty -
		density * 600 +
		Math.min(textDensity(el), 300) * 4
	);
}

/** 元素直系块级子元素数（+1 防除零）：文本密度评分的分母（正文容器通常
 * 块数少而文本厚，导航壳反之） */
function blockChildCount(el: Element): number {
	let count = 0;
	for (const child of Array.from(el.children)) {
		if (BLOCK_TAGS.has(child.tagName)) {
			count++;
		}
	}
	return count;
}

/**
 * 提取网页正文根元素与页面标题。
 * @param html 完整 HTML 文本（charset 已由 html-charset 解码）
 * @returns 正文过短或无成段正文（SPA 空壳/整页壳，115）返回 null
 */
export function extractArticle(html: string): ExtractedArticle | null {
	const doc = new DOMParser().parseFromString(html, "text/html");
	const title = (doc.title ?? "").trim();
	// 1. 剥噪声（根级整块移除，正文候选不被导航/推荐位/隐藏弹窗污染）
	for (const sel of STRIP_SELECTORS) {
		for (const el of Array.from(doc.querySelectorAll(sel))) {
			el.remove();
		}
	}
	// 2. 候选池：语义标签 + div/section/td（Set 去重——语义元素也在 div 池里
	//    重复出现）。body **不入池**：其段落数/文本量全页累计必然虚高反超真容器，
	//    改作第 5 步终极兜底（老式手写页段落直接挂 body 时才有意义）
	const pool = new Set<Element>();
	for (const sel of SEMANTIC_SELECTORS) {
		for (const el of Array.from(doc.querySelectorAll(sel))) {
			pool.add(el);
		}
	}
	for (const el of Array.from(doc.querySelectorAll("div, section, td"))) {
		pool.add(el);
	}
	// 3. 评分降序
	const ranked = Array.from(pool)
		.map((el) => ({ el, score: scoreCandidate(el) }))
		.filter((entry) => entry.score > 0)
		.sort((a, b) => b.score - a.score);
	// 4. 质量门槛（115）：依次取首个成段正文足量者；全不过 = 壳页/脚本渲染页
	for (const { el } of ranked) {
		if (paragraphTextLen(el) >= MIN_PARAGRAPH_TEXT) {
			return { title, root: el };
		}
	}
	// 5. 终极兜底：无单一好容器但成段正文直接挂 body（老式手写页）→ body；
	//    仍无则 null（壳页诚实失败，不落半截垃圾）
	const body = doc.body;
	if (body && paragraphTextLen(body) >= MIN_PARAGRAPH_TEXT && linkDensity(body) <= 0.5) {
		return { title, root: body };
	}
	return null;
}

/** 文本密度指标（文本量 /（块级子元素数 + 1））：正文容器块少文厚、导航壳反之 */
export function textDensity(el: Element): number {
	return textOf(el).length / (blockChildCount(el) + 1);
}
