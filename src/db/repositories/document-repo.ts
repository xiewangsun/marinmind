import type { MarinMindDatabase } from "../database";
import type { BookDocument } from "../../types";
import { newId, now } from "../../utils";

interface DocumentRow {
	id: string;
	title: string;
	file_path: string;
	created_at: number;
	updated_at: number;
}

function mapRowToDocument(row: DocumentRow): BookDocument {
	return {
		id: row.id,
		title: row.title,
		filePath: row.file_path,
		createdAt: row.created_at,
		updatedAt: row.updated_at,
	};
}

/** 文档（书籍）仓储 */
export class DocumentRepository {
	constructor(private db: MarinMindDatabase) {}

	/** 按路径查找或创建：同一文件重复打开复用同一条记录 */
	upsertByPath(filePath: string, title: string): BookDocument {
		const ts = now();
		this.db.run(
			`INSERT INTO documents (id, title, file_path, created_at, updated_at)
			 VALUES (?, ?, ?, ?, ?)
			 ON CONFLICT (file_path) DO UPDATE SET title = excluded.title, updated_at = excluded.updated_at`,
			[newId(), title, filePath, ts, ts],
		);
		const doc = this.getByPath(filePath);
		if (!doc) {
			throw new Error(`文档 upsert 后必然存在：${filePath}`);
		}
		return doc;
	}

	get(id: string): BookDocument | undefined {
		const row = this.db.get<DocumentRow>("SELECT * FROM documents WHERE id = ?", [id]);
		return row ? mapRowToDocument(row) : undefined;
	}

	getByPath(filePath: string): BookDocument | undefined {
		const row = this.db.get<DocumentRow>("SELECT * FROM documents WHERE file_path = ?", [filePath]);
		return row ? mapRowToDocument(row) : undefined;
	}

	/** 更新标题等元数据 */
	update(id: string, patch: { title?: string }): BookDocument | undefined {
		const current = this.get(id);
		if (!current) {
			return undefined;
		}
		const next: BookDocument = {
			...current,
			...(patch.title !== undefined ? { title: patch.title } : {}),
			updatedAt: now(),
		};
		this.db.run("UPDATE documents SET title = ?, updated_at = ? WHERE id = ?", [
			next.title,
			next.updatedAt,
			next.id,
		]);
		return next;
	}

	/** 文件重命名/移动时同步业务键，避免文档与其卡片孤儿化 */
	renamePath(oldPath: string, newPath: string): void {
		this.db.run(
			"UPDATE documents SET file_path = ?, updated_at = ? WHERE file_path = ?",
			[newPath, now(), oldPath],
		);
	}

	/** 删除文档（级联删除其卡片、链接与复习状态） */
	delete(id: string): boolean {
		const existed = this.get(id) !== undefined;
		if (existed) {
			this.db.run("DELETE FROM documents WHERE id = ?", [id]);
		}
		return existed;
	}

	list(): BookDocument[] {
		return this.db
			.all<DocumentRow>("SELECT * FROM documents ORDER BY updated_at DESC")
			.map(mapRowToDocument);
	}

	count(): number {
		const row = this.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM documents");
		return row?.n ?? 0;
	}
}
