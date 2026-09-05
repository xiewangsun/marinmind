import { Menu, setIcon } from "obsidian";
import type { DocRect, LineStyle } from "../types";
import { LINE_STYLES, LINE_STYLE_LABELS } from "../types";
import type { AiMenuAction } from "../ai/ai-prompts";
import { SELECTION_ACTION_LABELS } from "../ai/ai-prompts";
import type { AiCustomPrompt } from "../ai/ai-provider";
import { HIGHLIGHT_COLORS, LINE_STYLE_ICONS, type HighlightColorValue } from "./highlight-colors";
import { planSelectionToolbarPosition } from "./rect-utils";

/**
 * 划选快照（75）：show 时刻已归一化为**页相对坐标**——视口矩形随滚动失效，
 * 页相对坐标不会；按钮动作（建卡/书签页/译文留白锚点）在任何滚动位置都正确。
 */
export interface SelectionSnapshot {
	/** 选中文本（行序拼接，与旧直接建卡路径同源） */
	text: string;
	/** 归一化行矩形（单页；跨页选区在快照构建时已拦截，工具栏不弹） */
	rects: DocRect[];
	/** 选区归属页码 */
	page: number;
}

/** 工具栏动作回调（reader-view 注入；全部以点击时刻快照为参，收尾由工具栏统一做） */
export interface SelectionToolbarActions {
	/** 色点/摘录钮建卡：color 未传（摘录钮）= 当前文字工具色（调用方读设置，取值新鲜） */
	onExcerpt(snap: SelectionSnapshot, color?: HighlightColorValue): void;
	/** 线型菜单选择（77）：写设置持久化 + Notice；不建卡不收起（后续色点/摘录用新线型） */
	onPickLineStyle(style: LineStyle): void;
	onTranslate(snap: SelectionSnapshot): void;
	/** AI 菜单选择（97）：终态动作（弹窗承接），选区使命完成走 runAction 收尾 */
	onAiAction(snap: SelectionSnapshot, action: AiMenuAction): void;
	/** AI 制卡（99）：终态动作（预览弹窗承接），走 runAction 收尾 */
	onAiCardgen(snap: SelectionSnapshot): void;
	onCopy(text: string): void;
	onBookmark(snap: SelectionSnapshot): void;
	onSearch(text: string): void;
}

export interface SelectionToolbarOptions {
	/** 是否显示书签钮（md 文档书签停用，㊻-B） */
	showBookmark: boolean;
	/** 读当前线型（77）：菜单打开/刷新 title 时刻取值（镜像 onExcerpt 缺省色的「取值新鲜」模式） */
	currentLineStyle: () => LineStyle;
	/** 读自定义 AI 指令（97）：菜单打开时刻取值（设置弹窗里增删即时反映） */
	customAiPrompts: () => AiCustomPrompt[];
	actions: SelectionToolbarActions;
}

/**
 * 划选文字浮动工具栏（75，微信读书式）：text 工具划选松开后浮出——
 * 四色点一键摘录 + 摘录/线型（77 三选菜单）/翻译/AI 操作（97 菜单）/
 * 复制/书签/搜索。
 * obsidian/DOM 耦合不单测（镜像 md-document 分层先例）；定位纯函数
 * planSelectionToolbarPosition 在 rect-utils（vitest 覆盖）。
 */
export class SelectionToolbar {
	private readonly host: HTMLElement;
	private readonly currentLineStyle: () => LineStyle;
	private readonly customAiPrompts: () => AiCustomPrompt[];
	private readonly actions: SelectionToolbarActions;
	private readonly el: HTMLElement;
	private readonly lineBtn: HTMLElement;
	private readonly offHostPointerDown: () => void;
	private range: Range | null = null;
	private snap: SelectionSnapshot | null = null;
	private shown = false;
	/** 按钮点击链抑制旗标：工具栏内 pointerdown 置位，handleSelectionEnd 消费后
	 * 复位——按钮点击的 mouseup 会冒泡触发 handleSelectionEnd，靠它短路防重复快照重弹 */
	private suppressSelectionEnd = false;

