import { ButtonComponent, Modal, Notice } from "obsidian";
import type { App } from "obsidian";
import type MarinMindPlugin from "../main";
import type { Card } from "../types";
import { refreshActiveMindmaps } from "../mindmap/mindmap-view";
import type { AiUsage } from "./ai-provider";
import { sendChat } from "./ai-service";
import {
	LINK_CANDIDATE_CAP,
	buildLinkMessages,
	parseLinkSuggestions,
	type LinkCandidate,
	type LinkSuggestion,
} from "./ai-link";

/**
 * 相关卡推荐弹窗（99 P3，MN4「AI 链接建议」对齐）：同文档候选（截断 40）
 * → LLM 按「序号. 摘要」推荐（只见下标不见 id，回映射防幻觉）→ 勾选预览
 * → 批量 links.link（双向）→ 受影响脑图 refreshActiveMindmaps 重画虚线边。
 * obsidian 耦合不单测（镜像 AutoExcerptModal 分层）；纯逻辑在 ai-link
 * （vitest 覆盖）。
 */
export class AiLinkModal extends Modal {
	private checked = new Set<string>();
	private closed = false;

	constructor(
		app: App,
		private readonly plugin: MarinMindPlugin,
		private readonly card: Card,
	) {
		super(app);
	}

	onOpen(): void {
		this.titleEl.setText("相关卡片（AI 推荐）");
		void this.suggest();
	}

	onClose(): void {
		this.closed = true;
	}

	/** 候选收集 + 推荐（非流式：JSON 整体解析） */
	private async suggest(): Promise<void> {
		const source = this.card.excerptText?.trim() ?? this.card.note?.trim() ?? "";
		if (!source) {
			this.contentEl.createDiv({
				cls: "marinmind-ai-cardgen-loading",
				text: "这张卡片没有文本内容，无法推荐相关卡。",
			});
			return;
		}
		if (this.card.documentId == null) {
			this.contentEl.createDiv({
				cls: "marinmind-ai-cardgen-loading",
				text: "手工卡（无文档归属）暂不支持推荐——候选按同文档收集。",
			});
			return;
		}
		// 候选：同文档其他卡（排除自身与已链卡），摘要取 title/note/excerptText
		const linked = new Set(this.plugin.links.neighbors(this.card.id));
		const candidates: LinkCandidate[] = this.plugin.cards
			.listByDocument(this.card.documentId)
			.filter((c) => c.id !== this.card.id && !linked.has(c.id))
			.map((c) => ({
				cardId: c.id,
				text: c.title ?? c.note ?? c.excerptText ?? "（无文本）",
			}))
			.slice(0, LINK_CANDIDATE_CAP);
		if (candidates.length === 0) {
			this.contentEl.createDiv({
				cls: "marinmind-ai-cardgen-loading",
				text: "同文档没有其他卡片可作候选。",
			});
			return;
		}

		this.contentEl.empty();
		this.contentEl.createDiv({
			cls: "marinmind-ai-cardgen-loading",
			text: `正在从 ${candidates.length} 张同文档卡片中推荐…`,
		});
		try {
			const raw = await sendChat(
				this.plugin.settings,
				buildLinkMessages(source, candidates),
				{ onUsage: (usage: AiUsage) => this.plugin.addAiUsage(usage) },
			);
			if (this.closed || !this.contentEl.isConnected) {
				return;
			}
			const suggestions = parseLinkSuggestions(raw, candidates);
			this.renderList(suggestions);
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
				.onClick(() => void this.suggest());
		}
	}

	/** 推荐列表（勾选默认全选）+「建立 N 条链接」 */
	private renderList(suggestions: LinkSuggestion[]): void {
		this.contentEl.empty();
		this.contentEl.addClass("marinmind-ai-cardgen");
		if (suggestions.length === 0) {
			this.contentEl.createDiv({
				cls: "marinmind-ai-cardgen-loading",
				text: "AI 未找到语义相关的卡片（宁缺毋滥）。",
			});
			return;
		}
		this.checked = new Set(suggestions.map((s) => s.cardId));
		const listEl = this.contentEl.createDiv({ cls: "marinmind-ai-cardgen-list" });
		for (const s of suggestions) {
			const fresh = this.plugin.cards.get(s.cardId);
			if (!fresh) {
				this.checked.delete(s.cardId); // 推荐期间被删（竞态防御）
				continue;
			}
			const line = listEl.createDiv({ cls: "marinmind-ai-cardgen-row" });
			const check = line.createEl("input", { type: "checkbox" });
			check.checked = true;
			check.addEventListener("change", () => {
				if (check.checked) {
					this.checked.add(s.cardId);
				} else {
					this.checked.delete(s.cardId);
				}
				this.syncLinkBtn();
			});
			const main = line.createDiv({ cls: "marinmind-ai-cardgen-main" });
			main.createDiv({
				cls: "marinmind-ai-cardgen-front",
				text: s.text,
			});
			main.createDiv({
				cls: "marinmind-ai-cardgen-back",
				text: s.reason,
			});
		}
		const actions = this.contentEl.createDiv({ cls: "marinmind-tr-actions" });
		new ButtonComponent(actions).setButtonText("取消").onClick(() => this.close());
		const linkBtn = new ButtonComponent(actions).setButtonText("建立链接").setCta();
		linkBtn.onClick(() => this.linkCards(suggestions));
		this.linkBtn = linkBtn;
		this.syncLinkBtn();
	}

	private linkBtn: ButtonComponent | null = null;

	private syncLinkBtn(): void {
		this.linkBtn?.setButtonText(
			this.checked.size > 0 ? `建立 ${this.checked.size} 条链接` : "建立链接",
		);
		this.linkBtn?.setDisabled(this.checked.size === 0);
	}

	/** 批量建链（99）：links.link 双向；两端任一所在脑图 refresh 重画虚线边 */
	private linkCards(suggestions: LinkSuggestion[]): void {
		const picked = suggestions.filter((s) => this.checked.has(s.cardId));
		if (picked.length === 0) {
			return;
		}
		let created = 0;
		for (const s of picked) {
			try {
				if (this.plugin.links.link(this.card.id, s.cardId)) {
					created++;
				}
			} catch (err) {
				// 推荐期间对端被删（竞态）：link 校验两端存在时 throw
				console.error("[MarinMind] AI 建立卡片链接失败", err);
			}
		}
		// 无链接事件总线（53 取舍）：扫全部图找含两端任一卡的重画（低频点击毫秒级）
		const mapIds = new Set<string>();
		for (const map of this.plugin.mindmaps.list()) {
			for (const node of this.plugin.mindmaps.listNodes(map.id)) {
				if (node.cardId === this.card.id || picked.some((s) => s.cardId === node.cardId)) {
					mapIds.add(map.id);
					break;
				}
			}
		}
		for (const mapId of mapIds) {
			refreshActiveMindmaps(mapId);
		}
		this.close();
		new Notice(created > 0 ? `已建立 ${created} 条卡片链接` : "所选卡片均已链接过", 4000);
	}
}
