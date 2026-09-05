import { ButtonComponent, Modal, Notice } from "obsidian";
import type { App } from "obsidian";
import type MarinMindPlugin from "../main";
import type { Card, DocRect } from "../types";

import type { AiUsage } from "./ai-provider";
import { sendChat } from "./ai-service";
import {
	buildCardgenMessages,
	cardgenTitle,
	parseCardgenItems,
	type CardgenItem,
} from "./ai-cardgen";

/** 弹窗配置：源材料 + 锚点继承（划选/卡片入口都带原文定位，生成卡保留回链） */
export interface AiCardgenOptions {
	/** 制卡材料（划选文本或卡片摘录文字，trim 非空由调用方保证） */
	sourceText: string;
	/** 原文定位继承：null = 无源（复习手工卡等场景，卡不锚页） */
	anchor: {
		documentId: string;
		page: number;
		rects: DocRect[];
	} | null;
}

/** 预览行（勾选态） */
interface CardgenRow {
	item: CardgenItem;
	checked: boolean;
}

/**
 * AI 制卡弹窗（99 P3，MN4「AI 制卡」对齐）：材料 → LLM 生成 QA/填空卡 →
 * 预览勾选（镜像 AutoExcerptModal 勾选批量先例）→ 批量落卡。字段约定见
 * ai-cardgen.ts 头注（note=正面/excerptText=背面，零模型改动承接复习语义）；
 * 建卡走 cards.create——自动入图归章由 cardBus 回环白赚，转闪卡按设置。
 * obsidian 耦合不单测（镜像 AutoExcerptModal 分层）。
 */
export class AiCardgenModal extends Modal {
	private rows: CardgenRow[] = [];
	private generating = false;
	private closed = false;

	constructor(
		app: App,
		private readonly plugin: MarinMindPlugin,
		private readonly opts: AiCardgenOptions,
	) {
		super(app);
	}

	onOpen(): void {
		this.titleEl.setText("AI 制卡");
		void this.generate();
	}

	onClose(): void {
		this.closed = true; // 在途请求结果丢弃（渲染前 isConnected 双保险）
	}

	/** 生成（非流式：JSON 整体解析才有意义，逐字流式无观感价值） */
	private async generate(): Promise<void> {
		this.generating = true;
		this.contentEl.empty();
		this.contentEl.createDiv({
			cls: "marinmind-ai-cardgen-loading",
			text: "正在依据材料出题…",
		});
		try {
			const raw = await sendChat(
				this.plugin.settings,
				buildCardgenMessages(this.opts.sourceText),
				{ onUsage: (usage: AiUsage) => this.plugin.addAiUsage(usage) },
			);
			if (this.closed || !this.contentEl.isConnected) {
				return;
			}
			const items = parseCardgenItems(raw);
			this.rows = items.map((item) => ({ item, checked: true }));
			this.renderList();
		} catch (err) {
			if (this.closed || !this.contentEl.isConnected) {
				return;
			}
			this.contentEl.empty();
			const errorEl = this.contentEl.createDiv({
				cls: "marinmind-tr-text marinmind-tr-error",
			});
			errorEl.createDiv({ text: err instanceof Error ? err.message : String(err) });
			new ButtonComponent(errorEl.createDiv({ cls: "marinmind-tr-retry" }))
				.setButtonText("重试")
				.onClick(() => void this.generate());
		} finally {
			this.generating = false;
		}
	}

	/** 预览列表：类型徽标 + 正面/背面双行 + 勾选；底部「生成 N 张卡」 */
	private renderList(): void {
		this.contentEl.empty();
		this.contentEl.addClass("marinmind-ai-cardgen");
		const listEl = this.contentEl.createDiv({ cls: "marinmind-ai-cardgen-list" });
		for (const row of this.rows) {
			const item = row.item;
			const line = listEl.createDiv({ cls: "marinmind-ai-cardgen-row" });
			const check = line.createEl("input", { type: "checkbox" });
			check.checked = row.checked;
			check.addEventListener("change", () => {
				row.checked = check.checked;
				this.syncCreateBtn();
			});
			const main = line.createDiv({ cls: "marinmind-ai-cardgen-main" });
			main.createDiv({
				cls: "marinmind-ai-cardgen-front",
				text: item.front,
			});
			main.createDiv({
				cls: "marinmind-ai-cardgen-back",
				text: item.back,
			});
			line.createDiv({
				cls: `marinmind-ai-cardgen-kind is-${item.kind}`,
				text: item.kind === "qa" ? "问答" : "填空",
			});
		}
		const actions = this.contentEl.createDiv({ cls: "marinmind-tr-actions" });
		new ButtonComponent(actions).setButtonText("取消").onClick(() => this.close());
		const createBtn = new ButtonComponent(actions).setButtonText("生成卡片").setCta();
		createBtn.onClick(() => this.createCards());
		this.createBtn = createBtn;
		this.syncCreateBtn();
	}

	private createBtn: ButtonComponent | null = null;

	/** 生成按钮文案随勾选数（全不勾禁用） */
	private syncCreateBtn(): void {
		const count = this.rows.filter((r) => r.checked).length;
		this.createBtn?.setDisabled(count === 0);
		this.createBtn?.setButtonText(count > 0 ? `生成 ${count} 张卡` : "生成卡片");
	}

	/** 批量落卡（99）：QA note=问题/excerptText=答案；填空 note=挖空/excerptText=原句 */
	private createCards(): void {
		const picked = this.rows.filter((r) => r.checked).map((r) => r.item);
		if (picked.length === 0) {
			return;
		}
		// 101 修：改用原选区逐行矩形 + 文字形态（下划线）——此前 blank 胶囊锚在
		// 选区下方，不透明背景盖住下行正文，且 N 张卡同锚点堆叠愈盖愈多；
		// 下划线零遮挡，回链/自动入图归章不受影响（只依赖 documentId/page）
		const anchorRect: DocRect[] = this.opts.anchor?.rects ?? [];
		let flashcards = 0;
		for (const item of picked) {
			const card: Card = this.plugin.cards.create({
				// 有源继承回链（documentId+page → 自动入图归章 + 跳原文）；无源置空
				documentId: this.opts.anchor?.documentId ?? null,
				page: this.opts.anchor?.page ?? null,
				rects: anchorRect,
				excerptType: "text",
				excerptText: item.back,
				note: item.front,
				title: cardgenTitle(item),
				color: this.plugin.settings.excerptColors.text,
				tags: ["AI", "制卡"],
			});
			// 自动转闪卡（设置开关；预览里已人工筛过）——复习正反面语义即 note/excerptText
			if (this.plugin.settings.aiAutoFlashcard) {
				this.plugin.reviews.enable(card.id);
				flashcards++;
			}
		}
		this.close();
		new Notice(
			`已生成 ${picked.length} 张卡片（自动入图归章${flashcards > 0 ? `，${flashcards} 张已入复习队列` : ""}）`,
			5000,
		);
	}
}
