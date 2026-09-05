import type { ChatMessage } from "./ai-provider";
import { parseJsonLoose } from "./ai-json";

/**
 * AI 制卡（99 P3，纯函数层）：prompt 构造 + 结构化输出逐项校验。
 * 卡片字段约定（零模型改动，承接 review-view 既有正反面语义：
 * 有 note 时 note=正面问题、excerptText=背面答案）：
 * - QA 卡：note=问题, excerptText=答案, title=问题短句
 * - 填空卡：note=挖空句(____), excerptText=完整原句
 * tags ["AI","制卡"]；有源继承 documentId/page/rects（回链保留）。
 * 落库与入图在 ai-cardgen-modal（cardBus 回环白赚自动入图归章）。
 */

/** 单张生成卡的原料（schema 校验通过项；type 归一小写） */
export interface CardgenItem {
	kind: "qa" | "cloze";
	/** QA=问题；cloze=挖空句（含 ____） */
	front: string;
	/** QA=答案；cloze=完整原句 */
	back: string;
}

/** 单次生成的上限（防超长文本刷出几十张卡刷屏） */
export const CARDGEN_MAX = 8;

/**
 * 制卡请求（99）：输出约束为 JSON 数组 + few-shot 示例（结构化输出四层
 * 容错的第一层——prompt 约束）；温度建议低值（设置 desc 已引导）。
 */
export function buildCardgenMessages(text: string, maxCards = CARDGEN_MAX): ChatMessage[] {
	return [
		{
			role: "system",
			content: `你是严谨的出题助手。依据用户给出的学习材料出记忆卡片，以 JSON 数组输出，不要输出任何其他内容。每项格式二选一：
{"type":"qa","q":"问题","a":"答案"}
{"type":"cloze","sentence":"完整原句","blank":"把关键处替换为____的挖空句"}
要求：1) 至多 ${maxCards} 张，只出材料中确实有依据的题；2) qa 的答案简明准确（一题一知识点）；3) cloze 挖掉的关键词要有记忆价值（术语/数字/结论，不要挖"的""了"）；4) 全部用简体中文。
示例输出：
[{"type":"qa","q":"贝叶斯定理的公式是什么？","a":"P(H|E) = P(E|H)·P(H)/P(E)"},{"type":"cloze","sentence":"间隔重复通过拉长复习间隔巩固长期记忆","blank":"间隔重复通过拉长复习间隔巩固____"}]`,
		},
		{ role: "user", content: text },
	];
}

/**
 * 解析制卡输出（99，四层容错的二三层：parseJsonLoose 剥围栏/截取 →
 * schema 逐项校验丢弃坏项，不整批失败）：
 * - type 只认 "qa"/"cloze"（大小写宽容）
 * - qa 取 q/a；cloze 取 blank/sentence（兼容 q/a 别名）
 * - 空串项丢弃；blank 无 ____ 自动补一格（模型漏写挖空的兜底）
 * - 超过 CARDGEN_MAX 截断
 * 全部无效抛中文错误。
 */
export function parseCardgenItems(raw: string): CardgenItem[] {
	const data = parseJsonLoose(raw);
	const list = Array.isArray(data) ? data : [data];
	const out: CardgenItem[] = [];
	for (const entry of list) {
		if (typeof entry !== "object" || entry === null) {
			continue;
		}
		const item = entry as Record<string, unknown>;
		const type = typeof item.type === "string" ? item.type.trim().toLowerCase() : "";
		if (type === "qa") {
			const q = pickText(item, ["q", "question", "front"]);
			const a = pickText(item, ["a", "answer", "back"]);
			if (q && a) {
				out.push({ kind: "qa", front: q, back: a });
			}
		} else if (type === "cloze") {
			const blank = pickText(item, ["blank", "q", "front"]);
			const sentence = pickText(item, ["sentence", "a", "back"]);
			if (blank && sentence) {
				out.push({
					kind: "cloze",
					front: blank.includes("____") ? blank : `${blank}____`,
					back: sentence,
				});
			}
		}
		if (out.length >= CARDGEN_MAX) {
			break; // 超上限截断（prompt 已约束，防模型不听话）
		}
	}
	if (out.length === 0) {
		throw new Error("AI 未生成有效的制卡内容，请重试或换一段材料");
	}
	return out;
}

/** 多候选键取第一个非空字符串（trim）——对齐模型字段命名的宽容面 */
function pickText(item: Record<string, unknown>, keys: string[]): string {
	for (const key of keys) {
		const value = item[key];
		if (typeof value === "string" && value.trim()) {
			return value.trim();
		}
	}
	return "";
}

/** 卡片标题（㊺ 一卡一标题语义：QA=问题短句；cloze=挖空句截断） */
export function cardgenTitle(item: CardgenItem): string {
	const source = item.kind === "qa" ? item.front : item.front.replace(/_{2,}/g, "____");
	return source.length > 40 ? `${source.slice(0, 40)}…` : source;
}
