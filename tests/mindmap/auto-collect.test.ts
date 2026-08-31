import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MarinMindStore } from "../../src/store/marinmind-store";
import { CardRepository } from "../../src/db/repositories/card-repo";
import { DocumentRepository } from "../../src/db/repositories/document-repo";
import { MindmapRepository } from "../../src/db/repositories/mindmap-repo";
import { autoAddCard, collectTargetOf, ensureBookMindmap, followBookRename, linkedMapOf } from "../../src/mindmap/auto-collect";
import type { Card } from "../../src/types";
import { MemoryAdapter } from "../helpers/memory-adapter";

let store: MarinMindStore;
let documents: DocumentRepository;
let cards: CardRepository;
let mindmaps: MindmapRepository;

/** 每个用例使用独立的内存存储（㉗ 自动入图服务，落点决策见 auto-collect.ts；㉚ md 存储版） */
beforeEach(async () => {
	store = await MarinMindStore.open(new MemoryAdapter());
	documents = new DocumentRepository(store);
	cards = new CardRepository(store);
	mindmaps = new MindmapRepository(store);
});
afterEach(() => store.close());

function excerpt(text: string, docId: string, page = 1): Card {
	return cards.create({
		documentId: docId,
		page,
		rects: [],
		excerptType: "text",
		excerptText: text,
	});
}

