import { describe, expect, it } from "vitest";
import { collectClipAssetRefs, localizeClipImageRefs } from "../../src/webclip/clip-md";

/** 组装 fake blob URL（不依赖浏览器 createObjectURL；字节可回溯） */
const fakeUrl = (bytes: ArrayBuffer): string => `blob:fake-${new Uint8Array(bytes).length}`;

describe("collectClipAssetRefs（assets 引用抽取）", () => {
	it("抓取 md 图片目标里的 assets/ 引用并去重", () => {
		const text = [
			"![a](assets/abc-1.png)",
			"正文一段",
			"![b](assets/abc-2.jpg)",
			"![a2](assets/abc-1.png)", // 重复
			"",
		].join("\n");
		expect(collectClipAssetRefs(text)).toEqual(["assets/abc-1.png", "assets/abc-2.jpg"]);
	});

	it("远程/行内链接不收；正文纯文本提及 assets/ 宽松收（宁保留不误删）", () => {
		const text = "![r](https://a.com/x.png)\n\n提及 assets/xyz-9.webp 这个词\n";
		expect(collectClipAssetRefs(text)).toEqual(["assets/xyz-9.webp"]);
	});

	it("无引用返回空数组", () => {
		expect(collectClipAssetRefs("# 标题\n\n纯文本")).toEqual([]);
	});
});

describe("localizeClipImageRefs（渲染前 blob 替换）", () => {
	it("全部命中替换为 blob URL，逐引用读取", async () => {
		const read = new Map<string, ArrayBuffer>([
			["assets/a.png", new Uint8Array([1]).buffer as ArrayBuffer],
			["assets/b.png", new Uint8Array([2, 2]).buffer as ArrayBuffer],
		]);
		const reads: string[] = [];
		const out = await localizeClipImageRefs(
			"![x](assets/a.png)\n\n![y](assets/b.png)",
			async (ref) => {
				reads.push(ref);
				return read.get(ref)!;
			},
			fakeUrl,
		);
		expect(reads).toEqual(["assets/a.png", "assets/b.png"]);
		expect(out.text).toBe("![x](blob:fake-1)\n\n![y](blob:fake-2)");
		expect(out.blobUrls).toEqual(["blob:fake-1", "blob:fake-2"]);
	});

	it("读取失败的引用保留原字面（裂图优于抹除），成功项照常替换", async () => {
		const out = await localizeClipImageRefs(
			"![x](assets/ok.png) ![y](assets/gone.png)",
			async (ref) => {
				if (ref === "assets/gone.png") throw new Error("文件不存在");
				return new Uint8Array([7]).buffer as ArrayBuffer;
			},
			fakeUrl,
		);
		expect(out.text).toBe("![x](blob:fake-1) ![y](assets/gone.png)");
		expect(out.blobUrls).toEqual(["blob:fake-1"]);
	});

	it("无引用：文本原样、零 blob", async () => {
		const out = await localizeClipImageRefs(
			"纯文本",
			async () => {
				throw new Error("不应读取");
			},
			fakeUrl,
		);
		expect(out).toEqual({ text: "纯文本", blobUrls: [] });
	});
});
