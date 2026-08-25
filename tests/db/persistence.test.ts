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
});
