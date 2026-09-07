import { describe, expect, it } from "vitest";
import { MemoryAdapter, textOf, writeText } from "../helpers/memory-adapter";
import {
	isBookMdText,
	normalizeBackupNotePath,
	planLayoutMigration,
	runLayoutMigration,
} from "../../src/store/layout-migrate";
import { MarinMindStore } from "../../src/store/marinmind-store";
import { strToU8 } from "fflate";

/** 最小合法书文件（frontmatter 即可被判为 MarinMind 书） */
const BOOK_MD = (title: string, id = "doc-1") =>
	`---\nmarinmind: book\nid: ${id}\ntitle: ${title}\ncreated_at: 1\nupdated_at: 1\n---\n`;

const MINDMAP_MD = "---\nmarinmind: mindmap\nid: map-1\n---\n";

describe("isBookMdText（根层书探针）", () => {
	it("序列化书 frontmatter 判 true（含 \\r\\n 行尾与紧凑冒号形态）", () => {
		expect(isBookMdText(BOOK_MD("书"))).toBe(true);
		expect(isBookMdText("---\r\nmarinmind: book\r\n---\r\n")).toBe(true);
		expect(isBookMdText("---\nmarinmind:book\n---\n")).toBe(true);
	});

	it("普通笔记 / 脑图 frontmatter / 无 frontmatter / marinmind 行在 frontmatter 外 均 false", () => {
		expect(isBookMdText("# 我的随手记\n\n正文")).toBe(false);
		expect(isBookMdText(MINDMAP_MD)).toBe(false);
		expect(isBookMdText("---\nmarinmind: book\n---\n后记 marinmind: book")).toBe(true); // 首个命中在 fm 内
		expect(isBookMdText("正文\n---\nmarinmind: book\n---\n")).toBe(false); // fm 外出现不算
	});
});

describe("planLayoutMigration（纯函数）", () => {
	it("根层书 → books/、脑图/ 文件 → mindmaps/", () => {
		const plan = planLayoutMigration({
			booksAtRoot: ["书籍A.md", "未归类卡片.md"],
			mindmapsAtLegacy: ["脑图/学习图.md"],
			existing: new Set(),
		});
		expect(plan.moves).toEqual([
			{ from: "书籍A.md", to: "books/书籍A.md" },
			{ from: "未归类卡片.md", to: "books/未归类卡片.md" },
			{ from: "脑图/学习图.md", to: "mindmaps/学习图.md" },
		]);
		expect(plan.conflicts).toEqual([]);
	});

	it("目标位置已存在同名 → 进 conflicts（同异判定留给执行器）", () => {
		const plan = planLayoutMigration({
			booksAtRoot: ["书籍A.md"],
			mindmapsAtLegacy: ["脑图/学习图.md"],
			existing: new Set(["books/书籍A.md"]),
		});
		expect(plan.moves).toEqual([{ from: "脑图/学习图.md", to: "mindmaps/学习图.md" }]);
		expect(plan.conflicts).toEqual([{ from: "书籍A.md", to: "books/书籍A.md" }]);
	});
});

describe("normalizeBackupNotePath（备份导入布局归一）", () => {
	it("旧 v2 包形态：平铺书 → books/、脑图/ 前缀 → mindmaps/", () => {
		expect(normalizeBackupNotePath("强化学习.md", strToU8(BOOK_MD("强化学习")))).toBe(
			"books/强化学习.md",
		);
		expect(normalizeBackupNotePath("脑图/学习图.md", strToU8(MINDMAP_MD))).toBe(
			"mindmaps/学习图.md",
		);
	});

	it("系统文件 / 新布局路径 / 根层普通笔记 原样返回", () => {
		expect(
			normalizeBackupNotePath("复习日志.md", strToU8("---\nmarinmind: reviewlog\n---\n")),
		).toBe("复习日志.md");
		expect(
			normalizeBackupNotePath("分类.md", strToU8("---\nmarinmind: folders\n---\n- 学习")),
		).toBe("分类.md");
		expect(normalizeBackupNotePath("books/强化学习.md", strToU8(BOOK_MD("强化学习")))).toBe(
			"books/强化学习.md",
		);
		expect(normalizeBackupNotePath("随手记.md", strToU8("# 普通笔记"))).toBe("随手记.md");
		expect(
			normalizeBackupNotePath("pre-import-snapshot/书籍A.md", strToU8(BOOK_MD("书籍A"))),
		).toBe("pre-import-snapshot/书籍A.md");
	});
});

