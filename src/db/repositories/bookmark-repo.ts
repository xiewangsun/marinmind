import type { MarinMindStore } from "../../store/marinmind-store";
import type { DocumentBookmark } from "../../types";
import { newId, now } from "../../utils";

/** 文档书签仓储（㉓ 目录/书签侧栏；㉚ md 存储版）：阅读位置标记，按页码排序展示 */
export class BookmarkRepository {
	constructor(private store: MarinMindStore) {}

	/** 某文档的全部书签（按页码升序，同页按创建时间） */
	listByDocument(documentId: string): DocumentBookmark[] {
		return [...(this.store.books.get(documentId)?.bookmarks.values() ?? [])].sort(
			(a, b) => a.page - b.page || a.createdAt - b.createdAt || (a.id < b.id ? -1 : 1),
		);
	}

	/** 添加书签（label 由调用方给默认值"第 N 页"或用户输入） */
	add(documentId: string, page: number, label: string): DocumentBookmark {
		const book = this.store.books.get(documentId);
		if (!book) {
			throw new Error(`文档不存在，无法添加书签：${documentId}`); // 对齐旧库外键
		}
		const bookmark: DocumentBookmark = {
			id: newId(),
			documentId,
			page,
			label,
			createdAt: now(),
		};
		book.bookmarks.set(bookmark.id, bookmark);
		this.store.markDirty(documentId);
		return bookmark;
	}

	/** 删除书签（文档删除走 store 级联，无需显式清理） */
	remove(id: string): boolean {
		for (const book of this.store.books.values()) {
			if (!book.bookmarks.has(id)) continue;
			book.bookmarks.delete(id);
			this.store.markDirty(book.doc.id);
			return true;
		}
		return false; // 先查后删：无命中不标脏（防写放大，同 renamePath 模式）
	}
}
