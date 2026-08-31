import { FuzzySuggestModal } from "obsidian";
import type { App, FuzzyMatch } from "obsidian";
import type MarinMindPlugin from "../main";
import type { BookDocument, Card } from "../types";
import { pageWordOf } from "../storage/paths";

/** 最近卡片加载上限（选择器数据量） */
const RECENT_LIMIT = 200;

/**
 * 图内"添加卡片"选择器：列出最近卡片（已在当前图中的不出现），
 * 次行显示出处（书名 · 页码 / 手工卡片）。
 */
export class CardPickerModal extends FuzzySuggestModal<Card> {
	/** documentId → BookDocument 惰性缓存（同一文档大量卡片时避免重复查询） */
	private readonly docCache = new Map<string, BookDocument | null>();

	constructor(
		app: App,
		private readonly plugin: MarinMindPlugin,
		private readonly mapId: string,
		private readonly onChoose: (card: Card) => void,
	) {
		super(app);
		this.setPlaceholder("选择要加入的卡片…");
	}

	getItems(): Card[] {
		// 已在当前图中的卡片不出现（UNIQUE 约束的 UI 侧第一道闸）
		return this.plugin.cards.recent(RECENT_LIMIT).filter(
			(card) => !this.plugin.mindmaps.hasCard(this.mapId, card.id),
		);
	}

	getItemText(card: Card): string {
		return card.note ?? card.excerptText ?? card.excerptType;
	}

	renderSuggestion(match: FuzzyMatch<Card>, el: HTMLElement): void {
		const card = match.item;
		const name = document.createElement("div");
		name.textContent = card.note ?? card.excerptText ?? `（${card.excerptType} 摘录）`;

		const dir = document.createElement("div");
		dir.className = "marinmind-picker-dir";
		dir.textContent = this.describeSource(card);

		el.appendChild(name);
		el.appendChild(dir);
	}

	onChooseItem(card: Card): void {
		this.onChoose(card);
	}

	private describeSource(card: Card): string {
		if (!card.documentId) {
			return "手工卡片";
		}
		if (!this.docCache.has(card.documentId)) {
			this.docCache.set(card.documentId, this.plugin.documents.get(card.documentId) ?? null);
		}
		const doc = this.docCache.get(card.documentId);
		const page =
			card.page != null && doc ? ` · 第 ${card.page} ${pageWordOf(doc.filePath)}` : "";
		return doc ? `《${doc.title}》${page}` : "来源文档已删除";
	}
}
