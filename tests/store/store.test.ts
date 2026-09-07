import { describe, expect, it } from "vitest";
import type { BookDocument, Card, Mindmap, MindmapNode, ReviewState } from "../../src/types";
import { newId } from "../../src/utils";
import type { ListableStorageAdapter } from "../../src/storage/vault-rooted-adapter";
import { MarinMindStore, ORPHAN_SCOPE } from "../../src/store/marinmind-store";
import { defaultReviewState } from "../../src/store/book-format";
import { serializeGroupListMd } from "../../src/store/group-list";

/** 内存版可列举适配器：模拟 vault.adapter，并按路径统计写次数（零写契约断言用） */
class MemoryAdapter implements ListableStorageAdapter {
	files = new Map<string, ArrayBuffer>();
	writeCounts = new Map<string, number>();

	exists(path: string): Promise<boolean> {
		return Promise.resolve(this.files.has(path));
	}
	mkdir(): Promise<void> {
		return Promise.resolve();
	}
	readBinary(path: string): Promise<ArrayBuffer> {
		const data = this.files.get(path);
		if (!data) return Promise.reject(new Error(`文件不存在: ${path}`));
		return Promise.resolve(data);
	}
	writeBinary(path: string, data: ArrayBuffer): Promise<void> {
		this.writeCounts.set(path, (this.writeCounts.get(path) ?? 0) + 1);
		this.files.set(path, data);
		return Promise.resolve();
	}
	remove(path: string): Promise<void> {
		this.files.delete(path);
		return Promise.resolve();
	}
	list(dir: string): Promise<{ files: string[]; folders: string[] }> {
		const prefix = dir ? `${dir}/` : "";
		const files: string[] = [];
		const folders: string[] = [];
		for (const p of this.files.keys()) {
			if (!p.startsWith(prefix)) continue;
			const rest = p.slice(prefix.length);
			const slash = rest.indexOf("/");
			if (slash >= 0) {
				const folder = prefix + rest.slice(0, slash);
				if (!folders.includes(folder)) folders.push(folder);
			} else {
				files.push(p);
			}
		}
		return Promise.resolve({ files, folders });
	}
}

function textOf(adapter: MemoryAdapter, path: string): string {
	return new TextDecoder().decode(adapter.files.get(path)!);
}

function writeText(adapter: MemoryAdapter, path: string, text: string): void {
	adapter.files.set(path, new TextEncoder().encode(text).buffer as ArrayBuffer);
}

function doc(partial: Partial<BookDocument> = {}): BookDocument {
	return {
		id: newId(),
		filePath: "阅读/书籍A.pdf",
		title: "书籍A",
		category: null,
		collectMapId: null,
		autoFlashcard: false,
		createdAt: 1700000000000,
		updatedAt: 1700000000000,
		...partial,
	};
}

function card(partial: Partial<Card> & Pick<Card, "id" | "documentId">): Card {
	return {
		page: 3,
		rects: [{ x: 0.1, y: 0.2, w: 0.5, h: 0.05 }],
		polygon: null,
		excerptType: "text",
		excerptText: "摘录内容",
		excerptRef: null,
		note: null,
		color: null,
		lineStyle: null,
		title: null,
		deck: null,
		occlusions: [],
		tags: [],
		createdAt: 1700000001000,
		updatedAt: 1700000001000,
		...partial,
	};
}

function map(partial: Partial<Mindmap> = {}): Mindmap {
	return {
		id: newId(),
		name: "学习图",
		defaultBranchStyle: "tree",
		documentId: null,
		fixedRootNodeId: null,
		createdAt: 1700000000000,
		updatedAt: 1700000000000,
		...partial,
	};
}

function node(
	partial: Partial<MindmapNode> & Pick<MindmapNode, "id" | "mapId" | "cardId">,
): MindmapNode {
	return {
		parentId: null,
		x: 0,
		y: 0,
		collapsed: false,
		branchStyle: null,
		createdAt: 1700000001000,
		...partial,
	};
}

