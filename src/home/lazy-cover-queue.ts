/**
 * 惰性渲染队列（127 书架封面视口惰性渲染）：固定并发上限的动态入队队列。
 *
 * 与 utils.mapLimit 的差异：mapLimit 是一次性静态批（建批即全量开跑），本队列
 * 支持「先建队列、后续逐项 add」（IntersectionObserver 视口命中时入队），
 * 并发上限语义相同——任一时刻在途任务 ≤ limit，任务完成自动续跑队首。
 * 纯逻辑零 DOM 依赖，可 vitest 直接覆盖。
 */

export interface LazyQueue<T> {
	/** 入队一项并尝试抽干（不阻塞：并发满时静默排队） */
	add(item: T): void;
	/** 当前排队（不含在途）条目数 */
	size(): number;
}

/**
 * 创建惰性队列。fn 的异常自吞（console.warn）不阻断后续条目——封面渲染
 * 契约是「永不 reject」（getDocCover 内部兜底 + DOM 段不抛），防御仅兜底
 * 未知异常，避免一条脏数据卡死整个队列。
 */
export function createLazyQueue<T>(limit: number, fn: (item: T) => Promise<void>): LazyQueue<T> {
	const max = Math.max(1, Math.floor(limit) || 1); // 与 mapLimit 同款入参防御
	const queue: T[] = [];
	let active = 0;

	const drain = (): void => {
		while (active < max && queue.length > 0) {
			const item = queue.shift()!;
			active++;
			void fn(item)
				.catch((err: unknown) => {
					console.warn("[MarinMind] 惰性队列任务失败（已跳过）", err);
				})
				.finally(() => {
					active--;
					drain(); // 完成续跑：腾出的并发额度交给队首
				});
		}
	};

	return {
		add(item: T): void {
			queue.push(item);
			drain();
		},
		size(): number {
			return queue.length;
		},
	};
}