	constructor(host: HTMLElement, opts: SelectionToolbarOptions) {
		this.host = host;
		this.currentLineStyle = opts.currentLineStyle;
		this.customAiPrompts = opts.customAiPrompts;
		this.actions = opts.actions;
		// 默认 visibility 隐藏（非 display:none）：offsetWidth/Height 可测 + 免费淡入
		this.el = host.createDiv({ cls: "marinmind-selection-toolbar" });

		// 四色点：点击以该色直接建 text 卡（最快捷路径，选色一步到位）
		for (const color of HIGHLIGHT_COLORS) {
			const dot = this.el.createEl("button", { cls: "marinmind-tool-color-dot" });
			dot.dataset.color = color.value;
			dot.setAttribute("aria-label", `${color.label}摘录`);
			dot.title = `${color.label}摘录`;
			dot.addEventListener("click", () =>
				this.runAction((snap) => this.actions.onExcerpt(snap, color.value)),
			);
		}
		this.el.createDiv({ cls: "marinmind-tool-sep" });

		// 摘录钮：以当前文字工具色建卡（color 缺省，调用方读设置）
		this.addButton("highlighter", "摘录", () =>
			this.runAction((snap) => this.actions.onExcerpt(snap)),
		);
		// 线型钮（77）：弹三选菜单（当前打勾）；选后菜单关、工具栏与选区保留——
		// 接下来的色点/摘录建卡即用新线型。刻意不走 runAction（不 hide 不清选区；
		// 色点动作消费 show 时刻的页相对快照，Menu 点击清掉原生选区无碍）
		this.lineBtn = this.el.createEl("button", { cls: "marinmind-selection-btn" });
		this.applyLineStyleUI();
		this.lineBtn.addEventListener("click", (evt) => {
			const menu = new Menu();
			for (const style of LINE_STYLES) {
				menu.addItem((item) =>
					item
						.setTitle(LINE_STYLE_LABELS[style])
						.setIcon(LINE_STYLE_ICONS[style])
						.setChecked(style === this.currentLineStyle())
						.onClick(() => {
							this.actions.onPickLineStyle(style);
							// R4 D1-02: 切换线型后移除旧激活态
							this.lineBtn.classList.remove("is-active");
							this.applyLineStyleUI();
						}),
				);
			}
			menu.showAtMouseEvent(evt);
		});
		this.addButton("languages", "翻译", () =>
			this.runAction((snap) => this.actions.onTranslate(snap)),
		);
		// AI 钮（97）：弹操作菜单（解释/总结/改写 + 自定义指令）；菜单项是终态
		// 动作（结果弹窗承接）——点击走 runAction（hide + 清选区）。菜单打开
		// 时刻读自定义指令（取值新鲜，设置增删即时反映）
		const aiBtn = this.el.createEl("button", { cls: "marinmind-selection-btn" });
		setIcon(aiBtn, "sparkles");
		aiBtn.setAttribute("aria-label", "AI 操作");
		aiBtn.title = "AI 操作";
		aiBtn.addEventListener("click", (evt) => {
			const menu = new Menu();
			for (const [kind, label] of Object.entries(SELECTION_ACTION_LABELS) as [
				keyof typeof SELECTION_ACTION_LABELS,
				string,
			][]) {
				menu.addItem((item) =>
					item
						.setTitle(label)
						.setIcon("sparkles")
						.onClick(() =>
							this.runAction((snap) => this.actions.onAiAction(snap, { kind })),
						),
				);
			}
			// AI 制卡（99）：划选材料 → QA/填空卡预览（终态动作，同走 runAction）
			menu.addItem((item) =>
				item
					.setTitle("AI 制卡…")
					.setIcon("list-checks")
					.onClick(() => this.runAction((snap) => this.actions.onAiCardgen(snap))),
			);
			const customs = this.customAiPrompts();
			if (customs.length > 0) {
				menu.addSeparator();
				for (const custom of customs) {
					menu.addItem((item) =>
						item
							.setTitle(custom.label)
							.setIcon("wand")
							.onClick(() =>
								this.runAction((snap) =>
									this.actions.onAiAction(snap, {
										kind: "custom",
										label: custom.label,
										prompt: custom.prompt,
									}),
								),
							),
					);
				}
			}
			menu.showAtMouseEvent(evt);
		});
		this.addButton("copy", "复制", () =>
			this.runAction((snap) => this.actions.onCopy(snap.text)),
		);
		if (opts.showBookmark) {
			this.addButton("bookmark-plus", "添加书签", () =>
				this.runAction((snap) => this.actions.onBookmark(snap)),
			);
		}
		this.addButton("search", "全局搜索", () =>
			this.runAction((snap) => this.actions.onSearch(snap.text)),
		);

		// 宿主捕获 pointerdown：外部起笔（新选区/点空白）即隐；栏内起笔置抑制旗标
		const onHostPointerDown = (evt: PointerEvent) => {
			if (this.el.contains(evt.target as Node)) {
				this.suppressSelectionEnd = true;
				return;
			}
			if (this.shown) {
				this.hide();
			}
		};
		host.addEventListener("pointerdown", onHostPointerDown, true);
		this.offHostPointerDown = () =>
			host.removeEventListener("pointerdown", onHostPointerDown, true);
	}

