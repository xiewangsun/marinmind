import { describe, expect, it } from "vitest";
import { createLazyQueue } from "../../src/home/lazy-cover-queue";

/** 微任务全落地（release 后的续跑链跨多个 microtask，单 tick 不足） */
const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

/** 受控异步任务：resolve 由测试显式驱动（并发计数随起止增减） */
function makeTask() {
	let inFlight = 0;
	let peak = 0;
	const gates: (() => void)[] = [];
	const done: number[] = [];
	const fn = async (i: number): Promise<void> => {
		inFlight++;
		peak = Math.max(peak, inFlight);
		await new Promise<void>((resolve) => gates.push(resolve));
		inFlight--;
		done.push(i);
	};
	return {
		fn,
		peak: () => peak,
		done,
		/** 放行最早一个挂起任务 */
		releaseOne: (): void => gates.shift()?.(),
		/** 放行全部挂起任务直至队列抽干（续跑链新起的 gate 同循环放行） */
		releaseAll: async (): Promise<void> => {
			while (gates.length > 0) {
				gates.shift()?.();
				await flush(); // 宏任务边界：续跑链（含新 gate 入列）全部落地
			}
			await flush(); // 末批完成回调落地
		},
	};
}

describe("惰性渲染队列（127 书架封面视口惰性渲染）", () => {
	it("并发上限：limit 2 时在途任务峰值 ≤ 2", async () => {
		const t = makeTask();
		const q = createLazyQueue(2, t.fn);
		for (let i = 0; i < 6; i++) q.add(i);
		expect(t.peak()).toBe(2); // 只起 2 个，其余排队
		await t.releaseAll();
		expect(t.peak()).toBeLessThanOrEqual(2);
		expect(t.done).toEqual([0, 1, 2, 3, 4, 5]);
	});

	it("任务完成后自动续跑队首（动态抽干）", async () => {
		const t = makeTask();
		const q = createLazyQueue(2, t.fn);
		for (let i = 0; i < 4; i++) q.add(i);
		expect(q.size()).toBe(2); // 2 在途、2 排队
		t.releaseOne(); // 任务 0 完成 → 额度让给队首任务 2
		await flush();
		expect(t.peak()).toBe(2);
		expect(q.size()).toBe(1);
		await t.releaseAll();
		expect(q.size()).toBe(0);
		expect(t.done).toEqual([0, 1, 2, 3]); // 完成序即入队序（并发 2 内保序）
	});

	it("入队后逐项 add：晚到的条目同样受并发约束", async () => {
		const t = makeTask();
		const q = createLazyQueue(1, t.fn);
		q.add(0);
		q.add(1); // 已满 1 并发，排队
		expect(q.size()).toBe(1);
		t.releaseOne();
		await flush();
		expect(t.done).toEqual([0]);
		expect(q.size()).toBe(0); // 任务 1 已起跑
		await t.releaseAll();
		expect(t.done).toEqual([0, 1]);
	});

	it("fn 抛错自吞不阻断后续条目", async () => {
		const seen: number[] = [];
		const q = createLazyQueue(1, async (i: number) => {
			seen.push(i);
			if (i === 0) throw new Error("脏数据");
		});
		q.add(0);
		q.add(1);
		await flush(); // 等抛错与续跑都落地
		expect(seen).toEqual([0, 1]); // 抛错后任务 1 照常执行
		expect(q.size()).toBe(0);
	});

	it("limit ≤ 0 归一为 1（入参防御，镜像 mapLimit）", async () => {
		const t = makeTask();
		const q = createLazyQueue(0, t.fn);
		q.add(0);
		q.add(1);
		expect(t.peak()).toBe(1);
		await t.releaseAll();
		expect(t.done).toEqual([0, 1]);
	});

	it("空队列静默：无任务时 size 为 0 且零副作用", () => {
		const q = createLazyQueue(3, async () => {});
		expect(q.size()).toBe(0);
	});
});
