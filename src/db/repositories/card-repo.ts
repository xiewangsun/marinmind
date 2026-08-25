import type { MarinMindDatabase } from "../database";
import type { Card, DocRect, ExcerptType } from "../../types";
import { newId, now } from "../../utils";

/** cards 表的查询列（供其他仓储 join 复用） */
const CARD_COLUMNS =
	"id, document_id, page, rects, excerpt_type, excerpt_text, excerpt_ref, note, color, tags, created_at, updated_at";

export interface CardRow {
	id: string;
	document_id: string | null;
	page: number | null;
	rects: string;
	excerpt_type: ExcerptType;
	excerpt_text: string | null;
	excerpt_ref: string | null;
	note: string | null;
	color: string | null;
	tags: string;
	created_at: number;
	updated_at: number;
}

/** 数据库行 → 领域对象（rects/tags 从 JSON 还原） */
export function mapRowToCard(row: CardRow): Card {
	return {
		id: row.id,
		documentId: row.document_id,
		page: row.page,
		rects: JSON.parse(row.rects) as DocRect[],
		excerptType: row.excerpt_type,
		excerptText: row.excerpt_text,
		excerptRef: row.excerpt_ref,
		note: row.note,
		color: row.color,
		tags: JSON.parse(row.tags) as string[],
		createdAt: row.created_at,
		updatedAt: row.updated_at,
	};
}

/** 创建卡片的输入（可选字段缺省为空） */
export interface CreateCardInput {
	documentId: string | null;
	page: number | null;
	rects: DocRect[];
	excerptType: ExcerptType;
	excerptText?: string | null;
	excerptRef?: string | null;
	note?: string | null;
	color?: string | null;
	tags?: string[];
}

/** 卡片可编辑字段：undefined 表示不改，null 表示清空 */
export interface CardPatch {
	page?: number | null;
	excerptText?: string | null;
	excerptRef?: string | null;
	note?: string | null;
	color?: string | null;
	tags?: string[];
}

/** 知识卡片仓储 */
export class CardRepository {
	constructor(private db: MarinMindDatabase) {}

	/** 创建卡片，并同步生成默认复习状态（new、未启用闪卡） */
	create(input: CreateCardInput): Card {
		const ts = now();
		const card: Card = {
			id: newId(),
			documentId: input.documentId,
			page: input.page,
			rects: input.rects,
			excerptType: input.excerptType,
			excerptText: input.excerptText ?? null,
			excerptRef: input.excerptRef ?? null,
			note: input.note ?? null,
			color: input.color ?? null,
			tags: input.tags ?? [],
			createdAt: ts,
			updatedAt: ts,
		};
		this.db.tx(() => {
			this.db.run(
				`INSERT INTO cards (${CARD_COLUMNS})
				 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
				[
					card.id,
					card.documentId,
					card.page,
					JSON.stringify(card.rects),
					card.excerptType,
					card.excerptText,
					card.excerptRef,
					card.note,
					card.color,
					JSON.stringify(card.tags),
					card.createdAt,
					card.updatedAt,
				],
			);
			this.db.run(
				`INSERT INTO review_states (card_id, is_flashcard, phase, ease, interval_days, repetitions, due_at, lapses)
				 VALUES (?, 0, 'new', 2.5, 0, 0, ?, 0)`,
				[card.id, ts],
			);
		});
		return card;
	}

	get(id: string): Card | undefined {
		const row = this.db.get<CardRow>(
			`SELECT ${CARD_COLUMNS} FROM cards WHERE id = ?`,
			[id],
		);
		return row ? mapRowToCard(row) : undefined;
	}

	/** 合并式更新：只改动给定字段，其余保持不变 */
	update(id: string, patch: CardPatch): Card | undefined {
		const current = this.get(id);
		if (!current) {
			return undefined;
		}
		const next: Card = {
			...current,
			...(patch.page !== undefined ? { page: patch.page } : {}),
			...(patch.excerptText !== undefined ? { excerptText: patch.excerptText } : {}),
			...(patch.excerptRef !== undefined ? { excerptRef: patch.excerptRef } : {}),
			...(patch.note !== undefined ? { note: patch.note } : {}),
			...(patch.color !== undefined ? { color: patch.color } : {}),
			...(patch.tags !== undefined ? { tags: patch.tags } : {}),
			updatedAt: now(),
		};
		this.db.run(
			`UPDATE cards SET page = ?, excerpt_text = ?, excerpt_ref = ?, note = ?, color = ?, tags = ?, updated_at = ?
			 WHERE id = ?`,
			[
				next.page,
				next.excerptText,
				next.excerptRef,
				next.note,
				next.color,
				JSON.stringify(next.tags),
				next.updatedAt,
				next.id,
			],
		);
		return next;
	}

	/** 删除卡片（复习状态、链接由外键级联删除） */
	delete(id: string): boolean {
		const existed = this.get(id) !== undefined;
		if (existed) {
			this.db.run("DELETE FROM cards WHERE id = ?", [id]);
		}
		return existed;
	}

	/** 某文档下的全部卡片，按页码排序（无页码的排最后） */
	listByDocument(documentId: string): Card[] {
		return this.db
			.all<CardRow>(
				`SELECT ${CARD_COLUMNS} FROM cards WHERE document_id = ? ORDER BY page IS NULL, page, created_at`,
				[documentId],
			)
			.map(mapRowToCard);
	}

	/** 最近更新的卡片（工作区"最近"列表用） */
	recent(limit = 50): Card[] {
		return this.db
			.all<CardRow>(
				`SELECT ${CARD_COLUMNS} FROM cards ORDER BY updated_at DESC, id LIMIT ?`,
				[limit],
			)
			.map(mapRowToCard);
	}

	count(documentId?: string): number {
		const row =
			documentId === undefined
				? this.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM cards")
				: this.db.get<{ n: number }>(
						"SELECT COUNT(*) AS n FROM cards WHERE document_id = ?",
						[documentId],
					);
		return row?.n ?? 0;
	}
}
