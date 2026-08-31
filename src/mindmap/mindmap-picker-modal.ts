import { FuzzySuggestModal } from "obsidian";
import type { App, FuzzyMatch } from "obsidian";
import type MarinMindPlugin from "../main";
import type { Mindmap } from "../types";
import { TextPromptModal } from "../reader/note-edit-modal";

/** "新建脑图"哨兵项（列表首项，与真实脑图区分） */
export interface NewMapEntry {
	__new__: true;
}

type Entry = NewMapEntry | Mindmap;

function isNewMap(entry: Entry): entry is NewMapEntry {
	return (entry as NewMapEntry).__new__ === true;
}

const NEW_ENTRY: NewMapEntry = { __new__: true };

/**
 * 脑图快速选择弹窗（命令入口与 reader 高亮菜单共用）：
 * 首项"➕ 新建脑图"，其余为已有图（最近使用在前，次行显示节点数）。
 */
export class MindmapPickerModal extends FuzzySuggestModal<Entry> {
	constructor(
		app: App,
		private readonly plugin: MarinMindPlugin,
		private readonly onChoose: (map: Mindmap) => void,
	) {
		super(app);
		this.setPlaceholder("选择思维导图…");
	}

	getItems(): Entry[] {
		return [NEW_ENTRY, ...this.plugin.mindmaps.list()];
	}

	getItemText(entry: Entry): string {
		return isNewMap(entry) ? "新建脑图" : entry.name;
	}

	renderSuggestion(match: FuzzyMatch<Entry>, el: HTMLElement): void {
		const name = document.createElement("div");
		const dir = document.createElement("div");
		dir.className = "marinmind-picker-dir";
		if (isNewMap(match.item)) {
			name.textContent = "➕ 新建脑图";
			dir.textContent = "创建一张新的思维导图";
		} else {
			// 书籍默认脑图（㉗ 自动入图目标）带 📖 徽标——用户摘录后据此找图
			const isBookMap = match.item.documentId != null;
			const nodeCount = this.plugin.mindmaps.countNodes(match.item.id);
			name.textContent = isBookMap ? `📖 ${match.item.name}` : match.item.name;
			dir.textContent = isBookMap
				? `${nodeCount} 个节点 · 书籍脑图（该书摘录自动入图）`
				: `${nodeCount} 个节点`;
		}
		el.appendChild(name);
		el.appendChild(dir);
	}

	onChooseItem(entry: Entry): void {
		if (!isNewMap(entry)) {
			this.onChoose(entry);
			return;
		}
		// 新建：先输入名称（空名给默认值），再回调
		new TextPromptModal(
			this.app,
			{
				title: "新建脑图",
				placeholder: "输入脑图名称…",
				multiline: false,
			},
			(name) => {
				const map = this.plugin.mindmaps.create(name ?? "未命名脑图");
				this.onChoose(map);
			},
		).open();
	}
}
