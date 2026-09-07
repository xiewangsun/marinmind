/**
 * 存量剪藏迁移单测（124）：collectLegacyClipImageRefs 纯函数（三种旧引用
 * 转义形态）+ migrateLegacyWebclips 集成（vault 旧目录 → 数据根 clips/、
 * 图片经 attachments.save 入 assets/、documents.renamePath 业务键同步、
 * 幂等跳过）。物理形态：单一内存地图代表整个 vault（根层 WebClips/ +
 * MarinMind/ 数据根），dataLoc.adapter 用真实 VaultRootedAdapter 前缀视图，
 * vault.createBinary 与前缀视图落同一物理位置（与生产一致）。obsidian 仅
 * Notice（迁移汇总），mock 替身。
 */
import { describe, expect, it, vi } from "vitest";

vi.mock("obsidian", () => ({ Notice: class {} }));

import type { DataAdapter } from "obsidian";
import type MarinMindPlugin from "../../src/main";
import { MarinMindStore } from "../../src/store/marinmind-store";
import { DocumentRepository } from "../../src/db/repositories/document-repo";
import { AttachmentStore } from "../../src/attachments/attachment-store";
import { VaultRootedAdapter } from "../../src/storage/vault-rooted-adapter";
import {
	collectLegacyClipImageRefs,
	migrateLegacyWebclips,
} from "../../src/webclip/webclip-migrate";
import { MemoryAdapter, textOf, writeText } from "../helpers/memory-adapter";

const bytesOf = (arr: number[]): ArrayBuffer => new Uint8Array(arr).buffer as ArrayBuffer;
const ROOT = "MarinMind"; // 数据根（vault 内目录）

describe("collectLegacyClipImageRefs（旧 .assets 引用抽取）", () => {
	it("三种合法形态：裸路径 / %20 编码 / <> 包裹", () => {
		const text = [
			"![a](笔记.assets/1.png)",
			"![b](my%20note.assets/2.jpg)",
			"![c](<名(1).assets/3.png>)",
			"![r](https://a.com/x.png)", // 远程不收
			"[非图片链接](other.assets/4.png)", // 非图片语法不收
		].join("\n");
		expect(collectLegacyClipImageRefs(text)).toEqual([
			"笔记.assets/1.png",
			"my%20note.assets/2.jpg",
			"名(1).assets/3.png",
		]);
	});
});

/**
 * vault 数据根形态的 fake plugin：单张内存地图即整个 vault，
 * 数据根访问经真实 VaultRootedAdapter（MarinMind/ 前缀）。
 */
async function makePlugin(adapter: MemoryAdapter) {
	const rooted = new VaultRootedAdapter(adapter as unknown as DataAdapter, ROOT);
	const store = await MarinMindStore.open(rooted);
	return {
		plugin: {
			app: {
				vault: {
					adapter,
					// vault.createBinary：入 vault 索引的同物理位置落盘（内存形态等价写地图）
					createBinary: async (path: string, data: ArrayBuffer) => {
						await adapter.writeBinary(path, data);
					},
				},
			},
			dataLoc: { kind: "vault", rootDir: ROOT, adapter: rooted },
			clipOpenTarget: (rel: string) => `${ROOT}/${rel}`,
			attachments: new AttachmentStore(rooted),
			documents: new DocumentRepository(store),
		} as unknown as MarinMindPlugin,
		store,
	};
}

