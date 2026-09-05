import type { ChatMessage } from "./ai-provider";

/**
 * AI prompt 构造（97，纯函数层）：划选操作（解释/总结/改写/自定义）与卡片
 * AI 评论的 messages 组装。全部为无副作用纯函数（vitest 直测）；网络与弹窗
 * 在 ai-service / ai-action-modal（耦合层）。
 */

/** 内置划选操作类别（自定义走 AiMenuAction 的 custom 分支） */
export type AiSelectionAction = "explain" | "summarize" | "rewrite";

/** 划选 AI 菜单动作（selection-toolbar → reader-view → ai-action-modal） */
export type AiMenuAction =
	{ kind: AiSelectionAction } | { kind: "custom"; label: string; prompt: string };

/** 内置操作中文名（菜单项与弹窗标题共用） */
export const SELECTION_ACTION_LABELS: Record<AiSelectionAction, string> = {
	explain: "解释",
	summarize: "总结",
	rewrite: "改写",
};

/** 通用输出约束（所有划选操作 system 末尾统一附加，保证输出可直接转卡片） */
const OUTPUT_RULES = "用简体中文回答，直接输出结果本身（不加「好的」「以下是」等客套与前缀标题）。";

/** 内置操作的指令正文（拼进 system） */
const SELECTION_ACTION_PROMPTS: Record<AiSelectionAction, string> = {
	explain:
		"你是严谨的学习助手。请解释用户给出的内容：先说明它讲的是什么，再补充必要的背景知识与相关概念；涉及专业术语时一并解释。",
	summarize:
		"你是严谨的学习助手。请把用户给出的内容压缩为要点：至多 5 条、每条一行，保留关键信息与数字，不添加原文没有的内容。",
	rewrite:
		"你是中文写作助手。请改写用户给出的内容：更通顺、更简洁，保持原意不变。直接输出改写后的文字，不要解释改了什么。",
};

/**
 * 组装划选操作请求（97）：内置三选一或自定义指令，user 载荷为选中文本。
 * 自定义指令要求调用方保证非空（设置层 sanitize 已拦截空项）。
 */
export function buildAiActionMessages(action: AiMenuAction, text: string): ChatMessage[] {
	const instruction =
		action.kind === "custom"
			? `${action.prompt.trim()}\n以上指令作用于用户给出的文本。`
			: SELECTION_ACTION_PROMPTS[action.kind];
	return [
		{ role: "system", content: `${instruction}\n${OUTPUT_RULES}` },
		{ role: "user", content: text },
	];
}

/** 动作标题（弹窗标题栏）：内置「AI 解释」/ 自定义「AI · 〈label〉」 */
export function aiActionTitle(action: AiMenuAction): string {
	return action.kind === "custom"
		? `AI · ${action.label}`
		: `AI ${SELECTION_ACTION_LABELS[action.kind]}`;
}

/** 卡片 AI 评论的上下文输入（结构性满足 Card，免 prompts 依赖 types 模块） */
export interface AiCardContext {
	title?: string | null;
	note?: string | null;
	excerptText?: string | null;
}

/**
 * 组装卡片「AI 补充解释」请求（97，MN4 AI 评论对齐）：解释摘录内容并补充
 * 背景，输出预填批注（经 CardEditModal 人手确认后落库）。上下文带上标题与
 * 已有批注（若存在），让解释贴合用户已记录的关注点。
 */
export function buildCardCommentMessages(card: AiCardContext): ChatMessage[] {
	const excerpt = (card.excerptText ?? "").trim();
	const context: string[] = [];
	if (card.title?.trim()) {
		context.push(`卡片标题：${card.title.trim()}`);
	}
	if (card.note?.trim()) {
		context.push(`我的批注：${card.note.trim()}`);
	}
	const user = context.length > 0 ? `${context.join("\n")}\n\n摘录内容：${excerpt}` : excerpt;
	return [
		{
			role: "system",
			content:
				"你是严谨的学习助手。我在阅读时摘录了下面这段内容，想深入了解它。请用简体中文给出补充解释：它讲了什么、必要的背景知识、值得注意的要点或易混淆处。控制在 200 字以内，直接输出解释内容，不加前缀标题。",
		},
		{ role: "user", content: user },
	];
}

// ---------- 文档对话（98 P2） ----------

/** 对话轮次（面板内存态：user/assistant 交替；system 由构造时注入不进历史） */
export interface ChatTurn {
	role: "user" | "assistant";
	content: string;
}

/** 携带历史的多轮上限（超出丢最旧——控制请求体量，近期对话优先） */
export const CHAT_HISTORY_LIMIT = 8;

/**
 * 组装文档问答请求（98）：system 约束「只依据文档内容回答 + 引用只许文中
 * 已有页标记」（页码幻觉防线）；上下文以明确围栏包裹；历史裁剪到近
 * CHAT_HISTORY_LIMIT 轮。
 */
export function buildChatMessages(
	history: ChatTurn[],
	contextText: string,
	question: string,
): ChatMessage[] {
	const trimmed = history.slice(-CHAT_HISTORY_LIMIT);
	return [
		{
			role: "system",
			content:
				"你是严谨的学习助手，依据用户提供的文档内容回答问题。要求：1) 用简体中文回答；2) 引用出处时使用「（第 N 页）」格式，且 N 只能取文档内容中已出现的页标记，禁止编造页码；3) 文档内容中没有依据的部分要明确说明「文档中未提及」，不要自行脑补；4) 直接回答，不加客套。",
		},
		...trimmed,
		{
			role: "user",
			content: `【文档内容开始】\n${contextText}\n【文档内容结束】\n\n我的问题：${question}`,
		},
	];
}

// ---------- AI 摘要（98 P2） ----------

/**
 * 单块/短文直出摘要（98）：分块后仅 1 块或原文在预算内时走此路径。
 * 输出约束结构化（主题 + 要点），可直接落摘要卡。
 */
export function buildSummaryMessages(text: string): ChatMessage[] {
	return [
		{
			role: "system",
			content:
				"你是严谨的学习助手。请用简体中文总结用户给出的文档内容：先用一句话概括主题，再用 3-8 条要点罗列关键信息（保留重要数字与结论）。直接输出总结，不加前缀标题。文中页标记如「[第 N 页]」可在要点尾随标注为「（第 N 页）」。",
		},
		{ role: "user", content: text },
	];
}

/** map 阶段（98）：长文分块逐块提炼要点（每块独立请求，顺序执行防限流） */
export function buildSummaryMapMessages(chunk: string): ChatMessage[] {
	return [
		{
			role: "system",
			content:
				"你是严谨的学习助手。请用简体中文提炼这段文档片段的要点：至多 5 条、每条一行，保留关键数字与结论，保留文中「[第 N 页]」页标记为「（第 N 页）」。直接输出要点，不加前缀标题。",
		},
		{ role: "user", content: chunk },
	];
}

/** reduce 阶段（98）：合并各块要点为整体摘要（去重合并、全局结构） */
export function buildSummaryReduceMessages(maps: string[]): ChatMessage[] {
	return [
		{
			role: "system",
			content:
				"你是严谨的学习助手。下面是对一份文档分段提炼的要点，请合并成一份整体摘要：先用一句话概括主题，再用 3-8 条要点罗列关键信息（去重、按逻辑排序，保留重要数字与「（第 N 页）」出处标注）。直接输出摘要，不加前缀标题。",
		},
		{ role: "user", content: maps.map((m, i) => `【第 ${i + 1} 部分】\n${m}`).join("\n\n") },
	];
}