/** 造一本书 + 一张卡（直接经 store 状态写入并标脏，模拟仓储行为） */
async function seedBookWithCard(adapter: MemoryAdapter) {
	const store = await MarinMindStore.open(adapter);
	const d = doc();
	const c = card({ id: newId(), documentId: d.id });
	const state = store.upsertBook(d);
	state.cards.set(c.id, c);
	store.putReview(defaultReviewState(c.id, c.createdAt));
	await store.flush();
	return { store, d, c, state };
}

describe("MarinMindStore 落盘与恢复", () => {
	it("upsert + 卡片 → flush 落盘 → 重开恢复（书/卡/复习状态）", async () => {
		const adapter = new MemoryAdapter();
		const { d, c } = await seedBookWithCard(adapter);

		expect(adapter.files.has("books/书籍A.md")).toBe(true);
		expect(textOf(adapter, "books/书籍A.md")).toContain("marinmind: book");
		expect(textOf(adapter, "books/书籍A.md")).toContain("摘录内容");

		const reopened = await MarinMindStore.open(adapter);
		expect(reopened.stats()).toEqual({ documents: 1, cards: 1, mindmaps: 0, nodes: 0 });
		const restored = reopened.books.get(d.id)!.cards.get(c.id)!;
		expect(restored.excerptText).toBe("摘录内容");
		expect(restored.rects).toEqual(c.rects);
		expect(reopened.reviews.get(c.id)?.ease).toBe(2.5);
		reopened.close();
	});

	it("脏粒度：只改一本书，另一本不重写（写计数不变）", async () => {
		const adapter = new MemoryAdapter();
		const store = await MarinMindStore.open(adapter);
		const dA = store.upsertBook(doc({ title: "甲书" }));
		const dB = store.upsertBook(doc({ id: newId(), filePath: "阅读/乙.pdf", title: "乙书" }));
		dA.cards.set("ca", card({ id: "ca", documentId: dA.doc.id }));
		dB.cards.set("cb", card({ id: "cb", documentId: dB.doc.id }));
		await store.flush();
		const countB = adapter.writeCounts.get("books/乙书.md");

		// 只改甲书的一张卡
		dA.cards.get("ca")!.excerptText = "改后的内容";
		store.markDirty(dA.doc.id);
		await store.flush();
		expect(adapter.writeCounts.get("books/乙书.md")).toBe(countB);
		expect(textOf(adapter, "books/甲书.md")).toContain("改后的内容");
		store.close();
	});

	it("零写入契约：markDirty 但内容未变 → flush 不写盘", async () => {
		const adapter = new MemoryAdapter();
		const { store, d } = await seedBookWithCard(adapter);
		const count = adapter.writeCounts.get("books/书籍A.md");

		store.markDirty(d.id); // 无任何内容变化
		await store.flush();
		expect(adapter.writeCounts.get("books/书籍A.md")).toBe(count);
		store.close();
	});

	it("重开时未触碰的文件保持原字节（loadAll 不重写）", async () => {
		const adapter = new MemoryAdapter();
		const { d } = await seedBookWithCard(adapter);
		const raw = textOf(adapter, "books/书籍A.md");
		const before = adapter.writeCounts.get("books/书籍A.md");

		const store = await MarinMindStore.open(adapter);
		store.markDirty(d.id); // 即使标脏——内容与磁盘一致，零写契约拦下
		await store.flush();
		expect(textOf(adapter, "books/书籍A.md")).toBe(raw);
		expect(adapter.writeCounts.get("books/书籍A.md")).toBe(before);
		store.close();
	});

	it("ensureBookWritten：为 ㊻-A 前的旧文件补 ^card-id 块锚点（㊻-A-2），已最新则零写", async () => {
		const adapter = new MemoryAdapter();
		const seeded = await seedBookWithCard(adapter);
		const cardId = seeded.c.id;
		seeded.store.close();
		// 模拟 ㊻-A 之前写入的旧文件：序列化尚无块锚点行（callout 直连机器注释）
		const oldText = textOf(adapter, "books/书籍A.md").replace(`^card-${cardId}\n`, "");
		expect(oldText).not.toContain(`^card-${cardId}`);
		writeText(adapter, "books/书籍A.md", oldText);

		const store = await MarinMindStore.open(adapter);
		const book = store.bookOfCard(cardId)!; // 解析对缺失锚点仅警告，卡片照常认领
		expect(book).toBeDefined();
		await store.ensureBookWritten(book.doc.id);
		expect(textOf(adapter, "books/书籍A.md")).toContain(`^card-${cardId}`);
		const writes = adapter.writeCounts.get("books/书籍A.md")!;

		// 磁盘已最新：再保底不重写（零写契约）
		await store.ensureBookWritten(book.doc.id);
		expect(adapter.writeCounts.get("books/书籍A.md")).toBe(writes);
		store.close();
	});
});

