import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MarinMindStore } from "../../src/store/marinmind-store";
import { CardRepository } from "../../src/db/repositories/card-repo";
import { MindmapRepository } from "../../src/db/repositories/mindmap-repo";
import { MemoryAdapter } from "../helpers/memory-adapter";
import {
	applyUndoEntry,
	buildUndoEntry,
	captureMapState,
	MindmapUndoStack,
	UNDO_STACK_LIMIT,
	type UndoEntry,
} from "../../src/mindmap/undo-stack";
import type { MindmapNodeWithCard } from "../../src/types";

let store: MarinMindStore;
let cards: CardRepository;
let mindmaps: MindmapRepository;

beforeEach(async () => {
	store = await MarinMindStore.open(new MemoryAdapter());
	cards = new CardRepository(store);
	mindmaps = new MindmapRepository(store);
});
afterEach(() => store.close());

function makeCard(text: string) {
	return cards.create({
		documentId: null,
		page: 1,
		rects: [],
		excerptType: "text",
		excerptText: text,
	});
}

/** 便捷断言：可回退字段集合（id → 简化对象） */
function rewindOf(nodes: MindmapNodeWithCard[]) {
	return new Map(
		nodes.map((n) => [
			n.id,
			{
				x: n.x,
				y: n.y,
				parentId: n.parentId,
				order: n.order,
				collapsed: n.collapsed,
				branchStyle: n.branchStyle,
			},
		]),
	);
}

describe("MindmapUndoStack 栈行为", () => {
	it("push 清空 redo 分支（新命令作废重做历史）", () => {
		const stack = new MindmapUndoStack();
		const e1 = makeEntry("一");
		const e2 = makeEntry("二");
		stack.push(e1);
		stack.undo();
		expect(stack.canRedo()).toBe(true);
		stack.push(e2);
		expect(stack.canRedo()).toBe(false);
		expect(stack.redo()).toBeNull();
	});

	it("undo/redo 弹出互压：撤销后可重做，重做后可再撤销", () => {
		const stack = new MindmapUndoStack();
		stack.push(makeEntry("一"));
		stack.push(makeEntry("二"));
		const top = stack.undo();
		expect(top?.label).toBe("二");
		expect(stack.canUndo()).toBe(true); // "一" 仍在
		const again = stack.redo();
		expect(again?.label).toBe("二");
		expect(stack.canRedo()).toBe(false);
	});

	it("深度上限 50：超出丢最旧", () => {
		const stack = new MindmapUndoStack();
		for (let i = 0; i < UNDO_STACK_LIMIT + 5; i++) {
			stack.push(makeEntry(`命令${i}`));
		}
		let last: UndoEntry | null = null;
		while (stack.canUndo()) {
			last = stack.undo();
		}
		expect(UNDO_STACK_LIMIT).toBe(50);
		expect(last?.label).toBe("命令5"); // 命令0-4 被挤出，栈底是命令5
	});

	it("clear 双栈全空", () => {
		const stack = new MindmapUndoStack();
		stack.push(makeEntry("一"));
		stack.undo();
		stack.push(makeEntry("二"));
		stack.clear();
		expect(stack.canUndo()).toBe(false);
		expect(stack.canRedo()).toBe(false);
	});
});