describe("migrateLegacyWebclips（存量迁移执行器）", () => {
	it("整篇迁移：md 入 clips/、图入 assets/、引用重写、业务键同步、旧文件删除", async () => {
		const adapter = new MemoryAdapter();
		const { plugin, store } = await makePlugin(adapter);
		// 旧存量：md + 同名 .assets 图片 + 一条已登记文档
		writeText(
			adapter,
			"WebClips/笔记A.md",
			"---\nsource: https://a.com\n---\n\n正文\n\n![图](笔记A.assets/1.png)\n",
		);
		adapter.files.set("WebClips/笔记A.assets/1.png", bytesOf([8, 8]));
		const doc = plugin.documents.upsertByPath("WebClips/笔记A.md", "笔记A");
		// 空格标题的 %20 编码形态（md 文件名保空格，md 内引用百分号编码）
		writeText(adapter, "WebClips/my note.md", "![b](my%20note.assets/2.jpg)\n");
		adapter.files.set("WebClips/my note.assets/2.jpg", bytesOf([6]));

		const result = await migrateLegacyWebclips(plugin, null);
		expect(result).toEqual({ moved: 2, skipped: 0, failed: 0 });

		const md = textOf(adapter, `${ROOT}/clips/笔记A.md`);
		expect(md).toContain("source: https://a.com");
		const local = /!\[图\]\((assets\/[A-Za-z0-9-]+\.png)\)/.exec(md);
		expect(local).not.toBeNull();
		const assetBytes = adapter.files.get(`${ROOT}/${local![1]}`)!;
		expect([...new Uint8Array(assetBytes)]).toEqual([8, 8]);
		// %20 形态同样重写为 assets/
		expect(textOf(adapter, `${ROOT}/clips/my note.md`)).toMatch(
			/!\[b\]\(assets\/[A-Za-z0-9-]+\.jpg\)/,
		);
		// 业务键同步：documentId 不变，路径指向数据根内新位置
		expect(plugin.documents.getByPath(`${ROOT}/clips/笔记A.md`)?.id).toBe(doc.id);
		// 旧文件（md 与图片）删除
		expect(adapter.files.has("WebClips/笔记A.md")).toBe(false);
		expect(adapter.files.has("WebClips/笔记A.assets/1.png")).toBe(false);
		expect(adapter.files.has("WebClips/my note.md")).toBe(false);
		expect(adapter.files.has("WebClips/my note.assets/2.jpg")).toBe(false);
		store.close();
	});

	it("幂等：目录已空再跑零动作；clips 同名跳过且旧文件保留", async () => {
		const adapter = new MemoryAdapter();
		const { plugin, store } = await makePlugin(adapter);
		// clips 已有同名（上次迁移残留 / 用户自建）→ 该篇跳过，旧文件不动
		writeText(adapter, `${ROOT}/clips/笔记A.md`, "已存在");
		writeText(adapter, "WebClips/笔记A.md", "旧内容");

		const result = await migrateLegacyWebclips(plugin, null);
		expect(result).toEqual({ moved: 0, skipped: 1, failed: 0 });
		expect(textOf(adapter, "WebClips/笔记A.md")).toBe("旧内容");
		expect(textOf(adapter, `${ROOT}/clips/笔记A.md`)).toBe("已存在");

		// 清掉旧文件后（目录空）再跑：全零
		adapter.files.delete("WebClips/笔记A.md");
		expect(await migrateLegacyWebclips(plugin, null)).toEqual({
			moved: 0,
			skipped: 0,
			failed: 0,
		});
		store.close();
	});

	it("自定义旧目录（legacyFolder 提取值）同样迁移；未登记文档无业务键动作", async () => {
		const adapter = new MemoryAdapter();
		const { plugin, store } = await makePlugin(adapter);
		writeText(adapter, "MyClips/私有目录.md", "纯文字剪藏\n");

		const result = await migrateLegacyWebclips(plugin, "MyClips");
		expect(result).toEqual({ moved: 1, skipped: 0, failed: 0 });
		expect(textOf(adapter, `${ROOT}/clips/私有目录.md`)).toBe("纯文字剪藏\n");
		// 从未打开过的剪藏无文档记录：getByPath 落空（renamePath 静默返回 false）
		expect(plugin.documents.getByPath(`${ROOT}/clips/私有目录.md`)).toBeUndefined();
		store.close();
	});

	it("旧图片字节缺失：该篇失败留原处，其余篇目照常迁移", async () => {
		const adapter = new MemoryAdapter();
		const { plugin, store } = await makePlugin(adapter);
		writeText(adapter, "WebClips/坏图.md", "![x](坏图.assets/1.png)\n"); // 图片不存在
		writeText(adapter, "WebClips/好篇.md", "文字\n");

		const result = await migrateLegacyWebclips(plugin, null);
		expect(result).toEqual({ moved: 1, skipped: 0, failed: 1 });
		expect(adapter.files.has("WebClips/坏图.md")).toBe(true); // 失败篇保留
		expect(adapter.files.has(`${ROOT}/clips/好篇.md`)).toBe(true);
		store.close();
	});
});
