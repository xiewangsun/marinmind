import { ButtonComponent, Modal, Notice } from "obsidian";
import type { App } from "obsidian";
import type MarinMindPlugin from "../main";
import { domToMarkdown } from "./html-to-md";
import { fetchHtml, saveClipMarkdown } from "./webclip-service";
import { describeElement, injectBaseHref, resolveRegionElement } from "./region-resolve";

/**
 * 框选剪藏弹窗（116，obsidian 耦合层）：网页在 Modal 内 srcdoc iframe 预览，
 * 用户拖框/单击选区域 → 解析命中元素 → 确认后 domToMarkdown + saveClipMarkdown
 * 落盘（图片两遍法/压缩/冲突递增全复用自动模式管线）。
 *
 * - **srcdoc + sandbox="allow-same-origin"（无 allow-scripts）**：站点脚本不
 *   执行（无逃逸面），插件可访问 contentDocument 做命中解析；X-Frame-Options/
 *   CSP frame-ancestors 不约束 srcdoc（内容内联非远程帧），任意站点可预览；
 *   base target=_blank + 无 allow-popups → 预览态点链接被静默拦截，iframe
 *   不会被导航带离（带离后跨源 DOM 必不可访问）。
 * - **选择态**：覆盖层接管指针（crosshair + touch-action:none），iframe 滚动
 *   冻结——视口坐标 = 文档坐标，拖框矩形直接喂 resolveRegionElement。
 * - 已知限制：站点 JS 不执行——纯脚本渲染页预览同为空壳（与自动提取同限），
 *   静态内容站全部可用；所见即所得，彻底绕开「算法猜正文」。
 */
export class RegionClipModal extends Modal {
	/** iframe 文档内高亮类名（配套 outline 样式注入 iframe head） */
	private static readonly HIT_CLASS = "marinmind-region-hit";

	private iframe: HTMLIFrameElement | null = null;
	private overlay: HTMLElement | null = null;
	private selBox: HTMLElement | null = null;
	private labelEl: HTMLElement | null = null;
	private statusEl: HTMLElement | null = null;
	private hintEl: HTMLElement | null = null;
	private selectBtn: ButtonComponent | null = null;
	private confirmBtn: ButtonComponent | null = null;
	/** 当前命中目标（iframe 内元素；null = 未选） */
	private hitEl: Element | null = null;
	/** 是否处于框选态（覆盖层接管指针） */
	private selecting = false;
	private busy = false;
	private dragStart: { x: number; y: number } | null = null;

	constructor(
		app: App,
		private readonly plugin: MarinMindPlugin,
		private readonly url: string,
		private readonly opts: { titleOverride?: string; downloadImages: boolean },
	) {
		super(app);
	}

	onOpen(): void {
		this.titleEl.setText("框选剪藏网页区域");

		// R3（W-14 同款）：异步状态区播报
		this.statusEl = this.contentEl.createDiv({
			cls: "marinmind-clip-progress",
			attr: { "aria-live": "polite" },
		});

		const body = this.contentEl.createDiv({ cls: "marinmind-region-body" });
		const preview = body.createDiv({ cls: "marinmind-region-preview" });
		// sandbox 必须先于 srcdoc 设置（属性生效于文档创建时）
		this.iframe = preview.createEl("iframe", {
			cls: "marinmind-region-frame",
			attr: { sandbox: "allow-same-origin", title: "网页预览" },
		});
		this.overlay = preview.createDiv({ cls: "marinmind-region-overlay" });
		this.selBox = this.overlay.createDiv({ cls: "marinmind-region-sel" });
		this.labelEl = this.overlay.createDiv({ cls: "marinmind-region-label" });

		const toolbar = body.createDiv({ cls: "marinmind-region-toolbar" });
		this.selectBtn = new ButtonComponent(toolbar)
			.setButtonText("框选区域")
			.setDisabled(true)
			.onClick(() => this.toggleSelect());
		this.confirmBtn = new ButtonComponent(toolbar)
			.setButtonText("确认剪藏")
			.setCta()
			.setDisabled(true)
			.onClick(() => void this.confirm());
		this.hintEl = toolbar.createSpan({ cls: "marinmind-region-hint" });
		this.setHint("正在加载预览…");

		this.bindOverlay();
		void this.load();
	}

