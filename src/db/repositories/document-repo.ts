import type { MarinMindStore } from "../../store/marinmind-store";
import type { BookDocument } from "../../types";
import { newId, now } from "../../utils";

/**
 * 文档（书籍）仓储（㉚ md 存储版）：内存 Map 操作 + store 标脏。
 * 公开语义与 SQL 版一致；标题变更时 md 文件名跟随书名（store.upsertBook 承担）。
 */
export class DocumentRepository {
	constructor(private store: MarinMindStore) {}

	/**
	 * 按路径查找或创建：同一文件重复打开复用同一条记录。
	 * 仅打开（标题未变）走 touchBookOpen——内存更新 updatedAt 不标脏，
	 * 避免每次打开触发整书序列化 + 重写（2s 防抖后正好卡在用户开始阅读时）；
	 * 标题变化/新建仍走 upsertBook（文件名跟随书名 + 落盘）。
	 */
	upsertByPath(filePath: string, title: string): BookDocument {
		const ts = now();
		const existing = this.store.bookByFilePath(filePath);
		if (existing) {
			if (existing.doc.title === title) {
				this.store.touchBookOpen(existing.doc.id);
				return { ...existing.doc, updatedAt: ts };
			}
			const doc: BookDocument = { ...existing.doc, title, updatedAt: ts };
			this.store.upsertBook(doc);
			return doc;
		}
		const doc: BookDocument = {
			id: newId(),
			title,
			filePath,
			category: null,
			collectMapId: null,
			autoFlashcard: false,
			lastPage: null,
			createdAt: ts,
			updatedAt: ts,
		};
		this.store.upsertBook(doc);
		return doc;
	}

	get(id: string): BookDocument | undefined {
		return this.store.books.get(id)?.doc;
	}

	getByPath(filePath: string): BookDocument | undefined {
		return this.store.bookByFilePath(filePath)?.doc;
	}

	/**
	 * 更新标题/分类等元数据（标题变更时文件名跟随重命名）。
	 * category 语义：传 string 归入分类、传 null 显式移入未分类、不传（undefined）不动。
	 * collectMapId 同款三态（㊴）：传 string 设目标图、传 null 切回默认图、不传不动。
	 * autoFlashcard 布尔两态（㊷）：传值设置、不传不动。
	 * lastPage 同款可空三态（80）：传数字设页码、传 null 清除（回到第 1 页）、不传不动。
	 * lastPage-only 写入保留原 updatedAt：翻页是高频静默动作，若顶 updatedAt 会
	 * 违背 touchBookOpen 的既定设计（打开书不落盘不重排）且打乱主页「最近」
	 * 排序；patch 含其他字段时照常刷新。
	 */
	update(
		id: string,
		patch: {
			title?: string;
			category?: string | null;
			collectMapId?: string | null;
			autoFlashcard?: boolean;
			lastPage?: number | null;
		},
	): BookDocument | undefined {
		const current = this.store.books.get(id)?.doc;
		if (!current) {
			return undefined;
		}
		// lastPage-only（仅页码，无元数据变更）不刷新 updatedAt（见上方注释）
		const metaOnly =
			patch.title !== undefined ||
			patch.category !== undefined ||
			patch.collectMapId !== undefined ||
			patch.autoFlashcard !== undefined;
		const next: BookDocument = {
			...current,
			...(patch.title !== undefined ? { title: patch.title } : {}),
			...(patch.category !== undefined ? { category: patch.category } : {}),
			...(patch.collectMapId !== undefined ? { collectMapId: patch.collectMapId } : {}),
			...(patch.autoFlashcard !== undefined ? { autoFlashcard: patch.autoFlashcard } : {}),
			...(patch.lastPage !== undefined ? { lastPage: patch.lastPage } : {}),
			updatedAt: metaOnly ? now() : current.updatedAt,
		};
		this.store.upsertBook(next);
		return next;
	}

	/**
	 * 文件重命名/移动时同步业务键，避免文档与其卡片孤儿化。
	 * 先查后改：库内无该路径的记录时不标脏（防 vault 内无关文件改名触发
	 * 防抖落盘的写放大）；目标路径已被其他文档占用时抛错（对齐旧库 UNIQUE 约束，
	 * 重关联流程应先删空目标行——见 documents/relink.ts）。
	 * @returns 是否实际更新了记录
	 */
	renamePath(oldPath: string, newPath: string): boolean {
		const state = this.store.bookByFilePath(oldPath);
		if (!state) {
			return false;
		}
		const occupied = this.store.bookByFilePath(newPath);
		if (occupied && occupied !== state) {
			throw new Error(`目标路径已被文档占用：${newPath}`);
		}
		state.doc = { ...state.doc, filePath: newPath, updatedAt: now() };
		this.store.markDirty(state.doc.id);
		return true;
	}

	/** 删除文档（store 级联：卡片/链接/复习/书签 + 图 document_id 置空 + 文件删除） */
	delete(id: string): boolean {
		return this.store.deleteBook(id);
	}

	list(): BookDocument[] {
		return [...this.store.books.values()]
			.map((b) => b.doc)
			.sort((a, b) => b.updatedAt - a.updatedAt || (a.id < b.id ? -1 : 1));
	}

	count(): number {
		return this.store.books.size;
	}
}
