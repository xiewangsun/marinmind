import { FuzzySuggestModal } from "obsidian";
import type { App, FuzzyMatch } from "obsidian";
import type MarinMindPlugin from "../main";
import { buildCategoryTree, flattenCategoryTree } from "./home-data";

/**
 * 批量移动分类选择条目（㊾ 主页文档批选）：既有分类 / 新建 / 移入未分类。
 * items 源 = 文档实际分类 ∪ 显式清单（与主页左列分类树、右键归入菜单同源）。
 */
export type CategoryAssignItem =
	{ kind: "category"; path: string } | { kind: "new" } | { kind: "remove" };

/**
 * 批量移动分类选择弹窗（㊾）：从已定义分类中选择（可输入筛选）——镜像
 * DeckAssignModal / DocumentAssignModal 的交互与零写库契约（写库全部经
 * onChoose 回调上抛）。多选下「当前分类」语义不明（所选各本可能不同），
 * 刻意不渲染「当前」徽标，副行文案携带所选数量。
 */
export class CategoryAssignModal extends FuzzySuggestModal<CategoryAssignItem> {
	constructor(
		app: App,
		plugin: MarinMindPlugin,
		private readonly selectedCount: number,
		private readonly onChoose: (item: CategoryAssignItem) => void,
	) {
		super(app);
		this.plugin = plugin;
		this.setPlaceholder("选择或输入筛选分类…");
	}

	private plugin: MarinMindPlugin;

	getItems(): CategoryAssignItem[] {
		const items: CategoryAssignItem[] = flattenCategoryTree(
			buildCategoryTree(this.plugin.documents.list(), this.plugin.store?.getFolders() ?? [])
				.roots,
		).map((path) => ({ kind: "category", path }));
		items.push({ kind: "new" });
		items.push({ kind: "remove" }); // 移入未分类无条件提供（与单本右键菜单有 category 才显示不同）
		return items;
	}

	getItemText(item: CategoryAssignItem): string {
		if (item.kind === "category") return item.path;
		return item.kind === "new" ? "新建分类" : "移入未分类";
	}

	renderSuggestion(match: FuzzyMatch<CategoryAssignItem>, el: HTMLElement): void {
		const item = match.item;
		// R2（E2-07）：picker-title 统一截断（长分类名单行省略）
		const name = document.createElement("div");
		name.className = "marinmind-picker-name";
		const title = document.createElement("span");
		title.className = "marinmind-picker-title";
		const dir = document.createElement("div");
		dir.className = "marinmind-picker-dir";
		name.appendChild(title);
		if (item.kind === "category") {
			title.textContent = item.path;
			dir.textContent = `将移动所选 ${this.selectedCount} 本到此分类`;
		} else if (item.kind === "new") {
			title.textContent = "＋ 新建分类…";
			dir.textContent = "输入新分类名（支持多层，如：学习/英语）";
		} else {
			title.textContent = "移入未分类";
			dir.textContent = "清除所选文档的分类归属";
		}
		el.appendChild(name);
		el.appendChild(dir);
	}

	onChooseItem(item: CategoryAssignItem): void {
		this.onChoose(item);
	}
}