	/** 覆盖层指针交互：按下记起点 → 拖动画选框 → 抬起解析命中 */
	private bindOverlay(): void {
		const overlay = this.overlay!;
		overlay.addEventListener("pointerdown", (evt) => {
			if (!this.selecting || this.busy || !(evt.pointerId >= 0)) {
				return;
			}
			evt.preventDefault();
			const bounds = overlay.getBoundingClientRect();
			this.dragStart = { x: evt.clientX - bounds.left, y: evt.clientY - bounds.top };
			overlay.setPointerCapture(evt.pointerId);
		});
		overlay.addEventListener("pointermove", (evt) => {
			if (!this.dragStart || !this.selecting) {
				return;
			}
			const bounds = overlay.getBoundingClientRect();
			this.drawSelBox(this.dragStart, evt.clientX - bounds.left, evt.clientY - bounds.top);
		});
		overlay.addEventListener("pointerup", (evt) => {
			if (!this.dragStart || !this.selecting) {
				return;
			}
			const bounds = overlay.getBoundingClientRect();
			const rect = {
				x: Math.min(this.dragStart.x, evt.clientX - bounds.left),
				y: Math.min(this.dragStart.y, evt.clientY - bounds.top),
				w: Math.abs(evt.clientX - bounds.left - this.dragStart.x),
				h: Math.abs(evt.clientY - bounds.top - this.dragStart.y),
			};
			this.dragStart = null;
			try {
				overlay.releasePointerCapture(evt.pointerId);
			} catch {
				// 指针已不在覆盖层（罕见）：释放失败无碍，状态已复位
			}
			this.resolveSelection(rect);
		});
		// 指针取消（如窗口失焦）复位拖动，不留半截选框
		overlay.addEventListener("pointercancel", () => {
			this.dragStart = null;
		});
	}

	/** 抓取并装载预览（失败中文错误并保持弹窗可看错误信息） */
	private async load(): Promise<void> {
		this.showStatus("正在抓取网页…");
		try {
			const html = await fetchHtml(this.url);
			const iframe = this.iframe;
			if (!iframe?.isConnected) {
				return; // 弹窗已关
			}
			iframe.addEventListener(
				"load",
				() => {
					if (!this.selectBtn?.buttonEl.isConnected) {
						return;
					}
					this.showStatus("");
					this.selectBtn.setDisabled(false);
					this.setHint("浏览预览，点「框选区域」后拖框选范围（或单击直接选中元素）");
				},
				{ once: true },
			);
			iframe.srcdoc = injectBaseHref(html, this.url);
		} catch (err) {
			this.showError(err instanceof Error ? err.message : String(err));
			console.error("[MarinMind] 框选剪藏预览加载失败", err);
		}
	}

	/** 切换框选态：进入时清上次命中；退出交还滚动 */
	private toggleSelect(): void {
		if (this.busy) {
			return;
		}
		this.selecting = !this.selecting;
		this.overlay?.toggleClass("is-active", this.selecting);
		this.selectBtn?.setButtonText(this.selecting ? "退出框选" : "框选区域");
		if (this.selecting) {
			this.clearHit();
			this.setHint("在预览中拖框选区域，或单击直接选中元素（Esc 关闭弹窗）");
		} else {
			this.setHint("预览可自由滚动浏览");
		}
	}

	/** 画拖动中的选框（实时矩形，起点到当前点） */
	private drawSelBox(start: { x: number; y: number }, x: number, y: number): void {
		const sel = this.selBox;
		if (!sel) {
			return;
		}
		sel.addClass("is-active");
		sel.style.left = `${Math.min(start.x, x)}px`;
		sel.style.top = `${Math.min(start.y, y)}px`;
		sel.style.width = `${Math.abs(x - start.x)}px`;
		sel.style.height = `${Math.abs(y - start.y)}px`;
	}

	/** 拖框/单击矩形 → iframe 文档解析命中 → 高亮 + 标签 + 启用确认 */
	private resolveSelection(rect: { x: number; y: number; w: number; h: number }): void {
		const doc = this.iframe?.contentDocument;
		if (!doc) {
			this.showError("无法访问预览内容，请重试");
			return;
		}
		const target = resolveRegionElement(doc, rect);
		if (!target) {
			this.clearHit();
			this.setHint("该位置没有可选内容，请重新框选");
			return;
		}
		this.applyHit(doc, target);
	}

