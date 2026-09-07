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
import { resolveAiPreset, webSearchKind, type WebSource } from "./ai-provider";
import { setIconSafe } from "../ui/icon-resolve";

/** AI 助手对话视图的 viewType（右停靠侧栏叶） */
export const AI_CHAT_VIEW_TYPE = "marinmind-ai-chat";

/**
 * AI 助手对话面板（98 P2，MN4「AI 阅读/研究助手」对齐）：基于当前阅读文档
 * 的问答——上下文范围两档（当前页/全文，每次发送时现收集，文档切换自动
 * 跟随），多轮对话（历史裁剪近 8 轮），流式回复；回答中的「（第 N 页）」
 * 提取为跳页 chip，点击经 reader.revealPage 定位。105 增联网叠加开关（🌐）：
 * 文档上下文照常携带，另注入模型厂商自带搜索（智谱 web_search 工具 /
 * OpenAI search-preview 的 web_search_options / Perplexity sonar 系零参数），
 * 来源提取为可点外链 chip。obsidian 耦合不单测（镜像 reader/review 视图分层
 * 先例）；上下文纯逻辑在 ai-context、联网识别/来源提取在 ai-provider（vitest 覆盖）。
 */
export class AiChatView extends ItemView {
	private readonly plugin: MarinMindPlugin;
	/** 对话历史（内存态：视图关闭即弃；system 与上下文每次发送现拼） */
	private turns: ChatTurn[] = [];
	private ctxScope: AiContextScope = "page";
	/** 本次发送绑定的文档（chip 跳页时校验仍在同一文档，换文档 chip 失效） */
	private chatDocId: string | null = null;
	private chatKind: "pdf" | "epub" | "md" | "clip" = "pdf";
	private listEl!: HTMLElement;
	private inputEl!: HTMLTextAreaElement;
	private webBtn!: HTMLButtonElement;
	private sendBtn!: HTMLButtonElement;
	private abort: AbortController | null = null;
	private busy = false;
	/** 联网搜索开关（105，内存态默认关；重置对话不清——模式开关而非对话状态）。
	 *  开启时文档上下文照常携带，另注入模型厂商的联网搜索能力（叠加语义） */
	private webOn = false;

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
		// 联网开关（105）：与文档上下文叠加；开启时刻现查当前预设支持度
		// （预设可能在设置里换过，不做一次性置灰避免过期态）
		this.webBtn = foot.createEl("button", {
			cls: "clickable-icon marinmind-ai-chat-web",
			attr: { type: "button", "aria-label": "联网搜索（文档内容 + 网络资料一起作上下文）" },
		});
		setIconSafe(this.webBtn, "globe", "search");
		this.webBtn.toggleClass("is-on", this.webOn);
		this.webBtn.addEventListener("click", () => this.toggleWeb());
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
			text: "基于当前文档问答：先在阅读器打开文档，选择上下文范围（当前页 / 全文），然后提问。回答中的「第 N 页」可点击跳转。点 🌐 可叠加联网搜索（需 GLM / gpt-4o-search-preview / sonar 系模型，联网可能产生额外费用，经中转站时搜索参数可能不被透传）。",
		});
	}

	/** 切换联网开关（105）：开启时现查当前预设能力——未配置/不支持则 Notice 引导且不点亮 */
	private toggleWeb(): void {
		if (!this.webOn) {
			try {
				const kind = webSearchKind(resolveAiPreset(this.plugin.settings));
				if (!kind) {
					new Notice(
						"当前模型不支持联网搜索：请到 设置 → AI 换用 GLM（glm-*）、gpt-4o-search-preview 或 sonar 系列模型",
					);
					return;
				}
			} catch (err) {
				// 未配置预设：resolveAiPreset 的中文引导直接透出
				new Notice(err instanceof Error ? err.message : String(err));
				return;
			}
		}
		this.webOn = !this.webOn;
		this.webBtn.toggleClass("is-on", this.webOn);
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
		// 联网二次校验（105）：开关开启后预设可能已被换掉，发送前再查一次
		if (this.webOn) {
			try {
				if (!webSearchKind(resolveAiPreset(this.plugin.settings))) {
					new Notice(
						"当前模型不支持联网搜索：请到 设置 → AI 换用 GLM（glm-*）、gpt-4o-search-preview 或 sonar 系列模型",
					);
					return;
				}
			} catch {
				// 未配置预设：落到下方 sendChat 的 resolveAiPreset 统一报错路径
			}
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
				buildChatMessages(this.turns, contextText, question, this.webOn),
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
					// 联网来源（105）：流式收尾/非流式整包各回调一次，与页 chip 同节奏
					...(this.webOn
						? {
								webSearch: true,
								onSources: (sources: WebSource[]) =>
									this.renderWebChips(bubble, sources),
							}
						: {}),
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

	/** 联网来源 chip 行（105）：镜像 renderPageChips——标题（无标题兜底 host）
	 *  可点开外部浏览器；前置 globe 小图标与页 chip 区分 */
	private renderWebChips(bubble: HTMLElement, sources: WebSource[]): void {
		if (!bubble.isConnected || sources.length === 0) {
			return;
		}
		// 防御：同气泡极小概率收到两次回调（流末 + 整包兜底）——先清旧行再建
		bubble.querySelector(".marinmind-ai-chat-webchips")?.remove();
		const chips = bubble.createDiv({
			cls: "marinmind-ai-chat-chips marinmind-ai-chat-webchips",
		});
		const mark = chips.createDiv({
			cls: "marinmind-ai-chat-webmark",
			attr: { "aria-label": "联网来源" },
		});
		setIconSafe(mark, "globe", "search");
		for (const s of sources.slice(0, 8)) {
			let label = s.title.trim();
			if (!label) {
				// perplexity citations 纯 URL 无标题：兜底显示 host
				try {
					label = new URL(s.url).host;
				} catch {
					label = s.url;
				}
			}
			const chip = chips.createEl("button", {
				cls: "marinmind-ai-chat-chip is-link",
				text: label,
				attr: { type: "button", title: s.url },
			});
			chip.addEventListener("click", () => window.open(s.url, "_blank"));
		}
		this.listEl.scrollTop = this.listEl.scrollHeight;
	}
}
