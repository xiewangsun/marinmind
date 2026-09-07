import { Notice } from "obsidian";
import type { App } from "obsidian";
import { ConfirmModal } from "../mindmap/confirm-modal";
import type MarinMindPlugin from "../main";
import type { BookDocument } from "../types";

/**
 * 删除文档记录（单源）：主页文档右键「删除文档…」与文档管理弹窗「删除记录」共用。
 * 仅删 MarinMind 侧数据——卡片/摘录附件/复习状态/双向链接/脑图关联/书签/books 数据
 * 文件，书籍 PDF/EPUB 文件本身保留。附件清理是发起方职责（对齐 reader-view 删卡
 * 先例），单个附件失败不阻断；其余级联由 documents.delete → store.deleteBook 完成。
 * deleteBook 不发 cardBus 事件，删除成功后经 onDeleted 回调由调用方各自刷新视图。
 */

/** 确认弹窗 + 删除：卡数内部取（文案与计数同源），确认后执行 deleteDocumentRecord */
export function confirmDeleteDocument(
	app: App,
	plugin: MarinMindPlugin,
	doc: BookDocument,
	onDeleted?: () => void,
): void {
	const cardCount = plugin.cards.count(doc.id);
	new ConfirmModal(
		app,
		"删除文档记录",
		`将删除「${doc.title}」的记录，并级联删除其 ${cardCount} 张卡片、复习状态与脑图节点引用，媒体附件文件一并清除。\n` +
			"书籍文件本身（PDF/EPUB）保留不删。\n" +
			"此操作不可撤销。若该文档正被阅读器打开，请先关闭对应标签页。继续？",
		() =>
			void deleteDocumentRecord(plugin, doc).then((ok) => {
				if (ok) {
					onDeleted?.();
				}
			}),
	).open();
}

/** 实际删除（导出供测试）：逐卡清附件 → 删文档行（级联其余数据）→ Notice；失败返回 false */
export async function deleteDocumentRecord(
	plugin: MarinMindPlugin,
	doc: BookDocument,
): Promise<boolean> {
	try {
		// 主页入口无弹窗 onOpen 的就绪等待，这里统一补上（已就绪时为空等，弹窗路径无害）
		await plugin.whenReady();
		// 附件清理是发起方职责（对齐 reader-view 删卡清附件的模式）：
		// 先捕获卡片快照逐个删附件文件，再删文档行（级联清卡片等 DB 数据）
		for (const card of plugin.cards.listByDocument(doc.id)) {
			if (card.excerptRef) {
				await plugin.attachments.remove(card.excerptRef).catch(() => {
					// 单个附件缺失不阻断整体清理
				});
			}
		}
		plugin.documents.delete(doc.id);
		new Notice("文档记录已删除");
		return true;
	} catch (err) {
		console.error("[MarinMind] 删除文档记录失败", err);
		new Notice(`删除失败：${err instanceof Error ? err.message : String(err)}`);
		return false;
	}
}
