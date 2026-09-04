import { describe, expect, it, vi } from "vitest";
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

describe("DocumentRepository.update lastPage（80 阅读位置记忆）", () => {
	it("三态：传数字设页码 / 传 null 清除 / 不传不动", async () => {
		const store = await MarinMindStore.open(new MemoryAdapter());
		const documents = new DocumentRepository(store);
		const doc = documents.upsertByPath("books/a.pdf", "书A");
		expect(doc.lastPage).toBeNull(); // 新建默认无页码

		expect(documents.update(doc.id, { lastPage: 7 })?.lastPage).toBe(7);
		expect(documents.get(doc.id)?.lastPage).toBe(7);
		// 清除（回到第 1 页）：传 null
		expect(documents.update(doc.id, { lastPage: null })?.lastPage).toBeNull();
		// 不传：不动
		documents.update(doc.id, { lastPage: 5 });
		documents.update(doc.id, { title: "新名" });
		expect(documents.get(doc.id)?.lastPage).toBe(5); // 元数据变更不动页码
		store.close();
	});

	it("lastPage-only 写入不动 updatedAt（翻页高频，不打乱主页「最近」排序）", async () => {
		const store = await MarinMindStore.open(new MemoryAdapter());
		const documents = new DocumentRepository(store);
		const doc = documents.upsertByPath("books/a.pdf", "书A");
		const before = doc.updatedAt;

		vi.useFakeTimers();
		vi.setSystemTime(before + 60_000); // 推进 1 分钟模拟之后翻页
		const next = documents.update(doc.id, { lastPage: 9 });
		expect(next?.lastPage).toBe(9);
		expect(next?.updatedAt).toBe(before); // 保位：时钟已走但 updatedAt 不刷新
		vi.useRealTimers();
		store.close();
	});

	it("混合 patch（元数据 + lastPage）照常刷新 updatedAt", async () => {
		const store = await MarinMindStore.open(new MemoryAdapter());
		const documents = new DocumentRepository(store);
		const doc = documents.upsertByPath("books/a.pdf", "书A");

		vi.useFakeTimers();
		vi.setSystemTime(doc.updatedAt + 60_000);
		const next = documents.update(doc.id, { title: "改名", lastPage: 3 });
		expect(next?.lastPage).toBe(3);
		expect(next?.updatedAt).toBe(doc.updatedAt + 60_000); // 元数据变更刷新
		vi.useRealTimers();
		store.close();
	});
});