describe("MarinMindStore 孤儿与命名", () => {
	it("documentId=null 卡片落 未归类卡片.md，重开恢复 documentId=null", async () => {
		const adapter = new MemoryAdapter();
		const store = await MarinMindStore.open(adapter);
		const c = card({ id: newId(), documentId: null });
		store.orphanState.cards.set(c.id, c);
		store.markDirty(ORPHAN_SCOPE);
		await store.flush();
		expect(adapter.files.has("books/未归类卡片.md")).toBe(true);

		const reopened = await MarinMindStore.open(adapter);
		const restored = reopened.orphanState.cards.get(c.id)!;
		expect(restored.documentId).toBeNull();
		expect(restored.excerptText).toBe("摘录内容");
		expect(reopened.stats().documents).toBe(0); // 孤儿不进文档列表
		reopened.close();
	});

	it("孤儿集清空后 flush 删除文件；无卡无文件时零动作", async () => {
		const adapter = new MemoryAdapter();
		const store = await MarinMindStore.open(adapter);
		const c = card({ id: newId(), documentId: null });
		store.orphanState.cards.set(c.id, c);
		store.markDirty(ORPHAN_SCOPE);
		await store.flush();
		expect(adapter.files.has("books/未归类卡片.md")).toBe(true);

		store.orphanState.cards.delete(c.id);
		store.markDirty(ORPHAN_SCOPE);
		await store.flush();
		expect(adapter.files.has("books/未归类卡片.md")).toBe(false);
		store.close();
	});

	it("同名书冲突：第二本加 id 短后缀", async () => {
		const adapter = new MemoryAdapter();
		const store = await MarinMindStore.open(adapter);
		const d1 = doc();
		const d2 = doc({ id: "abcd1234-0000-4000-8000-000000000000" });
		store.upsertBook(d1);
		const s2 = store.upsertBook(d2);
		expect(s2.relPath).toBe("books/书籍A (abcd).md");
		await store.flush();
		expect([...adapter.files.keys()].sort()).toEqual([
			"books/书籍A (abcd).md",
			"books/书籍A.md",
		]);
		store.close();
	});
});

