import { ButtonComponent, Modal, Notice } from "obsidian";
import type { App } from "obsidian";
import type MarinMindPlugin from "../main";
import type { MarinMindReaderView } from "../reader/reader-view";
import { collectDocContext } from "./ai-context-service";
import { buildContextText, clampToTokenBudget } from "./ai-context";
import type { AiUsage } from "./ai-provider";
import { sendChat } from "./ai-service";
import { buildOutlineMessages, parseOutlineTree, type OutlineGenNode } from "./ai-plan";
import { planOutlineChapters, type ChapterPlanItem } from "../mindmap/pdf-outline";
import { ensureGroupCard, type AutoCollectHost } from "../mindmap/auto-collect";
import { refreshActiveMindmaps } from "../mindmap/mindmap-view";
import { effectiveBranchStyle, suggestChildPosition } from "../mindmap/mindmap-graph";
import type { BranchStyle } from "../types";

/**
 * AI 大纲建框架弹窗（100 P4，MN4「AI 大纲」对齐）：当前阅读文档全文（带
 * [第 N 页] 标记，98 上下文体系复用）→ LLM 提炼层级大纲 → 页码硬校验
 * （必须命中标记页集合，编造降级 null 走损坏条目跳过路径）→
 * planOutlineChapters 生成建卡计划 → 预览 → 建入该书**摘录目标图**
 * （与目录建框架同语义：《书名》组卡下挂章节骨架卡，新摘录按页码归章）。
 * 建卡不进撤销栈（与目录建框架一致——建删卡不进栈取舍）。
 */
export class AiOutlineModal extends Modal {
	private closed = false;

	constructor(
		app: App,
		private readonly plugin: MarinMindPlugin,
		private readonly view: MarinMindReaderView,
	) {
		super(app);
	}

	onOpen(): void {
		this.titleEl.setText("AI 大纲建框架");
		void this.generate();
	}

	onClose(): void {
		this.closed = true;
	}

