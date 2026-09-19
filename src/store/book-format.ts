import type {
	BookDocument,
	Card,
	CardLink,
	DocumentBookmark,
	DocRect,
	ExcerptType,
	NormPoint,
	ReviewState,
	SrsPhase,
} from "../types";
import { isLineStyle } from "../types";
import { newId } from "../utils";

/**
 * 书文件 / 脑图文件的 Markdown 序列化纯函数层（㉚）。
 *
 * 设计要点：
 * - **双层数据**：可读层（callout 正文承载 excerptText / note / tags 与媒体嵌入——
 *   用户可直接编辑）+ 机器层（`<!--mm JSON-->` HTML 注释承载 id / 几何 / 复习状态 /
 *   链接——插件权威）。解析以机器注释为锚，可读层按规则提取。
 * - **序列化确定性**：字段顺序固定、卡片按 (page null-last, createdAt, id) 排序、
 *   JSON.stringify 紧凑无空格——同数据两次序列化字节相同（往返可断言）。
 * - **容错**：单条注释 JSON 损坏只跳过该条并记 warning，不拖垮整文件；
 *   未知 frontmatter 字段原样保留往返（用户在 Obsidian 加的 aliases/tags 不丢）。
 * - 本模块零 obsidian 依赖，vitest 直测。
 */

/** Markdown 存储格式版本（替代 SQL SCHEMA_VERSION 语义，供日志与备份 manifest） */
export const MD_FORMAT_VERSION = 1;

/** 卡片 callout 标记（全部形态统一；形态在机器层 type 字段） */
export const CALLOUT_MARKER = "[!excerpt]";
/** 卡片机器注释前缀 */
export const MM_COMMENT_PREFIX = "<!--mm ";
/** 书签机器注释前缀 */
export const MM_BM_COMMENT_PREFIX = "<!--mm-bm ";
/** 卡片批注行前缀（可读层提取规则之一） */
const NOTE_PREFIX = "**批注**：";
/** 未分组页（page=null 卡片，含书籍分组卡）节标题 */
export const UNGROUPED_HEADING = "## 未分组";
/** 书签节标题 */
export const BOOKMARKS_HEADING = "## 📑 书签";
/** 书籍子目录（数据根相对，123 布局 v2：书 md 与 未归类卡片.md 归此目录） */
export const BOOKS_SUBDIR = "books";
/** 脑图子目录（数据根相对，123 英文化；原中文目录「脑图」由 layout-migrate 启动迁移） */
export const MINDMAPS_SUBDIR = "mindmaps";
/** 旧版中文脑图子目录（仅 layout-migrate 迁移源读取；loadAll 不再扫描） */
export const LEGACY_MINDMAPS_SUBDIR = "脑图";
/** 孤儿卡片（documentId=null）兜底文件名 */
export const ORPHAN_BOOK_FILENAME = "未归类卡片.md";
/** 孤儿卡片文件完整路径（books/ 下；迁移中断残留根层副本时孤儿状态跟随实际位置） */
export const ORPHAN_BOOK_PATH = `${BOOKS_SUBDIR}/${ORPHAN_BOOK_FILENAME}`;

/** 七种摘录形态（与 cards 表 CHECK 约束一致） */
const EXCERPT_TYPES = new Set<string>([
	"text",
	"area",
	"lasso",
	"blank",
	"handwriting",
	"audio",
	"photo",
]);

/** 合法复习阶段（SrsPhase 字面量） */
const SRS_PHASES = new Set<string>(["new", "learning", "review", "relearning"]);

/** 书文件 frontmatter 的已知字段（其余 key:value 行原样保留往返，用户加的 aliases 不丢） */
const KNOWN_BOOK_FM_KEYS = new Set([
	"marinmind",
	"id",
	"title",
	"author",
	"category",
	"collect_map_id",
	"auto_flashcard",
	"last_page",
	"file_path",
	"created_at",
	"updated_at",
]);

// ---------------------------------------------------------------------------
// 卡片级辅助
// ---------------------------------------------------------------------------

/** 建卡时的默认复习状态（对齐旧 card-repo create：new、未启用闪卡、due=创建时刻） */
export function defaultReviewState(cardId: string, ts: number): ReviewState {
	return {
		cardId,
		isFlashcard: false,
		phase: "new",
		ease: 2.5,
		intervalDays: 0,
		repetitions: 0,
		dueAt: ts,
		lastReviewedAt: null,
		lapses: 0,
	};
}

