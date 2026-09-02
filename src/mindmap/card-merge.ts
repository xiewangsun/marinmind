import type { CardRepository, CardPatch } from "../db/repositories/card-repo";
import type { MindmapRepository } from "../db/repositories/mindmap-repo";
import type { LinkRepository } from "../db/repositories/link-repo";
import type { ReviewRepository } from "../db/repositories/review-repo";
import type { MarinMindStore } from "../store/marinmind-store";

/**
 * 卡片合并服务（60）：源卡并入目标卡——文本类字段并入、脑图节点迁移、
 * 链接与复习态转移、源卡删除。host 注入模式镜像 auto-collect，零 obsidian
 * 依赖，vitest 可用内存库直测。
 *
 * 合并语义（MN4「卡片合并」；CardPatch 无 documentId/rects/excerptType/polygon——
 * **原文锚点、摘录形态与媒体以目标为准**，源只贡献可编辑文本类字段与图结构/链接/
 * 复习态）：
 * - note：双有 → `目标 + "\n\n" + 源`；目标空 → 取源
 * - excerptText / title / deck / color / occlusions：目标空才取源（有值不动）
 * - tags：并集去重
 *
 * 节点迁移顺序铁律：**删源卡之前**迁移（迁移读源卡节点；cards.delete 的级联会
 * 删除源卡残余节点）。同图已有目标节点 → 源节点子挂目标节点 + 删源节点
 * （removeNode 语义）；同图无 → repointNode 改挂目标卡（一图一卡预检在内）。
 *
 * 附件清理不在本模块（AttachmentStore 与视图耦合）——发起方（视图）在 ok 后
 * 删源 excerptRef（≠目标 ref 才删），镜像 deleteCardCascade 发起方职责先例。
 */
export interface CardMergeHost {
	cards: CardRepository;
	mindmaps: MindmapRepository;
	links: LinkRepository;
	reviews: ReviewRepository;
	/** 复习态整写（ReviewRepository 无 putReview 公开面，走 store） */
	store: MarinMindStore;
}

export type MergeResult =
	| { ok: true; affectedMapIds: string[] }
	| { ok: false; reason: string };

/** 文本类字段并入补丁构造（纯函数，可单测）：目标有值不动、目标空取源、tags 并集 */
export function buildMergePatch(
	source: { note: string | null; excerptText: string | null; title: string | null; deck: string | null; color: string | null; occlusions: unknown[]; tags: string[] },
	target: { note: string | null; excerptText: string | null; title: string | null; deck: string | null; color: string | null; occlusions: unknown[]; tags: string[] },
): CardPatch {
	const patch: CardPatch = {};
	if (source.note != null && target.note != null) {
		patch.note = target.note === source.note ? target.note : `${target.note}\n\n${source.note}`;
	} else if (target.note == null && source.note != null) {
		patch.note = source.note;
	}
	if (target.excerptText == null && source.excerptText != null) {
		patch.excerptText = source.excerptText;
	}
	if (target.title == null && source.title != null) {
		patch.title = source.title;
	}
	if (target.deck == null && source.deck != null) {
		patch.deck = source.deck;
	}
	if (target.color == null && source.color != null) {
		patch.color = source.color;
	}
	if (target.occlusions.length === 0 && source.occlusions.length > 0) {
		// 类型经调用方保证同构（DocRect[]），此处只判空——宽类型避免循环依赖引类型
		patch.occlusions = source.occlusions as CardPatch["occlusions"];
	}
	const mergedTags = [...target.tags];
	for (const t of source.tags) {
		if (!mergedTags.includes(t)) {
			mergedTags.push(t);
		}
	}
	if (mergedTags.length !== target.tags.length || mergedTags.some((t, i) => t !== target.tags[i])) {
		patch.tags = mergedTags;
	}
	return patch;
}

/**
 * 执行合并（顺序敏感，见模块注释）：快照 → 目标并入 → 节点迁移 → 链接转移 →
 * 复习态承接 → 删源卡。源卡删除发 removed 事件，各视图清理由订阅方完成；
 * 受影响脑图由调用方 refreshActiveMindmaps(affectedMapIds) 重拉。
 */
export function mergeCardsInto(
	host: CardMergeHost,
	sourceId: string,
	targetId: string,
): MergeResult {
	if (sourceId === targetId) {
		return { ok: false, reason: "不能与自身合并" };
	}
	const source = host.cards.get(sourceId);
	const target = host.cards.get(targetId);
	if (!source) {
		return { ok: false, reason: "源卡片已不存在" };
	}
	if (!target) {
		return { ok: false, reason: "目标卡片已不存在" };
	}

	// 1. 目标并入文本类字段（changed 事件回环刷新各视图）
	const patch = buildMergePatch(source, target);
	if (Object.keys(patch).length > 0) {
		host.cards.update(targetId, patch);
	}

	// 2. 节点迁移（删源卡前）：同图目标已有节点 → 子挂目标 + 删源节点；无 → repoint
	const affectedMapIds: string[] = [];
	const sourceNodes = host.mindmaps.nodesByCard(sourceId);
	const targetNodes = host.mindmaps.nodesByCard(targetId);
	for (const sn of sourceNodes) {
		if (!affectedMapIds.includes(sn.mapId)) {
			affectedMapIds.push(sn.mapId);
		}
		const twin = targetNodes.find((tn) => tn.mapId === sn.mapId);
		if (twin) {
			const children = host.mindmaps
				.listNodes(sn.mapId)
				.filter((n) => n.parentId === sn.id);
			for (const child of children) {
				host.mindmaps.setParent(child.id, twin.id);
			}
			host.mindmaps.removeNode(sn.id);
		} else {
			host.mindmaps.repointNode(sn.id, targetId);
		}
	}

	// 3. 链接转移：源的邻居逐个建到目标（link 内置去重；对端被删竞态 throw 吞掉）
	for (const neighborId of host.links.neighbors(sourceId)) {
		try {
			host.links.link(targetId, neighborId);
		} catch {
			// 对端已删（竞态）——跳过，源的链接随删卡级联清除
		}
	}

	// 4. 复习态承接：目标未启用闪卡而源已启用 → 完整承接源的调度字段
	const targetState = host.reviews.get(targetId);
	const sourceState = host.reviews.get(sourceId);
	if (!targetState?.isFlashcard && sourceState?.isFlashcard) {
		host.store.putReview({ ...sourceState, cardId: targetId });
	}

	// 5. 删源卡（级联残余节点/链接/复习态 + removed 事件驱动各视图收敛）
	host.cards.delete(sourceId);
	return { ok: true, affectedMapIds };
}
