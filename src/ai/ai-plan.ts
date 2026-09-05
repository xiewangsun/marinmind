import type { ChatMessage } from "./ai-provider";
import { parseJsonLoose } from "./ai-json";

/**
 * AI 脑图整理 + AI 大纲（100 P4，纯函数层）：prompt 构造 + 结构化输出解析。
 * 两条共用「LLM 只见下标/受控字段，回来经校验回映射」的既有防线：
 * - 整理：候选节点下标化 → JSON [{name, indices}] → 回映射真实 nodeId
 *   （越界丢弃、跨组重复以首组为准）；分组卡是全新节点（结构上不可能成环，
 *   wouldCycle 仍作防御层）。
 * - 大纲：嵌套树 JSON [{title, page, children}]，page 必须命中上下文标记页
 *   集合（硬校验防幻觉页码——编造页码降级为 null 走既有「损坏条目跳过重挂」
 *   路径），产物与 pdf-outline 的 OutlineEntry 同构，直接喂
 *   planOutlineChapters 复用「目录建框架」执行语义。
 */

// ===== AI 脑图整理 =====

/** 整理候选条目（发送给 LLM 前的形态：nodeId 不进 prompt，仅回映射用） */
export interface OrganizeCandidate {
	nodeId: string;
	/** 卡片摘要（title/note/excerptText 由调用方择优截断） */
	text: string;
}

/** 单个分组计划（回映射后）：组名 + 归入的真实节点 id 列表 */
export interface OrganizeGroupPlan {
	name: string;
	nodeIds: string[];
}

/** 送 LLM 的候选上限（token 预算保护；超出由调用方截断并明示） */
export const ORGANIZE_NODE_CAP = 60;

/** 分组数上限（prompt 约束 + 解析兜底双保险） */
export const ORGANIZE_GROUP_CAP = 10;

/** 组名截断长度 */
const ORGANIZE_NAME_CLIP = 12;

/** 候选摘要截断长度 */
const ORGANIZE_TEXT_CLIP = 80;

/**
 * 整理请求（100）：候选以「序号. 摘要」列表呈现，输出约束为 JSON 数组
 * [{name, indices}]；语义相近的归一组，每组至少 2 个，无合适组的节点
 * 不必强行分配（留在原位）。
 */
export function buildOrganizeMessages(candidates: readonly OrganizeCandidate[]): ChatMessage[] {
	const lines = candidates
		.map((c, i) => `${i}. ${clipText(c.text, ORGANIZE_TEXT_CLIP)}`)
		.join("\n");
	return [
		{
			role: "system",
			content: `你是思维导图整理助手。下面是「节点列表」（每行以序号开头）。请把**语义相近**的节点归入同一分组，以 JSON 数组输出，不要输出任何其他内容，格式：
[{"name":"分组名","indices":[序号,序号,…]}]
要求：1) indices 只能取节点列表中出现的序号；2) 每组至少 2 个节点；3) 没有合适分组的节点不必强行分配（省略即可，它们留在原位）；4) 分组名简明（至多 ${ORGANIZE_NAME_CLIP} 字，概括该组主题）；5) 至多 ${ORGANIZE_GROUP_CAP} 组；6) 全部用简体中文。`,
		},
		{ role: "user", content: `节点列表：\n${lines}` },
	];
}

/**
 * 解析整理输出（100）：parseJsonLoose → 逐组校验（name 归一缺省「分组N」/
 * indices 越界丢弃/跨组重复以首组为准/有效成员 <2 的组丢弃）→ 回映射
 * nodeIds；cap 兜底。自由文本（模型答「不需要整理」）与空数组一样返回
 * 空——「无分组建议」不是错误。
 */
export function parseOrganizeGroups(
	raw: string,
	candidates: readonly OrganizeCandidate[],
): OrganizeGroupPlan[] {
	let data: unknown;
	try {
		data = parseJsonLoose(raw);
	} catch {
		return [];
	}
	const list = Array.isArray(data) ? data : [data];
	const out: OrganizeGroupPlan[] = [];
	const seen = new Set<string>(); // 跨组去重：首组优先
	for (let g = 0; g < list.length; g++) {
		if (out.length >= ORGANIZE_GROUP_CAP) {
			break;
		}
		const entry = list[g];
		if (typeof entry !== "object" || entry === null) {
			continue;
		}
		const item = entry as Record<string, unknown>;
		const name = clipText(
			typeof item.name === "string" && item.name.trim() ? item.name : `分组${out.length + 1}`,
			ORGANIZE_NAME_CLIP,
		);
		const indices = Array.isArray(item.indices) ? item.indices : [];
		const nodeIds: string[] = [];
		for (const v of indices) {
			const index = typeof v === "number" ? Math.trunc(v) : -1;
			if (index < 0 || index >= candidates.length) {
				continue; // 越界（幻觉下标）丢弃
			}
			const nodeId = candidates[index].nodeId;
			if (seen.has(nodeId)) {
				continue; // 已被更早的组认领
			}
			seen.add(nodeId);
			nodeIds.push(nodeId);
		}
		if (nodeIds.length < 2) {
			continue; // 单成员组无整理价值（等于原地包一层）
		}
		out.push({ name, nodeIds });
	}
	return out;
}

