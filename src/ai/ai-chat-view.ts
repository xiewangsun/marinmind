import { ItemView, Notice, setIcon } from "obsidian";
import type { WorkspaceLeaf } from "obsidian";
import type MarinMindPlugin from "../main";
import { MarinMindReaderView, READER_VIEW_TYPE } from "../reader/reader-view";
import { buildChatMessages, type ChatTurn } from "./ai-prompts";
import {
	aiPageLabel,
	buildContextText,
	clampToTokenBudget,
	extractPageRefs,
	type AiContextScope,
} from "./ai-context";
import { collectDocContext } from "./ai-context-service";
import { sendChat } from "./ai-service";

/** AI 助手对话视图的 viewType（右停靠侧栏叶） */
export const AI_CHAT_VIEW_TYPE = "marinmind-ai-chat";

/**
 * AI 助手对话面板（98 P2，MN4「AI 阅读/研究助手」对齐）：基于当前阅读文档
 * 的问答——上下文范围两档（当前页/全文，每次发送时现收集，文档切换自动
 * 跟随），多轮对话（历史裁剪近 8 轮），流式回复；回答中的「（第 N 页）」
 * 提取为跳页 chip，点击经 reader.revealPage 定位。obsidian 耦合不单测
 * （镜像 reader/review 视图分层先例）；上下文纯逻辑在 ai-context（vitest 覆盖）。
 */
export class AiChatView extends ItemView {
	private readonly plugin: MarinMindPlugin;
	/** 对话历史（内存态：视图关闭即弃；system 与上下文每次发送现拼） */
	private turns: ChatTurn[] = [];
	private ctxScope: AiContextScope = "page";
	/** 本次发送绑定的文档（chip 跳页时校验仍在同一文档，换文档 chip 失效） */
	private chatDocId: string | null = null;
	private chatKind: "pdf" | "epub" | "md" = "pdf";
	private listEl!: HTMLElement;
	private inputEl!: HTMLTextAreaElement;
	private sendBtn!: HTMLButtonElement;
	private abort: AbortController | null = null;
	private busy = false;

	constructor(leaf: WorkspaceLeaf, plugin: MarinMindPlugin) {
		super(leaf);
		this.plugin = plugin;
	}

	getViewType(): string {
		return AI_CHAT_VIEW_TYPE;
	}

	getDisplayText(): string {
		return "AI 助手";
	}

	getIcon(): string {
		return "sparkles";
	}

	async onOpen(): Promise<void> {
		this.contentEl.empty();
		this.contentEl.addClass("marinmind-ai-chat");

		// 头部：范围下拉 + 重置对话
		const head = this.contentEl.createDiv({ cls: "marinmind-ai-chat-head" });
		const scopeEl = head.createEl("select", {
			cls: "marinmind-ai-chat-scope",
			attr: { "aria-label": "上下文范围" },
		});
		scopeEl.createEl("option", { text: "当前页为上下文" }).value = "page";
		scopeEl.createEl("option", { text: "全文为上下文" }).value = "doc";
		scopeEl.value = this.ctxScope;
		scopeEl.addEventListener("change", () => {
			this.ctxScope = scopeEl.value === "doc" ? "doc" : "page";
		});
		const reset = head.createEl("button", {
			cls: "clickable-icon",
			attr: { "aria-label": "重置对话" },
		});
		setIcon(reset, "rotate-ccw");
		reset.addEventListener("click", () => {
			this.abort?.abort();
			this.turns = [];
			this.busy = false;
			this.sendBtn.disabled = false;
			this.renderEmpty();
			new Notice("对话已重置");
		});

		// 消息列表 + 空态引导
		this.listEl = this.contentEl.createDiv({ cls: "marinmind-ai-chat-list" });
		this.renderEmpty();

		// 输入区：多行输入 + 发送（Enter 发送 / Shift+Enter 换行）
		const foot = this.contentEl.createDiv({ cls: "marinmind-ai-chat-foot" });
		this.inputEl = foot.createEl("textarea", {
			cls: "marinmind-ai-chat-input",
			attr: {
				placeholder: "问当前文档的问题…（Enter 发送，Shift+Enter 换行）",
				rows: "2",
			},
		});
		this.inputEl.addEventListener("keydown", (evt) => {
			if (evt.key === "Enter" && !evt.shiftKey && !evt.isComposing) {
				evt.preventDefault();
				void this.send();
			}
		});
		this.sendBtn = foot.createEl("button", {
			cls: "marinmind-ai-chat-send",
			text: "发送",
			attr: { type: "button" },
		});
		this.sendBtn.addEventListener("click", () => void this.send());
	}

	async onClose(): Promise<void> {
		this.abort?.abort(); // 关面板即断在途流（省 token）
	}

	/** 激活阅读视图（镜像 main.activeReaderDocId 的取叶策略：激活优先回退首个） */
	private activeReader(): MarinMindReaderView | null {
		const leaves = this.app.workspace.getLeavesOfType(READER_VIEW_TYPE);
		const leaf = leaves.find((l) => l === this.app.workspace.activeLeaf) ?? leaves[0];
		return leaf?.view instanceof MarinMindReaderView ? leaf.view : null;
	}

