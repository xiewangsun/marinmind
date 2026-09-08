/**
 * map-delete 单测（批次㊾）：删除脑图记录单源——mindmaps.delete 级联
 * （store.deleteMap 物理删图 md + collectMapId 清空 + portal childMapId 清扫）。
 * obsidian 以 vi.mock 替身（Notice 断言 + Modal/ButtonComponent 桩供
 * ConfirmModal 类定义——本文件不实例化弹窗）；仓储用真实 MarinMindStore +
 * MemoryAdapter（镜像 doc-delete.test 先例）。map-delete 刻意不 import
 * mindmap-view（refreshActiveMindmaps 由 home-pages 接线），本测试依赖图保持轻。
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
import { MindmapRepository } from "../../src/db/repositories/mindmap-repo";
import { DocumentRepository } from "../../src/db/repositories/document-repo";
import { CardRepository } from "../../src/db/repositories/card-repo";
import { deleteMindmapRecord } from "../../src/mindmap/map-delete";
import { MemoryAdapter } from "../helpers/memory-adapter";
import type MarinMindPlugin from "../../src/main";

interface Rig {
	mindmaps: MindmapRepository;
	documents: DocumentRepository;
	cards: CardRepository;
	plugin: MarinMindPlugin;
}

/** 每个用例独立内存库 + 真实仓储（删图链路全真，仅视图层不在测试图内） */
async function makeRig(): Promise<Rig> {
	const store = await MarinMindStore.open(new MemoryAdapter());
	const mindmaps = new MindmapRepository(store);
	const documents = new DocumentRepository(store);
	const cards = new CardRepository(store);
	const plugin = {
		whenReady: () => Promise.resolve(),
		mindmaps,
		documents,
		cards,
	} as unknown as MarinMindPlugin;
	return { mindmaps, documents, cards, plugin };
}

describe("deleteMindmapRecord 删除脑图记录", () => {
	it("删图成功 → 图与节点消失、卡片保留 → true + 成功 Notice", async () => {
		const rig = await makeRig();
		const doc = rig.documents.upsertByPath("books/a.pdf", "A");
		const card = rig.cards.create({
			documentId: doc.id,
			page: 1,
			rects: [],
			excerptType: "text",
			excerptText: "卡",
		});
		const map = rig.mindmaps.create("我的图");
		rig.mindmaps.addNode(map.id, card.id, null, 0, 0);
		rig.documents.update(doc.id, { collectMapId: map.id }); // 摘录目标图绑定

		const ok = await deleteMindmapRecord(rig.plugin, map);

		expect(ok).toBe(true);
		expect(rig.mindmaps.get(map.id)).toBeUndefined();
		expect(rig.mindmaps.list().some((m) => m.id === map.id)).toBe(false);
		expect(rig.mindmaps.countNodes(map.id)).toBe(0); // 节点随图级联
		expect(rig.cards.get(card.id)).toBeDefined(); // 卡片保留
		expect(rig.documents.get(doc.id)?.collectMapId).toBeNull(); // 绑定清空回退默认图
		expect(Notice).toHaveBeenCalledWith("脑图已删除");
	});

	it("portal 清扫：其他图指向被删图的 childMapId 置 null", async () => {
		const rig = await makeRig();
		const doc = rig.documents.upsertByPath("books/b.pdf", "B");
		const card = rig.cards.create({
			documentId: doc.id,
			page: 1,
			rects: [],
			excerptType: "text",
			excerptText: "卡",
		});
		const outer = rig.mindmaps.create("外层图");
		const inner = rig.mindmaps.create("内层子图");
		const node = rig.mindmaps.addNode(outer.id, card.id, null, 0, 0);
		rig.mindmaps.setChildMap(node!.id, inner.id); // portal 接线

		const ok = await deleteMindmapRecord(rig.plugin, inner);

		expect(ok).toBe(true);
		expect(rig.mindmaps.getNode(node!.id)?.childMapId).toBeNull(); // 悬空引用被清扫
		expect(rig.mindmaps.get(outer.id)).toBeDefined(); // 外层图不受影响
	});

	it("图已不存在（delete 落空）→ false 且不弹成功 Notice", async () => {
		const rig = await makeRig();
		const map = rig.mindmaps.create("瞬时图");
		rig.mindmaps.delete(map.id); // 先删一次，模拟外部删除竞态

		const callsBefore = vi.mocked(Notice).mock.calls.length;
		const ok = await deleteMindmapRecord(rig.plugin, map);

		expect(ok).toBe(false);
		expect(vi.mocked(Notice).mock.calls.length).toBe(callsBefore); // 无任何新 Notice
	});

	it("删图抛错 → false + 失败 Notice（不吞异常）", async () => {
		const rig = await makeRig();
		const map = rig.mindmaps.create("将炸图");
		vi.spyOn(rig.mindmaps, "delete").mockImplementation(() => {
			throw new Error("fs busy");
		});

		const ok = await deleteMindmapRecord(rig.plugin, map);

		expect(ok).toBe(false);
		const last = vi.mocked(Notice).mock.calls.at(-1)?.[0];
		expect(String(last)).toContain("fs busy");
	});
});
