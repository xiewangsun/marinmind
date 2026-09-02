import { FuzzySuggestModal } from "obsidian";
import type { App, FuzzyMatch } from "obsidian";
import type MarinMindPlugin from "../main";
import type { BookDocument, Card } from "../types";
import { pageWordOf } from "../storage/paths";

/** 最近卡片加载上限（选择器数据量，与 LinkPickerModal 对齐） */
const RECENT_LIMIT = 200;

/**
 * 合并目标选择器（60）：列出最近卡片（源卡自身不出现），选中后回调目标卡。
 * 镜像 LinkPickerModal 的列表与出处次行。
 */
export class MergePickerModal extends FuzzySuggestModal<Card> {
	/** documentId → BookDocument 惰性缓存（同一文档大量卡片时避免重复查询） */
	private readonly docCache = new Map<string, BookDocument | null>();

	constructor(
		app: App,
		private readonly plugin: MarinMindPlugin,
		private readonly sourceCardId: string,
		private readonly onChoose: (card: Card) => void,
	) {
		super(app);
		this.setPlaceholder("选择合并目标卡片（源卡片将并入并删除）…");
	}

	getItems(): Card[] {
		return this.plugin.cards
			.recent(RECENT_LIMIT)
			.filter((card) => card.id !== this.sourceCardId);
	}

	getItemText(card: Card): string {
		return card.title ?? card.note ?? card.excerptText ?? card.excerptType;
	}

	renderSuggestion(match: FuzzyMatch<Card>, el: HTMLElement): void {
		const card = match.item;
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
