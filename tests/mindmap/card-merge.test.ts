import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MarinMindStore } from "../../src/store/marinmind-store";
import { CardRepository } from "../../src/db/repositories/card-repo";
import { MindmapRepository } from "../../src/db/repositories/mindmap-repo";
import { LinkRepository } from "../../src/db/repositories/link-repo";
import { ReviewRepository } from "../../src/db/repositories/review-repo";
import { MemoryAdapter } from "../helpers/memory-adapter";
import { buildMergePatch, mergeCardsInto, type CardMergeHost } from "../../src/mindmap/card-merge";

let store: MarinMindStore;
let cards: CardRepository;
let mindmaps: MindmapRepository;
let links: LinkRepository;
let reviews: ReviewRepository;

beforeEach(async () => {
	store = await MarinMindStore.open(new MemoryAdapter());
	cards = new CardRepository(store);
	mindmaps = new MindmapRepository(store);
	links = new LinkRepository(store);
	reviews = new ReviewRepository(store);
});
afterEach(() => store.close());

function host(): CardMergeHost {
	return { cards, mindmaps, links, reviews, store };
}

function makeCard(text: string) {
	return cards.create({
		documentId: null,
		page: 1,
		rects: [],
		excerptType: "text",
		excerptText: text,
	});
}

describe("buildMergePatch 文本类字段并入", () => {
	it("note 双有拼接空行分隔；目标空取源", () => {
		const both = buildMergePatch(
			{ note: "源批注", excerptText: null, title: null, deck: null, color: null, occlusions: [], tags: ["a"] },
			{ note: "目标批注", excerptText: null, title: null, deck: null, color: null, occlusions: [], tags: [] },
		);
		expect(both.note).toBe("目标批注\n\n源批注");

		const emptyTarget = buildMergePatch(
			{ note: "源批注", excerptText: null, title: null, deck: null, color: null, occlusions: [], tags: [] },
			{ note: null, excerptText: null, title: null, deck: null, color: null, occlusions: [], tags: [] },
		);
		expect(emptyTarget.note).toBe("源批注");
	});

	it("目标有值的字段不动（excerptText/title/deck/color）；目标空取源", () => {
		const patch = buildMergePatch(
			{ note: null, excerptText: "源文", title: "源题", deck: "源组", color: "green", occlusions: [], tags: [] },
			{ note: null, excerptText: "目标文", title: null, deck: null, color: null, occlusions: [], tags: [] },
		);
		expect(patch.excerptText).toBeUndefined(); // 目标有
		expect(patch.title).toBe("源题"); // 目标空取源
		expect(patch.deck).toBe("源组");
		expect(patch.color).toBe("green");
	});

	it("tags 并集去重（顺序：目标在前源在后）", () => {
		const patch = buildMergePatch(
			{ note: null, excerptText: null, title: null, deck: null, color: null, occlusions: [], tags: ["b", "c"] },
			{ note: null, excerptText: null, title: null, deck: null, color: null, occlusions: [], tags: ["a", "b"] },
		);
		expect(patch.tags).toEqual(["a", "b", "c"]);

		// 无新增不发 tags 补丁
		const same = buildMergePatch(
			{ note: null, excerptText: null, title: null, deck: null, color: null, occlusions: [], tags: ["a"] },
			{ note: null, excerptText: null, title: null, deck: null, color: null, occlusions: [], tags: ["a"] },
		);
		expect(same.tags).toBeUndefined();
	});
});