describe("MarinMindStore 级联删除", () => {
	it("deleteCardCascade：复习/链接/脑图节点/固定根解钉 全清", async () => {
		const adapter = new MemoryAdapter();
		const store = await MarinMindStore.open(adapter);
		const d = doc();
		const c1 = card({ id: "c1", documentId: d.id });
		const c2 = card({ id: "c2", documentId: d.id });
		const bookState = store.upsertBook(d);
		bookState.cards.set(c1.id, c1);
		bookState.cards.set(c2.id, c2);
		store.putReview(defaultReviewState("c1", 1));
		store.putReview(defaultReviewState("c2", 1));
		store.addLink("c1", "c2", 123);

		const m = map();
		const n1 = node({ id: "n1", mapId: m.id, cardId: "c1" });
		const n2 = node({ id: "n2", mapId: m.id, cardId: "c2", parentId: "n1" });
		const mapState = store.upsertMap(m);
		mapState.nodes.set(n1.id, n1);
		mapState.nodes.set(n2.id, n2);
		mapState.map = { ...mapState.map, fixedRootNodeId: "n1" };
		await store.flush();

		const removed = store.deleteCardCascade("c1");
		expect(removed?.id).toBe("c1");
		expect(bookState.cards.has("c1")).toBe(false);
		expect(store.reviews.has("c1")).toBe(false);
		expect(store.links.size).toBe(0);
		expect(mapState.nodes.has("n1")).toBe(false);
		expect(mapState.map.fixedRootNodeId).toBeNull(); // 解钉
		expect(mapState.nodes.get("n2")?.parentId).toBeNull(); // 被删节点的子节点上浮为根（对齐旧库 parent_id SET NULL）
		await store.flush();
		// 落盘后的文件不再含 c1
		expect(textOf(adapter, "books/书籍A.md")).not.toContain("^card-c1");
		store.close();
	});

	it("deleteBook：卡片/书签级联 + 脑图 document_id SET NULL + 文件删除", async () => {
		const adapter = new MemoryAdapter();
		const { store, d } = await seedBookWithCard(adapter);
		const m = map({ documentId: d.id });
		store.upsertMap(m);
		await store.flush();
		expect(adapter.files.has("mindmaps/学习图.md")).toBe(true);

		expect(store.deleteBook(d.id)).toBe(true);
		await store.flush();
		expect(adapter.files.has("books/书籍A.md")).toBe(false);
		expect(store.books.size).toBe(0);
		expect(store.maps.get(m.id)!.map.documentId).toBeNull();
		store.close();
	});

	it("deleteMap：摘录目标覆盖 collectMapId 级联清空（㊴——该书回默认同名图）", async () => {
		const adapter = new MemoryAdapter();
		const store = await MarinMindStore.open(adapter);
		const d = doc();
		store.upsertBook(d);
		const m = map();
		store.upsertMap(m);
		store.upsertBook({ ...d, collectMapId: m.id });
		await store.flush();
		expect(textOf(adapter, "books/书籍A.md")).toContain("collect_map_id");

		expect(store.deleteMap(m.id)).toBe(true);
		expect(store.books.get(d.id)!.doc.collectMapId).toBeNull();
		await store.flush();
		expect(textOf(adapter, "books/书籍A.md")).not.toContain("collect_map_id");
		store.close();
	});

	it("元数据 patch 不改标题：文件名不翻转（㊴ 修复 allocateBookPath 自占冲突）", async () => {
		const adapter = new MemoryAdapter();
		const store = await MarinMindStore.open(adapter);
		const d = doc();
		store.upsertBook(d);
		await store.flush();
		// documents.update 改 category/collectMapId 等走 upsertBook——标题未变时
		// 目标路径被自己占用不算冲突，文件不得被改名成 书名 (id).md 再改回
		store.upsertBook({ ...d, category: "学习" });
		store.upsertBook({ ...d, category: "学习", updatedAt: d.updatedAt + 1 });
		expect(store.books.get(d.id)).toBeDefined();
		expect(adapter.files.has("books/书籍A.md")).toBe(true);
		expect([...adapter.files.keys()].some((k) => /\(\w{4}\)\.md$/.test(k))).toBe(false);
		await store.flush();
		expect(adapter.files.has("books/书籍A.md")).toBe(true);
		store.close();
	});
});

