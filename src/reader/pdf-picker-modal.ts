import { FuzzySuggestModal } from "obsidian";
import type { App, FuzzyMatch, TFile } from "obsidian";

/** 库内 PDF 快速选择弹窗（命令面板入口） */
export class PdfPickerModal extends FuzzySuggestModal<TFile> {
	constructor(
		app: App,
		private readonly onChoose: (file: TFile) => void,
	) {
		super(app);
		this.setPlaceholder("选择要阅读的 PDF…");
	}

	getItems(): TFile[] {
		return this.app.vault.getFiles().filter((f) => f.extension === "pdf");
	}

	/** 模糊匹配用完整路径（输入目录名也能命中） */
	getItemText(file: TFile): string {
		return file.path;
	}

	/** 主行文件名、次行所在目录（textContent 渲染，无注入风险） */
	renderSuggestion(match: FuzzyMatch<TFile>, el: HTMLElement): void {
		const name = document.createElement("div");
		name.textContent = match.item.basename;

		const dir = document.createElement("div");
		dir.className = "marinmind-picker-dir";
		dir.textContent = match.item.parent?.path ?? "";

		el.appendChild(name);
		el.appendChild(dir);
	}

	onChooseItem(file: TFile): void {
		this.onChoose(file);
	}
}