describe("mergeCardsInto store 级集成", () => {
	it("基本合并：文本并入 + 源卡删除", () => {
		const source = makeCard("源摘录");
		cards.update(source.id, { note: "源批注" });
		const target = makeCard("目标摘录");
		cards.update(target.id, { note: "目标批注" });

		const result = mergeCardsInto(host(), source.id, target.id);
		expect(result).toEqual({ ok: true, affectedMapIds: [] });

		expect(cards.get(source.id)).toBeUndefined();
		const merged = cards.get(target.id)!;
		expect(merged.excerptText).toBe("目标摘录"); // 目标有值不动
		expect(merged.note).toBe("目标批注\n\n源批注");
	});

	it("节点迁移：同图目标已有节点 → 源节点子挂目标 + 源节点删除", () => {
		const map = mindmaps.create("图");
		const targetCard = makeCard("目标");
		const sourceCard = makeCard("源");
		const tn = mindmaps.addNode(map.id, targetCard.id, null, 0, 0)!;
		const sn = mindmaps.addNode(map.id, sourceCard.id, tn.id, 200, 0)!;
		const childCard = makeCard("子");
		const cn = mindmaps.addNode(map.id, childCard.id, sn.id, 400, 0)!;

		const result = mergeCardsInto(host(), sourceCard.id, targetCard.id);
		expect(result).toEqual({ ok: true, affectedMapIds: [map.id] });

		const nodes = mindmaps.listNodes(map.id);
		expect(nodes.map((n) => n.id).sort()).toEqual([tn.id, cn.id].sort()); // 源节点已删
		expect(mindmaps.getNode(cn.id)?.parentId).toBe(tn.id); // 子挂目标
		expect(mindmaps.nodesByCard(targetCard.id).map((n) => n.id)).toEqual([tn.id]);
	});

	it("节点迁移：同图无目标节点 → repoint 改挂目标卡（一图一卡不破）", () => {
		const mapA = mindmaps.create("A");
		const mapB = mindmaps.create("B");
		const targetCard = makeCard("目标");
		const sourceCard = makeCard("源");
		const tn = mindmaps.addNode(mapB.id, targetCard.id, null, 0, 0)!;
		const sn = mindmaps.addNode(mapA.id, sourceCard.id, null, 10, 10)!;

		const result = mergeCardsInto(host(), sourceCard.id, targetCard.id);
		expect(result).toEqual({ ok: true, affectedMapIds: [mapA.id] });

		// A 图源节点改挂目标卡（位置保留）
		const inA = mindmaps.listNodes(mapA.id);
		expect(inA).toHaveLength(1);
		expect(inA[0].id).toBe(sn.id);
		expect(inA[0].cardId).toBe(targetCard.id);
		// B 图目标节点不受影响
		expect(mindmaps.listNodes(mapB.id).map((n) => n.id)).toEqual([tn.id]);
	});

	it("链接转移：源的邻居逐个链到目标", () => {
		const source = makeCard("源");
		const target = makeCard("目标");
		const n1 = makeCard("邻1");
		const n2 = makeCard("邻2");
		links.link(source.id, n1.id);
		links.link(source.id, n2.id);

		mergeCardsInto(host(), source.id, target.id);
		const neighbors = links.neighbors(target.id).sort();
		expect(neighbors).toEqual([n1.id, n2.id].sort());
		expect(links.neighbors(source.id)).toEqual([]); // 源链随删卡级联清除
	});

	it("复习态承接：源闪卡目标非闪卡 → 目标承接调度字段；目标已闪卡不动", () => {
		const source = makeCard("源");
		const target = makeCard("目标");
		reviews.enable(source.id, 12345);
		reviews.review(source.id, "good", 20000); // 推进调度留下 ease/interval 痕迹
		const sourceStateBefore = reviews.get(source.id)!;

		mergeCardsInto(host(), source.id, target.id);
		const state = reviews.get(target.id)!;
		expect(state.isFlashcard).toBe(true);
		expect(state.dueAt).toBe(sourceStateBefore.dueAt);
		expect(state.ease).toBe(sourceStateBefore.ease);
		expect(state.intervalDays).toBe(sourceStateBefore.intervalDays);

		// 目标已启用闪卡时不被源覆盖
		const source2 = makeCard("源2");
		const target2 = makeCard("目标2");
		reviews.enable(source2.id, 100);
		reviews.enable(target2.id, 99999);
		mergeCardsInto(host(), source2.id, target2.id);
		expect(reviews.get(target2.id)?.dueAt).toBe(99999);
	});

	it("拒绝路径：自身合并 / 卡片不存在", () => {
		const card = makeCard("卡");
		expect(mergeCardsInto(host(), card.id, card.id)).toEqual({
			ok: false,
			reason: "不能与自身合并",
		});
		expect(mergeCardsInto(host(), "ghost", card.id).ok).toBe(false);
		expect(mergeCardsInto(host(), card.id, "ghost").ok).toBe(false);
	});

	it("repointNode 一图一卡预检：目标卡同图已有节点 → undefined；合法改挂成功", () => {
		const map = mindmaps.create("图");
		const map2 = mindmaps.create("图2");
		const a = makeCard("A");
		const b = makeCard("B");
		const an = mindmaps.addNode(map.id, a.id, null, 0, 0)!;
		const bn = mindmaps.addNode(map.id, b.id, null, 0, 100)!;
		const an2 = mindmaps.addNode(map2.id, a.id, null, 0, 0)!;

		expect(mindmaps.repointNode(bn.id, a.id)).toBeUndefined(); // 同图已有 A 节点
		expect(mindmaps.repointNode(bn.id, "ghost-card")).toBeUndefined(); // 卡不存在
		// 图2 无 B 节点：合法改挂（坐标保留、mapId 不变）
		const ok = mindmaps.repointNode(an2.id, b.id);
		expect(ok?.cardId).toBe(b.id);
		expect(ok?.mapId).toBe(map2.id);
		expect(mindmaps.listNodes(map2.id)[0].x).toBe(0);
	});
});