describe("MarinMindStore 外部修改回灌", () => {
	it("非脏窗口：磁盘改动整文件覆盖内存；自写回声被忽略", async () => {
		const adapter = new MemoryAdapter();
		const { store, d, c } = await seedBookWithCard(adapter);
		const rel = "books/书籍A.md";

		// 用户手编文本
		const edited = textOf(adapter, rel).replace("摘录内容", "用户手编的新内容");
		writeText(adapter, rel, edited);
		const r1 = await store.handleExternalChange(rel, edited);
		expect(r1.removedCards).toEqual([]);
		expect(r1.warnings).toEqual([]);
		expect(store.books.get(d.id)!.cards.get(c.id)!.excerptText).toBe("用户手编的新内容");

		// 自写回声：同内容再触发 → 无动作（改内存后 flush 模拟）
		store.books.get(d.id)!.doc = { ...d, updatedAt: 999 };
		store.markDirty(d.id);
		await store.flush();
		const onDisk = textOf(adapter, rel);
		const r2 = await store.handleExternalChange(rel, onDisk);
		expect(r2.warnings).toEqual([]);
		expect(store.books.get(d.id)!.doc.updatedAt).toBe(999); // 未被磁盘覆盖
		store.close();
	});

	it("脏窗口：三字段合并——磁盘文本/批注/标签胜，几何与复习保内存", async () => {
		const adapter = new MemoryAdapter();
		const { store, d, c } = await seedBookWithCard(adapter);
		const rel = "books/书籍A.md";

		// 插件侧待写：改几何 + 复习
		const memCard = store.books.get(d.id)!.cards.get(c.id)!;
		memCard.rects = [{ x: 0.9, y: 0.9, w: 0.05, h: 0.05 }];
		store.putReview({ ...(store.reviews.get(c.id) as ReviewState), ease: 1.3 });
		store.markDirty(d.id);

		// 用户手编：改文本 + 批注 + 标签
		const edited = textOf(adapter, rel)
			.replace("摘录内容", "磁盘版文本")
			.replace(
				"> [!excerpt]\n> 磁盘版文本",
				"> [!excerpt]\n> 磁盘版文本\n> **批注**：磁盘批注\n> #重要",
			);
		writeText(adapter, rel, edited);
		const r = await store.handleExternalChange(rel, edited);
		expect(r.warnings.join()).toContain("合并");

		const merged = store.books.get(d.id)!.cards.get(c.id)!;
		expect(merged.excerptText).toBe("磁盘版文本"); // 文本取磁盘
		expect(merged.note).toBe("磁盘批注"); // 批注取磁盘
		expect(merged.tags).toEqual(["重要"]); // 标签取磁盘
		expect(merged.rects).toEqual([{ x: 0.9, y: 0.9, w: 0.05, h: 0.05 }]); // 几何保内存
		expect(store.reviews.get(c.id)!.ease).toBe(1.3); // 复习保内存
		store.close();
	});

	it("脏窗口：lineStyle 取磁盘（77——手编机器层 line 键的线型即时生效）", async () => {
		const adapter = new MemoryAdapter();
		const { store, d, c } = await seedBookWithCard(adapter);
		const rel = "books/书籍A.md";

		// 插件侧待写（脏窗口开启）：内存卡是默认下划线（lineStyle null）
		store.markDirty(d.id);

		// 用户手编磁盘：机器注释补 line 键
		const edited = textOf(adapter, rel).replace(
			`"id":"${c.id}"`,
			`"id":"${c.id}","line":"squiggle"`,
		);
		writeText(adapter, rel, edited);
		const r = await store.handleExternalChange(rel, edited);
		expect(r.warnings.join()).toContain("合并");
		expect(store.books.get(d.id)!.cards.get(c.id)!.lineStyle).toBe("squiggle"); // 线型取磁盘
		store.close();
	});

	it("脏窗口：文档级合并取磁盘 title 与 category（㉟——手编分类不被内存回退）", async () => {
		const adapter = new MemoryAdapter();
		const { store, d } = await seedBookWithCard(adapter);
		const rel = "books/书籍A.md";

		// 插件侧待写（脏窗口开启，内存 doc 仍是 category: null）
		store.markDirty(d.id);

		// 用户手编磁盘：加分类行
		const edited = textOf(adapter, rel).replace(
			"title: 书籍A",
			"title: 书籍A\ncategory: 手编分类",
		);
		writeText(adapter, rel, edited);
		const r = await store.handleExternalChange(rel, edited);
		expect(r.warnings.join()).toContain("合并");
		expect(store.books.get(d.id)!.doc.category).toBe("手编分类"); // 磁盘优先
		store.close();
	});

	it("文件被删除：书移除 + removedCards 快照 + 级联", async () => {
		const adapter = new MemoryAdapter();
		const { store, d, c } = await seedBookWithCard(adapter);
		const m = map({ documentId: d.id });
		store.upsertMap(m);

		const r = await store.handleExternalChange("books/书籍A.md", null);
		expect(r.removedCards.map((x) => x.id)).toEqual([c.id]);
		expect(store.books.size).toBe(0);
		expect(store.maps.get(m.id)!.map.documentId).toBeNull();
		store.close();
	});

	it("rename：路径与 lastWritten 跟随，标题同步，脑图 wikilink 重写", async () => {
		const adapter = new MemoryAdapter();
		const { store, d, c } = await seedBookWithCard(adapter);
		const m = map();
		const ms = store.upsertMap(m);
		ms.nodes.set("n1", node({ id: "n1", mapId: m.id, cardId: c.id }));
		await store.flush();
		expect(textOf(adapter, "mindmaps/学习图.md")).toContain("[[书籍A#^card-");

		// vault rename：文件已被移动到新路径，插件收到事件
		const content = adapter.files.get("books/书籍A.md")!;
		adapter.files.delete("books/书籍A.md");
		adapter.files.set("books/改名的书.md", content);
		store.handleExternalRename("books/书籍A.md", "books/改名的书.md");
		await store.flush();
		expect(adapter.files.has("books/书籍A.md")).toBe(false);
		expect(adapter.files.has("books/改名的书.md")).toBe(true);
		expect(textOf(adapter, "books/改名的书.md")).toContain("title: 改名的书"); // 标题跟随文件名
		expect(textOf(adapter, "mindmaps/学习图.md")).toContain("[[改名的书#^card-");
		expect(store.books.get(d.id)!.doc.title).toBe("改名的书");
		store.close();
	});

	it("frontmatter 缺失的外部修改被忽略（防误清库）", async () => {
		const adapter = new MemoryAdapter();
		const { store, d, c } = await seedBookWithCard(adapter);
		const r = await store.handleExternalChange("books/书籍A.md", "用户把文件搞坏了");
		expect(r.warnings.join()).toContain("忽略");
		expect(store.books.get(d.id)!.cards.get(c.id)).toBeDefined(); // 内存保住
		store.close();
	});
});

