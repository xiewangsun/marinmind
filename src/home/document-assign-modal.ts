import { FuzzySuggestModal } from "obsidian";
import type { App, FuzzyMatch } from "obsidian";
import type MarinMindPlugin from "../main";
import type { BookDocument } from "../types";

/**
 * 移动目标文档选择条目（127 批量移动卡片）：既有文档 / 未归类卡片。
 * items 源 = documents.list()（含库内/库外全部记录）。
 */
export type DocumentAssignItem = { kind: "doc"; doc: BookDocument } | { kind: "orphan" };

/**
 * 目标文档选择弹窗（127 批量移动卡片到文档）：从书库文档中选择（可输入筛选），
 * 尾部「未归类卡片」（documentId=null 的自由卡归属，同 84-C 手工卡语义）。
 * 当前文档标「当前」徽标；写库全部经 onChoose 回调上抛（弹窗零写库，
 * 镜像 DeckAssignModal / DeckPickerModal 先例）。
 */
export class DocumentAssignModal extends FuzzySuggestModal<DocumentAssignItem> {
	/** 批内第一张卡的当前文档（归一后）——「当前」徽标与等价目标提示用 */
	private readonly currentDocumentId: string | null;

	constructor(
		app: App,
		plugin: MarinMindPlugin,
		currentDocumentId: string | null,
		private readonly onChoose: (item: DocumentAssignItem) => void,
	) {
		super(app);
		this.plugin = plugin;
		this.currentDocumentId = currentDocumentId;
		this.setPlaceholder("选择或输入筛选目标文档…");
	}

	private plugin: MarinMindPlugin;

	getItems(): DocumentAssignItem[] {
		const items: DocumentAssignItem[] = this.plugin.documents
			.list()
			.map((doc) => ({ kind: "doc" as const, doc }));
		items.push({ kind: "orphan" });
		return items;
	}

	getItemText(item: DocumentAssignItem): string {
		return item.kind === "doc" ? item.doc.title : "未归类卡片";
	}

	renderSuggestion(match: FuzzyMatch<DocumentAssignItem>, el: HTMLElement): void {
		const item = match.item;
		// R2（E2-07）：picker-title 统一截断（长书名单行省略）
		const name = document.createElement("div");
		name.className = "marinmind-picker-name";
		const title = document.createElement("span");
		title.className = "marinmind-picker-title";
		const dir = document.createElement("div");
		dir.className = "marinmind-picker-dir";
		name.appendChild(title);
		if (item.kind === "doc") {
			title.textContent = item.doc.title;
			if ((this.currentDocumentId ?? null) === item.doc.id) {
				// 复用 picker-ext-badge 通用徽标样式（accent 色胶囊）
				const badge = document.createElement("span");
				badge.className = "marinmind-picker-ext-badge";
				badge.textContent = "当前";
				name.appendChild(badge);
			}
			dir.textContent = `${this.plugin.cards.count(item.doc.id)} 张卡片 · ${item.doc.filePath}`;
		} else {
			title.textContent = "未归类卡片";
			dir.textContent = "移动为无文档归属的自由卡片";
		}
		el.appendChild(name);
		el.appendChild(dir);
	}

	onChooseItem(item: DocumentAssignItem): void {
		this.onChoose(item);
	}
}