describe("undo-stack 真 repo 集成（capture/diff/重放）", () => {
	it("capture → 改 → capture：差分只含变化节点", () => {
		const map = mindmaps.create("图");
		const root = mindmaps.addNode(map.id, makeCard("根").id, null, 0, 0)!;
		const child = mindmaps.addNode(map.id, makeCard("子").id, root.id, 200, 0)!;
		const other = mindmaps.addNode(map.id, makeCard("旁").id, root.id, 200, 100)!;

		const before = captureMapState(mindmaps, map.id);
		mindmaps.moveNode(child.id, 500, 300);
		const after = captureMapState(mindmaps, map.id);

		const entry = buildUndoEntry(map.id, "移动", before, after, null)!;
		expect(entry.nodes.size).toBe(1);
		expect(entry.nodes.has(child.id)).toBe(true);
		expect(entry.nodes.get(child.id)).toEqual({
			before: {
				x: 200,
				y: 0,
				parentId: root.id,
				order: 0,
				collapsed: false,
				branchStyle: null,
			},
			after: {
				x: 500,
				y: 300,
				parentId: root.id,
				order: 0,
				collapsed: false,
				branchStyle: null,
			},
		});
		expect(entry.nodes.has(other.id)).toBe(false); // 未变节点不进 diff
	});

	it("无 diff 返回 null（等价操作不占栈）", () => {
		const map = mindmaps.create("图");
		mindmaps.addNode(map.id, makeCard("卡").id, null, 1, 2);
		const before = captureMapState(mindmaps, map.id);
		const after = captureMapState(mindmaps, map.id);
		expect(buildUndoEntry(map.id, "空操作", before, after, null)).toBeNull();
		// 仅 mapDefault 无节点 diff 也成条
		expect(
			buildUndoEntry(map.id, "默认样式", before, after, { before: "tree", after: "line" }),
		).not.toBeNull();
	});

	it("apply(before) 后图状态逐字段等于操作前（结构改父+折叠+样式）", () => {
		const map = mindmaps.create("图");
		const a = mindmaps.addNode(map.id, makeCard("A").id, null, 0, 0)!;
		const b = mindmaps.addNode(map.id, makeCard("B").id, a.id, 200, 0)!;
		const c = mindmaps.addNode(map.id, makeCard("C").id, a.id, 200, 100)!;
		const before = captureMapState(mindmaps, map.id);

		// 用户命令：C 挂到 B 下 + 折叠 A + C 样式覆盖 + 挪位
		mindmaps.setParent(c.id, b.id, 0);
		mindmaps.setCollapsed(a.id, true);
		mindmaps.setBranchStyle(c.id, "frame");
		mindmaps.moveNode(c.id, 400, 200);
		const after = captureMapState(mindmaps, map.id);
		const entry = buildUndoEntry(map.id, "改结构", before, after, null)!;
		expect(entry.nodes.size).toBeGreaterThan(0);

		applyUndoEntry(mindmaps, entry, "before");
		// 逐节点对照操作前快照（before 即操作前 repo 状态）
		const restored = rewindOf(mindmaps.listNodes(map.id));
		for (const [id, patch] of before) {
			expect(restored.get(id)).toEqual(patch);
		}
		// 关键字段抽查：C 回到 A 下、A 展开、C 样式回继承
		expect(mindmaps.getNode(c.id)?.parentId).toBe(a.id);
		expect(mindmaps.getNode(a.id)?.collapsed).toBe(false);
		expect(mindmaps.getNode(c.id)?.branchStyle).toBeNull();
	});

	it("apply(after) 重做：恢复到命令后状态", () => {
		const map = mindmaps.create("图");
		const a = mindmaps.addNode(map.id, makeCard("A").id, null, 0, 0)!;
		const b = mindmaps.addNode(map.id, makeCard("B").id, a.id, 200, 0)!;
		const before = captureMapState(mindmaps, map.id);

		mindmaps.setParent(b.id, null, 5); // 脱离成根
		mindmaps.moveNode(b.id, 0, 300);
		const after = captureMapState(mindmaps, map.id);
		const entry = buildUndoEntry(map.id, "脱离", before, after, null)!;

		applyUndoEntry(mindmaps, entry, "before");
		expect(mindmaps.getNode(b.id)?.parentId).toBe(a.id);
		applyUndoEntry(mindmaps, entry, "after");
		expect(mindmaps.getNode(b.id)?.parentId).toBeNull();
		expect(mindmaps.getNode(b.id)?.order).toBe(5);
		expect(mindmaps.getNode(b.id)?.x).toBe(0);
		expect(mindmaps.getNode(b.id)?.y).toBe(300);
	});

	it("节点被删后重放：悬空静默不抛（降级语义）", () => {
		const map = mindmaps.create("图");
		const a = mindmaps.addNode(map.id, makeCard("A").id, null, 0, 0)!;
		const b = mindmaps.addNode(map.id, makeCard("B").id, a.id, 200, 0)!;
		const before = captureMapState(mindmaps, map.id);
		mindmaps.moveNode(b.id, 500, 0);
		const after = captureMapState(mindmaps, map.id);
		const entry = buildUndoEntry(map.id, "移动", before, after, null)!;

		mindmaps.removeNode(b.id); // b 在 entry 之后被删
		expect(() => applyUndoEntry(mindmaps, entry, "before")).not.toThrow();
		expect(mindmaps.listNodes(map.id).map((n) => n.id)).toEqual([a.id]);
	});

	it("mapDefault 补丁随侧重放（图默认样式）", () => {
		const map = mindmaps.create("图");
		const before = captureMapState(mindmaps, map.id);
		mindmaps.setDefaultBranchStyle(map.id, "bidir");
		const after = captureMapState(mindmaps, map.id);
		const entry = buildUndoEntry(map.id, "默认样式", before, after, {
			before: "tree",
			after: "bidir",
		})!;

		applyUndoEntry(mindmaps, entry, "before");
		expect(mindmaps.get(map.id)?.defaultBranchStyle).toBe("tree");
		applyUndoEntry(mindmaps, entry, "after");
		expect(mindmaps.get(map.id)?.defaultBranchStyle).toBe("bidir");
	});

	it("capture 只认 repo：视图内存被就地改写不影响快照", () => {
		const map = mindmaps.create("图");
		const n = mindmaps.addNode(map.id, makeCard("卡").id, null, 10, 10)!;
		const before = captureMapState(mindmaps, map.id);
		// 模拟拖拽 pointermove 只改视图内存副本（repo 未写）
		const viewCopy: MindmapNodeWithCard = { ...n, x: 999, y: 999 };
		expect(viewCopy.x).toBe(999);
		expect(before.get(n.id)?.x).toBe(10); // 快照来自 repo，仍是操作前
	});
});

/** 栈行为用例的最小 entry 工厂 */
function makeEntry(label: string): UndoEntry {
	return { mapId: "m", label, nodes: new Map(), mapDefault: null };
}