/**
 * 环检测（100，防御层）：把 nodeId 挂到 newParentId 下是否成环——沿
 * newParentId 的父链向上走，途经 nodeId 即环。AI 整理的分组卡是全新
 * 节点（无后代，结构上不可能成环），此处兜底防御解析层异常产物。
 */
export function wouldCycle(
	parentOf: ReadonlyMap<string, string | null>,
	nodeId: string,
	newParentId: string | null,
): boolean {
	let cursor = newParentId;
	const guard = new Set<string>();
	while (cursor != null) {
		if (cursor === nodeId) {
			return true;
		}
		if (guard.has(cursor)) {
			return true; // 既有数据成环（理论不可达）：按环处理拒绝
		}
		guard.add(cursor);
		cursor = parentOf.get(cursor) ?? null;
	}
	return false;
}

// ===== AI 大纲 =====

/** 大纲树节点：与 pdf-outline 的 OutlineEntry 同构（page null = 无法定位的项） */
export interface OutlineGenNode {
	title: string;
	/** 起始页（必须命中上下文标记页集合，否则解析层降级 null） */
	page: number | null;
	children: OutlineGenNode[];
}

/** 大纲条目总数上限（防超长文档刷出几百章） */
export const OUTLINE_GEN_MAX = 80;

/** 标题截断长度 */
const OUTLINE_TITLE_CLIP = 60;

/** 大纲层级深度上限（过深树对记忆框架无益） */
const OUTLINE_DEPTH_MAX = 3;

/**
 * 大纲请求（100）：上下文是带 [第 N 页]/[第 N 章] 标记的全文（98
 * buildContextText 产物）；输出嵌套树 JSON，page **只许引用文中已出现的
 * 标记页码**（禁编造——解析层再按标记页集合硬校验，双防线）。
 */
export function buildOutlineMessages(contextText: string): ChatMessage[] {
	return [
		{
			role: "system",
			content: `你是文档大纲整理助手。用户给出带页标记的文档内容（每块前的 [第 N 页] / [第 N 章] 标记）。请提炼文档的层级大纲，以 JSON 数组输出，不要输出任何其他内容，格式：
[{"title":"章节标题","page":页码数字,"children":[…同构嵌套…]}]
要求：1) page **只能取文中出现过的 [第 N 页]/[第 N 章] 标记里的数字，禁止编造**；2) 顶层为章、二级为节，至多 ${OUTLINE_DEPTH_MAX} 层；3) 只列文档实际涉及的主题，不脑补；4) 至多 ${OUTLINE_GEN_MAX} 条；5) 标题简明（至多 ${OUTLINE_TITLE_CLIP} 字）；6) 全部用简体中文。`,
		},
		{ role: "user", content: contextText },
	];
}

/**
 * 解析大纲输出（100）：parseJsonLoose → 递归校验（title 非空截断、page
 * 必须命中 validPages 否则降级 null——交给 planOutlineChapters 的
 * 「损坏条目跳过就近重挂」路径、深度超限截平、总数截断）。
 * 全部无效抛中文错（用户在等框架，无产出是错误）。
 */
export function parseOutlineTree(raw: string, validPages: ReadonlySet<number>): OutlineGenNode[] {
	const data = parseJsonLoose(raw);
	const list = Array.isArray(data) ? data : [data];
	const budget = { count: 0 };
	const out = collectNodes(list, validPages, 0, budget);
	if (out.length === 0) {
		throw new Error("AI 未生成有效的大纲内容，请重试");
	}
	return out;
}

/**
 * 递归收集一层子列表（返回本层节点，children 递归挂回——树结构保持）；
 * budget.count 跨层累计总数截断；深度超限截平（深层子项丢弃）。
 */
function collectNodes(
	list: unknown[],
	validPages: ReadonlySet<number>,
	depth: number,
	budget: { count: number },
): OutlineGenNode[] {
	if (depth >= OUTLINE_DEPTH_MAX) {
		return [];
	}
	const out: OutlineGenNode[] = [];
	for (const entry of list) {
		if (budget.count >= OUTLINE_GEN_MAX) {
			return out;
		}
		if (typeof entry !== "object" || entry === null) {
			continue;
		}
		const item = entry as Record<string, unknown>;
		const title =
			typeof item.title === "string" ? item.title.trim().slice(0, OUTLINE_TITLE_CLIP) : "";
		if (!title) {
			continue;
		}
		const pageRaw = typeof item.page === "number" ? Math.trunc(item.page) : null;
		const page = pageRaw != null && validPages.has(pageRaw) ? pageRaw : null;
		budget.count++;
		out.push({
			title,
			page,
			children: Array.isArray(item.children)
				? collectNodes(item.children, validPages, depth + 1, budget)
				: [],
		});
	}
	return out;
}

/** 摘要截断（整理候选/组名共用） */
function clipText(text: string, max: number): string {
	const trimmed = text.trim();
	return trimmed.length > max ? `${trimmed.slice(0, max)}…` : trimmed;
}