	/** 全文收集 → 大纲生成 → 计划 → 预览（非流式：JSON 整体解析） */
	private async generate(): Promise<void> {
		this.contentEl.createDiv({
			cls: "marinmind-ai-cardgen-loading",
			text: "正在收集文档内容…",
		});
		const ctx = await collectDocContext(this.view, "doc");
		if (this.closed || !this.contentEl.isConnected) {
			return;
		}
		if (!ctx || ctx.blocks.length === 0) {
			this.contentEl.empty();
			this.contentEl.createDiv({
				cls: "marinmind-ai-cardgen-loading",
				text: "当前文档没有可提取的文本内容。",
			});
			return;
		}
		const doc = this.plugin.documents.get(ctx.docId);
		if (!doc) {
			this.contentEl.empty();
			this.contentEl.createDiv({
				cls: "marinmind-ai-cardgen-loading",
				text: "文档记录缺失，无法建框架。",
			});
			return;
		}
		this.contentEl.empty();
		this.contentEl.createDiv({
			cls: "marinmind-ai-cardgen-loading",
			text: `正在提炼《${doc.title}》的层级大纲…`,
		});
		try {
			// 98 同款预算裁剪（块级：保头部 + 首块必留）；标记页集合取自完整块集
			const budget =
				typeof this.plugin.settings.aiMaxContextTokens === "number"
					? this.plugin.settings.aiMaxContextTokens
					: 24000;
			const clamped = clampToTokenBudget(ctx.blocks, budget);
			const validPages = new Set(ctx.blocks.map((b) => b.page));
			const raw = await sendChat(
				this.plugin.settings,
				buildOutlineMessages(buildContextText(clamped.blocks, ctx.kind)),
				{ onUsage: (usage: AiUsage) => this.plugin.addAiUsage(usage) },
			);
			if (this.closed || !this.contentEl.isConnected) {
				return;
			}
			const tree = parseOutlineTree(raw, validPages);
			const plan = planOutlineChapters(tree);
			this.renderPreview(doc.id, doc.title, tree, plan, clamped.truncated);
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
					void this.generate();
				});
		}
	}

	/** 大纲树预览（缩进层级 + 页码；无有效页码的条目标「页码未核对」且不入计划） */
	private renderPreview(
		documentId: string,
		docTitle: string,
		tree: OutlineGenNode[],
		plan: ChapterPlanItem[],
		truncated: boolean,
	): void {
		this.contentEl.empty();
		this.contentEl.addClass("marinmind-ai-cardgen");
		if (plan.length === 0) {
			this.contentEl.createDiv({
				cls: "marinmind-ai-cardgen-loading",
				text: "AI 给出的条目页码均无法与文中页标记核对，未生成框架（可重试）。",
			});
			return;
		}
		if (truncated) {
			this.contentEl.createDiv({
				cls: "marinmind-ai-cardgen-loading",
				text: "注意：文档超出上下文预算已截断，大纲基于前部分内容。",
			});
		}
		const listEl = this.contentEl.createDiv({ cls: "marinmind-ai-cardgen-list" });
		const walk = (nodes: OutlineGenNode[], depth: number): void => {
			for (const node of nodes) {
				const line = listEl.createDiv({ cls: "marinmind-ai-outline-row" });
				line.style.marginLeft = `${depth * 18}px`;
				line.createDiv({ cls: "marinmind-ai-outline-title", text: node.title });
				line.createDiv({
					cls: `marinmind-ai-outline-page${node.page == null ? " is-invalid" : ""}`,
					text: node.page == null ? "页码未核对" : `第 ${node.page} 页`,
				});
				walk(node.children, depth + 1);
			}
		};
		walk(tree, 0);
		const actions = this.contentEl.createDiv({ cls: "marinmind-tr-actions" });
		new ButtonComponent(actions).setButtonText("取消").onClick(() => this.close());
		new ButtonComponent(actions)
			.setButtonText(`创建 ${plan.length} 张章节卡`)
			.setCta()
			.onClick(() => void this.createFramework(documentId, docTitle, plan));
	}

	/**
	 * 建入摘录目标图（autoAddCard 同款定位：覆盖图存在性守卫 → 绑定文档同名图
	 * get-or-create），建卡语义与 mindmap-view.createOutlineCards 一致：
	 * ensureGroupCard 组卡 + 章节骨架卡（outline 标记，摘录归章 page 生效）按
	 * parentIndex 互挂；兄弟坐标逐父增量缓存（镜像 createOutlineCards——
	 * 每父首子贴父、后续子顺延，避免同层堆叠）。
	 */
	private async createFramework(
		documentId: string,
		docTitle: string,
		plan: ChapterPlanItem[],
	): Promise<void> {
		const host: AutoCollectHost = {
			documents: this.plugin.documents,
			cards: this.plugin.cards,
			mindmaps: this.plugin.mindmaps,
		};
		const map =
			resolveCollectMap(this.plugin, documentId) ??
			this.plugin.mindmaps.create(docTitle, documentId);
		// 防重：目标图已有该书框架即拒（同书可在另一图各建一份——与目录建框架一致）
		if (
			this.plugin.mindmaps
				.listNodes(map.id)
				.some((n) => n.card.outline && n.card.documentId === documentId)
		) {
			new Notice(`《${docTitle}》的摘录目标图已有目录/AI 框架`, 6000);
			return;
		}
		let created = 0;
		try {
			const groupNodeId = ensureGroupCard(host, map, { id: documentId, title: docTitle });
			if (!groupNodeId) {
				new Notice("无法确保分组节点，已中止", 6000);
				return;
			}
			const nodes0 = this.plugin.mindmaps.listNodes(map.id);
			const groupNode = nodes0.find((n) => n.id === groupNodeId);
			if (!groupNode) {
				new Notice("分组节点缺失，已中止", 6000);
				return;
			}
			const groupStyle = effectiveBranchStyle(nodes0, groupNodeId, map.defaultBranchStyle);
			// 兄弟坐标缓存：种子 = 既有根节点（组卡可能已挂直挂摘录），建卡增量追加
			const sibPts = new Map<string, { x: number; y: number }[]>();
			for (const n of nodes0) {
				if (n.parentId == null) {
					continue;
				}
				const arr = sibPts.get(n.parentId);
				if (arr) {
					arr.push({ x: n.x, y: n.y });
				} else {
					sibPts.set(n.parentId, [{ x: n.x, y: n.y }]);
				}
			}
			// 已建章节：新节点无样式覆盖，生效样式 = 父的生效样式（传递继承）
			const made: Array<{ id: string; x: number; y: number; style: BranchStyle }> = [];
			for (const item of plan) {
				const parent = item.parentIndex == null ? null : made[item.parentIndex];
				if (item.parentIndex != null && !parent) {
					continue; // 防御：父项建卡失败时子级跳过（正常流程不会发生）
				}
				const parentId = parent ? parent.id : groupNodeId;
				let sibs = sibPts.get(parentId);
				if (!sibs) {
					sibs = [];
					sibPts.set(parentId, sibs);
				}
				const pos = suggestChildPosition(
					parent ? { x: parent.x, y: parent.y } : { x: groupNode.x, y: groupNode.y },
					sibs,
					parent ? parent.style : groupStyle,
				);
				const card = this.plugin.cards.create({
					documentId,
					page: item.page,
					rects: [],
					excerptType: "text",
					excerptText: item.title,
					title: item.title,
					outline: true,
				});
				const node = this.plugin.mindmaps.addNode(
					map.id,
					card.id,
					parentId,
					Math.round(pos.x),
					Math.round(pos.y),
				);
				if (!node) {
					continue;
				}
				made.push({
					id: node.id,
					x: node.x,
					y: node.y,
					style: parent ? parent.style : groupStyle,
				});
				sibs.push({ x: node.x, y: node.y });
				created++;
			}
		} catch (err) {
			console.error("[MarinMind] AI 大纲框架创建中断", err);
		}
		this.close();
		refreshActiveMindmaps(map.id);
		new Notice(
			created > 0
				? `已创建 ${created} 张章节骨架卡（《${docTitle}》摘录目标图），本书新摘录将按页码归入对应章节`
				: "框架创建失败（未建任何章节卡）",
			6000,
		);
	}
}

/** 摘录目标图定位（autoAddCard 第 2 级同款：覆盖图存在性守卫 → 绑定文档同名图） */
function resolveCollectMap(
	plugin: MarinMindPlugin,
	documentId: string,
): ReturnType<MarinMindPlugin["mindmaps"]["get"]> {
	const doc = plugin.documents.get(documentId);
	if (!doc) {
		return undefined;
	}
	if (doc.collectMapId) {
		const map = plugin.mindmaps.get(doc.collectMapId);
		if (map) {
			return map;
		}
	}
	return plugin.mindmaps.findByDocument(documentId) ?? undefined;
}