	/** 应用命中：高亮类 + 选框吸附目标矩形 + 标签 + 启用确认 */
	private applyHit(doc: Document, target: Element): void {
		this.clearHit();
		this.hitEl = target;
		target.classList.add(RegionClipModal.HIT_CLASS);
		// 高亮样式注入 iframe head（DOM 操作非脚本执行，sandbox 允许）
		if (!doc.getElementById("marinmind-region-style")) {
			const style = doc.createElement("style");
			style.id = "marinmind-region-style";
			style.textContent = `.${RegionClipModal.HIT_CLASS}{outline:3px solid #4d9fff;outline-offset:2px;}`;
			doc.head?.appendChild(style);
		}
		// 视口坐标 = 覆盖层坐标（1:1 对齐，选择期滚动冻结）
		const r = target.getBoundingClientRect();
		const sel = this.selBox;
		if (sel) {
			sel.addClass("is-active");
			sel.style.left = `${r.left}px`;
			sel.style.top = `${r.top}px`;
			sel.style.width = `${r.width}px`;
			sel.style.height = `${r.height}px`;
		}
		const label = this.labelEl;
		if (label) {
			label.addClass("is-active");
			label.setText(describeElement(target));
			label.style.left = `${Math.max(0, r.left)}px`;
			label.style.top = `${Math.max(0, r.top - 26)}px`;
		}
		this.confirmBtn?.setDisabled(false);
		this.setHint(`已选中 ${describeElement(target)}——可拖框重选，或点「确认剪藏」`);
	}

	/** 清除命中态（退出框选/重新选择时） */
	private clearHit(): void {
		this.hitEl?.classList.remove(RegionClipModal.HIT_CLASS);
		this.hitEl = null;
		this.selBox?.removeClass("is-active");
		this.labelEl?.removeClass("is-active");
		this.confirmBtn?.setDisabled(true);
	}

	/** 确认剪藏：选中元素 → md + 图片引用 → 共用下载落盘管线 */
	private async confirm(): Promise<void> {
		const target = this.hitEl;
		if (!target || this.busy) {
			return;
		}
		this.busy = true;
		this.confirmBtn?.setDisabled(true);
		this.selectBtn?.setDisabled(true);
		this.showStatus("正在转换所选区域…");
		try {
			const { markdown, images } = domToMarkdown(target, { baseUrl: this.url });
			if (!markdown.trim()) {
				this.showError("所选区域没有可保存的内容，请重新框选");
				return;
			}
			const outcome = await saveClipMarkdown(
				this.plugin,
				{ markdown, images, title: this.resolveTitle(), sourceUrl: this.url },
				{ downloadImages: this.opts.downloadImages, onStage: (m) => this.showStatus(m) },
			);
			this.close();
			const parts: string[] = [];
			if (outcome.imagesSaved > 0) {
				parts.push(`${outcome.imagesSaved} 张图片已本地化`);
			}
			const remote = outcome.imagesFallback + outcome.imagesDropped;
			if (remote > 0) {
				parts.push(`${remote} 张保留远程链接`);
			}
			const summary = parts.length > 0 ? `（${parts.join("，")}）` : "";
			new Notice(`已剪藏所选区域「${outcome.title}」${summary}`, 4000);
			await this.plugin.openClip(outcome.path);
		} catch (err) {
			this.showError(err instanceof Error ? err.message : String(err));
			console.error("[MarinMind] 框选剪藏失败", err);
		} finally {
			this.busy = false;
			if (this.selectBtn?.buttonEl.isConnected) {
				this.selectBtn.setDisabled(false);
			}
			if (this.confirmBtn?.buttonEl.isConnected && this.hitEl) {
				this.confirmBtn.setDisabled(false);
			}
		}
	}

	/** 标题回退链：手填 > 预览文档 <title> > 域名 > 兜底（镜像 clipWebpage） */
	private resolveTitle(): string {
		const manual = (this.opts.titleOverride ?? "").trim();
		if (manual) {
			return manual;
		}
		const docTitle = (this.iframe?.contentDocument?.title ?? "").trim();
		if (docTitle) {
			return docTitle;
		}
		try {
			return new URL(this.url).hostname.replace(/^www\./, "") || "网页剪藏";
		} catch {
			return "网页剪藏";
		}
	}

	private setHint(text: string): void {
		if (this.hintEl?.isConnected) {
			this.hintEl.setText(text);
		}
	}

	private showStatus(message: string): void {
		if (!this.statusEl?.isConnected) {
			return;
		}
		this.statusEl.setText(message);
		this.statusEl.removeClass("marinmind-clip-error");
	}

	private showError(message: string): void {
		if (!this.statusEl?.isConnected) {
			return;
		}
		this.statusEl.addClass("marinmind-clip-error");
		this.statusEl.setText(message);
	}
}
