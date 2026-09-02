import type { MarinMindStore } from "../../store/marinmind-store";
import { defaultReviewState } from "../../store/book-format";
import type { Card, DocRect, ExcerptType, LineStyle, NormPoint } from "../../types";
import { newId, now } from "../../utils";
import type { CardEventBus } from "../../events/card-bus";

/** 创建卡片的输入（可选字段缺省为空） */
export interface CreateCardInput {
	documentId: string | null;
	page: number | null;
	rects: DocRect[];
	excerptType: ExcerptType;
	/** 套索摘录的原始轮廓（创建后不可变，update 不改形状） */
	polygon?: NormPoint[] | null;
	excerptText?: string | null;
	excerptRef?: string | null;
	note?: string | null;
	color?: string | null;
	/** 文字摘录线型（77，仅 text 形态消费）：缺省为 null = 下划线 */
	lineStyle?: LineStyle | null;
	/** 卡片标题（㊺，脑图节点标题栏）：缺省为空 */
	title?: string | null;
	/** 卡组名（复习卡分组）：缺省为空 */
	deck?: string | null;
	/** 闪卡遮挡区域（㊷）：缺省为空 */
	occlusions?: DocRect[];
	/** 目录章节骨架卡（55，PDF 目录转框架）：缺省非骨架卡 */
	outline?: boolean;
	tags?: string[];
}

/** 卡片可编辑字段：undefined 表示不改，null 表示清空 */
export interface CardPatch {
	page?: number | null;
	excerptText?: string | null;
	excerptRef?: string | null;
	note?: string | null;
	color?: string | null;
	/** 文字摘录线型（77）：null = 改回下划线，undefined 不动 */
	lineStyle?: LineStyle | null;
	title?: string | null;
	/** 卡组名：null = 移出卡组，undefined 不动 */
	deck?: string | null;
	/** 闪卡遮挡区域（㊷）：传数组整体替换，undefined 不动 */
	occlusions?: DocRect[];
	tags?: string[];
}

/** 全库卡片迭代（含孤儿文件；recent/count/due 等全库查询共用） */
function* allCards(store: MarinMindStore): Generator<Card> {
	for (const book of store.books.values()) {
		yield* book.cards.values();
	}
	yield* store.orphanState.cards.values();
}

/**
 * 知识卡片仓储（㉚ md 存储版）：内存 Map 操作 + store 标脏。
 * 事件契约与 SQL 版一致：create 双发（created+changed）、update 只发 changed、
 * delete 发删除前快照、未命中一律不发。
 */
export class CardRepository {
	/**
	 * @param bus 可选事件总线：写方法成功后同步 emit（订阅方契约见 card-bus.ts——
	 *   回调禁止写库）。注入而非仓储自建，便于测试与"无总线"的旧行为兼容。
	 */
	constructor(
		private store: MarinMindStore,
		private bus?: CardEventBus,
	) {}

	/** 创建卡片，并同步生成默认复习状态（new、未启用闪卡） */
	create(input: CreateCardInput): Card {
		// documentId 外键语义：归属文档必须已存在（旧库由 FK 约束保证）
		if (input.documentId != null && !this.store.books.has(input.documentId)) {
			throw new Error(`卡片归属文档不存在：${input.documentId}`);
		}
		const ts = now();
		const card: Card = {
			id: newId(),
			documentId: input.documentId,
			page: input.page,
			rects: input.rects,
			excerptType: input.excerptType,
			polygon: input.polygon ?? null,
			excerptText: input.excerptText ?? null,
			excerptRef: input.excerptRef ?? null,
			note: input.note ?? null,
			color: input.color ?? null,
			// 线型（77）：入口收口 null=下划线（与 color 的 null=回退默认同构）
			lineStyle: input.lineStyle ?? null,
			title: input.title ?? null,
			deck: input.deck ?? null,
			occlusions: input.occlusions ?? [],
			// 目录章节骨架卡（55）：显式落布尔（false 同缺省，序列化省键零写入契约）
			outline: input.outline ?? false,
			tags: input.tags ?? [],
			createdAt: ts,
			updatedAt: ts,
		};
		const book =
			input.documentId == null
				? this.store.orphanState
				: this.store.books.get(input.documentId)!;
		book.cards.set(card.id, card);
		this.store.putReview(defaultReviewState(card.id, ts));
		// created（区分新建/编辑，脑图自动收录用）+ changed（跨标签同步旧语义）双发
		this.bus?.emitCardCreated(card);
		this.bus?.emitCardChanged(card);
		return card;
	}

	get(id: string): Card | undefined {
		return this.store.bookOfCard(id)?.cards.get(id);
	}

	/** 合并式更新：只改动给定字段，其余保持不变 */
	update(id: string, patch: CardPatch): Card | undefined {
		const book = this.store.bookOfCard(id);
		const current = book?.cards.get(id);
		if (!book || !current) {
			return undefined;
		}
		const next: Card = {
			...current,
			...(patch.page !== undefined ? { page: patch.page } : {}),
			...(patch.excerptText !== undefined ? { excerptText: patch.excerptText } : {}),
			...(patch.excerptRef !== undefined ? { excerptRef: patch.excerptRef } : {}),
			...(patch.note !== undefined ? { note: patch.note } : {}),
			...(patch.color !== undefined ? { color: patch.color } : {}),
			...(patch.lineStyle !== undefined ? { lineStyle: patch.lineStyle } : {}),
			...(patch.title !== undefined ? { title: patch.title } : {}),
			...(patch.deck !== undefined ? { deck: patch.deck } : {}),
			...(patch.occlusions !== undefined ? { occlusions: patch.occlusions } : {}),
			...(patch.tags !== undefined ? { tags: patch.tags } : {}),
			updatedAt: now(),
		};
		book.cards.set(id, next);
		this.store.markDirty(this.store.scopeOfCard(id));
		this.bus?.emitCardChanged(next);
		return next;
	}

	/** 删除卡片（复习状态、链接、脑图节点由 store 级联删除，子节点上浮为根） */
	delete(id: string): boolean {
		const last = this.store.deleteCardCascade(id);
		if (!last) {
			return false;
		}
		// 删除后已查不到，把删除前快照一并交给订阅方（DOM 清理需要 page 等信息）
		this.bus?.emitCardRemoved(id, last);
		return true;
	}

	/** 某文档下的全部卡片，按页码排序（无页码的排最后） */
	listByDocument(documentId: string): Card[] {
		return [...(this.store.books.get(documentId)?.cards.values() ?? [])].sort(
			(a, b) =>
				(a.page ?? Infinity) - (b.page ?? Infinity) ||
				a.createdAt - b.createdAt ||
				(a.id < b.id ? -1 : 1),
		);
	}

	/** 最近更新的卡片（工作区"最近"列表用） */
	recent(limit = 50): Card[] {
		return this.listAll().slice(0, limit);
	}

	/** 全库卡片（含孤儿卡），按更新时间降序——主页卡片页全量浏览的数据源 */
	listAll(): Card[] {
		return [...allCards(this.store)].sort(
			(a, b) =>
				b.updatedAt - a.updatedAt || (a.id < b.id ? -1 : 1),
		);
	}

	count(documentId?: string): number {
		if (documentId === undefined) {
			let n = this.store.orphanState.cards.size;
			for (const book of this.store.books.values()) n += book.cards.size;
			return n;
		}
		return this.store.books.get(documentId)?.cards.size ?? 0;
	}
}
