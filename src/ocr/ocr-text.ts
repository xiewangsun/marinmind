/**
 * OCR 结果的拼接与清洗纯函数（无 DOM/网络依赖，vitest 覆盖）。
 * ocr-service 逐矩形识别出的原始文本经这里归一后写回 Card.excerptText。
 */

/**
 * 清洗单段 OCR 原文：
 * - 全角空格（U+3000，中文 OCR 高频噪声）归一为半角；
 * - CRLF/CR 归一为 \n；
 * - 行内连续空格/制表符折叠为单个空格；
 * - 每行 trim，去掉空行（保留换行——多行结构反映版面段落）。
 */
export function normalizeOcrText(text: string): string {
	return text
		.replace(/　/g, " ")
		.replace(/\r\n?/g, "\n")
		.split("\n")
		.map((line) => line.replace(/[ \t]+/g, " ").trim())
		.filter((line) => line.length > 0)
		.join("\n");
}

/**
 * 按矩形顺序拼接各区域文本：逐段 normalize、丢弃空段，以 \n 连接
 * （多矩形 = 多块版面，块间换行保持阅读顺序）。
 */
export function joinRectTexts(texts: (string | null | undefined)[]): string {
	return texts
		.map((t) => normalizeOcrText(t ?? ""))
		.filter((t) => t.length > 0)
		.join("\n");
}
