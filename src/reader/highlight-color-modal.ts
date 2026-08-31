import { Modal } from "obsidian";
import type { App } from "obsidian";
import { HIGHLIGHT_COLORS } from "./highlight-colors";

/**
 * 高亮颜色选择弹窗（㊳ 多色高亮）：色块网格，当前色描边标示。
 * 点击色块即回调并关闭；Modal 自带 esc / 背景点击关闭（= 取消）。
 */
export class HighlightColorModal extends Modal {
	constructor(
		app: App,
		/** 当前颜色（card.color 原值，null = 未设置） */
		private readonly current: string | null,
		/** 选中回调（值来自 HIGHLIGHT_COLORS） */
		private readonly onPick: (value: string) => void,
	) {
		super(app);
	}

	onOpen(): void {
		this.titleEl.setText("高亮颜色");
		const grid = this.contentEl.createDiv({ cls: "marinmind-color-grid" });
		for (const def of HIGHLIGHT_COLORS) {
			const swatch = grid.createEl("button", {
				cls: "marinmind-color-swatch",
				attr: {
					type: "button",
					title: def.label,
					"aria-label": def.label,
				},
			});
			swatch.style.background = def.swatch;
			if (def.value === this.current) {
				swatch.classList.add("is-active");
			}
			swatch.addEventListener("click", () => {
				this.onPick(def.value);
				this.close();
			});
		}
	}
}
