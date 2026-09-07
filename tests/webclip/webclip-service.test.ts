/**
 * webclip-service 网络层单测（113-B）：runLimited 并发语义 + fetchImages
 * 逐张容错（CT 判定 / 后缀兜底 / data: 解码 / 进度回调）。obsidian 的
 * requestUrl 以 vi.mock 替身（镜像 media-import.test 先例）；vault 落盘
 * （saveWebclip）属集成路径，不在此覆盖——纯函数部件已在 113-A 各测试锁定。
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("obsidian", () => ({ requestUrl: vi.fn() }));

import { requestUrl } from "obsidian";
import { fetchImages, runLimited } from "../../src/webclip/webclip-service";
import type { MdImageRef } from "../../src/webclip/html-to-md";

/** 构造图片引用（默认远程 URL 形态） */
const img = (i: number, url?: string): MdImageRef => ({
	placeholder: `__MMIMG_${i}__`,
	url: url ?? `https://a.com/${i}.png`,
	dataUri: null,
	alt: "",
});

const bytesOf = (arr: number[]): ArrayBuffer => new Uint8Array(arr).buffer;

/** requestUrl 成功响应替身 */
function mockResponse(
	overrides: Partial<{
		status: number;
		headers: Record<string, string>;
		arrayBuffer: ArrayBuffer;
	}> = {},
): void {
	vi.mocked(requestUrl).mockResolvedValue({
		status: 200,
		headers: {},
		arrayBuffer: bytesOf([1, 2, 3]),
		...overrides,
	} as Awaited<ReturnType<typeof requestUrl>>);
}

describe("runLimited", () => {
	it("并发不超过 limit 且任务多于车道时满载", async () => {
		let active = 0;
		let peak = 0;
		const out = await runLimited([0, 1, 2, 3, 4, 5], 2, async (i) => {
			active++;
			peak = Math.max(peak, active);
			// 参差时延（0-2ms）制造完成乱序，检验车道补位不越限
			await new Promise((resolve) => setTimeout(resolve, i % 3));
			active--;
			return i;
		});
		expect(out).toEqual([0, 1, 2, 3, 4, 5]);
		expect(peak).toBe(2);
	});

	it("结果按下标对齐（后发起的先完成也不乱序）", async () => {
		const out = await runLimited([10, 20, 30], 3, async (n) => {
			// 首个任务最慢：按完成序输出会整体错位
			await new Promise((resolve) => setTimeout(resolve, n === 10 ? 5 : 0));
			return n * 2;
		});
		expect(out).toEqual([20, 40, 60]);
	});

	it("空输入直接返回空数组（不开车道）", async () => {
		expect(await runLimited([], 3, async (x) => x)).toEqual([]);
	});

	it("worker 抛错向上传播（调用方负责逐项容错）", async () => {
		await expect(
			runLimited([1, 2], 1, async (n) => {
				if (n === 1) {
					throw new Error("boom");
				}
				return n;
			}),
		).rejects.toThrow("boom");
	});
});

describe("fetchImages", () => {
	beforeEach(() => {
		vi.mocked(requestUrl).mockReset();
	});

	it("远程图片按 Content-Type 定扩展名，字节透传（compress=false）", async () => {
		mockResponse({ headers: { "content-type": "image/webp" }, arrayBuffer: bytesOf([9, 9]) });
		const out = await fetchImages([img(0)], { compress: false });
		expect(out).toHaveLength(1);
		expect(out[0]?.ext).toBe("webp");
		expect(Array.from(new Uint8Array(out[0]!.bytes))).toEqual([9, 9]);
	});

	it("CT 为 HTML（图床错误页）判失败，不产假图", async () => {
		mockResponse({ headers: { "content-type": "text/html; charset=utf-8" } });
		expect(await fetchImages([img(0)], { compress: false })).toEqual([null]);
	});

	it("octet-stream / 空 CT 走 URL 后缀兜底", async () => {
		mockResponse({ headers: { "content-type": "application/octet-stream" } });
		const out = await fetchImages([img(0, "https://a.com/static/pic.gif")], {
			compress: false,
		});
		expect(out[0]?.ext).toBe("gif");
	});

	it("无图片后缀的通用 CT 判失败", async () => {
		mockResponse({ headers: { "content-type": "application/octet-stream" } });
		expect(await fetchImages([img(0, "https://a.com/get?id=1")], { compress: false })).toEqual([
			null,
		]);
	});

	it("非 200 判失败", async () => {
		vi.mocked(requestUrl).mockResolvedValue({
			status: 404,
			headers: {},
			arrayBuffer: bytesOf([]),
		} as Awaited<ReturnType<typeof requestUrl>>);
		expect(await fetchImages([img(0)], { compress: false })).toEqual([null]);
	});

	it("data: URI 不走网络直接解码", async () => {
		const ref: MdImageRef = {
			placeholder: "__MMIMG_0__",
			url: null,
			dataUri: "data:image/png;base64,AAAA",
			alt: "",
		};
		const out = await fetchImages([ref], { compress: false });
		expect(out[0]?.ext).toBe("png");
		// atob("AAAA") = 3 个零字节
		expect(Array.from(new Uint8Array(out[0]!.bytes))).toEqual([0, 0, 0]);
		expect(vi.mocked(requestUrl)).not.toHaveBeenCalled();
	});

	it("进度回调从 1 计到总数", async () => {
		mockResponse({ headers: { "content-type": "image/png" } });
		const calls: Array<[number, number]> = [];
		await fetchImages([img(0), img(1), img(2)], {
			compress: false,
			onProgress: (done, total) => calls.push([done, total]),
		});
		expect(calls).toHaveLength(3);
		expect(calls.every(([, total]) => total === 3)).toBe(true);
		expect(calls.map(([done]) => done).sort((a, b) => a - b)).toEqual([1, 2, 3]);
	});
});