	private renderEmpty(): void {
		this.listEl.empty();
		this.listEl.createDiv({
			cls: "marinmind-ai-chat-empty",
			text: "基于当前文档问答：先在阅读器打开文档，选择上下文范围（当前页 / 全文），然后提问。回答中的「第 N 页」可点击跳转。",
		});
	}

	/** 追加一条消息气泡，返回内容容器（流式增量写 content） */
	private appendBubble(role: "user" | "assistant"): HTMLElement {
		if (this.listEl.querySelector(".marinmind-ai-chat-empty")) {
			this.listEl.empty(); // 首条消息清空态引导
		}
		const msg = this.listEl.createDiv({ cls: `marinmind-ai-chat-msg is-${role}` });
		return msg.createDiv({ cls: "marinmind-ai-chat-bubble" });
	}

	/** 发送：现收集上下文 → 多轮拼装 → 流式渲染 → 页引用 chip */
	private async send(): Promise<void> {
		if (this.busy) {
			return;
		}
		const question = this.inputEl.value.trim();
		if (!question) {
			return;
		}
		const reader = this.activeReader();
		if (!reader) {
			new Notice("请先在阅读器打开文档");
			return;
		}
		let contextText: string;
		try {
			const ctx = await collectDocContext(reader, this.ctxScope);
			if (!ctx || ctx.blocks.length === 0) {
				new Notice("当前文档没有可提取的文本");
				return;
			}
			this.chatDocId = ctx.docId;
			this.chatKind = ctx.kind;
			// 预算裁剪（保头部）+ 截断明示进上下文（AI 可告知用户内容不全）
			const clamped = clampToTokenBudget(ctx.blocks, this.plugin.settings.aiMaxContextTokens);
			contextText = buildContextText(clamped.blocks, ctx.kind);
			if (clamped.truncated) {
				contextText += "\n\n（说明：文档内容超出 token 预算，以上为从头截取的部分）";
			}
		} catch (err) {
			console.error("[MarinMind] AI 上下文收集失败", err);
			new Notice("提取文档文本失败，请重试");
			return;
		}

		this.busy = true;
		this.sendBtn.disabled = true;
		this.inputEl.value = "";
		const userBubble = this.appendBubble("user");
		userBubble.setText(question);
		const bubble = this.appendBubble("assistant");
		bubble.addClass("is-loading");
		bubble.setText("思考中…");

		this.abort = new AbortController();
		let reply = "";
		try {
			reply = await sendChat(
				this.plugin.settings,
				buildChatMessages(this.turns, contextText, question),
				{
					signal: this.abort.signal,
					onDelta: (delta) => {
						if (!bubble.isConnected) {
							return;
						}
						reply += delta;
						bubble.setText(reply);
						this.listEl.scrollTop = this.listEl.scrollHeight;
					},
					onDegraded: () => new Notice("当前网络不支持流式输出，已切换整包返回"),
					onUsage: (usage) => this.plugin.addAiUsage(usage),
				},
			);
			if (reply.trim()) {
				this.turns.push(
					{ role: "user", content: question },
					{ role: "assistant", content: reply },
				);
				this.renderPageChips(bubble, reply);
			} else {
				bubble.setText("（AI 返回内容为空，请重试或更换模型）");
			}
		} catch (err) {
			if (err instanceof DOMException && err.name === "AbortError") {
				// 重置对话中断流：气泡已由 renderEmpty 清除
				if (bubble.isConnected && !reply.trim()) {
					bubble.setText("（已停止）");
				}
			} else {
				const message = err instanceof Error ? err.message : String(err);
				bubble.setText(`出错了：${message}`);
				bubble.addClass("marinmind-ai-chat-error");
			}
		} finally {
			bubble.removeClass("is-loading");
			this.busy = false;
			this.sendBtn.disabled = false;
			this.abort = null;
		}
	}

	/** 页引用 chip 行（98）：提取（第 N 页）→ 可点跳页（点击时刻现找阅读器并校验同文档） */
	private renderPageChips(bubble: HTMLElement, reply: string): void {
		const refs = extractPageRefs(reply);
		if (refs.length === 0) {
			return;
		}
		const chips = bubble.createDiv({ cls: "marinmind-ai-chat-chips" });
		for (const n of refs.slice(0, 8)) {
			const chip = chips.createEl("button", {
				cls: "marinmind-ai-chat-chip",
				text: aiPageLabel(this.chatKind, n),
				attr: { type: "button" },
			});
			chip.addEventListener("click", () => {
				const reader = this.activeReader();
				if (!reader || reader.docId !== this.chatDocId) {
					new Notice("原文文档未打开，无法跳转");
					return;
				}
				void reader.revealPage(n);
			});
		}
		this.listEl.scrollTop = this.listEl.scrollHeight;
	}
}