describe("MarinMindStore 分类/卡组清单（76）", () => {
	it("addFolder/addDeck → flush 落盘 → 重开恢复", async () => {
		const adapter = new MemoryAdapter();
		const store = await MarinMindStore.open(adapter);
		store.addFolder("学习");
		store.addFolder("学习/英语");
		store.addDeck("英语");
		await store.flush();
		expect(adapter.files.has("分类.md")).toBe(true);
		expect(adapter.files.has("卡组.md")).toBe(true);
		expect(textOf(adapter, "分类.md")).toContain("marinmind: folders");
		expect(textOf(adapter, "卡组.md")).toContain("marinmind: decks");

		const reopened = await MarinMindStore.open(adapter);
		expect([...reopened.getFolders()]).toEqual(["学习", "学习/英语"]);
		expect([...reopened.getDecks()]).toEqual(["英语"]);
		reopened.close();
	});

	it("重复 add 同值零写入（flush 无新写）", async () => {
		const adapter = new MemoryAdapter();
		const store = await MarinMindStore.open(adapter);
		store.addFolder("学习");
		await store.flush();
		const writes = adapter.writeCounts.get("分类.md") ?? 0;
		store.addFolder("学习"); // 已存在：不标脏
		await store.flush();
		expect(adapter.writeCounts.get("分类.md") ?? 0).toBe(writes);
		store.close();
	});

	it("清单清空 → flush 删文件（清空即删）；从未写过零动作", async () => {
		const adapter = new MemoryAdapter();
		const store = await MarinMindStore.open(adapter);
		store.addFolder("学习");
		await store.flush();
		expect(adapter.files.has("分类.md")).toBe(true);
		store.removeFoldersUnder("学习");
		await store.flush();
		expect(adapter.files.has("分类.md")).toBe(false);
		// 卡组从未写过：flush 零动作
		await store.flush();
		expect(adapter.files.has("卡组.md")).toBe(false);
		store.close();
	});

	it("remove/rename 前缀级联（含子路径；无命中原引用零写入）", async () => {
		const adapter = new MemoryAdapter();
		const store = await MarinMindStore.open(adapter);
		store.addFolder("学习");
		store.addFolder("学习/英语");
		store.renameFoldersPrefix("学习", "study");
		expect([...store.getFolders()]).toEqual(["study", "study/英语"]);
		store.removeFoldersUnder("study");
		expect([...store.getFolders()]).toEqual([]);
		// 无命中不再标脏（remove 已清空 + add 无变化组合后 flush 幂等）
		await store.flush();
		store.close();
	});

	it("groupListHasChildren：严格子孙判定（主页空组免确认用）", async () => {
		const adapter = new MemoryAdapter();
		const store = await MarinMindStore.open(adapter);
		store.addDeck("学习");
		store.addDeck("学习/英语");
		expect(store.groupListHasChildren("decks", "学习")).toBe(true);
		expect(store.groupListHasChildren("decks", "学习/英语")).toBe(false);
		store.close();
	});

	it("外部手编清单：modify 覆盖内存 / 损坏保内存 / delete 清空撤脏", async () => {
		const adapter = new MemoryAdapter();
		const store = await MarinMindStore.open(adapter);
		store.addFolder("学习");
		await store.flush();

		// 手编加行 → 磁盘即权威（parse 产出拼音序：工作 g < 学习 x）
		const edited = serializeGroupListMd("folders", ["学习", "工作"]);
		await store.handleExternalChange("分类.md", edited);
		expect([...store.getFolders()]).toEqual(["工作", "学习"]);

		// 损坏（frontmatter 没了）→ 保内存，下次 flush 覆盖回
		await store.handleExternalChange("分类.md", "用户改坏了");
		expect([...store.getFolders()]).toEqual(["工作", "学习"]);

		// 删除 → 清内存；再 add 时按新清单重建不复活旧值
		await store.handleExternalChange("分类.md", null);
		expect([...store.getFolders()]).toEqual([]);
		store.addFolder("新分类");
		await store.flush();
		// 头部提示文案含示例「学习/英语」，只断言列表行无旧值
		expect(textOf(adapter, "分类.md")).not.toContain("- 学习");
		store.close();
	});

	it("书名恰为「分类」/「卡组」：让路加 id 后缀防覆盖清单文件", async () => {
		const adapter = new MemoryAdapter();
		const store = await MarinMindStore.open(adapter);
		store.addFolder("学习");
		await store.flush();
		const d = doc({ id: "abcd1234-0000-4000-8000-000000000000", title: "分类" });
		const s = store.upsertBook(d);
		expect(s.relPath.startsWith("books/分类 (")).toBe(true);
		await store.flush();
		// 清单文件内容未被书文件覆盖
		expect(textOf(adapter, "分类.md")).toContain("marinmind: folders");
		store.close();
	});
});
