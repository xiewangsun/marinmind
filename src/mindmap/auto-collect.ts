import type { DocumentRepository } from "../db/repositories/document-repo";
import type { CardRepository } from "../db/repositories/card-repo";
import type { MindmapRepository } from "../db/repositories/mindmap-repo";
import type { Card, Mindmap } from "../types";
import { autoCollectPlacement, fixedRootPlacement } from "./mindmap-graph";

/**
 * 摘录自动入图服务（㉗，替代 ⑲ 的视图级自动收录）：
 * 插件级订阅 cardBus created，不要求打开任何脑图视图。
 *
 * 插入落点决策（优先级从高到低，㊴ 起为三级）：
 * 1. 固定根节点——用户在某节点上右键「设为固定根节点」后，所有新摘录直挂该节点
 *    之下（跨文档收拢，不经文档分组）；
 * 2. 按书目标图——文档 collectMapId 覆盖（用户在阅读器「脑图」按钮主动切换，
 *    每本书独立记住；目标图内同样按《书名》分组，多本书共用一图各自成组）；
 * 3. 同名默认图——一文档一张默认图（mindmaps.document_id，图名 = 文档标题），
 *    书名分组卡《文档名》作根节点，摘录依次挂其下（⑲ 语义）。
 *    ㊴ 起打开文档即建（ensureBookMindmap），不再等首张摘录。
 *
 * 零 obsidian 依赖（Notice 由 main.ts 调用方按需处理），vitest 可用内存库直测。
 */
export interface AutoCollectHost {
	documents: DocumentRepository;
	cards: CardRepository;
	mindmaps: MindmapRepository;
}

/**
 * 解析一本书的摘录目标图（不创建）：按书覆盖优先，覆盖悬空（图已删/手编坏引用）
 * 守卫回退默认图。默认图尚未创建时返回 null（调用方按需走 ensureBookMindmap）。
 */
export function collectTargetOf(
	host: AutoCollectHost,
	documentId: string,
): { map: Mindmap; overridden: boolean } | null {
	const doc = host.documents.get(documentId);
	if (!doc) {
		return null;
	}
	if (doc.collectMapId) {
		const override = host.mindmaps.get(doc.collectMapId);
		if (override) {
			return { map: override, overridden: true };
		}
		// 悬空覆盖：正常路径由 store.deleteMap 级联清引用，此处兜底手编坏值——
		// 只回退不写清理（下次切换目标自然修复）
	}
	const def = host.mindmaps.findByDocument(documentId);
	return def ? { map: def, overridden: false } : null;
}

/**
 * 打开文档即确保摘录目标就绪（㊴）：覆盖生效时返回覆盖图（不建同名图——
 * 该书摘录落覆盖图，组卡在首张摘录时懒建）；否则 get-or-create 同名默认图
 * 并确保《书名》分组根节点存在。幂等：已有图/组卡不重复建。
 * 与「添加到脑图」开关无关（开关只管摘录是否入图）；固定根生效时照建
 * （同名图是该书的家，摘录仍优先落固定根）。
 */
export function ensureBookMindmap(
	host: AutoCollectHost,
	documentId: string,
): string | null {
	const doc = host.documents.get(documentId);
	if (!doc) {
		return null;
	}
	const target = collectTargetOf(host, documentId);
	if (target?.overridden) {
		return target.map.id;
	}
	let map = host.mindmaps.findByDocument(documentId);
	if (!map) {
		map = host.mindmaps.create(doc.title, documentId);
	}
	ensureGroupCard(host, map, doc);
	return map.id;
}

/** 图内确保《书名》分组根节点存在（已存在则原样返回其节点 id） */
function ensureGroupCard(
	host: AutoCollectHost,
	map: Mindmap,
	doc: { id: string; title: string },
): string | null {
	const nodes = host.mindmaps.listNodes(map.id);
	const mapDefault = map.defaultBranchStyle;
	const plan = autoCollectPlacement(nodes, { documentId: doc.id, page: null }, mapDefault);
	if (!plan.createGroup) {
		return plan.parentId;
	}
	// 书名分组根节点：page=null 的《文档名》文字卡（同文档唯一；判定见纯函数）
	const groupCard = host.cards.create({
		documentId: doc.id,
		page: null,
		rects: [],
		excerptType: "text",
		excerptText: `《${doc.title}》`,
	});
	const gnode = host.mindmaps.addNode(
		map.id,
		groupCard.id,
		null,
		Math.round(plan.groupPos.x),
		Math.round(plan.groupPos.y),
	);
	return gnode ? gnode.id : null;
}

