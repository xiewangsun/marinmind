/**
 * saveWebclip 数据根落盘单测（124）：fs 数据根形态（adapter IO，不依赖 vault
 * 索引）。obsidian 仅 requestUrl（网络层，本文件不触发）与 Notice（media-import
 * 传递依赖）——均 mock 替身。vault 数据根分支（vault.createBinary 入索引）属
 * 桌面集成路径，不在此覆盖。
 */
import { describe, expect, it, vi } from "vitest";

vi.mock("obsidian", () => ({ requestUrl: vi.fn(), Notice: class {} }));

import type MarinMindPlugin from "../../src/main";
import { AttachmentStore } from "../../src/attachments/attachment-store";
import { saveWebclip, type SaveWebclipInput } from "../../src/webclip/webclip-service";
import type { MdImageRef } from "../../src/webclip/html-to-md";
import { MemoryAdapter, textOf } from "../helpers/memory-adapter";

const bytesOf = (arr: number[]): ArrayBuffer => new Uint8Array(arr).buffer as ArrayBuffer;

/** fs 数据根形态的 fake plugin（saveWebclip 只触及 dataLoc 与 attachments） */
function makePlugin(adapter: MemoryAdapter, attachments?: AttachmentStore): MarinMindPlugin {
	return {
		dataLoc: { kind: "fs", rootDir: "D:\\MarinMindData", adapter },
		attachments: attachments ?? new AttachmentStore(adapter),
	} as unknown as MarinMindPlugin;
}

const ref = (i: number, url: string | null): MdImageRef => ({
	placeholder: `__MMIMG_${i}__`,
	url,
	dataUri: null,
	alt: "",
});

function input(overrides: Partial<SaveWebclipInput> = {}): SaveWebclipInput {
	return {
		title: "强化学习入门",
		markdown: "# 标题\n\n![图一](__MMIMG_0__)\n\n![远程](__MMIMG_1__)\n",
		images: [ref(0, "https://a.com/0.png"), ref(1, "https://a.com/1.png")],
		fetched: [{ bytes: bytesOf([9, 9, 9]), ext: "png" }, null],
		sourceUrl: "https://example.com/article",
		...overrides,
	};
}

describe("saveWebclip（124 数据根落盘）", () => {
	it("md 落 clips/、图片经 attachments.save 进 assets/、引用写根相对路径", async () => {
		const adapter = new MemoryAdapter();
		const saved = await saveWebclip(makePlugin(adapter), input());
		expect(saved).toMatchObject({
			path: "clips/强化学习入门.md",
			imagesSaved: 1,
			imagesFallback: 1,
		});

		const md = textOf(adapter, "clips/强化学习入门.md");
		// frontmatter：source + clipped（无 marinmind: 键，防书文件认领）
		expect(md).toContain("source: https://example.com/article");
		expect(md).toContain("clipped: ");
		expect(md).not.toContain("marinmind:");
		// 引用形态：本地图 → assets/uid.ext；失败图回退远程 URL
		const local = /!\[图一\]\((assets\/[A-Za-z0-9-]+\.[a-z]+)\)/.exec(md);
		expect(local).not.toBeNull();
		expect(md).toContain("![远程](https://a.com/1.png)");
		// 附件字节落 assets/ 且与 fetched 一致
		const assetPath = local![1]!;
		expect([...new Uint8Array(adapter.files.get(assetPath)!)]).toEqual([9, 9, 9]);
	});

	it("同名冲突 -2 递增（clips/ 既有文件名让路）", async () => {
		const adapter = new MemoryAdapter();
		adapter.files.set("clips/强化学习入门.md", bytesOf([1]));
		const saved = await saveWebclip(makePlugin(adapter), input());
		expect(saved.path).toBe("clips/强化学习入门-2.md");
	});

	it("标题非法字符净化 + 空标题回退「网页剪藏」", async () => {
		const adapter = new MemoryAdapter();
		const saved = await saveWebclip(makePlugin(adapter), input({ title: "a/b:c?d  " }));
		expect(saved.path).toBe("clips/a b c d.md");
		const saved2 = await saveWebclip(makePlugin(adapter), input({ title: "  " }));
		expect(saved2.path).toBe("clips/网页剪藏.md");
	});

	it("单图落盘失败（超上限等）回退远程链接，不中断整篇", async () => {
		const adapter = new MemoryAdapter();
		const failing = {
			save: vi.fn().mockRejectedValue(new Error("附件超过 20MB 上限")),
		} as unknown as AttachmentStore;
		const saved = await saveWebclip(makePlugin(adapter, failing), input());
		expect(saved).toMatchObject({ imagesSaved: 0, imagesFallback: 2 });
		expect(textOf(adapter, "clips/强化学习入门.md")).toContain("![图一](https://a.com/0.png)");
	});

	it("无图片：纯文本 md 直接落盘（assets/ 不创建）", async () => {
		const adapter = new MemoryAdapter();
		const saved = await saveWebclip(
			makePlugin(adapter),
			input({ markdown: "# 只有文字\n", images: [], fetched: [] }),
		);
		expect(saved).toMatchObject({
			path: "clips/强化学习入门.md",
			imagesSaved: 0,
			imagesFallback: 0,
		});
		expect([...adapter.files.keys()]).toEqual(["clips/强化学习入门.md"]);
	});
});
