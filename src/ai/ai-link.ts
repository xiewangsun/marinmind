import type { ChatMessage } from "./ai-provider";
import { parseJsonLoose } from "./ai-json";

/**
 * 相关卡推荐（99 P3，纯函数层）：候选下标化（**LLM 只见下标不见 id**，
 * 回来经回映射取真实卡——杜绝幻觉 id）+ prompt 构造 + 解析校验。
 * 建链走 links.link（双向），视图刷新由调用方 refreshActiveMindmaps 承接。
 */

/** 推荐候选条目（发送给 LLM 前的形态：下标 + 摘要文本） */
export interface LinkCandidate {
	/** 候选卡 id（不进 prompt，仅回映射用） */
	cardId: string;
	/** 摘录文字/标题摘要（截断后送 LLM） */
	text: string;
}

/** 单条推荐结果（回映射后；index 越界的候选在解析层丢弃） */
export interface LinkSuggestion {
	cardId: string;
	text: string;
	reason: string;
}

/** 送 LLM 的候选上限（超出截断——token 预算保护；截断保出现序） */
export const LINK_CANDIDATE_CAP = 40;

/** 候选摘要截断长度（超长摘录只送前段） */
const CANDIDATE_TEXT_CLIP = 120;

/**
 * 推荐请求（99）：候选以「序号. 摘要」列表呈现，输出约束为 JSON 数组
 * [{index, reason}]；要求语义相关（同概念/互为佐证/因果）才推荐。
 */
export function buildLinkMessages(
	sourceText: string,
	candidates: readonly LinkCandidate[],
): ChatMessage[] {
	const lines = candidates
		.map((c, i) => `${i}. ${clipText(c.text, CANDIDATE_TEXT_CLIP)}`)
		.join("\n");
	return [
		{
			role: "system",
			content: `你是学习卡片整理助手。下面是「当前卡片」与「候选卡片列表」（每行以序号开头）。请从候选中挑出与当前卡片**语义相关**的卡片（同概念/互为佐证/因果关系），以 JSON 数组输出，不要输出任何其他内容，格式：
[{"index":候选序号,"reason":"一句话相关理由"}]
要求：1) index 只能取候选列表中出现的序号；2) 只推荐确实相关的，宁缺毋滥（可返回空数组 []）；3) 至多推荐 8 条；4) reason 用简体中文。`,
		},
		{
			role: "user",
			content: `当前卡片：${clipText(sourceText, CANDIDATE_TEXT_CLIP)}\n\n候选卡片列表：\n${lines}`,
		},
	];
}

/**
 * 解析推荐输出（99）：parseJsonLoose → 逐项校验（index 整数且在候选范围内；
 * reason 缺省兜底「语义相关」）→ **下标回映射**为真实 cardId；去重。
 * 全部无效（空数组/越界/非 JSON 自由文本）返回空列表——宁缺毋滥语义下
 * 「没给结构化推荐」≈「没有推荐」，不抛错（与制卡的整批失败语义区分）。
 */
export function parseLinkSuggestions(
	raw: string,
	candidates: readonly LinkCandidate[],
): LinkSuggestion[] {
	// 自由文本（模型答「没有相关的」）按无推荐处理；解析失败不惊扰用户
	let data: unknown;
	try {
		data = parseJsonLoose(raw);
	} catch {
		return [];
	}
	const list = Array.isArray(data) ? data : [data];
	const out: LinkSuggestion[] = [];
	const seen = new Set<string>();
	for (const entry of list) {
		if (typeof entry !== "object" || entry === null) {
			continue;
		}
		const item = entry as Record<string, unknown>;
		const index = typeof item.index === "number" ? Math.trunc(item.index) : -1;
		if (index < 0 || index >= candidates.length) {
			continue; // 越界（幻觉下标）丢弃
		}
		const cardId = candidates[index].cardId;
		if (seen.has(cardId)) {
			continue; // 重复推荐去重
		}
		seen.add(cardId);
		const reason =
			typeof item.reason === "string" && item.reason.trim() ? item.reason.trim() : "语义相关";
		out.push({ cardId, text: candidates[index].text, reason });
		if (out.length >= 8) {
			break; // prompt 约束上限的兜底
		}
	}
	return out;
}

/** 摘要截断（候选文本与理由共用） */
function clipText(text: string, max: number): string {
	const trimmed = text.trim();
	return trimmed.length > max ? `${trimmed.slice(0, max)}…` : trimmed;
}
