import { ButtonComponent, Modal } from "obsidian";
import type { App } from "obsidian";
import type MarinMindPlugin from "../main";
import type { Card } from "../types";

/**
 * 卡片编辑弹窗（78 统一入口）：标题 + 批注双字段（85-D 起摘录文字另列只读块）——
 * 落库语义与脑图节点编辑器（mindmap-view 的 openNodeEditor/closeNodeEditor）同源：
 * trim 空串归一 null、fresh 取库同值不写、cards.update → cardBus changed 回环
 * （各视图刷新统一承接）。替代各处单字段「编辑批注」（TextPromptModal），
 * 阅读器/复习/主页/媒体预览共用。obsidian 耦合不单测（镜像 deck-assign-modal 分层）。
 */
export class CardEditModal extends Modal {
	constructor(
		app: App,
		private readonly plugin: MarinMindPlugin,
		private readonly card: Card,
		/** 保存成功回调（拿到最新卡快照；媒体预览弹窗用于同步宿主缓存与重渲染） */
		private readonly onSaved?: (updated: Card) => void,
	) {
		super(app);
	}

	onOpen(): void {
		this.titleEl.setText("编辑标题/批注");
		const wrap = this.contentEl.createDiv({ cls: "marinmind-card-edit" });

		const titleLabel = wrap.createEl("label", { text: "标题" });
		const title = titleLabel.createEl("input");
		title.type = "text";
		title.placeholder = "默认显示 “…”";
		title.value = this.card.title ?? "";

		const noteLabel = wrap.createEl("label", { text: "批注" });
		const note = noteLabel.createEl("textarea");
		note.rows = 4;
		note.placeholder = "复习正面的问题（留空则用摘录内容）";
		note.value = this.card.note ?? "";

		// 85-D 摘录只读块：OCR/划选文字存 excerptText，弹窗此前只读写
		// title/note——用户"看不到 OCR 识别文字"。只读展示（与节点编辑器同款；
		// OCR 纠错走阅读器覆盖确认流程，编辑面不改 excerptText 语义）。
		const excerpt = this.card.excerptText?.trim();
		if (excerpt) {
			const block = wrap.createDiv({ cls: "marinmind-card-edit-excerpt" });
			block.createDiv({ cls: "marinmind-card-edit-excerpt-label", text: "摘录（只读）" });
			block.createDiv({ cls: "marinmind-card-edit-excerpt-body", text: excerpt });
		}

		const actions = wrap.createDiv({ cls: "marinmind-note-actions" });
		new ButtonComponent(actions).setButtonText("取消").onClick(() => this.close());
		new ButtonComponent(actions)
			.setButtonText("保存")
			.setCta()
			.onClick(() => this.saveAndClose(title.value, note.value));

		// Ctrl/Cmd+Enter 保存（镜像节点编辑器键位）；Esc/背景点击 = Modal 自带取消，不写库
		this.contentEl.addEventListener("keydown", (evt) => {
			if (evt.key === "Enter" && (evt.ctrlKey || evt.metaKey)) {
				evt.preventDefault();
				this.saveAndClose(title.value, note.value);
			}
		});
		// 无标题聚焦标题框（引导起名）、有标题聚焦批注框（常见操作：补批注）——镜像节点编辑器
		(this.card.title ? note : title).focus();
	}

	/**
	 * 落库语义镜像节点编辑器 closeNodeEditor(save)：保存时刻 fresh 取库——
	 * 弹窗开着时外部（跨视图/手编回灌）改卡则同值比较对最新值做（最后写者胜），
	 * 卡已被删则静默不写；同值不写库（零写入契约）。
	 */
	private saveAndClose(titleRaw: string, noteRaw: string): void {
		const title = titleRaw.trim() || null;
		const note = noteRaw.trim() || null;
		const fresh = this.plugin.cards.get(this.card.id);
		if (fresh && (fresh.title !== title || fresh.note !== note)) {
			const updated = this.plugin.cards.update(this.card.id, { title, note });
			if (updated) {
				this.onSaved?.(updated);
			}
		}
		this.close();
	}
}