/** 链接持有方：双侧 id 较小者（一条链接全局只存一份，挂在持有方的机器注释里） */
export function linkOwnerId(a: string, b: string): string {
	return a < b ? a : b;
}

/** 链接 id：双侧 id 排序拼接（规范化派生，方向无关——neighbors 本就双向） */
export function linkId(a: string, b: string): string {
	return a < b ? `${a}|${b}` : `${b}|${a}`;
}

/** 生成卡片的媒体嵌入行（photo/handwriting/audio/区域快照通用；解析时跳过同款行） */
function embedLine(ref: string): string {
	return `![](${ref})`;
}

/** 整行是否全部是 #tag 词元（避免误吞 "#1 排名" 这类正文行） */
function isTagLine(line: string): boolean {
	return /^(#[^\s#]+)(\s+#[^\s#]+)*\s*$/.test(line);
}

/** 从整行 tag 行提取词元（去 # 前缀） */
function parseTagLine(line: string): string[] {
	return line
		.trim()
		.split(/\s+/)
		.map((t) => t.replace(/^#/, ""));
}

/** 文件名净化：替换 Obsidian 非法与 wikilink 保留字符，折叠空白，限长 */
export function sanitizeFileName(name: string): string {
	const cleaned = name
		.replace(/[\\/:*?"<>|#^[\]]/g, " ")
		.replace(/\s+/g, " ")
		.trim()
		.slice(0, 100);
	return cleaned || "未命名";
}

/** YAML 值加引号（含 ": " 或首尾空白等危险形态时） */
function yamlQuote(v: string): string {
	if (/[:#[\]{}&*!|>'"%@`]/.test(v) || /^\s|\s$/.test(v) || v === "") {
		return JSON.stringify(v);
	}
	return v;
}

/** YAML 值去引号（与 yamlQuote 对偶；非引号形态原样返回） */
function yamlUnquote(v: string): string {
	if (v.startsWith('"') && v.endsWith('"')) {
		try {
			const parsed = JSON.parse(v);
			return typeof parsed === "string" ? parsed : v;
		} catch {
			return v;
		}
	}
	return v;
}

// ---------------------------------------------------------------------------
// 机器层 JSON 形态（字段顺序即序列化顺序）
// ---------------------------------------------------------------------------

/** 复习状态在机器注释里的紧凑形态 */
interface ReviewJson {
	flash: boolean;
	phase: SrsPhase;
	ease: number;
	iv: number;
	reps: number;
	due: number;
	last: number | null;
	lapses: number;
}

function reviewToJson(r: ReviewState): ReviewJson {
	return {
		flash: r.isFlashcard,
		phase: r.phase,
		ease: r.ease,
		iv: r.intervalDays,
		reps: r.repetitions,
		due: r.dueAt,
		last: r.lastReviewedAt,
		lapses: r.lapses,
	};
}

function reviewFromJson(cardId: string, raw: unknown, fallback: ReviewState): ReviewState {
	if (typeof raw !== "object" || raw === null) {
		return fallback;
	}
	const o = raw as Record<string, unknown>;
	const phase = typeof o.phase === "string" && SRS_PHASES.has(o.phase) ? o.phase : fallback.phase;
	return {
		cardId,
		isFlashcard: o.flash === true,
		phase: phase as SrsPhase,
		ease: typeof o.ease === "number" ? o.ease : fallback.ease,
		intervalDays: typeof o.iv === "number" ? o.iv : fallback.intervalDays,
		repetitions: typeof o.reps === "number" ? o.reps : fallback.repetitions,
		dueAt: typeof o.due === "number" ? o.due : fallback.dueAt,
		lastReviewedAt: typeof o.last === "number" ? o.last : null,
		lapses: typeof o.lapses === "number" ? o.lapses : fallback.lapses,
	};
}

// ---------------------------------------------------------------------------
// 解析：书文件
// ---------------------------------------------------------------------------

/** parseBookMd 的返回 */
export interface ParsedBookFile {
	/** 是否为 MarinMind 书文件（frontmatter `marinmind: book`）——扫描目录时用于认领 */
	claimed: boolean;
	doc: BookDocument;
	cards: Card[];
	/** 与 cards 一一对应的复习状态 */
	reviews: ReviewState[];
	bookmarks: DocumentBookmark[];
	/** 本文件卡片作为持有方的链接（链接只存于较小 id 一侧的卡） */
	links: CardLink[];
	/** 未知 frontmatter 行（原样保留，序列化时回写） */
	extraFrontmatter: string[];
	warnings: string[];
}

/** parseBookMd 可选入参 */
export interface ParseBookOptions {
	/** 所在文件名（缺 title 时兜底取名） */
	fileName?: string;
}

/**
 * 解析一个书文件。以 `<!--mm …-->` 机器注释为锚定位卡片，
 * 可读层正文按提取规则还原 excerptText / note / tags；单条损坏跳过记 warning。
 */
export function parseBookMd(text: string, opts: ParseBookOptions = {}): ParsedBookFile {
	const warnings: string[] = [];
	const lines = text.split(/\r?\n/);

	// --- frontmatter ---
	const fm = new Map<string, string>();
	const extraFrontmatter: string[] = [];
	let bodyStart = 0;
	if (lines[0]?.trim() === "---") {
		const end = lines.findIndex((l, idx) => idx > 0 && l.trim() === "---");
		if (end < 0) {
			warnings.push("frontmatter 未闭合，按无 frontmatter 解析");
			bodyStart = 1;
		} else {
			for (let j = 1; j < end; j++) {
				const m = /^([A-Za-z0-9_]+):\s?(.*)$/.exec(lines[j]);
				if (m && KNOWN_BOOK_FM_KEYS.has(m[1])) fm.set(m[1], m[2]);
				else extraFrontmatter.push(lines[j]); // 未知字段/非常规行原样保留
			}
			bodyStart = end + 1;
		}
	}

	const docId = fm.get("id")?.trim() || "";
	if (!docId) warnings.push("frontmatter 缺 id（已自动生成，下次写入修复）");

	const title =
		yamlUnquote(fm.get("title") ?? "") || opts.fileName?.replace(/\.md$/, "") || "未命名";
	const doc: BookDocument = {
		id: docId || newId(),
		filePath: yamlUnquote(fm.get("file_path") ?? ""),
		title,
		// 作者（163）：mobi EXTH 100 / epub dc:creator；缺行/空值 = 无作者（可选字段）
		author: yamlUnquote(fm.get("author") ?? "").trim() || null,
		// 分类缺失与空值都归未分类（frontmatter 只支持单行标量，yamlQuote 兜危险字符）
		category: yamlUnquote(fm.get("category") ?? "").trim() || null,
		// 摘录目标图覆盖（㊴）：缺行/空值 = 用同名默认图
		collectMapId: yamlUnquote(fm.get("collect_map_id") ?? "").trim() || null,
		// 按书自动转闪卡（㊷）：缺行/false = 关，仅字面 true 开启
		autoFlashcard: fm.get("auto_flashcard") === "true",
		// 上次阅读页码（80）：缺行/0/负数/非数字（NaN 比较为 false）归 null——
		// 页 1 也在写侧归一为 null 不落行，此处读侧同样容错
		lastPage: (() => {
			const lp = Number(fm.get("last_page"));
			return lp > 1 ? Math.floor(lp) : null;
		})(),
		createdAt: Number(fm.get("created_at")) || 0,
		updatedAt: Number(fm.get("updated_at")) || 0,
	};

	// 类型不符（如误把脑图文件当书解析）按空书返回——由 warnings 说明
	const kind = fm.get("marinmind");
	if (kind !== undefined && kind !== "book") {
		warnings.push(`marinmind frontmatter 应为 book，实际为 ${kind}，按空书解析`);
		return {
			claimed: false,
			doc,
			cards: [],
			reviews: [],
			bookmarks: [],
			links: [],
			extraFrontmatter,
			warnings,
		};
	}

	// --- 正文：页节游走 ---
	const cards: Card[] = [];
	const reviews: ReviewState[] = [];
	const links: CardLink[] = [];
	const bookmarks: DocumentBookmark[] = [];

	/** undefined = 尚未遇到任何页节（按未分组处理） */
	let page: number | null | undefined = undefined;
	let inBookmarks = false;

	for (let j = bodyStart; j < lines.length; j++) {
		const line = lines[j];

		const pageMatch = /^## 第 (\d+) 页\s*$/.exec(line);
		if (pageMatch) {
			page = Number(pageMatch[1]);
			inBookmarks = false;
			continue;
		}
		if (line.trim() === UNGROUPED_HEADING) {
			page = null;
			inBookmarks = false;
			continue;
		}
		if (line.trim() === BOOKMARKS_HEADING) {
			inBookmarks = true;
			continue;
		}

		if (line.startsWith(MM_BM_COMMENT_PREFIX) && line.endsWith("-->")) {
			parseBookmarkLine(lines, j, doc.id, bookmarks, warnings);
			continue;
		}

		if (line.startsWith(MM_COMMENT_PREFIX) && line.endsWith("-->")) {
			if (inBookmarks) {
				warnings.push(`第 ${j + 1} 行：书签节内出现卡片注释，已忽略`);
				continue;
			}
			parseCardComment(
				lines,
				j,
				page ?? null,
				doc.id,
				title,
				cards,
				reviews,
				links,
				warnings,
			);
		}
	}

	return {
		claimed: kind === "book",
		doc,
		cards,
		reviews,
		bookmarks,
		links,
		extraFrontmatter,
		warnings,
	};
}

/** 解析一条卡片机器注释（lines[j] 即注释行；向上收集 block id 行与 callout 正文。
 *  docTitle（81）用于存量书名分组卡的推导识别） */
function parseCardComment(
	lines: string[],
	j: number,
	page: number | null,
	docId: string,
	docTitle: string,
	cards: Card[],
	reviews: ReviewState[],
	links: CardLink[],
	warnings: string[],
): void {
	const where = `第 ${j + 1} 行`;
	let json: Record<string, unknown>;
	try {
		json = JSON.parse(lines[j].slice(MM_COMMENT_PREFIX.length, -3)) as Record<string, unknown>;
	} catch {
		warnings.push(`${where}：卡片机器注释 JSON 损坏，已跳过`);
		return;
	}
	const id = typeof json.id === "string" ? json.id : "";
	const type = typeof json.type === "string" ? json.type : "";
	if (!id || !EXCERPT_TYPES.has(type)) {
		warnings.push(`${where}：机器注释缺 id 或摘录形态非法，已跳过`);
		return;
	}

	// 向上找 block id 行（紧邻注释行；缺失仅警告——block id 可再生）
	let calloutEnd = j - 1;
	if (calloutEnd >= 0 && lines[calloutEnd] === `^card-${id}`) {
		calloutEnd -= 1;
	} else if (calloutEnd >= 0 && lines[calloutEnd].startsWith("^card-")) {
		warnings.push(`${where}：block id 与机器注释 id 不一致，以机器注释为准`);
		calloutEnd -= 1;
	} else {
		warnings.push(`${where}：缺 ^card-<id> 块锚点行（下次写入自动补齐）`);
	}

	// 向上收集连续 callout 行（以 > 起头的行）
	const bodyLines: string[] = [];
	for (let k = calloutEnd; k >= 0 && lines[k].startsWith(">"); k--) {
		bodyLines.unshift(lines[k].replace(/^> ?/, ""));
	}
	if (bodyLines.length === 0 || bodyLines[0].trim() !== CALLOUT_MARKER) {
		warnings.push(`${where}：卡片 ${id} 缺 callout 正文（可读层数据丢失，仅恢复机器层）`);
		bodyLines.length = 0;
	} else {
		bodyLines.shift(); // 去掉 [!excerpt] 标记行
	}

	const ref = typeof json.ref === "string" ? json.ref : null;
	const createdAt = typeof json.created === "number" ? json.created : 0;
	const updatedAt = typeof json.updated === "number" ? json.updated : createdAt;

	// 可读层提取：嵌入行跳过 → 批注行（含续行）→ tag 行 → 其余为摘录文本。
	// 序列化顺序为 文本 → 批注 → tag，故 tag 检查在批注续行之前（批注后的 tag 行仍是 tag）
	const textLines: string[] = [];
	let noteLines: string[] | null = null;
	const tags: string[] = [];
	for (const raw of bodyLines) {
		if (ref && raw === embedLine(ref)) continue;
		if (raw.startsWith(NOTE_PREFIX)) {
			if (noteLines === null) noteLines = [raw.slice(NOTE_PREFIX.length)];
			else noteLines.push(raw); // 批注续行里的字面 marker 原样保留（往返无损）
			continue;
		}
		if (isTagLine(raw)) {
			tags.push(...parseTagLine(raw));
			continue;
		}
		if (noteLines !== null) {
			noteLines.push(raw); // 批注续行（批注可多行）
			continue;
		}
		textLines.push(raw);
	}
	const joined = textLines.length ? textLines.join("\n") : null;

	const card: Card = {
		id,
		documentId: docId,
		page,
		rects: Array.isArray(json.rects) ? (json.rects as DocRect[]) : [],
		polygon: Array.isArray(json.polygon) ? (json.polygon as NormPoint[]) : null,
		excerptType: type as ExcerptType,
		excerptText: joined === "" ? null : joined,
		excerptRef: ref,
		note: noteLines !== null ? noteLines.join("\n") : null,
		// color 原样透传（138 修复：㊹ 曾误判"blue 视觉一直是黄"而读取归一
		// blue→yellow，实际 blue 自文字摘录闭环（4ec3958）起就是蓝色视觉——归一导致
		// 存量蓝卡与㊹ 后新建蓝卡重开即变黄，已移除；㊹~138 间被实质变更顺带
		// 重写为 yellow 的存量卡不自动恢复，需手动改色）
		color: typeof json.color === "string" ? json.color : null,
		// 文字摘录线型（77）：损坏/缺失/手写 underline 均归一 null（与序列化省键首尾一致）
		lineStyle:
			typeof json.line === "string" && isLineStyle(json.line) && json.line !== "underline"
				? json.line
				: null,
		// 卡片标题（㊺）：脑图节点标题栏；损坏/缺失按无标题处理
		title: typeof json.title === "string" ? json.title : null,
		// 卡组名：损坏/缺失按未分组处理，不拖垮整卡
		deck: typeof json.deck === "string" ? json.deck : null,
		// 语音时长秒（84-B）：损坏/缺失/非正数不落字段（undefined = 未知），不拖垮整卡
		...(typeof json.dur === "number" && Number.isFinite(json.dur) && json.dur > 0
			? { durationSec: json.dur }
			: {}),
		// 闪卡遮挡区域（㊷）：损坏/缺失按无遮挡处理，不拖垮整卡
		occlusions: Array.isArray(json.occ) ? (json.occ as DocRect[]) : [],
		// 目录章节骨架卡（55）：严格 true 判定；缺省/损坏不落键（与序列化
		// 同构——普通卡 Card 上无 outline 字段，零写入契约首尾一致）
		...(json.outline === true ? { outline: true } : {}),
		// 书名分组卡（81）：显式标记 or 存量推导——同书 page null 的 text 卡
		// 且文本恰为《书名》（书文件内 page null 的 text 卡只有组卡与 EPUB
		// 摘录两种，后者文本恰为书名括注视同组卡）。推导只在内存不标脏，
		// 该卡下次自然写入时才落 group 键（零写入契约：读取不触发落盘）
		...(json.group === true ||
		(page === null && type === "text" && joined === `《${docTitle}》`)
			? { group: true }
			: {}),
		tags,
		createdAt,
		updatedAt,
	};
	cards.push(card);
	reviews.push(reviewFromJson(id, json.review, defaultReviewState(id, createdAt)));

	// 链接重建：links 存 {to, at}，规范化为双向等价链接
	if (Array.isArray(json.links)) {
		for (const entry of json.links) {
			if (typeof entry !== "object" || entry === null) continue;
			const e = entry as Record<string, unknown>;
			if (typeof e.to !== "string") continue;
			links.push({
				id: linkId(id, e.to),
				sourceId: id < e.to ? id : e.to,
				targetId: id < e.to ? e.to : id,
				createdAt: typeof e.at === "number" ? e.at : createdAt,
			});
		}
	}
}

/** 解析一条书签机器注释（label 取上方最近的列表行，剥离生成的页码后缀） */
function parseBookmarkLine(
	lines: string[],
	j: number,
	docId: string,
	bookmarks: DocumentBookmark[],
	warnings: string[],
): void {
	const where = `第 ${j + 1} 行`;
	let json: Record<string, unknown>;
	try {
		json = JSON.parse(lines[j].slice(MM_BM_COMMENT_PREFIX.length, -3)) as Record<
			string,
			unknown
		>;
	} catch {
		warnings.push(`${where}：书签机器注释 JSON 损坏，已跳过`);
		return;
	}
	const id = typeof json.id === "string" ? json.id : "";
	const page = typeof json.page === "number" ? json.page : -1;
	if (!id || page < 0) {
		warnings.push(`${where}：书签注释缺 id 或页码，已跳过`);
		return;
	}
	// label 取上方最近列表行（紧邻；缺失用默认名）
	let label = `第 ${page} 页`;
	for (let k = j - 1; k >= 0; k--) {
		const m = /^- (.+)$/.exec(lines[k]);
		if (m) {
			label = m[1];
			// 剥离与注释页码一致的生成后缀；用户改过就整行作 label
			const suffix = new RegExp(`（第 ${page} 页）\\s*$`);
			if (suffix.test(label)) label = label.replace(suffix, "");
			break;
		}
		if (lines[k].trim() === "") continue;
		break; // 上方不是列表行（也不是空行）——用默认名
	}
	bookmarks.push({
		id,
		documentId: docId,
		page,
		label,
		createdAt: typeof json.created === "number" ? json.created : 0,
	});
}

// ---------------------------------------------------------------------------
// 序列化：书文件
// ---------------------------------------------------------------------------

/** serializeBookMd 的输入 */
export interface SerializeBookInput {
	doc: BookDocument;
	cards: Card[];
	/** cardId → 复习状态（缺省按默认状态写） */
	reviews: Map<string, ReviewState>;
	bookmarks: DocumentBookmark[];
	/** 全局链接列表（函数内部只序列化持有方在本次 cards 集内的） */
	links: CardLink[];
	/** 未知 frontmatter 行原样回写 */
	extraFrontmatter?: string[];
}

/** 序列化书文件（确定性输出：同输入两次序列化字节相同） */
export function serializeBookMd(input: SerializeBookInput): string {
	const { doc, cards, reviews, bookmarks, links } = input;
	const out: string[] = [];

	// frontmatter（已知字段顺序固定，未知字段原样续后）
	out.push("---");
	out.push("marinmind: book");
	out.push(`id: ${doc.id}`);
	out.push(`title: ${yamlQuote(doc.title)}`);
	// 作者（163）：null/缺省省略整行，存量书文件字节不变（零写入契约）
	if (doc.author) out.push(`author: ${yamlQuote(doc.author)}`);
	// 分类为 null 时省略整行——存量库（无分类）序列化字节不变，零写入契约不被破坏
	if (doc.category) out.push(`category: ${yamlQuote(doc.category)}`);
	// 摘录目标图覆盖同款省略策略（㊴）：null 不落行，存量库字节不变
	if (doc.collectMapId) out.push(`collect_map_id: ${yamlQuote(doc.collectMapId)}`);
	// 按书自动转闪卡（㊷）：false 省略整行，存量库字节不变
	if (doc.autoFlashcard) out.push("auto_flashcard: true");
	// 上次阅读页码（80）：null（含页 1 归一）省略整行，未翻页的书字节不变；
	// 写侧保证 lastPage 非 null 时必 >1，无需再次钳制
	if (doc.lastPage) out.push(`last_page: ${doc.lastPage}`);
	if (doc.filePath) out.push(`file_path: ${yamlQuote(doc.filePath)}`);
	out.push(`created_at: ${doc.createdAt}`);
	out.push(`updated_at: ${doc.updatedAt}`);
	for (const line of input.extraFrontmatter ?? []) out.push(line);
	out.push("---");

	// 按页分节（数值升序 → 未分组殿后）；空节不发
	const byPage = new Map<number | null, Card[]>();
	for (const card of cards) {
		const key = card.page ?? null;
		const bucket = byPage.get(key);
		if (bucket) bucket.push(card);
		else byPage.set(key, [card]);
	}
	const pageKeys = [...byPage.keys()].sort((a, b) => {
		if (a === null) return b === null ? 0 : 1;
		if (b === null) return -1;
		return a - b;
	});

	for (const key of pageKeys) {
		const group = (byPage.get(key) ?? []).sort((a, b) =>
			a.createdAt === b.createdAt ? (a.id < b.id ? -1 : 1) : a.createdAt - b.createdAt,
		);
		out.push("");
		out.push(key === null ? UNGROUPED_HEADING : `## 第 ${key} 页`);
		for (const card of group) {
			out.push("");
			serializeCard(out, card, reviews, links);
		}
	}

	// 书签节
	if (bookmarks.length > 0) {
		out.push("");
		out.push(BOOKMARKS_HEADING);
		const sorted = [...bookmarks].sort((a, b) =>
			a.page !== b.page
				? a.page - b.page
				: a.createdAt !== b.createdAt
					? a.createdAt - b.createdAt
					: a.id < b.id
						? -1
						: 1,
		);
		for (const bm of sorted) {
			out.push("");
			// 默认名（“第 N 页”）不重复追加页码后缀
			const item =
				bm.label === `第 ${bm.page} 页` ? bm.label : `${bm.label}（第 ${bm.page} 页）`;
			out.push(`- ${item}`);
			out.push(
				`${MM_BM_COMMENT_PREFIX}${JSON.stringify({
					id: bm.id,
					page: bm.page,
					created: bm.createdAt,
				})} -->`,
			);
		}
	}

	out.push("");
	return out.join("\n");
}

/** 序列化单张卡片：callout 正文 + block id 行 + 机器注释行 */
function serializeCard(
	out: string[],
	card: Card,
	reviews: Map<string, ReviewState>,
	links: CardLink[],
): void {
	// 可读层
	out.push(`> ${CALLOUT_MARKER}`);
	if (card.excerptRef) out.push(`> ${embedLine(card.excerptRef)}`);
	if (card.excerptText) {
		for (const line of card.excerptText.split("\n")) out.push(`> ${line}`);
	}
	if (card.note !== null) {
		const noteLines = card.note.split("\n");
		out.push(`> ${NOTE_PREFIX}${noteLines[0]}`);
		for (let i = 1; i < noteLines.length; i++) out.push(`> ${noteLines[i]}`);
	}
	if (card.tags.length > 0) {
		out.push(`> ${card.tags.map((t) => `#${t}`).join(" ")}`);
	}
	out.push(`^card-${card.id}`);

	// 机器层（字段顺序固定）
	const machine: Record<string, unknown> = { id: card.id, type: card.excerptType };
	if (card.rects.length > 0) machine.rects = card.rects;
	if (card.polygon) machine.polygon = card.polygon;
	if (card.excerptRef) machine.ref = card.excerptRef;
	// 语音时长秒（84-B）：仅合法数值落键（键序 ref 后，媒体语义相邻）；缺省省略——
	// 存量卡字节不变（零写入契约，镜像 title 模式）
	if (
		typeof card.durationSec === "number" &&
		Number.isFinite(card.durationSec) &&
		card.durationSec > 0
	) {
		machine.dur = card.durationSec;
	}
	if (card.color) machine.color = card.color;
	// 卡片标题（㊺）：null 省略键，存量卡字节不变（零写入契约）
	if (card.title) machine.title = card.title;
	// 卡组名：null 省略键，存量卡字节不变（零写入契约；键序在 title 之后）
	if (card.deck) machine.deck = card.deck;
	// 文字摘录线型（77）：squiggle/strikethrough 才落键（null/underline 省略），
	// 存量卡与下划线卡字节不变（零写入契约；键序 deck 后 occ 前）
	if (card.lineStyle && card.lineStyle !== "underline") machine.line = card.lineStyle;
	// 闪卡遮挡（㊷）：空数组省略键，存量卡字节不变
	if (card.occlusions.length > 0) machine.occ = card.occlusions;
	// 目录章节骨架卡（55）：仅 true 写键，存量卡字节不变（零写入契约）
	if (card.outline) machine.outline = true;
	// 书名分组卡（81）：仅 true 写键（存量未标记卡读取时已推导，自然写入补齐）
	if (card.group) machine.group = true;
	machine.created = card.createdAt;
	machine.updated = card.updatedAt;
	const review = reviews.get(card.id) ?? defaultReviewState(card.id, card.createdAt);
	machine.review = reviewToJson(review);
	// 链接只存持有方（双侧 id 较小者）；另一端可能在别的书文件——从持有方一侧即可重建
	const owned = links.filter((l) => linkOwnerId(l.sourceId, l.targetId) === card.id);
	if (owned.length > 0) {
		machine.links = owned.map((l) => ({
			to: l.sourceId === card.id ? l.targetId : l.sourceId,
			at: l.createdAt,
		}));
	}
	out.push(`${MM_COMMENT_PREFIX}${JSON.stringify(machine)} -->`);
}