describe("摘录自动入图（㉗：书籍默认脑图 + 固定根节点）", () => {
	it("首张摘录：get-or-create 书籍默认脑图（图名=文档标题，书名分组卡为根）", () => {
		const doc = documents.upsertByPath("books/a.pdf", "书A");
		const card = excerpt("要点一", doc.id);

		const mapId = autoAddCard({ documents, cards, mindmaps }, card);
		expect(mapId).toBeTruthy();

		const map = mindmaps.get(mapId!)!;
		expect(map.name).toBe("书A");
		expect(map.documentId).toBe(doc.id);

		// 结构：根 = 《书A》分组卡（page null），摘录挂其下
		const nodes = mindmaps.listNodes(mapId!);
		expect(nodes).toHaveLength(2);
		const group = nodes.find((n) => n.parentId === null)!;
		const child = nodes.find((n) => n.parentId === group.id)!;
		expect(group.card.page).toBeNull();
		expect(group.card.excerptText).toBe("《书A》");
		expect(child.cardId).toBe(card.id);
	});

	it("后续摘录挂同一张书图、同一分组根下顺延", () => {
		const doc = documents.upsertByPath("books/a.pdf", "书A");
		const c1 = excerpt("要点一", doc.id);
		const map1 = autoAddCard({ documents, cards, mindmaps }, c1);
		const c2 = excerpt("要点二", doc.id, 3);
		const map2 = autoAddCard({ documents, cards, mindmaps }, c2);

		expect(map2).toBe(map1);
		// 分组卡只建一张（3 节点 = 分组 + 两摘录）
		const nodes = mindmaps.listNodes(map1!);
		expect(nodes).toHaveLength(3);
		expect(nodes.filter((n) => n.card.page === null)).toHaveLength(1);
		// 两摘录同父
		const group = nodes.find((n) => n.card.page === null)!;
		expect(nodes.filter((n) => n.parentId === group.id)).toHaveLength(2);
	});

	it("多本书各自成图：互不混入（一书一图一分组根）", () => {
		const docA = documents.upsertByPath("books/a.pdf", "书A");
		const docB = documents.upsertByPath("books/b.pdf", "书B");
		const mA = autoAddCard({ documents, cards, mindmaps }, excerpt("A1", docA.id));
		autoAddCard({ documents, cards, mindmaps }, excerpt("B1", docB.id));
		const mA2 = autoAddCard({ documents, cards, mindmaps }, excerpt("A2", docA.id));

		expect(mA).toBe(mA2);
		expect(mindmaps.list().length).toBe(2); // 书A图 + 书B图
	});

	it("回环防护：分组卡（page null）与手工卡（documentId null）不入图", () => {
		const doc = documents.upsertByPath("books/a.pdf", "书A");
		const card = excerpt("要点", doc.id);
		autoAddCard({ documents, cards, mindmaps }, card);

		// 服务自建的书名分组卡再喂回来 → 返回 null 且不再建图建节点
		const group = mindmaps
			.listNodes(mindmaps.findByDocument(doc.id)!.id)
			.find((n) => n.card.page === null)!;
		expect(autoAddCard({ documents, cards, mindmaps }, group.card)).toBeNull();
		expect(mindmaps.listNodes(mindmaps.findByDocument(doc.id)!.id)).toHaveLength(2);

		// 手工卡
		const manual = cards.create({
			documentId: null,
			page: null,
			rects: [],
			excerptType: "text",
			excerptText: "手工",
		});
		expect(autoAddCard({ documents, cards, mindmaps }, manual)).toBeNull();
	});

	it("已在图中的卡重复触发：幂等返回 null", () => {
		const doc = documents.upsertByPath("books/a.pdf", "书A");
		const card = excerpt("要点", doc.id);
		const mapId = autoAddCard({ documents, cards, mindmaps }, card);
		expect(autoAddCard({ documents, cards, mindmaps }, card)).toBeNull();
		expect(mindmaps.listNodes(mapId!)).toHaveLength(2);
	});

	it("固定根节点优先：跨文档摘录直挂固定根下，不经书图分组", () => {
		const docA = documents.upsertByPath("books/a.pdf", "书A");
		const docB = documents.upsertByPath("books/b.pdf", "书B");
		// 书A 先按默认路径建图建分组
		autoAddCard({ documents, cards, mindmaps }, excerpt("A1", docA.id));

		// 在书A图里钉一个节点为固定根
		const mapA = mindmaps.findByDocument(docA.id)!;
		const pinnedNode = mindmaps.listNodes(mapA.id)[0];
		mindmaps.setFixedRoot(mapA.id, pinnedNode.id);

		// 书B 的摘录不再建书B图，直挂固定根下
		const bCard = excerpt("B1", docB.id);
		const touched = autoAddCard({ documents, cards, mindmaps }, bCard);
		expect(touched).toBe(mapA.id);
		expect(mindmaps.findByDocument(docB.id)).toBeUndefined(); // 未建书B图
		const nodes = mindmaps.listNodes(mapA.id);
		expect(nodes.find((n) => n.cardId === bCard.id)?.parentId).toBe(pinnedNode.id);
	});

	it("固定根取消后：回到书籍默认脑图路径", () => {
		const docA = documents.upsertByPath("books/a.pdf", "书A");
		const docB = documents.upsertByPath("books/b.pdf", "书B");
		autoAddCard({ documents, cards, mindmaps }, excerpt("A1", docA.id));
		const mapA = mindmaps.findByDocument(docA.id)!;
		const pinned = mindmaps.listNodes(mapA.id)[0];
		mindmaps.setFixedRoot(mapA.id, pinned.id);

		mindmaps.setFixedRoot(mapA.id, null); // 取消固定
		const bCard = excerpt("B1", docB.id);
		const touched = autoAddCard({ documents, cards, mindmaps }, bCard);
		expect(touched).toBe(mindmaps.findByDocument(docB.id)?.id); // 书B 自建图
	});

	it("固定根节点被删（SET NULL 自动解钉）：回落到书籍图路径", () => {
		const docA = documents.upsertByPath("books/a.pdf", "书A");
		const docB = documents.upsertByPath("books/b.pdf", "书B");
		autoAddCard({ documents, cards, mindmaps }, excerpt("A1", docA.id));
		const mapA = mindmaps.findByDocument(docA.id)!;
		const pinned = mindmaps.listNodes(mapA.id)[0];
		mindmaps.setFixedRoot(mapA.id, pinned.id);
		mindmaps.removeNode(pinned.id); // 删钉：外键 SET NULL

		const bCard = excerpt("B1", docB.id);
		const touched = autoAddCard({ documents, cards, mindmaps }, bCard);
		expect(touched).toBe(mindmaps.findByDocument(docB.id)?.id);
	});
});