	/** 浮出：以活 range 现算定位（选区保持可见，reposition 用同一 range 跟随滚动） */
	show(range: Range, snap: SelectionSnapshot): void {
		this.range = range;
		this.snap = snap;
		if (!this.applyPosition()) {
			return; // 空矩形（理论不可达——show 前刚量过）：不显示
		}
		this.el.addClass("is-visible");
		this.shown = true;
	}

	/** 滚动跟随：活 range 现算新位置；页 unrender/节点移除致矩形为空时自动隐藏 */
	reposition(): void {
		if (!this.shown) {
			return;
		}
		this.applyPosition();
	}

	/** 隐藏（保留 DOM 复用；range/snap 保留——Esc 路径选区仍在可再次利用） */
	hide(): void {
		this.el.removeClass("is-visible");
		this.shown = false;
	}

	get visible(): boolean {
		return this.shown;
	}

	/** 刷新线型钮的图标与 title（选型后 reader 回调里调用；图标随当前线型三态切换） */
	syncLineStyle(): void {
		this.applyLineStyleUI();
	}

	/** 线型钮外观：图标随当前线型切换 + title/aria-label 显示线型名 + is-active 高亮 */
	private applyLineStyleUI(): void {
		const style = this.currentLineStyle();
		setIcon(this.lineBtn, LINE_STYLE_ICONS[style]);
		const label = `线型：${LINE_STYLE_LABELS[style]}`;
		this.lineBtn.setAttribute("aria-label", label);
		this.lineBtn.title = label;
		// R4 D1-02: 线型按钮加激活态视觉反馈
		this.lineBtn.classList.add("is-active");
	}

	/** 读 + 复位抑制旗标（handleSelectionEnd 消费：工具栏按钮点击链的 mouseup 短路） */
	takeSuppressSelectionEnd(): boolean {
		const value = this.suppressSelectionEnd;
		this.suppressSelectionEnd = false;
		return value;
	}

	/** 销毁（换文档/关视图）：移除宿主监听 + DOM */
	destroy(): void {
		this.offHostPointerDown();
		this.el.remove();
		this.shown = false;
		this.range = null;
		this.snap = null;
	}

	/** 动作统一收尾：执行回调 → 隐藏 → 清选区（选区使命已完成） */
	private runAction(fn: (snap: SelectionSnapshot) => void): void {
		const snap = this.snap;
		this.hide();
		window.getSelection()?.removeAllRanges();
		if (snap) {
			fn(snap);
		}
	}

	private addButton(icon: string, label: string, onClick: () => void): void {
		const btn = this.el.createEl("button", { cls: "marinmind-selection-btn" });
		setIcon(btn, icon);
		btn.setAttribute("aria-label", label);
		btn.title = label;
		btn.addEventListener("click", onClick);
	}

	/**
	 * 以活 range 的 client rects 并集定位工具栏（空矩形 → hide 返 false）；
	 * getClientRects 在页 unrender/节点移除时可能返回空或抛错，try/catch 兜住。
	 */
	private applyPosition(): boolean {
		const range = this.range;
		if (!range) {
			return false;
		}
		let union: { left: number; top: number; right: number; bottom: number } | null = null;
		try {
			for (const r of Array.from(range.getClientRects())) {
				if (r.width <= 0 || r.height <= 0) {
					continue; // getClientRects 可能产生零尺寸行
				}
				if (!union) {
					union = { left: r.left, top: r.top, right: r.right, bottom: r.bottom };
				} else {
					union.left = Math.min(union.left, r.left);
					union.top = Math.min(union.top, r.top);
					union.right = Math.max(union.right, r.right);
					union.bottom = Math.max(union.bottom, r.bottom);
				}
			}
		} catch {
			union = null; // 节点已移除等异常：按空选区处理
		}
		if (!union) {
			this.hide();
			return false;
		}
		const box = this.host.getBoundingClientRect();
		const pos = planSelectionToolbarPosition({
			anchor: union,
			container: { left: box.left, top: box.top, width: box.width, height: box.height },
			toolbarWidth: this.el.offsetWidth,
			toolbarHeight: this.el.offsetHeight,
		});
		this.el.style.left = `${pos.left}px`;
		this.el.style.top = `${pos.top}px`;
		return true;
	}
}
