import { FuzzySuggestModal } from "obsidian";
import type { App, FuzzyMatch } from "obsidian";
import type MarinMindPlugin from "../main";
import { distinctDecks } from "../home/home-data";

/**
 * 卡组快速选择弹窗（命令「按卡组复习」/ 复习 Empty·Done 屏入口）：
 * 卡组无实体表——由卡片的 deck 设置派生（distinctDecks 去重排序），
 * 无"新建"哨兵（建组 = 给卡片设置卡组名）。
 */
export class DeckPickerModal extends FuzzySuggestModal<string> {
	constructor(
		app: App,
		private readonly plugin: MarinMindPlugin,
		private readonly onChoose: (deck: string) => void,
	) {
		super(app);
		this.setPlaceholder("选择卡组…");
	}

	getItems(): string[] {
		return distinctDecks(this.plugin.cards.listAll());
	}

	getItemText(deck: string): string {
		return deck;
	}

	renderSuggestion(match: FuzzyMatch<string>, el: HTMLElement): void {
		// R2（E2-07）：picker-title 统一截断（长卡组名单行省略）
		const name = document.createElement("div");
		name.className = "marinmind-picker-name";
		const title = document.createElement("span");
		title.className = "marinmind-picker-title";
		title.textContent = match.item;
		const dir = document.createElement("div");
		dir.className = "marinmind-picker-dir";
		dir.textContent = "复习该组的到期闪卡";
		name.appendChild(title);
		el.appendChild(name);
		el.appendChild(dir);
	}

	onChooseItem(deck: string): void {
		this.onChoose(deck);
	}
}