/**
 * 本书「联动展示图」判定（㊿ 文档↔脑图一对一）：固定根所在图（摘录收拢地，
 * 展示它与摘录落点同源）> ensureBookMindmap（按书覆盖 > 同名图 get-or-create）。
 * 与摘录落点保持同源——联动侧看到的正是新摘录进入的那张图。文档缺失 null。
 */
export function linkedMapOf(host: AutoCollectHost, documentId: string): string | null {
	const fixed = host.mindmaps.fixedRoot();
	if (fixed) {
		return fixed.mapId;
	}
	return ensureBookMindmap(host, documentId);
}

/**
 * 书名变化时同名图跟随改名（㊴）：图名仍等于旧书名才跟随（用户手动改过图名
 * 则不动，宁拒不赌）；《书名》组卡文本独立跟随（excerptText 仍是旧《书名》才改）。
 * 两项守卫独立——用户只改过其一，另一项照常跟随。
 */
export function followBookRename(
	host: AutoCollectHost,
	documentId: string,
	oldTitle: string,
	newTitle: string,
): void {
	if (oldTitle === newTitle) {
		return;
	}
	const map = host.mindmaps.findByDocument(documentId);
	if (map && map.name === oldTitle) {
		host.mindmaps.rename(map.id, newTitle);
	}
	if (!map) {
		return;
	}
	const group = host.mindmaps
		.listNodes(map.id)
		.find((n) => n.card.documentId === documentId && n.card.page == null);
	if (group && group.card.excerptText === `《${oldTitle}》`) {
		host.cards.update(group.card.id, { excerptText: `《${newTitle}》` });
	}
}

/**
 * 把一张新摘录卡加入脑图。返回受影响的 mapId（调用方据此通知打开中的
 * 视图刷新）；无需处理（开关外/回环卡/已在图中/文档缺失）返回 null。
 */
export function autoAddCard(host: AutoCollectHost, card: Card): string | null {
	// 只收文档摘录卡：分组卡（page null）是本流程自己建的卡，在此被拦——
	// 拦住即无 cardBus 事件回环；手工卡（documentId null）不自动入图
	if (card.documentId == null || card.page == null) {
		return null;
	}

	// 1) 固定根节点优先：摘录直挂其下（含跨文档——用户钉的就是"什么都挂这"）
	const fixed = host.mindmaps.fixedRoot();
	if (fixed) {
		if (host.mindmaps.hasCard(fixed.mapId, card.id)) {
			return null; // 已在固定根所在图中：无需处理
		}
		const nodes = host.mindmaps.listNodes(fixed.mapId);
		const mapDefault = host.mindmaps.get(fixed.mapId)?.defaultBranchStyle ?? "tree";
		const pos = fixedRootPlacement(nodes, fixed.nodeId, mapDefault);
		if (pos) {
			host.mindmaps.addNode(fixed.mapId, card.id, fixed.nodeId, pos.x, pos.y);
			return fixed.mapId;
		}
		// 落位失败（节点行消失的瞬时竞态）：落到目标图路径兜底
	}

	// 2) 目标图：按书覆盖（collectMapId，存在性守卫）→ 同名默认图（get-or-create）
	const doc = host.documents.get(card.documentId);
	if (!doc) {
		return null;
	}
	let map = doc.collectMapId ? host.mindmaps.get(doc.collectMapId) : undefined;
	if (!map) {
		map = host.mindmaps.findByDocument(card.documentId);
		if (!map) {
			map = host.mindmaps.create(doc.title, card.documentId);
		}
	}
	if (host.mindmaps.hasCard(map.id, card.id)) {
		return null;
	}
	// 3) 图内落点：找/建《书名》分组卡，摘录挂其下（覆盖图内同样分组——
	//    多本书共用一图时各自成组，MN4「分组（按文档）」语义）
	const nodes = host.mindmaps.listNodes(map.id);
	const plan = autoCollectPlacement(nodes, card, map.defaultBranchStyle);
	let parentId: string | null = plan.parentId;
	if (plan.createGroup) {
		// 书名分组根节点：page=null 的《文档名》文字卡（同文档唯一；判定见纯函数）
		const groupCard = host.cards.create({
			documentId: card.documentId,
			page: null,
			rects: [],
			excerptType: "text",
			excerptText: `《${doc.title}》`,
		});
		const gnode = host.mindmaps.addNode(
			map.id,
			groupCard.id,
			null,
			Math.round(plan.groupPos.x),
			Math.round(plan.groupPos.y),
		);
		if (!gnode) {
			return null;
		}
		parentId = gnode.id;
	}
	if (!parentId) {
		return null;
	}
	const added = host.mindmaps.addNode(
		map.id,
		card.id,
		parentId,
		Math.round(plan.childPos.x),
		Math.round(plan.childPos.y),
	);
	return added ? map.id : null;
}
