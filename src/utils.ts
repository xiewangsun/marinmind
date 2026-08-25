/** 生成实体唯一 ID（UUID v4） */
export function newId(): string {
	if (globalThis.crypto?.randomUUID) {
		return globalThis.crypto.randomUUID();
	}
	// 回退：Math.random 拼装（本地数据去重足够使用）
	return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (ch) => {
		const r = (Math.random() * 16) | 0;
		const v = ch === "x" ? r : (r & 0x3) | 0x8;
		return v.toString(16);
	});
}

/** 当前毫秒时间戳 */
export function now(): number {
	return Date.now();
}
