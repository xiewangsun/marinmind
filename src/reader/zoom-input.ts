/**
 * 缩放比例输入解析（纯函数）：菜单「输入缩放比例…」的输入框文本 → 缩放值。
 * 仅解析不钳制——20%-500% 的钳制由 ReaderView.setZoom 统一负责（单一口径）。
 */

/**
 * 解析缩放比例输入："150" / "150%" / "62.5％"（全角百分号）→ 1.5 / 1.5 / 0.625。
 * 非法输入（空串 / 纯百分号 / 非数字 / 带其他后缀如 "1.5x"）返回 null；
 * 前后空白自动 trim；返回值为比例（百分比 ÷ 100）。
 */
export function parseZoomInput(raw: string): number | null {
	const trimmed = raw.trim();
	if (!trimmed) {
		return null;
	}
	// 去尾部可选的半角/全角百分号（只许出现在末尾，"15%0" 之类由 Number 兜底判 NaN）
	const body = trimmed.replace(/[%％]+$/, "");
	if (!body) {
		return null;
	}
	const value = Number(body);
	if (!Number.isFinite(value)) {
		return null;
	}
	return value / 100;
}