describe("runLayoutMigration（执行器，MemoryAdapter）", () => {
	it("整库迁移：书与孤儿进 books/、脑图进 mindmaps/；系统文件与普通笔记不动", async () => {
		const adapter = new MemoryAdapter();
		writeText(adapter, "书籍A.md", BOOK_MD("书籍A", "doc-a"));
		writeText(adapter, "未归类卡片.md", BOOK_MD("未归类卡片", "orphan"));
		writeText(adapter, "复习日志.md", "---\nmarinmind: reviewlog\n---\n暂无记录");
		writeText(adapter, "分类.md", "---\nmarinmind: folders\n---\n- 学习");
		writeText(adapter, "随手记.md", "# 用户自己的笔记");
		writeText(adapter, "脑图/学习图.md", MINDMAP_MD);

		const result = await runLayoutMigration(adapter);
		expect(result).toEqual({ booksMoved: 2, mapsMoved: 1, conflictsSkipped: 0 });

		expect(adapter.files.has("books/书籍A.md")).toBe(true);
		expect(adapter.files.has("books/未归类卡片.md")).toBe(true);
		expect(adapter.files.has("mindmaps/学习图.md")).toBe(true);
		expect(textOf(adapter, "books/书籍A.md")).toContain("marinmind: book");
		// 留在原处的：系统文件 + 普通笔记
		expect([...adapter.files.keys()].sort()).toEqual(
			[
				"books/书籍A.md",
				"books/未归类卡片.md",
				"分类.md",
				"复习日志.md",
				"随手记.md",
				"mindmaps/学习图.md",
			].sort(),
		);
	});

	it("幂等：v2 布局再跑全零、零搬迁", async () => {
		const adapter = new MemoryAdapter();
		writeText(adapter, "books/书籍A.md", BOOK_MD("书籍A"));
		writeText(adapter, "mindmaps/学习图.md", MINDMAP_MD);

		const result = await runLayoutMigration(adapter);
		expect(result).toEqual({ booksMoved: 0, mapsMoved: 0, conflictsSkipped: 0 });
		expect(adapter.files.has("books/书籍A.md")).toBe(true);
	});

	it("中断搬迁收敛：源与目标同名同内容 → 补删源并计入已迁", async () => {
		const adapter = new MemoryAdapter();
		writeText(adapter, "书籍A.md", BOOK_MD("书籍A"));
		writeText(adapter, "books/书籍A.md", BOOK_MD("书籍A")); // 上次 copy 后、delete 前崩溃

		const result = await runLayoutMigration(adapter);
		expect(result).toEqual({ booksMoved: 1, mapsMoved: 0, conflictsSkipped: 0 });
		expect(adapter.files.has("书籍A.md")).toBe(false);
		expect(adapter.files.has("books/书籍A.md")).toBe(true);
	});

	it("同名冲突内容不同：跳过不搬，源与目标都保留", async () => {
		const adapter = new MemoryAdapter();
		writeText(adapter, "书籍A.md", BOOK_MD("书籍A", "doc-root"));
		writeText(adapter, "books/书籍A.md", BOOK_MD("书籍A", "doc-books"));

		const result = await runLayoutMigration(adapter);
		expect(result).toEqual({ booksMoved: 0, mapsMoved: 0, conflictsSkipped: 1 });
		expect(adapter.files.has("书籍A.md")).toBe(true);
		expect(adapter.files.has("books/书籍A.md")).toBe(true);
	});
});

describe("MarinMindStore.open 集成（迁移 → 认领）", () => {
	it("v1 旧布局库启动即迁移：书在 books/ 认领、孤儿吸收、统计可见", async () => {
		const adapter = new MemoryAdapter();
		writeText(adapter, "书籍A.md", BOOK_MD("书籍A", "doc-a"));
		writeText(
			adapter,
			"未归类卡片.md",
			BOOK_MD("未归类卡片", "orphan") +
				'## 未分组\n\n> [!excerpt]\n> 孤儿摘录\n^card-cx\n<!--mm {"id":"cx","type":"text","created":1,"updated":1} -->\n',
		);
		writeText(adapter, "脑图/学习图.md", MINDMAP_MD);

		const store = await MarinMindStore.open(adapter);
		expect(store.lastLayoutMigration).toEqual({
			booksMoved: 2,
			mapsMoved: 1,
			conflictsSkipped: 0,
		});
		expect(store.stats().documents).toBe(1); // 书籍A（孤儿不进文档列表）
		expect(store.orphanState.cards.get("cx")).toBeDefined();
		expect(store.orphanState.relPath).toBe("books/未归类卡片.md");
		expect(store.books.get("doc-a")!.relPath).toBe("books/书籍A.md");
		store.close();
	});
});
