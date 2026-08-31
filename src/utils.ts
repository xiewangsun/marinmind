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

/**
 * 并发受限的保序 map（㊳ 性能：outline 逐条目串行解析页码 → 并行化）。
 * 结果顺序与输入一致（占位落位，不按完成序）；任一 fn 抛错整体 reject；
 * limit ≤ 0 归一为 1（退化为顺序执行，防御异常入参）。
 */
export async function mapLimit<T, R>(
	items: readonly T[],
	limit: number,
	fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
	const n = Math.max(1, Math.floor(limit) || 1);
	const results = new Array<R>(items.length);
	let next = 0; // 下一个待领下标（worker 间自分配）
	const worker = async (): Promise<void> => {
		while (next < items.length) {
			const i = next++;
			results[i] = await fn(items[i], i);
		}
	};
	const workers: Promise<void>[] = [];
	for (let k = 0; k < Math.min(n, items.length); k++) {
		workers.push(worker());
	}
	await Promise.all(workers);
	return results;
}
