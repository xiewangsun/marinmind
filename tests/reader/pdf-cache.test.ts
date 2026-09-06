import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * pdf-cache 空闲暖窗（112）与引用计数簿记——PdfDocument（pdf.js 耦合）mock 掉，
 * 只测缓存层：暖窗复用 / 到期销毁 / 续期 / LRU 上限 / 替换清理 / 并发单飞。
 * 动机见 pdf-cache.ts 头注释（主页卡片预览每次点击重读重解析 → 秒级延迟）。
 */

// vi.mock 工厂被提升，引用外层变量须经 vi.hoisted 建立绑定
const { openMock } = vi.hoisted(() => ({
	openMock: vi.fn(),
}));

vi.mock("../../src/reader/pdf-document", () => ({
	PdfDocument: { open: (bytes: ArrayBuffer) => openMock(bytes) },
}));

/** 模块级缓存状态：每用例重载模块取干净实例（vi.mock 工厂随 resetModules 重跑） */
async function load() {
	vi.resetModules();
	return await import("../../src/reader/pdf-cache");
}

/** 从句柄上取 mock 出来的 destroy（断言销毁时机用） */
function destroyOf(handle: { doc: unknown }): ReturnType<typeof vi.fn> {
	return (handle.doc as { destroy: ReturnType<typeof vi.fn> }).destroy;
}

const bytes = (len: number) => new ArrayBuffer(len);

describe("112 pdf-cache 空闲暖窗", () => {
	beforeEach(() => {
		vi.useFakeTimers();
		openMock.mockReset();
		openMock.mockImplementation(async (buf: ArrayBuffer) => ({
			destroy: vi.fn(),
			byteLength: buf.byteLength,
		}));
	});
	afterEach(() => {
		vi.useRealTimers();
	});

	it("refs 归零进入暖窗：retainPdf 可借、再次 acquire 复用不重解析", async () => {
		const { acquirePdf, retainPdf, pdfCacheKey } = await load();
		const h1 = await acquirePdf("a.pdf", bytes(10));
		const doc = h1.doc;
		h1.release();
		// 112 前：归零即销毁、retainPdf 必 null——现在 60s 内可借（跳过读字节+重解析）
		const h2 = retainPdf(pdfCacheKey("a.pdf"));
		expect(h2).not.toBeNull();
		expect(h2?.doc).toBe(doc);
		h2?.release();
		const h3 = await acquirePdf(pdfCacheKey("a.pdf"), bytes(10));
		expect(h3.doc).toBe(doc);
		expect(openMock).toHaveBeenCalledTimes(1); // 全程只解析一次
		h3.release();
	});

	it("暖窗到点仍未引用：销毁并清出缓存", async () => {
		const { acquirePdf, retainPdf, pdfCacheKey } = await load();
		const h = await acquirePdf("a.pdf", bytes(10));
		const destroy = destroyOf(h);
		h.release();
		expect(destroy).not.toHaveBeenCalled();
		await vi.advanceTimersByTimeAsync(60_000);
		expect(destroy).toHaveBeenCalledTimes(1);
		expect(retainPdf(pdfCacheKey("a.pdf"))).toBeNull();
	});

	it("暖窗内再次引用会续期：release 重新计时", async () => {
		const { acquirePdf, pdfCacheKey } = await load();
		const h1 = await acquirePdf("a.pdf", bytes(10));
		const destroy = destroyOf(h1);
		h1.release();
		await vi.advanceTimersByTimeAsync(40_000);
		const h2 = await acquirePdf(pdfCacheKey("a.pdf"), bytes(10)); // 命中并清表
		await vi.advanceTimersByTimeAsync(40_000); // 距上次归零已 80s，但期间被引用过
		expect(destroy).not.toHaveBeenCalled();
		h2.release(); // t=80s 重新暖入计时
		await vi.advanceTimersByTimeAsync(59_000);
		expect(destroy).not.toHaveBeenCalled();
		await vi.advanceTimersByTimeAsync(1_000);
		expect(destroy).toHaveBeenCalledTimes(1);
	});

	it("LRU ≤2 份：第三本进入时最久未暖入的被淘汰销毁", async () => {
		const { acquirePdf, retainPdf, pdfCacheKey } = await load();
		const destroys: ReturnType<typeof vi.fn>[] = [];
		for (const key of ["a.pdf", "b.pdf", "c.pdf"]) {
			const h = await acquirePdf(key, bytes(10));
			destroys.push(destroyOf(h));
			h.release();
		}
		expect(retainPdf(pdfCacheKey("a.pdf"))).toBeNull(); // a 淘汰
		const hb = retainPdf(pdfCacheKey("b.pdf"));
		const hc = retainPdf(pdfCacheKey("c.pdf"));
		expect(hb).not.toBeNull();
		expect(hc).not.toBeNull();
		expect(destroys[0]).toHaveBeenCalledTimes(1);
		hb?.release();
		hc?.release();
	});

	it("文件替换（长度不符）：暖窗条目立即让位销毁，新条目就绪", async () => {
		const { acquirePdf, retainPdf, pdfCacheKey } = await load();
		const h1 = await acquirePdf("a.pdf", bytes(10));
		const destroy1 = destroyOf(h1);
		h1.release();
		const h2 = await acquirePdf(pdfCacheKey("a.pdf"), bytes(20)); // 长度不符 → 替换
		expect(destroy1).toHaveBeenCalledTimes(1); // 暖窗条目 refs=0 直接销毁
		expect(openMock).toHaveBeenCalledTimes(2);
		const hr = retainPdf(pdfCacheKey("a.pdf"));
		expect(hr).not.toBeNull(); // 新条目在缓存
		hr?.release();
		h2.release();
	});

	it("并发同 key acquire 单飞：只解析一次、同文档实例", async () => {
		const { acquirePdf } = await load();
		const [h1, h2] = await Promise.all([
			acquirePdf("a.pdf", bytes(10)),
			acquirePdf("a.pdf", bytes(10)),
		]);
		expect(h1.doc).toBe(h2.doc);
		expect(openMock).toHaveBeenCalledTimes(1);
		h1.release();
		h2.release();
	});
});
