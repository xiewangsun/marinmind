import { describe, expect, it } from "vitest";
import { MarinMindDatabase, type StorageAdapter } from "../../src/db/database";
import { DocumentRepository } from "../../src/db/repositories/document-repo";
import { CardRepository } from "../../src/db/repositories/card-repo";
import { ReviewRepository } from "../../src/db/repositories/review-repo";
import { SCHEMA_VERSION } from "../../src/db/schema";

/** 内存版 StorageAdapter：模拟 Obsidian 的 vault.adapter 文件读写 */
class MemoryAdapter implements StorageAdapter {
	files = new Map<string, ArrayBuffer>();
	exists(path: string): Promise<boolean> {
		return Promise.resolve(this.files.has(path));
	}
	mkdir(): Promise<void> {
		return Promise.resolve();
	}
	readBinary(path: string): Promise<ArrayBuffer> {
		const data = this.files.get(path);
		if (!data) {
			return Promise.reject(new Error(`文件不存在: ${path}`));
		}
		return Promise.resolve(data);
	}
	writeBinary(path: string, data: ArrayBuffer): Promise<void> {
		this.files.set(path, data);
		return Promise.resolve();
	}
}

const DB_PATH = ".marinmind/marinmind.db";

describe("数据库持久化", () => {
	it("写入经 flush 落盘，重开后数据完整恢复", async () => {
		const adapter = new MemoryAdapter();
		const db1 = await MarinMindDatabase.open({ adapter, path: DB_PATH });
		const doc = new DocumentRepository(db1).upsertByPath("books/rl.pdf", "强化学习");
		const card = new CardRepository(db1).create({
			documentId: doc.id,
			page: 5,
			rects: [{ x: 0, y: 0, w: 0.5, h: 0.1 }],
			excerptType: "text",
			excerptText: "贝尔曼方程",
			tags: ["动态规划"],
		});
		new ReviewRepository(db1).enable(card.id);
		await db1.flush();
		db1.close();

		// 文件确实写入
		expect(adapter.files.has(DB_PATH)).toBe(true);

		const db2 = await MarinMindDatabase.open({ adapter, path: DB_PATH });
		const restored = new CardRepository(db2).get(card.id);
		expect(restored?.excerptText).toBe("贝尔曼方程");
		expect(restored?.rects).toEqual([{ x: 0, y: 0, w: 0.5, h: 0.1 }]);
		expect(new ReviewRepository(db2).dueCount(Number.MAX_SAFE_INTEGER)).toBe(1);
		db2.close();
	});

	it("重开后 schema 版本一致，不重复迁移", async () => {
		const adapter = new MemoryAdapter();
		const db1 = await MarinMindDatabase.open({ adapter, path: DB_PATH });
		await db1.flush();
		db1.close();

		const db2 = await MarinMindDatabase.open({ adapter, path: DB_PATH });
		expect(db2.version).toBe(SCHEMA_VERSION);
		db2.close();
	});

	it("无 adapter 时为纯内存库，flush 为空操作", async () => {
		const db = await MarinMindDatabase.open();
		new DocumentRepository(db).upsertByPath("a.pdf", "A");
		await db.flush(); // 不应抛错
		db.close();
	});

	it("exportBytes 导出内存权威快照，重开后数据可查", async () => {
		const adapter = new MemoryAdapter();
		const db1 = await MarinMindDatabase.open({ adapter, path: DB_PATH });
		const doc = new DocumentRepository(db1).upsertByPath("books/mm.pdf", "数学分析");
		new CardRepository(db1).create({
			documentId: doc.id,
			page: 1,
			rects: [],
			excerptType: "area",
		});
		// 刻意不 flush（dirty 未落盘）：exportBytes 仍应包含最新写入
		const bytes = db1.exportBytes();
		db1.close();

		// 用导出字节在全新 adapter 上恢复，验证快照自包含
		const adapter2 = new MemoryAdapter();
		adapter2.files.set(".marinmind/restore.db", bytes);
		const db2 = await MarinMindDatabase.open({
			adapter: adapter2,
			path: ".marinmind/restore.db",
		});
		expect(new DocumentRepository(db2).getByPath("books/mm.pdf")?.title).toBe("数学分析");
		expect(new CardRepository(db2).count()).toBe(1);
		db2.close();
	});
});
