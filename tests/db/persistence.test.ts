import { describe, expect, it } from "vitest";
import { MarinMindStore } from "../../src/store/marinmind-store";
import { MD_FORMAT_VERSION } from "../../src/store/book-format";
import { DocumentRepository } from "../../src/db/repositories/document-repo";
import { CardRepository } from "../../src/db/repositories/card-repo";
import { ReviewRepository } from "../../src/db/repositories/review-repo";
import { BookmarkRepository } from "../../src/db/repositories/bookmark-repo";
import { MindmapRepository } from "../../src/db/repositories/mindmap-repo";
import { MemoryAdapter, textOf, dirtyScopeCount } from "../helpers/memory-adapter";

describe("Markdown 存储持久化（㉚）", () => {
	it("写入经 flush 落盘为 md 文件，重开后数据完整恢复", async () => {
		const adapter = new MemoryAdapter();
		const store1 = await MarinMindStore.open(adapter);
		const doc = new DocumentRepository(store1).upsertByPath("books/rl.pdf", "强化学习");
		const card = new CardRepository(store1).create({
			documentId: doc.id,
			page: 5,
			rects: [{ x: 0, y: 0, w: 0.5, h: 0.1 }],
			excerptType: "text",
			excerptText: "贝尔曼方程",
			tags: ["动态规划"],
		});
		new ReviewRepository(store1).enable(card.id);
		await store1.flush();
		store1.close();

		// md 文件确实写入（文件名 = 书名）
		expect(adapter.files.has("强化学习.md")).toBe(true);
		expect(textOf(adapter, "强化学习.md")).toContain("贝尔曼方程");

		const store2 = await MarinMindStore.open(adapter);
		const restored = new CardRepository(store2).get(card.id);
		expect(restored?.excerptText).toBe("贝尔曼方程");
		expect(restored?.rects).toEqual([{ x: 0, y: 0, w: 0.5, h: 0.1 }]);
		expect(new ReviewRepository(store2).dueCount(Number.MAX_SAFE_INTEGER)).toBe(1);
		expect(store2.formatVersion).toBe(MD_FORMAT_VERSION);
		store2.close();
	});

	it("重开后未触碰的文件保持原字节（loadAll 不重写）", async () => {
		const adapter = new MemoryAdapter();
		const store1 = await MarinMindStore.open(adapter);
		new DocumentRepository(store1).upsertByPath("books/rl.pdf", "强化学习");
		await store1.flush();
		store1.close();
		const raw = textOf(adapter, "强化学习.md");
		const writes = adapter.writeCounts.get("强化学习.md");

		const store2 = await MarinMindStore.open(adapter);
		await store2.flush(); // 无任何改动
		expect(textOf(adapter, "强化学习.md")).toBe(raw);
		expect(adapter.writeCounts.get("强化学习.md")).toBe(writes);
		store2.close();
	});

	it("套索多边形字段持久化：polygon 随卡片落盘往返", async () => {
		const adapter = new MemoryAdapter();
		const store1 = await MarinMindStore.open(adapter);
		const doc = new DocumentRepository(store1).upsertByPath("lasso.pdf", "套索书");
		new CardRepository(store1).create({
			documentId: doc.id,
			page: 7,
			rects: [{ x: 0.1, y: 0.1, w: 0.5, h: 0.4 }], // bbox
			polygon: [
				{ x: 0.1, y: 0.1 },
				{ x: 0.6, y: 0.12 },
				{ x: 0.55, y: 0.5 },
				{ x: 0.12, y: 0.48 },
			],
			excerptType: "lasso",
			color: "orange",
		});
		await store1.flush();
		store1.close();

		const store2 = await MarinMindStore.open(adapter);
		const cards = new CardRepository(store2).listByDocument(doc.id);
		expect(cards).toHaveLength(1);
		expect(cards[0].polygon).toEqual([
			{ x: 0.1, y: 0.1 },
			{ x: 0.6, y: 0.12 },
			{ x: 0.55, y: 0.5 },
			{ x: 0.12, y: 0.48 },
		]);
		expect(cards[0].color).toBe("orange");
		store2.close();
	});

	it("书签持久化：label 与页码落盘往返（含默认名净化）", async () => {
		const adapter = new MemoryAdapter();
		const store1 = await MarinMindStore.open(adapter);
		const doc = new DocumentRepository(store1).upsertByPath("books/a.pdf", "书签书");
		const bookmarks = new BookmarkRepository(store1);
		bookmarks.add(doc.id, 12, "章节名");
		await store1.flush();
		store1.close();

		const store2 = await MarinMindStore.open(adapter);
		const list = new BookmarkRepository(store2).listByDocument(doc.id);
		expect(list).toHaveLength(1);
		expect(list[0].page).toBe(12);
		expect(list[0].label).toBe("章节名"); // 生成的页码后缀被剥离
		store2.close();
	});

	it("脑图持久化：节点树 + 折叠态 + 坐标落盘往返（wikilink 指向书文件）", async () => {
		const adapter = new MemoryAdapter();
		const store1 = await MarinMindStore.open(adapter);
		const documents = new DocumentRepository(store1);
		const cards = new CardRepository(store1);
		const mindmaps = new MindmapRepository(store1);
		const doc = documents.upsertByPath("books/g.pdf", "图论");
		const c1 = cards.create({
			documentId: doc.id,
			page: 1,
			rects: [],
			excerptType: "text",
			excerptText: "根",
		});
		const c2 = cards.create({
			documentId: doc.id,
			page: 2,
			rects: [],
			excerptType: "text",
			excerptText: "子",
		});
		const map = mindmaps.create("学习图");
		const n1 = mindmaps.addNode(map.id, c1.id, null, 0, 0)!;
		mindmaps.addNode(map.id, c2.id, n1.id, 300, 40);
		mindmaps.setCollapsed(n1.id, true);
		await store1.flush();
		store1.close();

		expect(textOf(adapter, "脑图/学习图.md")).toContain("[[图论#^card-");

		const store2 = await MarinMindStore.open(adapter);
		const maps2 = new MindmapRepository(store2);
		const nodes = maps2.listNodes(map.id);
		expect(nodes).toHaveLength(2);
		const parent = nodes.find((n) => n.parentId === null)!;
		const child = nodes.find((n) => n.parentId === parent.id)!;
		expect(parent.collapsed).toBe(true);
		expect(child.x).toBe(300);
		store2.close();
	});

	it("脏粒度：改书 A 不重写书 B（分文件落盘）", async () => {
		const adapter = new MemoryAdapter();
		const store = await MarinMindStore.open(adapter);
		const documents = new DocumentRepository(store);
		const cards = new CardRepository(store);
		const docA = documents.upsertByPath("books/a.pdf", "书A");
		const docB = documents.upsertByPath("books/b.pdf", "书B");
		cards.create({
			documentId: docA.id,
			page: 1,
			rects: [],
			excerptType: "text",
			excerptText: "a",
		});
		cards.create({
			documentId: docB.id,
			page: 1,
			rects: [],
			excerptType: "text",
			excerptText: "b",
		});
		await store.flush();
		const writesB = adapter.writeCounts.get("书B.md");

		cards.update(cards.listByDocument(docA.id)[0].id, { note: "只改 A" });
		await store.flush();
		expect(adapter.writeCounts.get("书B.md")).toBe(writesB);
		expect(textOf(adapter, "书A.md")).toContain("只改 A");
		store.close();
	});

	it("重复打开同一文档不触发整书落盘（touch 只改内存不标脏）", async () => {
		const adapter = new MemoryAdapter();
		const store = await MarinMindStore.open(adapter);
		const documents = new DocumentRepository(store);
		documents.upsertByPath("books/rl.pdf", "强化学习");
		await store.flush();
		const raw = textOf(adapter, "强化学习.md");
		const writes = adapter.writeCounts.get("强化学习.md");
		expect(dirtyScopeCount(store)).toBe(0);

		// 同路径同标题重复打开：内存 updatedAt 更新（最近文档排序仍即时），
		// 但不标脏不落盘——打开 2s 后的整书序列化 + 重写随之消失
		const again = documents.upsertByPath("books/rl.pdf", "强化学习");
		expect(dirtyScopeCount(store)).toBe(0);
		expect(again.updatedAt).toBeGreaterThan(0);
		await store.flush();
		expect(adapter.writeCounts.get("强化学习.md")).toBe(writes);
		expect(textOf(adapter, "强化学习.md")).toBe(raw);
		store.close();
	});

	it("打开后标题变化仍走完整 upsert（文件名跟随重命名 + 落盘）", async () => {
		const adapter = new MemoryAdapter();
		const store = await MarinMindStore.open(adapter);
		const documents = new DocumentRepository(store);
		const doc = documents.upsertByPath("books/rl.pdf", "旧书名");
		await store.flush();

		documents.upsertByPath("books/rl.pdf", "新书名");
		await store.flush();
		expect(adapter.files.has("旧书名.md")).toBe(false);
		expect(adapter.files.has("新书名.md")).toBe(true);
		expect(documents.getByPath("books/rl.pdf")?.id).toBe(doc.id);
		store.close();
	});

	it("loadAll 并行读取不改变吸收顺序（文档列表仍按文件顺序）", async () => {
		// 按读取完成顺序乱序到达的字节：若吸收随完成顺序漂移，列表顺序不稳定
		class StaggeredAdapter extends MemoryAdapter {
			readonly delays = new Map<string, number>();
			async readBinary(path: string): Promise<ArrayBuffer> {
				const ms = this.delays.get(path) ?? 0;
				if (ms > 0) await new Promise((r) => setTimeout(r, ms));
				return super.readBinary(path);
			}
		}
		const adapter = new StaggeredAdapter();
		const seed = await MarinMindStore.open(adapter);
		const documents = new DocumentRepository(seed);
		documents.upsertByPath("books/1.pdf", "甲书");
		documents.upsertByPath("books/2.pdf", "乙书");
		documents.upsertByPath("books/3.pdf", "丙书");
		await seed.flush();
		seed.close();

		// 文件顺序 甲乙丙，读取完成顺序故意打乱为 丙乙甲（乙最慢）
		adapter.delays.set("乙书.md", 30);
		adapter.delays.set("丙书.md", 15);
		const store = await MarinMindStore.open(adapter);
		const titles = [...store.books.values()].map((b) => b.doc.title);
		expect(titles).toEqual(["甲书", "乙书", "丙书"]);
		store.close();
	});
});
