import type { ChatMessage } from "./ai-provider";
import { parseJsonLoose } from "./ai-json";

/**
 * AI 复习助手（101 P5，纯函数层）：卡壳提示（防泄题）、选择题干扰项、
 * 错题总结的 prompt 构造与解析。设计核心：
 * - **提示只见正面**：调用方保证 hint 的 prompt 不携带答案侧（note=问题的
 *   QA 语义，answer=excerptText 不进 hint 请求）——泄题防线在数据侧，
 *   prompt 侧再约束「严禁复述/概括/暗示答案」双保险。
 * - **干扰项自测零 SRS 接触**：产物只是 UI 选项列表，视图层不触碰
 *   reviews/review——评分仍由人工四档完成。
 */

/** 干扰项条数（加正确答案共 4 选项） */
export const QUIZ_DISTRACTOR_COUNT = 3;

/**
 * 卡壳提示请求（101）：只给方向性提示（相关概念/思路方向/关键词类别），
 **严禁**复述、概括、翻译或以任何形式暗示答案本身；至多 80 字。
 */
export function buildReviewHintMessages(question: string): ChatMessage[] {
	return [
		{
			role: "system",
			content: `你是记忆卡复习教练。用户正在回忆一张卡片的答案但卡壳了，需要一点**方向性提示**。以 JSON 对象输出，不要输出任何其他内容，格式：
{"hint":"提示文字"}
要求：1) 提示只能是相关概念、思路方向、关键词所属类别、首字/字数之类的间接线索；2) **严禁复述、概括、翻译或暗示答案本身**——用户还没回忆出来，不能替他回答；3) 至多 80 字；4) 简体中文。`,
		},
		{ role: "user", content: `问题：${question}` },
	];
}

/**
 * 解析提示输出（101）：宽容取 {hint} 或裸字符串；全无效抛中文错。
 * 不校验「是否泄题」（语义判断交 prompt 约束 + 人工核对——提示本就显示
 * 在答案之前，用户一眼能看出是否泄底）。
 */
export function parseReviewHint(raw: string): string {
	let data: unknown;
	try {
		data = parseJsonLoose(raw);
	} catch {
		return raw.trim(); // 模型直接回了纯文本提示（最常见的不听话形态）
	}
	if (typeof data === "string" && data.trim()) {
		return data.trim();
	}
	if (typeof data === "object" && data !== null) {
		const hint = (data as Record<string, unknown>).hint;
		if (typeof hint === "string" && hint.trim()) {
			return hint.trim();
		}
	}
	throw new Error("AI 未生成有效提示，请重试");
}

/**
 * 选择题干扰项请求（101）：依据问题与正确答案出 3 个**似是而非**的错误
 * 选项（同范畴/易混淆/常见误解），JSON 输出。
 */
export function buildQuizMessages(question: string, answer: string): ChatMessage[] {
	return [
		{
			role: "system",
			content: `你是出题助手。用户给出一张问答卡的「问题」与「正确答案」，请出 ${QUIZ_DISTRACTOR_COUNT} 个**错误选项**用于选择题自测，以 JSON 对象输出，不要输出任何其他内容，格式：
{"distractors":["错误项1","错误项2","错误项3"]}
要求：1) 错误项与正确答案同范畴、形式一致（长度/格式接近），具有迷惑性（易混淆概念/常见误解）；2) **必须是错的**，不能与正确答案等价；3) 互不相同；4) 与正确答案字面不同；5) 简体中文。`,
		},
		{ role: "user", content: `问题：${question}\n正确答案：${answer}` },
	];
}

/**
 * 解析干扰项（101）：逐项校验（trim 非空、≠ 正确答案、去重）取前
 * QUIZ_DISTRACTOR_COUNT 个；一个有效干扰项都没有抛中文错。
 */
export function parseQuizDistractors(raw: string, correct: string): string[] {
	let data: unknown;
	try {
		data = parseJsonLoose(raw);
	} catch {
		throw new Error("AI 未生成有效的干扰项，请重试");
	}
	// 裸数组（模型漏掉外层对象）直接当列表用；对象才取 distractors 字段
	const holder =
		typeof data === "object" && data !== null && !Array.isArray(data)
			? (data as Record<string, unknown>).distractors
			: data;
	const list = Array.isArray(holder) ? holder : [];
	const out: string[] = [];
	const seen = new Set<string>([correct.trim()]);
	for (const v of list) {
		if (typeof v !== "string") {
			continue;
		}
		const item = v.trim();
		if (!item || seen.has(item)) {
			continue; // 空项 / 与正确答案相同 / 重复
		}
		seen.add(item);
		out.push(item);
		if (out.length >= QUIZ_DISTRACTOR_COUNT) {
			break;
		}
	}
	if (out.length === 0) {
		throw new Error("AI 未生成有效的干扰项，请重试");
	}
	return out;
}

/**
 * 打乱选项（Fisher-Yates）：rng 参数供测试注入确定性序列，运行时缺省
 * Math.random。正确答案位置随机是自测有效性的前提。
 */
export function shuffleQuizOptions<T>(items: readonly T[], rng: () => number = Math.random): T[] {
	const out = [...items];
	for (let i = out.length - 1; i > 0; i--) {
		const j = Math.floor(rng() * (i + 1));
		[out[i], out[j]] = [out[j], out[i]];
	}
	return out;
}

/** 错题总结条目（视图从会话 again 评分收集；answer 可空——无答案的卡只列问题） */
export interface MistakeItem {
	question: string;
	answer: string;
}

/**
 * 错题总结请求（101）：本会话答错的卡（问题+答案清单）→ 共性薄弱点归纳
 * 与复习建议。自由文本输出（AiActionModal 流式承接，「存为卡片」应用）。
 */
export function buildMistakeSummaryMessages(items: readonly MistakeItem[]): ChatMessage[] {
	const lines = items
		.map((it, i) => {
			const q = clip(it.question, 60);
			const a = it.answer ? `｜答案：${clip(it.answer, 60)}` : "";
			return `${i + 1}. ${q}${a}`;
		})
		.join("\n");
	return [
		{
			role: "system",
			content: `你是学习教练。用户刚结束一轮间隔重复复习，下面是其中答错的卡片清单。请输出一份简短的错题总结：1) 归纳共性薄弱点（哪类概念/知识点反复出错）；2) 每个薄弱点给一条具体的复习建议；3) 至多 300 字；4) 简体中文；5) 直接输出总结正文，不要客套开场。`,
		},
		{ role: "user", content: `答错卡片：\n${lines}` },
	];
}

/** 摘要截断（错题条目共用） */
function clip(text: string, max: number): string {
	const trimmed = text.trim();
	return trimmed.length > max ? `${trimmed.slice(0, max)}…` : trimmed;
}
