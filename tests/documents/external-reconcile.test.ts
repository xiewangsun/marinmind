import { describe, expect, it } from "vitest";
import {
	externalBasename,
	externalParentDir,
	planExternalReconcile,
} from "../../src/documents/external-reconcile";

const DIR = "D:\\books\\";

function rec(filePath: string) {
	return { id: filePath, filePath };
}

describe("externalParentDir / externalBasename 路径切分", () => {
	it("反斜杠路径：父目录带结尾分隔符", () => {
		expect(externalParentDir("D:\\books\\a.pdf")).toBe("D:\\books\\");
		expect(externalParentDir("D:\\a.pdf")).toBe("D:\\");
		expect(externalBasename("D:\\books\\a.pdf")).toBe("a.pdf");
	});

	it("正斜杠与混合分隔符通吃", () => {
		expect(externalParentDir("/home/u/a.pdf")).toBe("/home/u/");
		expect(externalParentDir("D:/books/sub/b.pdf")).toBe("D:/books/sub/");
		expect(externalBasename("D:/books/sub/b.pdf")).toBe("b.pdf");
	});
});

describe("planExternalReconcile 对账决策（㊳ 宁拒不赌）", () => {
	it("旧路径仍在 → none", () => {
		const out = planExternalReconcile({
			records: [rec(DIR + "a.pdf")],
			exists: [true],
			dirFiles: new Map([[DIR, new Set(["a.pdf"])]]),
			dirFilesBefore: new Map([[DIR, new Set(["a.pdf"])]]),
		});
		expect(out).toEqual([{ kind: "none", index: 0 }]);
	});

	it("消失 + 同目录恰一新增 → follow（新路径 = 目录 + 候选名）", () => {
		const out = planExternalReconcile({
			records: [rec(DIR + "old.pdf")],
			exists: [false],
			dirFiles: new Map([[DIR, new Set(["new.pdf"])]]),
			dirFilesBefore: new Map([[DIR, new Set(["old.pdf"])]]),
		});
		expect(out).toEqual([{ kind: "follow", index: 0, newPath: DIR + "new.pdf" }]);
	});

	it("消失且无新增 → missing", () => {
		const out = planExternalReconcile({
			records: [rec(DIR + "old.pdf")],
			exists: [false],
			dirFiles: new Map([[DIR, new Set([])]]),
			dirFilesBefore: new Map([[DIR, new Set(["old.pdf"])]]),
		});
		expect(out).toEqual([{ kind: "missing", index: 0 }]);
	});

	it("消失 + 两个新增 → ambiguous", () => {
		const out = planExternalReconcile({
			records: [rec(DIR + "old.pdf")],
			exists: [false],
			dirFiles: new Map([[DIR, new Set(["n1.pdf", "n2.pdf"])]]),
			dirFilesBefore: new Map([[DIR, new Set(["old.pdf"])]]),
		});
		expect(out[0].kind).toBe("ambiguous");
	});

	it("新增名与另一记录同名 → 不算候选 → missing", () => {
		// dir2 的记录 B.pdf 被移走（跨目录移动），dir1 同时出现同名 B.pdf：
		// 该文件更可能是 B 的跨目录移动，归属不明——不给 A 配对
		const out = planExternalReconcile({
			records: [rec(DIR + "a.pdf"), rec("D:\\other\\b.pdf")],
			exists: [false, false],
			dirFiles: new Map([
				[DIR, new Set(["b.pdf"])],
				["D:\\other\\", new Set([])],
			]),
			dirFilesBefore: new Map([
				[DIR, new Set(["a.pdf"])],
				["D:\\other\\", new Set(["b.pdf"])],
			]),
		});
		expect(out[0]).toEqual({ kind: "missing", index: 0 });
	});

	it("同目录两条失联 + 一个新增 → 均 ambiguous", () => {
		const out = planExternalReconcile({
			records: [rec(DIR + "a.pdf"), rec(DIR + "c.pdf")],
			exists: [false, false],
			dirFiles: new Map([[DIR, new Set(["n.pdf"])]]),
			dirFilesBefore: new Map([[DIR, new Set(["a.pdf", "c.pdf"])]]),
		});
		expect(out[0].kind).toBe("ambiguous");
		expect(out[1].kind).toBe("ambiguous");
	});

	it("两失联两新增 → 均 ambiguous", () => {
		const out = planExternalReconcile({
			records: [rec(DIR + "a.pdf"), rec(DIR + "c.pdf")],
			exists: [false, false],
			dirFiles: new Map([[DIR, new Set(["n1.pdf", "n2.pdf"])]]),
			dirFilesBefore: new Map([[DIR, new Set(["a.pdf", "c.pdf"])]]),
		});
		expect(out[0].kind).toBe("ambiguous");
		expect(out[1].kind).toBe("ambiguous");
	});

	it("before 缺目录 → 保守视为无新增 → missing；大小写归一匹配", () => {
		// 快照缺失：无法判定何为"新增"，只报失联不自动跟
		const noSnapshot = planExternalReconcile({
			records: [rec(DIR + "old.pdf")],
			exists: [false],
			dirFiles: new Map([[DIR, new Set(["new.pdf"])]]),
			dirFilesBefore: new Map([]),
		});
		expect(noSnapshot[0].kind).toBe("missing");

		// 大小写归一：OLD.pdf 在快照中 → old.pdf 的消失不算"新增另一文件"
		const caseNorm = planExternalReconcile({
			records: [rec(DIR + "old.pdf")],
			exists: [false],
			dirFiles: new Map([[DIR, new Set(["OLD.pdf", "new.PDF"])]]),
			dirFilesBefore: new Map([[DIR, new Set(["old.pdf"])]]),
		});
		expect(caseNorm[0]).toEqual({
			kind: "follow",
			index: 0,
			newPath: DIR + "new.PDF", // 候选保留原名大小写
		});
	});
});
