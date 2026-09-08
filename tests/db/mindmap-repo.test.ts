import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MarinMindStore } from "../../src/store/marinmind-store";
import { CardRepository } from "../../src/db/repositories/card-repo";
import { DocumentRepository } from "../../src/db/repositories/document-repo";
import { MindmapRepository } from "../../src/db/repositories/mindmap-repo";
import { MemoryAdapter } from "../helpers/memory-adapter";

let store: MarinMindStore;
let documents: DocumentRepository;
let cards: CardRepository;
let mindmaps: MindmapRepository;

/** 每个用例使用独立的内存存储（㉚ md 存储版；老 SQLite 库升级路径已于 129 批移除） */
beforeEach(async () => {
	store = await MarinMindStore.open(new MemoryAdapter());
	documents = new DocumentRepository(store);
	cards = new CardRepository(store);
	mindmaps = new MindmapRepository(store);
});
afterEach(() => store.close());

function makeCard(text: string, documentId: string | null = null) {
	return cards.create({
		documentId,
		page: 1,
		rects: [],
		excerptType: "text",
		excerptText: text,
	});
}

describe("脑图仓储", () => {
	it("create/get/rename/list：list 按最近使用在前", () => {
		const a = mindmaps.create("图一");
		const b = mindmaps.create("图二");
		expect(mindmaps.get(a.id)?.name).toBe("图一");
		expect(mindmaps.list().map((m) => m.id)).toEqual([b.id, a.id]);

		mindmaps.rename(a.id, "改名");
		expect(mindmaps.get(a.id)?.name).toBe("改名");
		expect(mindmaps.rename("不存在", "x")).toBeUndefined();
	});

	it("addNode + listNodes：节点字段与卡片本体往返完整", () => {
		const doc = documents.upsertByPath("books/a.pdf", "书A");
		const card = makeCard("要点", doc.id);
		const map = mindmaps.create("图");

		const added = mindmaps.addNode(map.id, card.id, null, 10, 20);
		expect(added?.parentId).toBeNull();
		expect(added?.card.excerptText).toBe("要点");
		expect(added?.card.tags).toEqual([]);

		const nodes = mindmaps.listNodes(map.id);
		expect(nodes).toHaveLength(1);
		expect(nodes[0].id).toBe(added?.id);
		expect(nodes[0].card.id).toBe(card.id);
	});

	it("同图重复加卡返回 undefined；不同图可加同一卡", () => {
		const card = makeCard("同一张卡");
		const mapA = mindmaps.create("A");
		const mapB = mindmaps.create("B");

		expect(mindmaps.addNode(mapA.id, card.id, null, 0, 0)).toBeDefined();
		expect(mindmaps.addNode(mapA.id, card.id, null, 5, 5)).toBeUndefined();
		expect(mindmaps.hasCard(mapA.id, card.id)).toBe(true);
		// 不同图互不影响
		expect(mindmaps.addNode(mapB.id, card.id, null, 0, 0)).toBeDefined();
		expect(mindmaps.countNodes(mapB.id)).toBe(1);
	});

	it("nodesByCard 按卡反查节点引用（一卡多图各一节点；㉒ 复习脑图上下文入口）", () => {
		const card = makeCard("跨图卡");
		const mapA = mindmaps.create("A");
		const mapB = mindmaps.create("B");
		const rootB = mindmaps.addNode(mapB.id, makeCard("B 根").id, null, 0, 0)!;

		const nodeA = mindmaps.addNode(mapA.id, card.id, null, 1, 1)!;
		const nodeB = mindmaps.addNode(mapB.id, card.id, rootB.id, 2, 2)!;

		const hits = mindmaps.nodesByCard(card.id);
		expect(hits.map((n) => n.id).sort()).toEqual([nodeA.id, nodeB.id].sort());
		// 附带卡片本体（位置摘要要取标题）与父子关系
		expect(hits.every((n) => n.card.id === card.id)).toBe(true);
		expect(hits.find((n) => n.id === nodeB.id)?.parentId).toBe(rootB.id);
		expect(mindmaps.nodesByCard("不存在的卡")).toEqual([]);
	});

	it("moveNode 更新坐标（小数取整）", () => {
		const card = makeCard("卡");
		const map = mindmaps.create("图");
		const node = mindmaps.addNode(map.id, card.id, null, 0, 0)!;

		mindmaps.moveNode(node.id, 10.6, -3.2);
		const moved = mindmaps.getNode(node.id)!;
		expect(moved.x).toBe(11);
		expect(moved.y).toBe(-3);
	});

	it("setParent：同图成功；跨图/自身返回 undefined", () => {
		const c1 = makeCard("1");
		const c2 = makeCard("2");
		const mapA = mindmaps.create("A");
		const mapB = mindmaps.create("B");
		const n1 = mindmaps.addNode(mapA.id, c1.id, null, 0, 0)!;
		const n2 = mindmaps.addNode(mapA.id, c2.id, null, 0, 0)!;
		const nOther = mindmaps.addNode(mapB.id, makeCard("3").id, null, 0, 0)!;

		expect(mindmaps.setParent(n2.id, n1.id)?.parentId).toBe(n1.id);
		expect(mindmaps.setParent(n1.id, n1.id)).toBeUndefined(); // 自身
		expect(mindmaps.setParent(n1.id, nOther.id)).toBeUndefined(); // 跨图
		// 置空 = 变回根
		expect(mindmaps.setParent(n2.id, null)?.parentId).toBeNull();
	});

	it("addNode 兄弟序追加末位（㉜：新节点 order 递增，不覆盖旧序）", () => {
		const map = mindmaps.create("图");
		const c1 = makeCard("1").id;
		const c2 = makeCard("2").id;
		const n1 = mindmaps.addNode(map.id, c1, null, 0, 0)!;
		const n2 = mindmaps.addNode(map.id, c2, null, 0, 0)!;
		expect(n1.order).toBe(0);
		expect(n2.order).toBe(1);
	});

	it("setParent 带 order 参数（㉜ before/after 插同级）：缺省保留原序号", () => {
		const map = mindmaps.create("图");
		const c1 = makeCard("1");
		const c2 = makeCard("2");
		const c3 = makeCard("3");
		const n1 = mindmaps.addNode(map.id, c1.id, null, 0, 0)!;
		const n2 = mindmaps.addNode(map.id, c2.id, n1.id, 0, 0)!;
		const n3 = mindmaps.addNode(map.id, c3.id, n1.id, 0, 0)!;
		// before/after 插同级：新父 = 原父（n1），order 由 insertOrder 计算的中点
		const moved = mindmaps.setParent(n2.id, n1.id, 0.5);
		expect(moved?.parentId).toBe(n1.id);
		expect(moved?.order).toBe(0.5);
		// 缺省 order：保留原序号（普通改父不重排）
		const ret = mindmaps.setParent(n3.id, n1.id);
		expect(ret?.order).toBe(n3.order); // 未变
	});

	it("removeNode 后子节点上浮为根（SET NULL）", () => {
		const c1 = makeCard("1");
		const c2 = makeCard("2");
		const map = mindmaps.create("图");
		const n1 = mindmaps.addNode(map.id, c1.id, null, 0, 0)!;
		const n2 = mindmaps.addNode(map.id, c2.id, n1.id, 100, 0)!;

		expect(mindmaps.removeNode(n1.id)).toBe(true);
		expect(mindmaps.getNode(n1.id)).toBeUndefined();
		expect(mindmaps.getNode(n2.id)?.parentId).toBeNull();
	});

	it("级联：删图→节点消失；删卡→节点消失且其子节点上浮；删文档→卡与节点消失", () => {
		const doc = documents.upsertByPath("books/a.pdf", "书");
		const c1 = makeCard("1", doc.id);
		const c2 = makeCard("2", doc.id);
		const map = mindmaps.create("图");
		const n1 = mindmaps.addNode(map.id, c1.id, null, 0, 0)!;
		const n2 = mindmaps.addNode(map.id, c2.id, n1.id, 100, 0)!;

		// 删卡：其节点级联消失，子节点上浮为根（对齐旧库 parent_id SET NULL）
		cards.delete(c2.id);
		expect(mindmaps.countNodes(map.id)).toBe(1);
		expect(mindmaps.getNode(n2.id)).toBeUndefined();

		// 删文档：卡片连同节点两跳级联消失
		documents.delete(doc.id);
		expect(mindmaps.countNodes(map.id)).toBe(0);

		// 再补一个节点验证删图级联
		const c3 = makeCard("3");
		mindmaps.addNode(map.id, c3.id, null, 0, 0);
		expect(mindmaps.countNodes(map.id)).toBe(1);
		mindmaps.delete(map.id);
		expect(mindmaps.countNodes()).toBe(0);
	});

	it("删中间卡后其子节点上浮（跨代不丢子树）", () => {
		const c1 = makeCard("1");
		const c2 = makeCard("2");
		const c3 = makeCard("3");
		const map = mindmaps.create("图");
		const n1 = mindmaps.addNode(map.id, c1.id, null, 0, 0)!;
		const n2 = mindmaps.addNode(map.id, c2.id, n1.id, 100, 0)!;
		mindmaps.addNode(map.id, c3.id, n2.id, 200, 0);

		cards.delete(c2.id); // 删中间层
		expect(mindmaps.getNode(n2.id)).toBeUndefined();
		const nodes = mindmaps.listNodes(map.id);
		expect(nodes.map((n) => n.cardId).sort()).toEqual([c1.id, c3.id].sort());
		expect(nodes.find((n) => n.cardId === c3.id)?.parentId).toBeNull(); // 孙辈上浮为根
	});

	it("addNode 前移图的 updated_at（list 最近使用排序变化）", async () => {
		const a = mindmaps.create("A");
		await new Promise((r) => setTimeout(r, 5)); // 保证时间戳不同
		const b = mindmaps.create("B");
		expect(mindmaps.list().map((m) => m.id)).toEqual([b.id, a.id]);

		await new Promise((r) => setTimeout(r, 5)); // 保证 addNode 的 updated_at 严格晚于 B 创建时刻（毫秒粒度）
		const card = makeCard("卡");
		mindmaps.addNode(a.id, card.id, null, 0, 0);
		expect(mindmaps.list().map((m) => m.id)).toEqual([a.id, b.id]);
	});

	// ---------- ⑨-C 折叠态 / 自动布局 ----------

	it("setCollapsed + applyLayout：写回取整，重开后折叠态与坐标保留", async () => {
		const adapter = new MemoryAdapter();
		const store1 = await MarinMindStore.open(adapter);
		const cards1 = new CardRepository(store1);
		const maps1 = new MindmapRepository(store1);
		const map = maps1.create("图");
		const c1 = cards1.create({
			documentId: null,
			page: null,
			rects: [],
			excerptType: "text",
			excerptText: "1",
		});
		const c2 = cards1.create({
			documentId: null,
			page: null,
			rects: [],
			excerptType: "text",
			excerptText: "2",
		});
		const n1 = maps1.addNode(map.id, c1.id, null, 0, 0)!;
		const n2 = maps1.addNode(map.id, c2.id, n1.id, 0, 0)!;

		maps1.setCollapsed(n1.id, true);
		maps1.applyLayout(
			map.id,
			new Map([
				[n1.id, { x: 10.4, y: 20.6 }],
				[n2.id, { x: 300.9, y: -5.2 }],
			]),
		);
		// 悬空 id 静默跳过（map 守卫），不影响其余写入
		maps1.applyLayout(map.id, new Map([["ghost", { x: 1, y: 1 }]]));
		await store1.flush();
		store1.close();

		const store2 = await MarinMindStore.open(adapter);
		const maps2 = new MindmapRepository(store2);
		const r1 = maps2.getNode(n1.id)!;
		expect(r1.collapsed).toBe(true);
		expect(r1.x).toBe(10); // 坐标取整入库
		expect(maps2.getNode(n2.id)?.y).toBe(-5);
		// listNodes 同样带出折叠态
		const listed = maps2.listNodes(map.id);
		expect(listed.find((n) => n.id === n2.id)?.collapsed).toBe(false);
		store2.close();
	});

	// ---------- ⑱ 分支样式 ----------

	it("分支样式读写往返：图默认 + 节点覆盖（null=继承）", () => {
		const card = makeCard("卡");
		const map = mindmaps.create("图");
		const node = mindmaps.addNode(map.id, card.id, null, 0, 0)!;

		// 新图/新节点默认值
		expect(mindmaps.get(map.id)?.defaultBranchStyle).toBe("tree");
		expect(mindmaps.getNode(node.id)?.branchStyle).toBeNull();

		// 图默认切换：未覆盖的节点读取侧仍为 null（继承由视图层解析）
		mindmaps.setDefaultBranchStyle(map.id, "bidir");
		expect(mindmaps.get(map.id)?.defaultBranchStyle).toBe("bidir");

		// 节点覆盖与清除
		mindmaps.setBranchStyle(node.id, "frame");
		expect(mindmaps.getNode(node.id)?.branchStyle).toBe("frame");
		expect(mindmaps.listNodes(map.id)[0].branchStyle).toBe("frame"); // 同样带出
		mindmaps.setBranchStyle(node.id, null);
		expect(mindmaps.getNode(node.id)?.branchStyle).toBeNull();
	});

	// ---------- ㉗ v8：书籍默认脑图 + 固定根节点 ----------

	it("create 携带 documentId + findByDocument：一书一图（重复创建抛错）", () => {
		const doc = documents.upsertByPath("books/a.pdf", "书A");
		const map = mindmaps.create(doc.title, doc.id);
		expect(map.documentId).toBe(doc.id);
		expect(map.fixedRootNodeId).toBeNull();
		expect(mindmaps.findByDocument(doc.id)?.id).toBe(map.id);
		// 一书一图（对齐旧库 UNIQUE）
		expect(() => mindmaps.create("重复图", doc.id)).toThrow();
		// 普通图不带文档归属
		expect(mindmaps.create("普通图").documentId).toBeNull();
		// 删文档：document_id 置空，图保留退化为普通图
		documents.delete(doc.id);
		expect(mindmaps.get(map.id)?.documentId).toBeNull();
	});

	it("setFixedRoot：全局唯一（后设清先设）；跨图节点拒绝；取消后为空", () => {
		const c1 = makeCard("1");
		const c2 = makeCard("2");
		const mapA = mindmaps.create("A");
		const mapB = mindmaps.create("B");
		const nA = mindmaps.addNode(mapA.id, c1.id, null, 0, 0)!;
		const nB = mindmaps.addNode(mapB.id, c2.id, null, 0, 0)!;

		// 跨图节点拒绝
		expect(mindmaps.setFixedRoot(mapB.id, nA.id)).toBe(false);
		expect(mindmaps.fixedRoot()).toBeNull();

		// 设定成功；改设在另一张图时自动清掉原图（全局唯一）
		expect(mindmaps.setFixedRoot(mapA.id, nA.id)).toBe(true);
		expect(mindmaps.fixedRoot()).toEqual({ mapId: mapA.id, nodeId: nA.id });
		expect(mindmaps.setFixedRoot(mapB.id, nB.id)).toBe(true);
		expect(mindmaps.fixedRoot()).toEqual({ mapId: mapB.id, nodeId: nB.id });
		expect(mindmaps.get(mapA.id)?.fixedRootNodeId).toBeNull();

		// 取消
		expect(mindmaps.setFixedRoot(mapB.id, null)).toBe(true);
		expect(mindmaps.fixedRoot()).toBeNull();
	});

	it("删除固定根节点：自动解钉", () => {
		const card = makeCard("卡");
		const map = mindmaps.create("图");
		const node = mindmaps.addNode(map.id, card.id, null, 0, 0)!;
		mindmaps.setFixedRoot(map.id, node.id);
		expect(mindmaps.fixedRoot()).not.toBeNull();

		mindmaps.removeNode(node.id);
		expect(mindmaps.fixedRoot()).toBeNull();
		expect(mindmaps.get(map.id)?.fixedRootNodeId).toBeNull();
	});

	it("删除带固定根的整图：图删即引用消失", () => {
		const card = makeCard("卡");
		const map = mindmaps.create("图");
		const node = mindmaps.addNode(map.id, card.id, null, 0, 0)!;
		mindmaps.setFixedRoot(map.id, node.id);

		expect(mindmaps.delete(map.id)).toBe(true);
		expect(mindmaps.fixedRoot()).toBeNull();
		expect(mindmaps.list()).toHaveLength(0);
	});

	// ---------- 61 子脑图坍缩 ----------

	it("moveSubtreeToMap 整子树链迁移：父链完整搬走、目标图引用隔离", () => {
		const c1 = makeCard("根");
		const c2 = makeCard("子");
		const c3 = makeCard("孙");
		const mapA = mindmaps.create("A");
		const mapB = mindmaps.create("B");
		const root = mindmaps.addNode(mapA.id, c1.id, null, 0, 0)!;
		const child = mindmaps.addNode(mapA.id, c2.id, root.id, 100, 0)!;
		const grand = mindmaps.addNode(mapA.id, c3.id, child.id, 200, 0)!;

		expect(mindmaps.moveSubtreeToMap(child.id, mapB.id)).toBe(true);
		expect(mindmaps.countNodes(mapA.id)).toBe(1); // 源图只剩根
		expect(mindmaps.countNodes(mapB.id)).toBe(2);
		const bChild = mindmaps.getNode(child.id)!;
		expect(bChild.mapId).toBe(mapB.id);
		expect(bChild.parentId).toBeNull(); // 缺省父 = 成根
		expect(mindmaps.getNode(grand.id)?.parentId).toBe(child.id); // 孙仍挂子下
		// 迁移后双图节点为独立对象：改 B 坐标不影响（getNode 每次取，验证 mapId 已换）
		mindmaps.moveNode(child.id, 500, 500);
		expect(mindmaps.getNode(child.id)?.x).toBe(500);
		expect(mindmaps.getNode(root.id)?.mapId).toBe(mapA.id);
	});

	it("moveSubtreeToMap targetParentId 两语义：null 保 order 成根 / 非 null 追加末位", () => {
		const mapA = mindmaps.create("A");
		const mapB = mindmaps.create("B");
		const pa = mindmaps.addNode(mapA.id, makeCard("父").id, null, 0, 0)!;
		const c0 = mindmaps.addNode(mapA.id, makeCard("兄0").id, pa.id, 0, 0)!;
		const c1 = mindmaps.addNode(mapA.id, makeCard("兄1").id, pa.id, 0, 0)!;
		// B 图内既有根（解除坍缩场景：坍缩期间新加的子）
		const bHost = mindmaps.addNode(mapB.id, makeCard("宿主").id, null, 0, 0)!;

		// 兄0 成根（order 保留 0）；兄1 挂宿主下（追加末位 order=0：宿主原无子）
		expect(mindmaps.moveSubtreeToMap(c0.id, mapB.id)).toBe(true);
		expect(mindmaps.moveSubtreeToMap(c1.id, mapB.id, bHost.id)).toBe(true);
		const r0 = mindmaps.getNode(c0.id)!;
		const r1 = mindmaps.getNode(c1.id)!;
		expect(r0.parentId).toBeNull();
		expect(r0.order).toBe(c0.order); // order 保留 → 坍缩后 B 内根序 = 原兄弟序
		expect(r1.parentId).toBe(bHost.id);
		expect(r1.order).toBe(0); // 追加末位（宿主下第一个子）
		// 再迁一个到宿主下：order 递增（排在坍缩期间新加子之后）
		const c2 = mindmaps.addNode(mapA.id, makeCard("弟2").id, pa.id, 0, 0)!;
		mindmaps.moveSubtreeToMap(c2.id, mapB.id, bHost.id);
		expect(mindmaps.getNode(c2.id)?.order).toBe(1);
	});

	it("moveSubtreeToMap 整批预检：子树任一卡已在目标图 → 整批拒绝零改动", () => {
		const shared = makeCard("同卡");
		const c2 = makeCard("子");
		const mapA = mindmaps.create("A");
		const mapB = mindmaps.create("B");
		const root = mindmaps.addNode(mapA.id, shared.id, null, 0, 0)!;
		mindmaps.addNode(mapA.id, c2.id, root.id, 100, 0)!;
		mindmaps.addNode(mapB.id, shared.id, null, 0, 0); // B 已有该卡

		expect(mindmaps.moveSubtreeToMap(root.id, mapB.id)).toBe(false);
		expect(mindmaps.countNodes(mapA.id)).toBe(2); // 零改动
		expect(mindmaps.countNodes(mapB.id)).toBe(1);
		expect(mindmaps.getNode(root.id)?.mapId).toBe(mapA.id);
	});

	it("moveSubtreeToMap 失败分支：目标图不存在 / 源=目标 / 挂点不在目标图", () => {
		const mapA = mindmaps.create("A");
		const mapB = mindmaps.create("B");
		const aNode = mindmaps.addNode(mapA.id, makeCard("a").id, null, 0, 0)!;
		const aOther = mindmaps.addNode(mapA.id, makeCard("other").id, null, 0, 0)!;

		expect(mindmaps.moveSubtreeToMap(aNode.id, "ghost")).toBe(false);
		expect(mindmaps.moveSubtreeToMap(aNode.id, mapA.id)).toBe(false); // 源=目标
		expect(mindmaps.moveSubtreeToMap(aNode.id, mapB.id, aOther.id)).toBe(false); // 挂点属 A
		expect(mindmaps.moveSubtreeToMap("ghost", mapB.id)).toBe(false);
		expect(mindmaps.countNodes(mapA.id)).toBe(2);
	});

	it("moveSubtreeToMap：源图固定根在子树内 → 解钉（对齐 removeNode）", () => {
		const c1 = makeCard("根");
		const c2 = makeCard("子");
		const mapA = mindmaps.create("A");
		const mapB = mindmaps.create("B");
		const root = mindmaps.addNode(mapA.id, c1.id, null, 0, 0)!;
		const child = mindmaps.addNode(mapA.id, c2.id, root.id, 100, 0)!;
		mindmaps.setFixedRoot(mapA.id, root.id);
		expect(mindmaps.fixedRoot()).not.toBeNull();

		mindmaps.moveSubtreeToMap(child.id, mapB.id);
		expect(mindmaps.fixedRoot()).not.toBeNull(); // 固定根本身未迁，钉保持

		expect(mindmaps.moveSubtreeToMap(root.id, mapB.id)).toBe(true);
		expect(mindmaps.fixedRoot()).toBeNull(); // 固定根随子树迁走 → 解钉
	});

	it("setChildMap：设置/清除 portal 引用（61 唯一写入口）", () => {
		const mapA = mindmaps.create("A");
		const mapB = mindmaps.create("B");
		const node = mindmaps.addNode(mapA.id, makeCard("卡").id, null, 0, 0)!;
		expect(node.childMapId).toBeNull(); // addNode 默认非 portal

		mindmaps.setChildMap(node.id, mapB.id);
		expect(mindmaps.getNode(node.id)?.childMapId).toBe(mapB.id);
		mindmaps.setChildMap(node.id, null);
		expect(mindmaps.getNode(node.id)?.childMapId).toBeNull();
	});

	it("delete portal 清扫：删子图后其他图指向它的引用置 null", () => {
		const mapA = mindmaps.create("A");
		const mapB = mindmaps.create("B");
		const n1 = mindmaps.addNode(mapA.id, makeCard("portal").id, null, 0, 0)!;
		const n2 = mindmaps.addNode(mapA.id, makeCard("普通").id, null, 0, 0)!;
		mindmaps.setChildMap(n1.id, mapB.id);
		mindmaps.setChildMap(n2.id, mapB.id); // 多个 portal 同指一图

		expect(mindmaps.delete(mapB.id)).toBe(true);
		expect(mindmaps.getNode(n1.id)?.childMapId).toBeNull();
		expect(mindmaps.getNode(n2.id)?.childMapId).toBeNull();
		expect(mindmaps.get(mapB.id)).toBeUndefined();
	});
});