describe("摘录目标图（㊴：打开即建同名图 + 按书切换 + 改名跟随）", () => {
	it("ensureBookMindmap：打开即建同名图与《书名》根节点；二次调用幂等不重复", () => {
		const doc = documents.upsertByPath("books/a.pdf", "书A");

		const mapId = ensureBookMindmap({ documents, cards, mindmaps }, doc.id);
		expect(mapId).toBeTruthy();
		const map = mindmaps.get(mapId!)!;
		expect(map.name).toBe("书A");
		expect(map.documentId).toBe(doc.id);
		const nodes = mindmaps.listNodes(mapId!);
		expect(nodes).toHaveLength(1); // 只有《书A》分组根
		expect(nodes[0].card.excerptText).toBe("《书A》");
		expect(nodes[0].parentId).toBeNull();

		// 幂等：再 ensure 不建第二张图/第二个分组
		expect(ensureBookMindmap({ documents, cards, mindmaps }, doc.id)).toBe(mapId);
		expect(mindmaps.list().length).toBe(1);
		expect(mindmaps.listNodes(mapId!)).toHaveLength(1);
	});

	it("ensure 后首张摘录挂既有分组下（不再另建分组）", () => {
		const doc = documents.upsertByPath("books/a.pdf", "书A");
		const mapId = ensureBookMindmap({ documents, cards, mindmaps }, doc.id);
		const group = mindmaps.listNodes(mapId!)[0];

		const touched = autoAddCard(
			{ documents, cards, mindmaps },
			excerpt("要点", doc.id),
		);
		expect(touched).toBe(mapId);
		const nodes = mindmaps.listNodes(mapId!);
		expect(nodes).toHaveLength(2);
		expect(nodes.find((n) => n.card.page !== null)?.parentId).toBe(group.id);
	});

	it("按书覆盖生效：ensure 返回覆盖图不建同名图；摘录入覆盖图并懒建分组", () => {
		const docA = documents.upsertByPath("books/a.pdf", "书A");
		const topic = mindmaps.create("主题图");

		documents.update(docA.id, { collectMapId: topic.id });
		expect(ensureBookMindmap({ documents, cards, mindmaps }, docA.id)).toBe(topic.id);
		expect(mindmaps.findByDocument(docA.id)).toBeUndefined(); // 未建同名图

		const card = excerpt("要点", docA.id);
		expect(autoAddCard({ documents, cards, mindmaps }, card)).toBe(topic.id);
		// 覆盖图内：书A 的《书A》分组 + 摘录挂其下（多书共图各自成组）
		const nodes = mindmaps.listNodes(topic.id);
		expect(nodes).toHaveLength(2);
		const group = nodes.find((n) => n.card.page === null)!;
		expect(group.card.excerptText).toBe("《书A》");
		expect(nodes.find((n) => n.cardId === card.id)?.parentId).toBe(group.id);
	});

	it("覆盖悬空（图已删）：读取守卫回退同名默认图", () => {
		const doc = documents.upsertByPath("books/a.pdf", "书A");
		const topic = mindmaps.create("主题图");
		documents.update(doc.id, { collectMapId: topic.id });
		mindmaps.delete(topic.id);

		const card = excerpt("要点", doc.id);
		const touched = autoAddCard({ documents, cards, mindmaps }, card);
		expect(touched).toBe(mindmaps.findByDocument(doc.id)?.id);
		// collectTargetOf 同步回退：overridden=false
		const target = collectTargetOf({ documents, cards, mindmaps }, doc.id);
		expect(target?.overridden).toBe(false);
	});

	it("collectTargetOf：无图未建时返回 null；覆盖优先于默认图", () => {
		const doc = documents.upsertByPath("books/a.pdf", "书A");
		expect(collectTargetOf({ documents, cards, mindmaps }, doc.id)).toBeNull();

		ensureBookMindmap({ documents, cards, mindmaps }, doc.id);
		const def = mindmaps.findByDocument(doc.id)!;
		expect(collectTargetOf({ documents, cards, mindmaps }, doc.id)).toEqual({
			map: def,
			overridden: false,
		});

		const topic = mindmaps.create("主题图");
		documents.update(doc.id, { collectMapId: topic.id });
		expect(collectTargetOf({ documents, cards, mindmaps }, doc.id)).toEqual({
			map: topic,
			overridden: true,
		});
	});

	it("固定根 + 按书覆盖并存：固定根胜（㊴ 三级落点保持㉗语义）", () => {
		const docA = documents.upsertByPath("books/a.pdf", "书A");
		const docB = documents.upsertByPath("books/b.pdf", "书B");
		autoAddCard({ documents, cards, mindmaps }, excerpt("A1", docA.id));
		const mapA = mindmaps.findByDocument(docA.id)!;
		const pinned = mindmaps.listNodes(mapA.id)[0];
		mindmaps.setFixedRoot(mapA.id, pinned.id);

		// 书B 覆盖到主题图——但固定根仍在：摘录优先落固定根
		const topic = mindmaps.create("主题图");
		documents.update(docB.id, { collectMapId: topic.id });
		const bCard = excerpt("B1", docB.id);
		expect(autoAddCard({ documents, cards, mindmaps }, bCard)).toBe(mapA.id);
		expect(mindmaps.listNodes(topic.id)).toHaveLength(0);
	});

	it("followBookRename：图名与组卡文本跟随新书名（未被手动改过时）", () => {
		const doc = documents.upsertByPath("books/a.pdf", "书A");
		const mapId = ensureBookMindmap({ documents, cards, mindmaps }, doc.id);

		followBookRename({ documents, cards, mindmaps }, doc.id, "书A", "新书");
		expect(mindmaps.get(mapId!)!.name).toBe("新书");
		expect(mindmaps.listNodes(mapId!)[0].card.excerptText).toBe("《新书》");
	});

	it("followBookRename 宁拒不赌：手动改过图名/组卡文本的不被覆盖（两项守卫独立）", () => {
		const doc = documents.upsertByPath("books/a.pdf", "书A");
		const mapId = ensureBookMindmap({ documents, cards, mindmaps }, doc.id);

		// 用户手动改过图名：图名不动，但组卡文本仍跟随
		mindmaps.rename(mapId!, "我的图");
		followBookRename({ documents, cards, mindmaps }, doc.id, "书A", "新书");
		expect(mindmaps.get(mapId!)!.name).toBe("我的图");
		expect(mindmaps.listNodes(mapId!)[0].card.excerptText).toBe("《新书》");

		// 用户手动改过组卡文本：文本不动，图名跟随（先把图名改回旧书名模拟未被手改）
		mindmaps.rename(mapId!, "新书");
		cards.update(mindmaps.listNodes(mapId!)[0].card.id, { excerptText: "我的分组" });
		followBookRename({ documents, cards, mindmaps }, doc.id, "新书", "更名");
		expect(mindmaps.get(mapId!)!.name).toBe("更名");
		expect(mindmaps.listNodes(mapId!)[0].card.excerptText).toBe("我的分组");
	});
});

