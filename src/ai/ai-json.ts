/**
 * AI 结构化输出容错解析（96，纯函数层）：parseJsonLoose 三段降级（直接解析 →
 * 剥 ``` 围栏 → 首尾大括号截取），供制卡 / 脑图整理 / 大纲 / 链接建议等
 * 需要 JSON 输出的功能共用。各功能的 schema 逐项校验（坏项丢弃不整批失败）
 * 随对应批次在 ai-plan 落地，96 仅基础设施。
 */

/**
 * 宽容解析 LLM 输出为 JSON 值：
 * 1. 直接 JSON.parse（模型听话时的主流路径）；
 * 2. 失败剥 ```json 围栏再试（最常见的不听话形态——模型爱用代码块包裹）；
 * 3. 仍失败截取首个 [ 或 { 到末个 ] 或 } 再试（前后带解释文字的兜底）。
 * 全部失败抛中文错（调用方 Notice 引导重试或换模型）。
 */
export function parseJsonLoose(raw: string): unknown {
	const text = raw.trim();
	if (text === "") {
		throw new Error("AI 返回内容为空，请重试");
	}
	try {
		return JSON.parse(text);
	} catch {
		// 降级路径继续
	}
	const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
	if (fenced?.[1]) {
		try {
			return JSON.parse(fenced[1].trim());
		} catch {
			// 降级路径继续
		}
	}
	// 首个 [ / { 到末个 ] / }：按先出现者定类型，配对取同型末位
	const firstArr = text.indexOf("[");
	const firstObj = text.indexOf("{");
	const startIsObject = firstObj !== -1 && (firstArr === -1 || firstObj < firstArr);
	const start = startIsObject ? firstObj : firstArr;
	const end = startIsObject ? text.lastIndexOf("}") : text.lastIndexOf("]");
	if (start !== -1 && end > start) {
		try {
			return JSON.parse(text.slice(start, end + 1));
		} catch {
			// 全部失败：抛中文错
		}
	}
	throw new Error("AI 返回内容无法解析为结构化数据，请重试或更换模型");
}
