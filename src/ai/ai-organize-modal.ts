import { ButtonComponent, Modal, Notice } from "obsidian";
import type { App } from "obsidian";
import type MarinMindPlugin from "../main";
import type { AiUsage } from "./ai-provider";
import { sendChat } from "./ai-service";
import {
	buildOrganizeMessages,
	parseOrganizeGroups,
	type OrganizeCandidate,
	type OrganizeGroupPlan,
} from "./ai-plan";

/** 弹窗配置：候选（调用方收集）+ 组卡挂载锚点 + 应用回调（视图执行写库/撤销/布局） */
export interface AiOrganizeOptions {
	/** 候选节点（已按序截断至 ORGANIZE_NODE_CAP；text 为卡片摘要） */
	candidates: OrganizeCandidate[];
	/** 组卡挂载父节点：null = 根级（整图整理）/ 节点 id = 该节点下（子级整理） */
	anchorParentId: string | null;
	/** 确认整理回调：视图执行「建组卡 + 移动 + 自动布局」单步撤销事务 */
	onApply: (groups: OrganizeGroupPlan[]) => void;
}

/**
 * AI 整理弹窗（100 P4，MN4「AI 脑图整理」对齐）：候选节点下标化送 LLM
 * 分组（语义相近归组）→ 勾选预览 → onApply 回调由视图承接（beginUndoCapture
 * → 建组卡（group 结构卡，documentId=null 不触发自动入图回环）+ setParent
 * 移动 + layoutTree 自动布局 → commitUndo 单步撤销）。
 * 候选收集与写库在视图侧（mindmap-view），本弹窗只做推荐与确认。
 */
export class AiOrganizeModal extends Modal {
	private checked = new Set<number>();
	private closed = false;

	constructor(
		app: App,
		private readonly plugin: MarinMindPlugin,
		private readonly opts: AiOrganizeOptions,
	) {
		super(app);
	}

	onOpen(): void {
		this.titleEl.setText("AI 整理");
		void this.suggest();
	}

	onClose(): void {
		this.closed = true;
	}

	/** 推荐（非流式：JSON 整体解析） */
	private async suggest(): Promise<void> {
		this.contentEl.createDiv({
			cls: "marinmind-ai-cardgen-loading",
			text: `正在为 ${this.opts.candidates.length} 个节点规划分组…`,
		});
		try {
			const raw = await sendChat(
				this.plugin.settings,
				buildOrganizeMessages(this.opts.candidates),
				{ onUsage: (usage: AiUsage) => this.plugin.addAiUsage(usage) },
			);
			if (this.closed || !this.contentEl.isConnected) {
				return;
			}
			this.renderList(parseOrganizeGroups(raw, this.opts.candidates));
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
				.onClick(() => {
					this.contentEl.empty();
					void this.suggest();
				});
		}
	}

	/** 分组预览（勾选默认全选；未分配节点不展示——它们留在原位） */
	private renderList(groups: OrganizeGroupPlan[]): void {
		this.contentEl.empty();
		this.contentEl.addClass("marinmind-ai-cardgen");
		if (groups.length === 0) {
			this.contentEl.createDiv({
				cls: "marinmind-ai-cardgen-loading",
				text: "AI 认为这些节点没有值得归组的语义联系（宁缺毋滥）。",
			});
			return;
		}
		const byId = new Map(this.opts.candidates.map((c) => [c.nodeId, c.text] as const));
		this.checked = new Set(groups.map((_, i) => i));
		const listEl = this.contentEl.createDiv({ cls: "marinmind-ai-cardgen-list" });
		groups.forEach((group, i) => {
			const line = listEl.createDiv({ cls: "marinmind-ai-cardgen-row" });
			const check = line.createEl("input", { type: "checkbox" });
			check.checked = true;
			check.addEventListener("change", () => {
				if (check.checked) {
					this.checked.add(i);
				} else {
					this.checked.delete(i);
				}
				this.syncApplyBtn();
			});
			const main = line.createDiv({ cls: "marinmind-ai-cardgen-main" });
			main.createDiv({
				cls: "marinmind-ai-cardgen-front",
				text: `${group.name}（${group.nodeIds.length} 张）`,
			});
			// 成员摘要串（前 3 + 计数；摘要 40 字内保持单行紧凑）
			const members = group.nodeIds
				.map((id) => byId.get(id) ?? "（已移除）")
				.map((t) => (t.length > 40 ? `${t.slice(0, 40)}…` : t));
			const preview =
				members.length > 3
					? `${members.slice(0, 3).join("、")} 等 ${members.length} 张`
					: members.join("、");
			main.createDiv({ cls: "marinmind-ai-cardgen-back", text: preview });
		});
		const actions = this.contentEl.createDiv({ cls: "marinmind-tr-actions" });
		new ButtonComponent(actions).setButtonText("取消").onClick(() => this.close());
		const applyBtn = new ButtonComponent(actions).setButtonText("整理").setCta();
		applyBtn.onClick(() => this.apply(groups));
		this.applyBtn = applyBtn;
		this.syncApplyBtn();
	}

	private applyBtn: ButtonComponent | null = null;

	private syncApplyBtn(): void {
		const count = this.checked.size;
		this.applyBtn?.setDisabled(count === 0);
		this.applyBtn?.setButtonText(count > 0 ? `整理（${count} 组）` : "整理");
	}

	/** 确认：交回调执行；确认时刻成员可能已被外部移动/删除——id 交给视图逐个守卫 */
	private apply(groups: OrganizeGroupPlan[]): void {
		const picked = groups.filter((_, i) => this.checked.has(i));
		if (picked.length === 0) {
			return;
		}
		this.close();
		this.opts.onApply(picked);
		new Notice(`AI 整理：${picked.length} 组归位（Ctrl+Z 可一步撤销）`, 4000);
	}
}
