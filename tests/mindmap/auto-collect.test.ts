import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MarinMindStore } from "../../src/store/marinmind-store";
import { CardRepository } from "../../src/db/repositories/card-repo";
import { DocumentRepository } from "../../src/db/repositories/document-repo";
import { MindmapRepository } from "../../src/db/repositories/mindmap-repo";
import {
	autoAddCard,
	chapterParentFor,
	collectTargetOf,
	ensureBookMindmap,
	fixedRootDocOf,
	followBookRename,
	linkedMapOf,
} from "../../src/mindmap/auto-collect";
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

	it("固定根节点优先：本书摘录直挂固定根下，不经书图分组（80 起书图钉仅收本书）", () => {
		const docA = documents.upsertByPath("books/a.pdf", "书A");
		// 书A 先按默认路径建图建分组
		autoAddCard({ documents, cards, mindmaps }, excerpt("A1", docA.id));

		// 在书A图里钉一个节点为固定根（书图有 documentId → 仅收书A摘录）
		const mapA = mindmaps.findByDocument(docA.id)!;
		const pinnedNode = mindmaps.listNodes(mapA.id)[0];
		mindmaps.setFixedRoot(mapA.id, pinnedNode.id);

		const aCard = excerpt("A2", docA.id, 3);
		const touched = autoAddCard({ documents, cards, mindmaps }, aCard);
		expect(touched).toBe(mapA.id);
		expect(mindmaps.listNodes(mapA.id).find((n) => n.cardId === aCard.id)?.parentId).toBe(
			pinnedNode.id,
		);
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

	it("书名分组卡带 group 标记（81）：建卡即落标，不进卡片视角（列表/计数）", () => {
		const doc = documents.upsertByPath("books/a.pdf", "书A");
		ensureBookMindmap({ documents, cards, mindmaps }, doc.id); // ensure 路径建组卡
		autoAddCard({ documents, cards, mindmaps }, excerpt("要点", doc.id)); // autoAdd 懒建路径不触发（组卡已存在）
		const docB = documents.upsertByPath("books/b.pdf", "书B");
		autoAddCard({ documents, cards, mindmaps }, excerpt("B 要点", docB.id)); // autoAdd 懒建路径建组卡

		// 卡片视角（listAll/count）只见两张摘录，组卡经 get 逐一验证均带标记
		expect(cards.listAll()).toHaveLength(2);
		for (const mapId of mindmaps.list().map((m) => m.id)) {
			const root = mindmaps.listNodes(mapId).find((n) => n.parentId === null)!;
			expect(cards.get(root.cardId)!.group).toBe(true);
		}
		expect(cards.count()).toBe(2); // 计数同为摘录口径
	});

	it("ensure 后首张摘录挂既有分组下（不再另建分组）", () => {
		const doc = documents.upsertByPath("books/a.pdf", "书A");
		const mapId = ensureBookMindmap({ documents, cards, mindmaps }, doc.id);
		const group = mindmaps.listNodes(mapId!)[0];

		const touched = autoAddCard({ documents, cards, mindmaps }, excerpt("要点", doc.id));
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

	it("固定根 + 按书覆盖并存（归属文档内）：固定根胜——书A 自覆盖仍直挂固定根", () => {
		const docA = documents.upsertByPath("books/a.pdf", "书A");
		autoAddCard({ documents, cards, mindmaps }, excerpt("A1", docA.id));
		const mapA = mindmaps.findByDocument(docA.id)!;
		const pinned = mindmaps.listNodes(mapA.id)[0];
		mindmaps.setFixedRoot(mapA.id, pinned.id);

		// 书A 自己覆盖到主题图——固定根属书A仍胜：摘录优先落固定根
		const topic = mindmaps.create("主题图");
		documents.update(docA.id, { collectMapId: topic.id });
		const aCard = excerpt("A2", docA.id, 3);
		expect(autoAddCard({ documents, cards, mindmaps }, aCard)).toBe(mapA.id);
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

	it("固定根所在图最优先（归属文档内）；他书让位走本书目标图（80）", () => {
		const docA = documents.upsertByPath("books/a.pdf", "书A");
		const docB = documents.upsertByPath("books/b.pdf", "书B");
		autoAddCard({ documents, cards, mindmaps }, excerpt("A1", docA.id));
		const mapA = mindmaps.findByDocument(docA.id)!;
		mindmaps.setFixedRoot(mapA.id, mindmaps.listNodes(mapA.id)[0].id);

		// 书A 即使覆盖到主题图：固定根胜（镜像摘录三级落点语义）
		const topic = mindmaps.create("主题图");
		documents.update(docA.id, { collectMapId: topic.id });
		expect(linkedMapOf({ documents, cards, mindmaps }, docA.id)).toBe(mapA.id);
		// 80：固定根属书A——书B 联动让位，走书B 同名图（get-or-create）
		expect(linkedMapOf({ documents, cards, mindmaps }, docB.id)).toBe(
			mindmaps.findByDocument(docB.id)?.id,
		);
	});

	it("文档缺失返回 null（调用方静默降级）", () => {
		expect(linkedMapOf({ documents, cards, mindmaps }, "no-such-doc")).toBeNull();
	});
});

describe("固定根仅所属文档生效（80：fixedRootDocOf 推导 + 三级落点/联动门控）", () => {
	it("钉在书A默认图节点：A 摘录直挂固定根；B 摘录让位自建书B图（原跨文档设计收窄）", () => {
		const docA = documents.upsertByPath("books/a.pdf", "书A");
		const docB = documents.upsertByPath("books/b.pdf", "书B");
		autoAddCard({ documents, cards, mindmaps }, excerpt("A1", docA.id));
		const mapA = mindmaps.findByDocument(docA.id)!;
		const pinned = mindmaps.listNodes(mapA.id)[0];
		mindmaps.setFixedRoot(mapA.id, pinned.id);

		const aCard = excerpt("A2", docA.id, 2);
		expect(autoAddCard({ documents, cards, mindmaps }, aCard)).toBe(mapA.id);
		expect(mindmaps.listNodes(mapA.id).find((n) => n.cardId === aCard.id)!.parentId).toBe(
			pinned.id,
		);

		// B 让位：走第 2 级自建书B图（组卡正常，不混入固定根）
		const bCard = excerpt("B1", docB.id);
		const touchedB = autoAddCard({ documents, cards, mindmaps }, bCard);
		const mapB = mindmaps.findByDocument(docB.id)!;
		expect(touchedB).toBe(mapB.id);
		const bNode = mindmaps.listNodes(mapB.id).find((n) => n.cardId === bCard.id)!;
		expect(bNode.parentId).not.toBe(pinned.id);
	});

	it("钉在无归属主题图（图与钉节点卡片均无 documentId）：跨文档收拢保留", () => {
		const docA = documents.upsertByPath("books/a.pdf", "书A");
		const docB = documents.upsertByPath("books/b.pdf", "书B");
		const topic = mindmaps.create("主题图");
		const manual = cards.create({
			documentId: null,
			page: null,
			rects: [],
			excerptType: "text",
			excerptText: "主题",
		});
		const pinned = mindmaps.addNode(topic.id, manual.id, null, 0, 0)!;
		mindmaps.setFixedRoot(topic.id, pinned.id);

		const aCard = excerpt("A1", docA.id);
		const bCard = excerpt("B1", docB.id);
		expect(autoAddCard({ documents, cards, mindmaps }, aCard)).toBe(topic.id);
		expect(autoAddCard({ documents, cards, mindmaps }, bCard)).toBe(topic.id);
		// 两书摘录都直挂固定根，不再建书图
		expect(mindmaps.findByDocument(docA.id)).toBeUndefined();
		expect(mindmaps.findByDocument(docB.id)).toBeUndefined();
		expect(mindmaps.listNodes(topic.id).find((n) => n.cardId === aCard.id)!.parentId).toBe(
			pinned.id,
		);
		expect(mindmaps.listNodes(topic.id).find((n) => n.cardId === bCard.id)!.parentId).toBe(
			pinned.id,
		);
	});

	it("钉在主题图但钉节点卡片属书A（摘录卡节点）：仅 A 收集，B 让位", () => {
		const docA = documents.upsertByPath("books/a.pdf", "书A");
		const docB = documents.upsertByPath("books/b.pdf", "书B");
		const aCard = excerpt("A1", docA.id);
		autoAddCard({ documents, cards, mindmaps }, aCard); // 建书A图（本用例不消费）
		const topic = mindmaps.create("主题图");
		const pinned = mindmaps.addNode(topic.id, aCard.id, null, 0, 0)!;
		mindmaps.setFixedRoot(topic.id, pinned.id);

		expect(autoAddCard({ documents, cards, mindmaps }, excerpt("A2", docA.id, 2))).toBe(
			topic.id,
		);
		expect(autoAddCard({ documents, cards, mindmaps }, excerpt("B1", docB.id))).toBe(
			mindmaps.findByDocument(docB.id)!.id,
		);
	});

	it("linkedMapOf 门控：固定根属A时 A→固定根图、B→B目标图；无归属主题图两书都→固定根图", () => {
		const docA = documents.upsertByPath("books/a.pdf", "书A");
		const docB = documents.upsertByPath("books/b.pdf", "书B");
		autoAddCard({ documents, cards, mindmaps }, excerpt("A1", docA.id));
		const mapA = mindmaps.findByDocument(docA.id)!;
		mindmaps.setFixedRoot(mapA.id, mindmaps.listNodes(mapA.id)[0].id);
		expect(linkedMapOf({ documents, cards, mindmaps }, docA.id)).toBe(mapA.id);
		expect(linkedMapOf({ documents, cards, mindmaps }, docB.id)).toBe(
			mindmaps.findByDocument(docB.id)!.id,
		);

		// 换钉到无归属主题图（全局唯一，原钉自动清除）：两书联动都指向固定根图
		const topic = mindmaps.create("主题图");
		const manual = cards.create({
			documentId: null,
			page: null,
			rects: [],
			excerptType: "text",
			excerptText: "主题",
		});
		mindmaps.setFixedRoot(topic.id, mindmaps.addNode(topic.id, manual.id, null, 0, 0)!.id);
		expect(linkedMapOf({ documents, cards, mindmaps }, docA.id)).toBe(topic.id);
		expect(linkedMapOf({ documents, cards, mindmaps }, docB.id)).toBe(topic.id);
	});

	it("让位后按书覆盖仍生效：固定根属A，B 覆盖到主题图X → B 摘录落 X（图内建《书B》组）", () => {
		const docA = documents.upsertByPath("books/a.pdf", "书A");
		const docB = documents.upsertByPath("books/b.pdf", "书B");
		autoAddCard({ documents, cards, mindmaps }, excerpt("A1", docA.id));
		const mapA = mindmaps.findByDocument(docA.id)!;
		mindmaps.setFixedRoot(mapA.id, mindmaps.listNodes(mapA.id)[0].id);

		const topic = mindmaps.create("主题图X");
		documents.update(docB.id, { collectMapId: topic.id });
		const bCard = excerpt("B1", docB.id);
		expect(autoAddCard({ documents, cards, mindmaps }, bCard)).toBe(topic.id);
		const nodes = mindmaps.listNodes(topic.id);
		const group = nodes.find((n) => n.card.page === null && n.card.excerptText === "《书B》")!;
		expect(nodes.find((n) => n.cardId === bCard.id)!.parentId).toBe(group.id);
	});

	it("fixedRootDocOf：图 documentId 优先；回退钉节点卡片 documentId；双 null → null", () => {
		const docA = documents.upsertByPath("books/a.pdf", "书A");
		const docB = documents.upsertByPath("books/b.pdf", "书B");
		autoAddCard({ documents, cards, mindmaps }, excerpt("A1", docA.id));
		const mapA = mindmaps.findByDocument(docA.id)!;

		// 图级归属优先：即使钉节点卡片属 B，返回图的 documentId（书默认图绑定优先）
		const bCard = excerpt("B1", docB.id);
		const node = mindmaps.addNode(mapA.id, bCard.id, null, 0, 0)!;
		mindmaps.setFixedRoot(mapA.id, node.id);
		expect(
			fixedRootDocOf({ documents, cards, mindmaps }, { mapId: node.mapId, nodeId: node.id }),
		).toBe(docA.id);

		// 主题图（无 documentId）钉 B 卡节点 → 回退卡片归属
		const topic = mindmaps.create("主题图");
		const tnode = mindmaps.addNode(topic.id, bCard.id, null, 0, 0)!;
		expect(
			fixedRootDocOf(
				{ documents, cards, mindmaps },
				{ mapId: tnode.mapId, nodeId: tnode.id },
			),
		).toBe(docB.id);

		// 主题图钉手工卡（无 documentId）→ null（跨文档）
		const manual = cards.create({
			documentId: null,
			page: null,
			rects: [],
			excerptType: "text",
			excerptText: "手工",
		});
		const mnode = mindmaps.addNode(topic.id, manual.id, null, 0, 0)!;
		expect(
			fixedRootDocOf(
				{ documents, cards, mindmaps },
				{ mapId: mnode.mapId, nodeId: mnode.id },
			),
		).toBeNull();
	});

	it("固定根幂等：已在固定根所在图的卡重复触发返回 null", () => {
		const docA = documents.upsertByPath("books/a.pdf", "书A");
		const aCard = excerpt("A1", docA.id);
		const topic = mindmaps.create("主题图");
		mindmaps.addNode(topic.id, aCard.id, null, 0, 0); // 手动挂入固定根图
		const manual = cards.create({
			documentId: null,
			page: null,
			rects: [],
			excerptType: "text",
			excerptText: "主题",
		});
		mindmaps.setFixedRoot(topic.id, mindmaps.addNode(topic.id, manual.id, null, 0, 0)!.id);
		expect(autoAddCard({ documents, cards, mindmaps }, aCard)).toBeNull();
	});
});

describe("PDF 目录框架归章（55：outline 回环过滤 + chapterParentFor）", () => {
	/** 章节骨架卡工厂（镜像 mindmap-view 建框架时的 create 输入） */
	function chapter(text: string, docId: string, page: number): Card {
		return cards.create({
			documentId: docId,
			page,
			rects: [],
			excerptType: "text",
			excerptText: text,
			title: text,
			outline: true,
		});
	}

	it("章节骨架卡（outline）不入图：建框架的 created 回环被入口过滤拦住", () => {
		const doc = documents.upsertByPath("books/a.pdf", "书A");
		const map = mindmaps.create("书A", doc.id);
		const ch = chapter("第一章", doc.id, 1);
		mindmaps.addNode(map.id, ch.id, null, 0, 0);

		// 建卡流程的 cardBus created 回环会把章节卡喂回来：必须被拒
		// （page 非空会穿透摘录判定，穿透则同图重复挂/他图建脏节点）
		expect(autoAddCard({ documents, cards, mindmaps }, ch)).toBeNull();
		expect(mindmaps.list().length).toBe(1);
		expect(mindmaps.listNodes(map.id)).toHaveLength(1);
	});

	it("摘录归章：挂 page ≤ 摘录页的最大 page 章节下；早于首章回退组卡直挂", () => {
		const doc = documents.upsertByPath("books/a.pdf", "书A");
		const map = mindmaps.create("书A", doc.id);
		const group = cards.create({
			documentId: doc.id,
			page: null,
			rects: [],
			excerptType: "text",
			excerptText: "《书A》",
		});
		const gnode = mindmaps.addNode(map.id, group.id, null, 0, 0)!;
		const ch1Id = mindmaps.addNode(
			map.id,
			chapter("第一章", doc.id, 1).id,
			gnode.id,
			200,
			0,
		)!.id;
		const ch2Id = mindmaps.addNode(
			map.id,
			chapter("第二章", doc.id, 20).id,
			gnode.id,
			400,
			0,
		)!.id;

		// 页 5 → 第一章；页 25 → 第二章；页 0（前言）→ 组卡直挂
		const c5 = excerpt("页5要点", doc.id, 5);
		const c25 = excerpt("页25要点", doc.id, 25);
		const c0 = excerpt("前言", doc.id, 0);
		expect(autoAddCard({ documents, cards, mindmaps }, c5)).toBe(map.id);
		expect(autoAddCard({ documents, cards, mindmaps }, c25)).toBe(map.id);
		expect(autoAddCard({ documents, cards, mindmaps }, c0)).toBe(map.id);
		const nodes = mindmaps.listNodes(map.id);
		expect(nodes.find((n) => n.cardId === c5.id)!.parentId).toBe(ch1Id);
		expect(nodes.find((n) => n.cardId === c25.id)!.parentId).toBe(ch2Id);
		expect(nodes.find((n) => n.cardId === c0.id)!.parentId).toBe(gnode.id);
	});

	it("chapterParentFor：最大 page 者胜；平页命中其一（同毫秒创建序不定）；他书章节与他卡不干扰", () => {
		const docA = documents.upsertByPath("books/a.pdf", "书A");
		const docB = documents.upsertByPath("books/b.pdf", "书B");
		const map = mindmaps.create("框架图");
		const g = mindmaps.addNode(
			map.id,
			cards.create({
				documentId: docA.id,
				page: null,
				rects: [],
				excerptType: "text",
				excerptText: "《书A》",
			}).id,
			null,
			0,
			0,
		)!;
		// 两章同 page 5（损坏目录少见但可能）：命中其一即可（listNodes 同毫秒
		// 按 id 排序不定——语义上前章节优先，但同为 page 5 时任一都正确）
		const chA1 = mindmaps.addNode(map.id, chapter("甲一", docA.id, 5).id, g.id, 200, 0)!;
		const chA2 = mindmaps.addNode(map.id, chapter("甲二", docA.id, 5).id, g.id, 400, 0)!;
		// 后建但 page 更小：查询 6 必须命中 page 5 的章节而非 page 3（最大 page 胜）
		mindmaps.addNode(map.id, chapter("甲三", docA.id, 3).id, g.id, 600, 0);
		// 他书章节 + 普通摘录卡（page 9 非 outline）：都不参与归章
		const chB = mindmaps.addNode(map.id, chapter("乙一", docB.id, 1).id, g.id, 800, 0)!;
		mindmaps.addNode(map.id, excerpt("普通卡", docA.id, 9).id, g.id, 1000, 0);

		const nodes = mindmaps.listNodes(map.id);
		const hit = chapterParentFor(nodes, docA.id, 6);
		expect([chA1.id, chA2.id]).toContain(hit?.id);
		expect(hit?.card.page).toBe(5);
		expect(chapterParentFor(nodes, docA.id, 2)).toBeNull(); // 早于全部章节
		expect(chapterParentFor(nodes, docB.id, 6)?.id).toBe(chB.id);
		expect(chapterParentFor(nodes, "no-such-doc", 100)).toBeNull();
	});

	it("固定根优先于归章：钉住后摘录直挂固定根，不进章节分支", () => {
		const docA = documents.upsertByPath("books/a.pdf", "书A");
		// 先走默认路径建书A图（组卡 + 首摘录）
		autoAddCard({ documents, cards, mindmaps }, excerpt("A1", docA.id));
		const mapA = mindmaps.findByDocument(docA.id)!;
		const nodes0 = mindmaps.listNodes(mapA.id);
		const groupNode = nodes0.find((n) => n.card.page === null)!;
		// 组卡下加两章 + 钉组卡为固定根
		mindmaps.addNode(mapA.id, chapter("第一章", docA.id, 1).id, groupNode.id, 200, 0);
		mindmaps.addNode(mapA.id, chapter("第二章", docA.id, 30).id, groupNode.id, 400, 0);
		mindmaps.setFixedRoot(mapA.id, groupNode.id);

		const c = excerpt("页40要点", docA.id, 40);
		expect(autoAddCard({ documents, cards, mindmaps }, c)).toBe(mapA.id);
		expect(mindmaps.listNodes(mapA.id).find((n) => n.cardId === c.id)!.parentId).toBe(
			groupNode.id,
		);
	});
});

describe("归章 (page, y) 字典序泛化（62：md 同页 y 分章；pdf/epub 行为不变）", () => {
	/** md 章节卡工厂：带合成锚 rect（镜像 mindmap-view 62 建框架 create 输入） */
	function mdChapter(text: string, docId: string, anchorY: number): Card {
		return cards.create({
			documentId: docId,
			page: 1,
			rects: [{ x: 0, y: anchorY, w: 1, h: 0.001 }],
			excerptType: "text",
			excerptText: text,
			title: text,
			outline: true,
		});
	}

	/** md 摘录卡工厂：锚 rect y 真实存在（划选/留白摘录皆有归一化矩形） */
	function mdExcerpt(text: string, docId: string, anchorY: number): Card {
		return cards.create({
			documentId: docId,
			page: 1,
			rects: [{ x: 0.1, y: anchorY, w: 0.5, h: 0.02 }],
			excerptType: "text",
			excerptText: text,
		});
	}

	it("md 同页按 y 分章：摘录归 y 不晚于其锚点的最大 y 章节；先于本章起始归前章", () => {
		const doc = documents.upsertByPath("notes/a.md", "笔记A");
		const map = mindmaps.create("笔记A", doc.id);
		const group = mindmaps.addNode(
			map.id,
			cards.create({
				documentId: doc.id,
				page: null,
				rects: [],
				excerptType: "text",
				excerptText: "《笔记A》",
			}).id,
			null,
			0,
			0,
		)!;
		const ch1 = mindmaps.addNode(
			map.id,
			mdChapter("第一章", doc.id, 0.05).id,
			group.id,
			200,
			0,
		)!;
		const ch2 = mindmaps.addNode(
			map.id,
			mdChapter("第二章", doc.id, 0.5).id,
			group.id,
			400,
			0,
		)!;

		// y=0.3 的摘录 → 第一章（第二章 0.5 尚未开始）；y=0.7 → 第二章；
		// y=0.02（第一章标题之前的前言）→ 组卡直挂
		const a = mdExcerpt("章一内", doc.id, 0.3);
		const b = mdExcerpt("章二内", doc.id, 0.7);
		const pre = mdExcerpt("前言", doc.id, 0.02);
		autoAddCard({ documents, cards, mindmaps }, a);
		autoAddCard({ documents, cards, mindmaps }, b);
		autoAddCard({ documents, cards, mindmaps }, pre);
		const nodes = mindmaps.listNodes(map.id);
		expect(nodes.find((n) => n.cardId === a.id)!.parentId).toBe(ch1.id);
		expect(nodes.find((n) => n.cardId === b.id)!.parentId).toBe(ch2.id);
		expect(nodes.find((n) => n.cardId === pre.id)!.parentId).toBe(group.id);
	});

	it("chapterParentFor (page,y)：同页章节 y 超摘录 y 不命中；平 (page,y) 取先序首个", () => {
		const doc = documents.upsertByPath("notes/a.md", "笔记A");
		const map = mindmaps.create("图");
		const g = mindmaps.addNode(
			map.id,
			cards.create({
				documentId: doc.id,
				page: null,
				rects: [],
				excerptType: "text",
				excerptText: "组",
			}).id,
			null,
			0,
			0,
		)!;
		const ch1 = mindmaps.addNode(map.id, mdChapter("第一章", doc.id, 0.1).id, g.id, 0, 0)!;
		const ch1b = mindmaps.addNode(map.id, mdChapter("第一章小节", doc.id, 0.4).id, g.id, 0, 0)!;

		const nodes = mindmaps.listNodes(map.id);
		// 同页 y=0.2：第一章（0.1）命中，小节（0.4）尚未开始
		expect(chapterParentFor(nodes, doc.id, 1, 0.2)?.id).toBe(ch1.id);
		// y=0.5：小节胜（y 更大且不晚于摘录）
		expect(chapterParentFor(nodes, doc.id, 1, 0.5)?.id).toBe(ch1b.id);
		// 无 y 摘录（视页顶 0）：两章均晚于页顶 → null（回退组卡直挂）
		expect(chapterParentFor(nodes, doc.id, 1)).toBeNull();
		expect(chapterParentFor(nodes, doc.id, 1, null)).toBeNull();
	});

	it("pdf/epub 退化不变：章节 rects 空（视页顶 0）→ 纯 page 比较，跨页无条件命中", () => {
		const doc = documents.upsertByPath("books/a.pdf", "书A");
		const map = mindmaps.create("图");
		const g = mindmaps.addNode(
			map.id,
			cards.create({
				documentId: doc.id,
				page: null,
				rects: [],
				excerptType: "text",
				excerptText: "组",
			}).id,
			null,
			0,
			0,
		)!;
		const ch1 = mindmaps.addNode(
			map.id,
			cards.create({
				documentId: doc.id,
				page: 3,
				rects: [],
				excerptType: "text",
				excerptText: "一",
				title: "一",
				outline: true,
			}).id,
			g.id,
			0,
			0,
		)!;

		const nodes = mindmaps.listNodes(map.id);
		// 摘录页 10 y=0.99：章节页 3（更早页）无条件命中——与 55 行为逐字节一致
		expect(chapterParentFor(nodes, doc.id, 10, 0.99)?.id).toBe(ch1.id);
		// 同页（页 3）：章节 y 视 0 ≤ 任意摘录 y，命中
		expect(chapterParentFor(nodes, doc.id, 3, 0)?.id).toBe(ch1.id);
		// 早于章节页 → null
		expect(chapterParentFor(nodes, doc.id, 2, 0.5)).toBeNull();
	});
});
