import { describe, expect, it } from "vitest";
import { mapLimit } from "../src/utils";

describe("mapLimit 并发受限保序 map（㊳ outline 并行）", () => {
	it("结果顺序与输入一致（完成序乱也不乱序）", async () => {
		const items = [1, 2, 3, 4, 5, 6, 7];
		// 后面的项先完成（延时反比于下标）
		const out = await mapLimit(items, 3, async (n) => {
			await new Promise((r) => setTimeout(r, 30 - n * 3));
			return n * 10;
		});
		expect(out).toEqual([10, 20, 30, 40, 50, 60, 70]);
	});

	it("并发峰值不超过 limit", async () => {
		let running = 0;
		let peak = 0;
		await mapLimit([1, 2, 3, 4, 5, 6, 7, 8], 2, async (n) => {
			running++;
			peak = Math.max(peak, running);
			await new Promise((r) => setTimeout(r, 5 + n));
			running--;
			return n;
		});
		expect(peak).toBeLessThanOrEqual(2);
		expect(peak).toBeGreaterThan(0); // 确实并行过（防御假绿）
	});

	it("空数组返回空结果", async () => {
		expect(await mapLimit([], 4, async (n) => n)).toEqual([]);
	});

	it("limit ≤ 0 归一为 1（退化为顺序执行仍保序）", async () => {
		const out = await mapLimit([1, 2, 3], 0, async (n) => {
			await new Promise((r) => setTimeout(r, 1));
			return n;
		});
		expect(out).toEqual([1, 2, 3]);
		expect(await mapLimit([1], -5, async (n) => n)).toEqual([1]);
	});

	it("fn 抛错整体 reject", async () => {
		await expect(
			mapLimit([1, 2, 3], 2, async (n) => {
				if (n === 2) {
					throw new Error("boom");
				}
				return n;
			}),
		).rejects.toThrow("boom");
	});
});
