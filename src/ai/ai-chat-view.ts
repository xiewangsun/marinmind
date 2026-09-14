import { ItemView, MarkdownRenderer, Notice, setIcon } from "obsidian";
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
import {
	buildWebContextText,
	resolveSearchCall,
	searchServiceReady,
	toWebSources,
	type SearchEngineCall,
} from "./web-search-engine";
import { runWebSearch } from "./web-search-service";
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
 * 来源提取为可点外链 chip。128 联网三态：厂商搜索（模型自带）→ 插件侧
 * RAG 后备（设置搜索服务后，普通模型先搜后拼【联网搜索资料】围栏；搜索
 * 失败 Notice 降级继续不联网）→ 都无才拦截（文案给双出路）。133 回复
 * 正文 markdown 化：MarkdownRenderer 流式节流重渲 + 完成终渲，游离暂存
 * 原子换装（135——渲染期间新旧正文不同屏）；136 弃 markdown-preview-view
 * 类改自绘排版（主题对该类的布局干扰致文字重叠），正文与 chips 分容器。
 * obsidian 耦合不单测（镜像 reader/review 视图分层先例）；上下文纯逻辑在
 * ai-context、联网识别/来源提取在 ai-provider、引擎层在 web-search-engine
 * （vitest 覆盖）。
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
			text: "基于当前文档问答：先在阅读器打开文档，选择上下文范围（当前页 / 全文），然后提问。回答中的「第 N 页」可点击跳转。点 🌐 可叠加联网搜索：模型自带搜索（GLM / gpt-4o-search-preview / sonar 系列，或 OpenRouter 模型名加 :online 后缀）直接用；普通模型可到 设置 → AI → 联网搜索服务 配置 Tavily / 博查 / SearXNG 后，插件先搜后拼资料作答（联网可能产生额外费用）。",
		});
	}

	/**
	 * 切换联网开关（128 三态）：开启时现查能力——厂商搜索（模型自带）或
	 * 插件侧搜索服务（RAG 后备）任一可用即点亮；都无则 Notice 给双出路
	 * （换模型 / 配置搜索服务）且不点亮。
	 */
	private toggleWeb(): void {
		if (!this.webOn) {
			let vendor: boolean;
			try {
				vendor = webSearchKind(resolveAiPreset(this.plugin.settings)) !== null;
			} catch (err) {
				// 未配置预设：AI 无从对话——resolveAiPreset 的中文引导直接透出
				new Notice(err instanceof Error ? err.message : String(err));
				return;
			}
			if (!vendor && !searchServiceReady(this.plugin.settings)) {
				new Notice(
					"联网需任选其一：到 设置 → AI 换用自带搜索的模型（GLM / gpt-4o-search-preview / sonar 系列，OpenRouter 模型名加 :online 后缀），或到 设置 → AI → 联网搜索服务 配置插件侧搜索（Tavily / 博查 / SearXNG）后用普通模型联网",
				);
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
		// 联网路径选择（105 厂商优先 / 128 RAG 后备）：开关开启后预设可能已被
		// 换掉，发送前现查——厂商搜索可用走注入；否则插件侧服务可用走 RAG；
		// 都无才拦截（双出路文案同 toggleWeb）
		let vendorWeb = false;
		let ragCall: SearchEngineCall | null = null;
		if (this.webOn) {
			try {
				vendorWeb = webSearchKind(resolveAiPreset(this.plugin.settings)) !== null;
			} catch {
				// 未配置预设：落到下方 sendChat 的 resolveAiPreset 统一报错路径
			}
			if (!vendorWeb) {
				try {
					ragCall = resolveSearchCall(this.plugin.settings);
				} catch (err) {
					// 选了服务但凭据没配全：明确告知并拦截（宁拒不赌——用户点名要联网）
					new Notice(err instanceof Error ? err.message : String(err));
					return;
				}
				if (!ragCall) {
					new Notice(
						"联网需任选其一：到 设置 → AI 换用自带搜索的模型（GLM / gpt-4o-search-preview / sonar 系列，OpenRouter 模型名加 :online 后缀），或到 设置 → AI → 联网搜索服务 配置插件侧搜索（Tavily / 博查 / SearXNG）后用普通模型联网",
					);
					return;
				}
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
		// 正文容器（133）：markdown 渲染进 body，页/来源 chip 挂 bubble 尾——
		// 重渲正文（原子换装清旧）不吞 chips，chips 后插也永远在正文之下
		const body = bubble.createDiv();
		body.setText("思考中…");

		this.abort = new AbortController();
		let reply = "";
		// 流式 markdown 渲染（133；135 重叠加固）：节流整段重渲（≥300ms 一轮；
		// 流中未成对 ** / 半截围栏由下一轮自然修复）。135 前新 host 渲染开始
		// 即入 DOM、完成才删旧——渲染期间新旧两份正文同屏堆叠（慢渲染/侧栏
		// 收起渲染挂起时持续可见），表现为文字重叠；改为**游离暂存 + 原子
		// 换装**：先在移出视口的隐藏容器渲染（镜像 md-outline-measure 量测
		// 先例），完成后 body.empty() 一步换入——任一时刻 body 只有一份内容。
		// 并发串行化：在途时新请求只标记补渲，完成后补一轮，防多轮渲染堆积
		let paintSeq = 0;
		let painting = false;
		let repaintDue = false;
		let lastPaintAt = 0;
		const paintMd = (): void => {
			if (painting) {
				repaintDue = true; // 在途：让路，完成后补渲最新内容
				return;
			}
			painting = true;
			const seq = ++paintSeq;
			// 136：不再挂 markdown-preview-view 类——部分主题对该类注入绝对
			// 定位等布局干扰，窄气泡内高度塌陷导致正文与 chips 同坐标互叠；
			// 排版全部由 .marinmind-ai-chat-md 自绘（styles.css）
			const staging = document.createElement("div");
			staging.className = "marinmind-ai-chat-md";
			staging.style.cssText =
				"position:fixed;left:-10000px;top:0;visibility:hidden;pointer-events:none;";
			document.body.appendChild(staging);
			MarkdownRenderer.render(this.app, reply, staging, "", this)
				.then(() => {
					if (seq !== paintSeq || !body.isConnected) {
						staging.remove(); // 过期（有更新一轮）/气泡已弃：丢弃
						return;
					}
					staging.style.cssText = "";
					body.empty();
					body.appendChild(staging); // 原子换装：清旧换新一步完成
					this.listEl.scrollTop = this.listEl.scrollHeight;
				})
				.catch(() => {
					staging.remove();
					// 渲染失败兜底：最新轮退回纯文本（内容不丢，仅无排版）
					if (seq === paintSeq && body.isConnected) {
						body.setText(reply);
					}
				})
				.finally(() => {
					painting = false;
					if (repaintDue) {
						repaintDue = false;
						paintMd();
					}
				});
			lastPaintAt = Date.now();
		};
		// RAG 后备（128）：普通模型先经插件侧搜索取资料（提问词即查询词）——
		// 失败 Notice 降级继续不联网作答（联网是增强不是依赖，同封面语义）
		let webContextText: string | undefined;
		let ragSources: WebSource[] | null = null;
		if (ragCall) {
			try {
				const results = await runWebSearch(question, ragCall);
				webContextText = buildWebContextText(results);
				ragSources = toWebSources(results);
			} catch (err) {
				console.error("[MarinMind] 联网搜索失败", err);
				new Notice(
					`联网搜索失败，已降级为不联网作答：${err instanceof Error ? err.message : String(err)}`,
				);
			}
		}
		try {
			reply = await sendChat(
				this.plugin.settings,
				buildChatMessages(
					this.turns,
					contextText,
					question,
					vendorWeb, // 厂商路径 system 用联网版文案；RAG 路径由 webContextText 触发同款
					webContextText,
				),
				{
					signal: this.abort.signal,
					onDelta: (delta) => {
						if (!bubble.isConnected) {
							return;
						}
						reply += delta;
						// 节流 markdown 重渲：间隔内只累计不渲染，下一轮补上
						if (Date.now() - lastPaintAt >= 300) {
							paintMd();
						}
					},
					onDegraded: () => new Notice("当前网络不支持流式输出，已切换整包返回"),
					onUsage: (usage) => this.plugin.addAiUsage(usage),
					// 厂商注入路径（105）：body 注入 + 来源回调；RAG 路径不传 webSearch
					// （普通模型零注入，资料已在 prompt 里），来源 chip 流完成后渲染
					...(vendorWeb
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
				paintMd(); // 终渲：节流窗口尾量 + 半截标记一轮成型
				if (ragSources) {
					this.renderWebChips(bubble, ragSources);
				}
				this.renderPageChips(bubble, reply);
			} else {
				bubble.setText("（AI 返回内容为空，请重试或更换模型）");
			}
		} catch (err) {
			if (err instanceof DOMException && err.name === "AbortError") {
				// 重置对话中断流：气泡已由 renderEmpty 清除
				if (bubble.isConnected && reply.trim()) {
					paintMd(); // 中止保部分：已到内容照样格式化成型
				} else if (bubble.isConnected) {
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

	/** 联网来源列表（105；134 下划线文字链；137 纵排一条一行）：标题（无标题
	 *  兜底 host）可点开外部浏览器；globe + 「来源」标头与正文分隔成引用区 */
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
		mark.createSpan({ text: "来源" });
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
