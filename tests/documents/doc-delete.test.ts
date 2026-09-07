/**
 * doc-delete 单测（113 批）：删除文档记录单源——逐卡清附件（仅有 excerptRef
 * 的卡；单个失败不阻断）→ documents.delete 级联。obsidian 以 vi.mock 替身
 * （Notice 断言 + Modal/ButtonComponent 桩供 ConfirmModal 类定义——本文件
 * 不实例化弹窗）；附件仓以 spy 桩（真实 AttachmentStore 走文件系统）；
 * documents/cards 用真实仓储 + MemoryAdapter（镜像 relink.test 先例）。
 */
import { describe, expect, it, vi } from "vitest";

vi.mock("obsidian", () => ({
	Notice: vi.fn(),
	// ConfirmModal extends Modal——仅类定义所需
	Modal: class {},
	ButtonComponent: class {},
}));

import { Notice } from "obsidian";
import { MarinMindStore } from "../../src/store/marinmind-store";
import { DocumentRepository } from "../../src/db/repositories/document-repo";
import { CardRepository } from "../../src/db/repositories/card-repo";
import { deleteDocumentRecord } from "../../src/documents/doc-delete";
import { MemoryAdapter } from "../helpers/memory-adapter";
import type MarinMindPlugin from "../../src/main";

interface Rig {
	store: MarinMindStore;
	documents: DocumentRepository;
	cards: CardRepository;
	removeAttachment: ReturnType<typeof vi.fn>;
	plugin: MarinMindPlugin;
}

/** 每个用例独立内存库 + 附件删除 spy 桩 */
async function makeRig(): Promise<Rig> {
	const store = await MarinMindStore.open(new MemoryAdapter());
	const documents = new DocumentRepository(store);
	const cards = new CardRepository(store);
	const removeAttachment = vi.fn().mockResolvedValue(undefined);
	const plugin = {
		whenReady: () => Promise.resolve(),
		cards,
		documents,
		attachments: { remove: removeAttachment },
	} as unknown as MarinMindPlugin;
	return { store, documents, cards, removeAttachment, plugin };
}

describe("deleteDocumentRecord 删除文档记录", () => {
	it("逐卡清附件（仅有 excerptRef 的卡）→ 删文档行级联卡片 → true", async () => {
		const rig = await makeRig();
		const doc = rig.documents.upsertByPath("books/a.pdf", "A");
		rig.cards.create({
			documentId: doc.id,
			page: 1,
			rects: [],
			excerptType: "handwriting",
			excerptRef: "assets/ink.webp",
		});
		rig.cards.create({
			documentId: doc.id,
			page: 1,
			rects: [],
			excerptType: "text",
			excerptText: "无附件卡",
		});

		const ok = await deleteDocumentRecord(rig.plugin, doc);

		expect(ok).toBe(true);
		expect(rig.removeAttachment).toHaveBeenCalledTimes(1);
		expect(rig.removeAttachment).toHaveBeenCalledWith("assets/ink.webp");
		expect(rig.cards.listByDocument(doc.id)).toHaveLength(0); // 级联清卡
		expect(rig.documents.get(doc.id)).toBeUndefined(); // 文档行已删
		expect(Notice).toHaveBeenCalledWith("文档记录已删除");
	});

	it("单个附件删除失败不阻断（幂等容错——缺失文件照常完成删除）", async () => {
		const rig = await makeRig();
		const doc = rig.documents.upsertByPath("books/b.pdf", "B");
		rig.cards.create({
			documentId: doc.id,
			page: 2,
			rects: [],
			excerptType: "area",
			excerptRef: "assets/gone.png",
		});
		rig.removeAttachment.mockRejectedValue(new Error("ENOENT"));

		const ok = await deleteDocumentRecord(rig.plugin, doc);

		expect(ok).toBe(true);
		expect(rig.documents.get(doc.id)).toBeUndefined();
	});

	it("删行抛错 → false + 失败 Notice（不吞异常）", async () => {
		const rig = await makeRig();
		const doc = rig.documents.upsertByPath("books/c.pdf", "C");
		vi.spyOn(rig.documents, "delete").mockImplementation(() => {
			throw new Error("db locked");
		});

		const ok = await deleteDocumentRecord(rig.plugin, doc);

		expect(ok).toBe(false);
		const last = vi.mocked(Notice).mock.calls.at(-1)?.[0];
		expect(String(last)).toContain("db locked");
	});
});
