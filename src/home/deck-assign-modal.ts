import { FuzzySuggestModal } from "obsidian";
import type { App, FuzzyMatch } from "obsidian";
import type MarinMindPlugin from "../main";
import type { Card } from "../types";
import { allKnownDecks, normalizeCategory } from "./home-data";

/**
 * 设卡组选择器条目（76）：既有卡组 / 新建 / 移出。
 * items 源 = allKnownDecks（卡片实际卡组 ∪ 显式清单，与主页左列卡组树同源）。
 */
export type DeckAssignItem = { kind: "deck"; deck: string } | { kind: "new" } | { kind: "remove" };

/**
 * 设卡组选择弹窗（76 设卡组改选择器）：从已定义卡组中选择（可输入筛选），
 * 替代文本填入——与「按卡组复习」DeckPickerModal 同款交互。
 * 当前卡组标「当前」徽标；尾部「＋ 新建卡组…」（经构造回调上抛，由调用方
 * promptPathName 输入名并写显式清单）；已有卡组时另有「移出卡组」。
 * 写库全部经 onChoose 回调上抛（弹窗零写库，镜像 DeckPickerModal）。
 */
export class DeckAssignModal extends FuzzySuggestModal<DeckAssignItem> {
	/** 当前卡卡组（归一后；null = 未归属）——「当前」徽标与移出项判定 */
	private readonly currentDeck: string | null;

	constructor(
		app: App,
		plugin: MarinMindPlugin,
		card: Card,
		private readonly onChoose: (item: DeckAssignItem) => void,
	) {
		super(app);
		this.plugin = plugin;
		this.currentDeck = card.deck ? normalizeCategory(card.deck) : null;
		this.setPlaceholder("选择或输入筛选卡组…");
	}

	private plugin: MarinMindPlugin;

	getItems(): DeckAssignItem[] {
		const items: DeckAssignItem[] = allKnownDecks(
			this.plugin.cards.listAll(),
			this.plugin.store?.getDecks() ?? [],
		).map((deck) => ({ kind: "deck", deck }));
		items.push({ kind: "new" });
		if (this.currentDeck) items.push({ kind: "remove" });
		return items;
	}

	getItemText(item: DeckAssignItem): string {
		if (item.kind === "deck") return item.deck;
		return item.kind === "new" ? "新建卡组" : "移出卡组";
	}

	renderSuggestion(match: FuzzyMatch<DeckAssignItem>, el: HTMLElement): void {
		const item = match.item;
		// R2（E2-07）：picker-title 统一截断（长卡组名单行省略）
		const name = document.createElement("div");
		name.className = "marinmind-picker-name";
		const title = document.createElement("span");
		title.className = "marinmind-picker-title";
		const dir = document.createElement("div");
		dir.className = "marinmind-picker-dir";
		name.appendChild(title);
		if (item.kind === "deck") {
			title.textContent = item.deck;
			if (item.deck === this.currentDeck) {
				// 复用 picker-ext-badge 通用徽标样式（accent 色胶囊）
				const badge = document.createElement("span");
				badge.className = "marinmind-picker-ext-badge";
				badge.textContent = "当前";
				name.appendChild(badge);
			}
			dir.textContent = "归入该卡组";
		} else if (item.kind === "new") {
			title.textContent = "＋ 新建卡组…";
			dir.textContent = "输入新卡组名（支持多层，如：学习/英语）";
		} else {
			title.textContent = "移出卡组";
			dir.textContent = "这张卡不归属任何卡组";
		}
		el.appendChild(name);
		el.appendChild(dir);
	}

	onChooseItem(item: DeckAssignItem): void {
		this.onChoose(item);
	}
}
