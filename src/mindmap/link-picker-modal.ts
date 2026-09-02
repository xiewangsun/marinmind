import { FuzzySuggestModal } from "obsidian";
import type { App, FuzzyMatch } from "obsidian";
import type MarinMindPlugin from "../main";
import type { BookDocument, Card } from "../types";
import { pageWordOf } from "../storage/paths";
import { linkId } from "../store/book-format";

/** 最近卡片加载上限（选择器数据量，与 CardPickerModal 对齐） */
const RECENT_LIMIT = 200;

/**
 * 卡片互链选择器（53）：列出最近卡片（自身与已链接的不出现），
 * 次行显示出处（书名 · 页码 / 手工卡片）。镜像 CardPickerModal。
 */
export class LinkPickerModal extends FuzzySuggestModal<Card> {
	/** documentId → BookDocument 惰性缓存（同一文档大量卡片时避免重复查询） */
	private readonly docCache = new Map<string, BookDocument | null>();

	constructor(
		app: App,
		private readonly plugin: MarinMindPlugin,
		private readonly sourceCardId: string,
		private readonly onChoose: (card: Card) => void,
	) {
		super(app);
		this.setPlaceholder("选择要链接的卡片…");
	}

	getItems(): Card[] {
		return this.plugin.cards
			.recent(RECENT_LIMIT)
			.filter((card) => card.id !== this.sourceCardId && !this.isLinked(card.id));
	}

	getItemText(card: Card): string {
		return card.title ?? card.note ?? card.excerptText ?? card.excerptType;
	}

	renderSuggestion(match: FuzzyMatch<Card>, el: HTMLElement): void {
		const card = match.item;
		// R2（E2-07）：主行 picker-name + picker-title 统一截断
		const name = document.createElement("div");
		name.className = "marinmind-picker-name";
		const title = document.createElement("span");
		title.className = "marinmind-picker-title";
		title.textContent =
			card.title ?? card.note ?? card.excerptText ?? `（${card.excerptType} 摘录）`;

		const dir = document.createElement("div");
		dir.className = "marinmind-picker-dir";
		dir.textContent = this.describeSource(card);

		name.appendChild(title);
		el.appendChild(name);
		el.appendChild(dir);
	}

	onChooseItem(card: Card): void {
		this.onChoose(card);
	}

	/** 是否已与源卡片建链（含反向）——store 未就绪时按未链接处理（建链路径自有守卫） */
	private isLinked(cardId: string): boolean {
		const links = this.plugin.store?.links;
		return links ? links.has(linkId(this.sourceCardId, cardId)) : false;
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
