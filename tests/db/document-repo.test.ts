import { describe, expect, it } from "vitest";
import { MarinMindStore } from "../../src/store/marinmind-store";
import { DocumentRepository } from "../../src/db/repositories/document-repo";
import { CardRepository } from "../../src/db/repositories/card-repo";
import { MemoryAdapter, dirtyScopeCount } from "../helpers/memory-adapter";

describe("DocumentRepository.renamePath", () => {
	it("路径命中：更新业务键且返回 true，卡片原地跟随（id 不变）", async () => {
		const adapter = new MemoryAdapter();
		const store = await MarinMindStore.open(adapter);
		const documents = new DocumentRepository(store);
		const cards = new CardRepository(store);
		const doc = documents.upsertByPath("books/old.pdf", "旧位置");
		const card = cards.create({
			documentId: doc.id,
			page: 1,
			rects: [],
			excerptType: "area",
		});

		expect(documents.renamePath("books/old.pdf", "moved/new.pdf")).toBe(true);

		const moved = documents.getByPath("moved/new.pdf");
		expect(moved?.id).toBe(doc.id); // 记录 id 不变，卡片零迁移
		expect(cards.get(card.id)?.documentId).toBe(doc.id);
		expect(documents.getByPath("books/old.pdf")).toBeUndefined();
		store.close();
	});

	it("路径未命中：返回 false 且不标脏（无写放大——零写契约拦截落盘）", async () => {
		const adapter = new MemoryAdapter();
		const store = await MarinMindStore.open(adapter);
		const documents = new DocumentRepository(store);
		documents.upsertByPath("books/a.pdf", "A");
		await store.flush();
		const writesBefore = [...adapter.writeCounts.values()].reduce((a, b) => a + b, 0);

		// 模拟 vault 内无关文件改名：数据层无此路径
		expect(documents.renamePath("notes/无关笔记.md", "notes/改名.md")).toBe(false);

		// 未发生任何标脏：脏 scope 集为空，flush 零写入
		expect(dirtyScopeCount(store)).toBe(0);
		await store.flush();
		const writesAfter = [...adapter.writeCounts.values()].reduce((a, b) => a + b, 0);
		expect(writesAfter).toBe(writesBefore);
		store.close();
	});
});

describe("DocumentRepository 库外绝对路径（㉞ 双语义业务键）", () => {
	it("绝对路径建档 + getByPath 同串命中", async () => {
		const adapter = new MemoryAdapter();
		const store = await MarinMindStore.open(adapter);
		const documents = new DocumentRepository(store);
		const abs = "D:\\Books 库外\\深度学习.pdf";
		const doc = documents.upsertByPath(abs, "深度学习");

		expect(documents.getByPath(abs)?.id).toBe(doc.id);
		// 与库内相对路径互不串键
		expect(documents.getByPath("深度学习.pdf")).toBeUndefined();
		store.close();
	});

	it("renamePath 绝对→绝对：更新业务键且卡片原地跟随", async () => {
		const adapter = new MemoryAdapter();
		const store = await MarinMindStore.open(adapter);
		const documents = new DocumentRepository(store);
		const cards = new CardRepository(store);
		const oldPath = "D:\\Books\\旧名.pdf";
		const newPath = "D:\\Books\\新名.pdf";
		const doc = documents.upsertByPath(oldPath, "旧名");
		const card = cards.create({
			documentId: doc.id,
			page: 3,
			rects: [],
			excerptType: "area",
		});

		expect(documents.renamePath(oldPath, newPath)).toBe(true);

		const moved = documents.getByPath(newPath);
		expect(moved?.id).toBe(doc.id);
		expect(cards.get(card.id)?.documentId).toBe(doc.id);
		expect(documents.getByPath(oldPath)).toBeUndefined();
		store.close();
	});
});
