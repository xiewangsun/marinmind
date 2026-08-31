import { describe, expect, it } from "vitest";
import { MarinMindStore } from "../../src/store/marinmind-store";
import { DocumentRepository } from "../../src/db/repositories/document-repo";
import { BookmarkRepository } from "../../src/db/repositories/bookmark-repo";
import { CardRepository } from "../../src/db/repositories/card-repo";
import { MemoryAdapter, dirtyScopeCount } from "../helpers/memory-adapter";

/** 每个用例独立的内存适配器 + 存储（㉚ md 存储版） */
async function openStore(): Promise<{
	store: MarinMindStore;
	adapter: MemoryAdapter;
	documents: DocumentRepository;
	bookmarks: BookmarkRepository;
}> {
	const adapter = new MemoryAdapter();
	const store = await MarinMindStore.open(adapter);
	return {
		store,
		adapter,
		documents: new DocumentRepository(store),
		bookmarks: new BookmarkRepository(store),
	};
}

describe("BookmarkRepository（㉓ 文档书签）", () => {
	it("add / listByDocument：按页码升序（同页按创建时间），字段完整", async () => {
		const { store, documents, bookmarks } = await openStore();
		const doc = documents.upsertByPath("books/a.pdf", "A");
		bookmarks.add(doc.id, 30, "第三章");
		bookmarks.add(doc.id, 5, "第 5 页");
		bookmarks.add(doc.id, 12, "");

		const list = bookmarks.listByDocument(doc.id);
		expect(list.map((b) => b.page)).toEqual([5, 12, 30]);
		expect(list[0].label).toBe("第 5 页");
		expect(list[1].label).toBe(""); // label 由调用方默认，仓储不越权补值
		expect(list[2].documentId).toBe(doc.id);
		expect(list[2].createdAt).toBeGreaterThan(0);
		store.close();
	});

	it("remove：先查后删（无命中不标脏、返回 false）", async () => {
		const { store, adapter, documents, bookmarks } = await openStore();
		const doc = documents.upsertByPath("books/a.pdf", "A");
		const bm = bookmarks.add(doc.id, 8, "起点");
		await store.flush();
		const writesBefore = totalWrites(adapter);

		expect(bookmarks.remove("不存在")).toBe(false);
		expect(dirtyScopeCount(store)).toBe(0); // 无命中不标脏（防写放大）
		await store.flush();
		expect(totalWrites(adapter)).toBe(writesBefore); // flush 零写入（零写契约拦截落盘）

		expect(bookmarks.remove(bm.id)).toBe(true);
		expect(bookmarks.listByDocument(doc.id)).toHaveLength(0);
		expect(bookmarks.remove(bm.id)).toBe(false); // 幂等
		store.close();
	});

	it("删文档级联删书签（应用层 CASCADE 语义）", async () => {
		const { store, documents, bookmarks } = await openStore();
		const cards = new CardRepository(store);
		const docA = documents.upsertByPath("books/a.pdf", "A");
		const docB = documents.upsertByPath("books/b.pdf", "B");
		bookmarks.add(docA.id, 3, "a");
		bookmarks.add(docB.id, 4, "b");
		// A 挂一张卡（验证级联只清 A 的书签，不动 B）
		cards.create({ documentId: docA.id, page: 3, rects: [], excerptType: "area" });

		documents.delete(docA.id);

		expect(bookmarks.listByDocument(docA.id)).toHaveLength(0);
		expect(bookmarks.listByDocument(docB.id)).toHaveLength(1);
		store.close();
	});

	it("文档间书签隔离", async () => {
		const { store, documents, bookmarks } = await openStore();
		const docA = documents.upsertByPath("books/a.pdf", "A");
		const docB = documents.upsertByPath("books/b.pdf", "B");
		bookmarks.add(docA.id, 1, "x");
		expect(bookmarks.listByDocument(docB.id)).toHaveLength(0);
		store.close();
	});
});

/** 适配器累计写次数（防写放大断言用） */
function totalWrites(adapter: MemoryAdapter): number {
	return [...adapter.writeCounts.values()].reduce((a, b) => a + b, 0);
}