describe("联动展示图判定（㊿ linkedMapOf：文档↔脑图一对一）", () => {
	it("默认 get-or-create 同名图（联动打开即有图可定位，不弹选图器）", () => {
		const doc = documents.upsertByPath("books/a.pdf", "书A");
		const mapId = linkedMapOf({ documents, cards, mindmaps }, doc.id);
		expect(mapId).toBeTruthy();
		expect(mindmaps.get(mapId!)!.name).toBe("书A");
		// 幂等：再次判定返回同一张图
		expect(linkedMapOf({ documents, cards, mindmaps }, doc.id)).toBe(mapId);
	});

	it("按书覆盖（collectMapId）优先于同名图——主动切换后联动跟随覆盖图", () => {
		const doc = documents.upsertByPath("books/a.pdf", "书A");
		const topic = mindmaps.create("主题图");
		documents.update(doc.id, { collectMapId: topic.id });
		expect(linkedMapOf({ documents, cards, mindmaps }, doc.id)).toBe(topic.id);
	});

	it("固定根所在图最优先（与摘录落点同源：展示收拢地）", () => {
		const docA = documents.upsertByPath("books/a.pdf", "书A");
		const docB = documents.upsertByPath("books/b.pdf", "书B");
		autoAddCard({ documents, cards, mindmaps }, excerpt("A1", docA.id));
		const mapA = mindmaps.findByDocument(docA.id)!;
		mindmaps.setFixedRoot(mapA.id, mindmaps.listNodes(mapA.id)[0].id);

		// 书B 即使覆盖到主题图：固定根胜（镜像摘录三级落点语义）
		const topic = mindmaps.create("主题图");
		documents.update(docB.id, { collectMapId: topic.id });
		expect(linkedMapOf({ documents, cards, mindmaps }, docB.id)).toBe(mapA.id);
	});

	it("文档缺失返回 null（调用方静默降级）", () => {
		expect(linkedMapOf({ documents, cards, mindmaps }, "no-such-doc")).toBeNull();
	});
});
