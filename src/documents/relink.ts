import type { DocumentRepository } from "../db/repositories/document-repo";
import type { CardRepository } from "../db/repositories/card-repo";
import type { BookDocument } from "../types";

/** 重关联的冲突一方（源文档 / 目标路径上的既有记录） */
export interface RelinkParty {
	id: string;
	cardCount: number;
}

/** 重关联决策（纯函数产物，message 面向 Notice/ConfirmModal） */
export interface RelinkPlan {
	action: "apply" | "takeover-empty-target" | "reject";
	message: string;
}

/**
 * 决策规则：
 * - 目标路径无主 → 直接改道（apply）；
 * - 目标已有记录且有卡片 → 拒绝（reject）：两份卡片集合同页码矩形语义无安全合并默认值，
 *   宁可拒绝也不赌（跨文档卡片合并见后续规划）；
 * - 目标有记录但零卡片 → 删除空记录后接管（takeover-empty-target）：空行只含
 *   title+path（由"打开文件即 upsert"产生），不含用户数据，删除无损。
 */
export function planRelink(source: RelinkParty, target: RelinkParty | null): RelinkPlan {
	if (!target) {
		return { action: "apply", message: "" };
	}
	if (target.cardCount > 0) {
		return {
			action: "reject",
			message:
				`目标文件已关联另一文档（${target.cardCount} 张卡片），` +
				`与源文档（${source.cardCount} 张）冲突；请直接打开该文件使用现有记录`,
		};
	}
	return {
		action: "takeover-empty-target",
		message: "目标路径已存在一条无卡片的空记录，将删除该空记录并由源文档接管",
	};
}

/**
 * 落库：[删除空目标行] + 改道源行业务键。
 * 卡片随书文件原地跟随（documentId 不变）——零卡片迁移、零孤儿；
 * 内存同步操作天然原子（md 存储无事务概念，markDirty 收敛在改动之后）。
 * 防御：目标行非空（有卡片）时抛错（调用方应先经 planRelink 拒绝，不走此分支）。
 */
export function applyRelink(
	documents: DocumentRepository,
	cards: CardRepository,
	sourceDoc: BookDocument,
	newPath: string,
): void {
	const occupied = documents.getByPath(newPath);
	if (occupied) {
		if (occupied.id === sourceDoc.id) {
			return; // 目标即源自身（路径未变），无操作
		}
		if (cards.count(occupied.id) > 0) {
			throw new Error(`目标路径已被有卡片的文档占用：${newPath}`);
		}
		documents.delete(occupied.id);
	}
	documents.renamePath(sourceDoc.filePath, newPath);
}
