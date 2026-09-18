import { ButtonComponent, Modal, Notice } from "obsidian";
import type { App } from "obsidian";
import { cropScreenRegion, waitForImage } from "./image-crop";
import {
	MIN_SELECT,
	fitSize,
	moveSelRect,
	physicalCropRect,
	pickActiveScreen,
	resizeFromAnchor,
	writePngToClipboard,
	type CapturedScreen,
	type SelRect,
} from "./screen-capture";

/**
 * 截图裁剪弹窗（114）：全屏位图铺满弹窗，四块遮罩夹出选区洞（微信式，比
 * box-shadow 稳）+ 虚线选框 + 四角柄 + 物理像素尺寸标签。
 * 118 起降级为覆盖窗直选（screen-select）不可用时的兜底路径。
 * 交互（Pointer Events，frame 上 setPointerCapture 统一收流）：
 * - 遮罩/空白处按下拖动 → 以按下点为锚新选（新选与角柄缩放同用 resizeFromAnchor）；
 * - 框内按下拖动 → 整体移动（moveSelRect 钳制在画面内）；
 * - 角柄按下拖动 → 对角为锚缩放；最小选区 8×8，松手后微小框视为误触清空。
 * 键盘：Enter 确认复制；Esc 取消（Modal 自带，关闭即弃——只在显式确认时写剪贴板）。
 * 确认 → cropScreenRegion 物理像素裁剪（118 抽出共用，比例用实测
 * natural/client）→ PNG 写系统剪贴板，全程不落任何文件；在阅读器内
 * Ctrl+V 即走现有粘贴通道成图片卡。多屏时底部工具条切换屏幕（切换重置选区）。
 */

/** 绝对定位矩形单点赋值 */
function place(el: HTMLElement, x: number, y: number, w: number, h: number): void {
	el.setCssStyles({ left: `${x}px` });
	el.setCssStyles({ top: `${y}px` });
	el.setCssStyles({ width: `${w}px` });
	el.setCssStyles({ height: `${h}px` });
}

export class ScreenshotCropModal extends Modal {
	/** 当前展示的屏幕下标（多屏切换） */
	private active: number;
	/** 选区（frame 显示坐标；null = 无选区，遮罩铺满） */
	private sel: SelRect | null = null;
	/** 拖拽会话：锚点式（新选/缩放）或平移式（移动） */
	private drag:
		| { anchorX: number; anchorY: number }
		| { startX: number; startY: number; origin: SelRect }
		| null = null;
	private busy = false;
	/** 图片显示尺寸（contain 适配后，遮罩/选区坐标基准） */
	private dispW = 0;
	private dispH = 0;

	private frameEl!: HTMLElement;
	private imgEl!: HTMLImageElement;
	private masks: HTMLElement[] = [];
	private boxEl!: HTMLElement;
	private sizeEl!: HTMLElement;
	private confirmBtn!: ButtonComponent;
	private screenBtns: ButtonComponent[] = [];

	constructor(
		app: App,
		private readonly screens: CapturedScreen[],
	) {
		super(app);
		this.active = pickActiveScreen(screens);
	}

	onOpen(): void {
		this.modalEl.addClass("marinmind-crop-modal");
		// 全屏裁剪不需要标题行
		this.titleEl.hide();

		// 画面区：stage（flex 居中）> frame（与图等大的坐标基准层）
		const stage = this.contentEl.createDiv({ cls: "marinmind-crop-stage" });
		this.frameEl = stage.createDiv({ cls: "marinmind-crop-frame" });
		this.imgEl = this.frameEl.createEl("img", {
			cls: "marinmind-crop-img",
			attr: { alt: "", draggable: "false" },
		});
		this.masks = ["top", "bottom", "left", "right"].map(() =>
			this.frameEl.createDiv({ cls: "marinmind-crop-mask" }),
		);
		this.boxEl = this.frameEl.createDiv({ cls: "marinmind-crop-box" });
		for (const corner of ["nw", "ne", "sw", "se"] as const) {
			this.boxEl.createDiv({
				cls: `marinmind-crop-handle marinmind-crop-handle-${corner}`,
				attr: { "data-corner": corner },
			});
		}
		this.sizeEl = this.boxEl.createDiv({ cls: "marinmind-crop-size" });

		// 工具条：多屏切换 / 提示 / 取消 / 确认
		const bar = this.contentEl.createDiv({ cls: "marinmind-crop-toolbar" });
		if (this.screens.length > 1) {
			const group = bar.createDiv({ cls: "marinmind-crop-screens" });
			this.screens.forEach((screen, i) => {
				const btn = new ButtonComponent(group)
					.setButtonText(screen.label || `屏幕 ${i + 1}`)
					.onClick(() => void this.setActive(i));
				btn.buttonEl.addClass("marinmind-crop-screen-btn");
				btn.buttonEl.toggleClass("is-active", i === this.active);
				this.screenBtns.push(btn);
			});
		}
		bar.createDiv({ cls: "marinmind-crop-tip" }).setText("拖动选择区域，Enter 复制，Esc 取消");
		new ButtonComponent(bar).setButtonText("取消").onClick(() => this.close());
		this.confirmBtn = new ButtonComponent(bar)
			.setButtonText("复制截图")
			.setCta()
			.setDisabled(true)
			.onClick(() => void this.confirm());

		// Enter 确认（Modal scope 键位只在本弹窗存活期内生效）
		this.scope.register([], "Enter", (evt) => {
			evt.preventDefault();
			void this.confirm();
		});

		// Pointer 流统一收在 frame（capture 后移出画面也能持续收到 move/up）
		this.frameEl.addEventListener("pointerdown", (evt) => this.onPointerDown(evt));
		this.frameEl.addEventListener("pointermove", (evt) => this.onPointerMove(evt));
		this.frameEl.addEventListener("pointerup", (evt) => this.onPointerUp(evt));
		this.frameEl.addEventListener("pointercancel", (evt) => this.onPointerUp(evt));

		void this.loadScreen();
	}

	/** 载入当前屏位图并按 contain 适配定 frame 尺寸（重置选区） */
	private async loadScreen(): Promise<void> {
		const screen = this.screens[this.active];
		if (!screen) {
			return;
		}
		await waitForImage(this.imgEl, screen.dataUrl);
		if (!this.frameEl.isConnected) {
			return; // 弹窗已关，丢弃过期布局
		}
		const stage = this.frameEl.parentElement;
		const naturalW = this.imgEl.naturalWidth || screen.width;
		const naturalH = this.imgEl.naturalHeight || screen.height;
		const fit = fitSize(naturalW, naturalH, stage?.clientWidth ?? 0, stage?.clientHeight ?? 0);
		this.dispW = fit.width;
		this.dispH = fit.height;
		this.frameEl.setCssStyles({ width: `${this.dispW}px` });
		this.frameEl.setCssStyles({ height: `${this.dispH}px` });
		this.renderSelection();
	}

	/** 切屏（多屏工具条）：换图重适配并清空选区 */
	private async setActive(index: number): Promise<void> {
		if (this.busy || index === this.active || !this.screens[index]) {
			return;
		}
		this.active = index;
		this.sel = null;
		this.drag = null;
		for (const [i, btn] of this.screenBtns.entries()) {
			btn.buttonEl.toggleClass("is-active", i === index);
		}
		await this.loadScreen();
	}

	private onPointerDown(evt: PointerEvent): void {
		if (this.busy || evt.button !== 0 || this.dispW === 0) {
			return;
		}
		const rect = this.frameEl.getBoundingClientRect();
		const x = evt.clientX - rect.left;
		const y = evt.clientY - rect.top;
		const corner = (evt.target as HTMLElement).dataset?.corner;
		const sel = this.sel;
		if (corner && sel) {
			// 角柄：对角为锚（拖西柄锚在东缘，拖北柄锚在南缘）
			this.drag = {
				anchorX: corner === "nw" || corner === "sw" ? sel.x + sel.w : sel.x,
				anchorY: corner === "nw" || corner === "ne" ? sel.y + sel.h : sel.y,
			};
		} else if (sel && x >= sel.x && x <= sel.x + sel.w && y >= sel.y && y <= sel.y + sel.h) {
			this.drag = { startX: x, startY: y, origin: { ...sel } };
		} else {
			// 空白处：以按下点为锚起新框（与角柄缩放共用同一锚点函数）
			this.drag = { anchorX: x, anchorY: y };
			this.sel = { x, y, w: 0, h: 0 };
		}
		this.frameEl.setPointerCapture(evt.pointerId);
		evt.preventDefault();
		this.renderSelection();
	}

	private onPointerMove(evt: PointerEvent): void {
		if (!this.drag) {
			return;
		}
		const rect = this.frameEl.getBoundingClientRect();
		const x = evt.clientX - rect.left;
		const y = evt.clientY - rect.top;
		if ("anchorX" in this.drag) {
			this.sel = resizeFromAnchor(
				this.drag.anchorX,
				this.drag.anchorY,
				x,
				y,
				this.dispW,
				this.dispH,
				MIN_SELECT,
			);
		} else {
			this.sel = moveSelRect(
				this.drag.origin,
				x - this.drag.startX,
				y - this.drag.startY,
				this.dispW,
				this.dispH,
			);
		}
		this.renderSelection();
	}

	private onPointerUp(evt: PointerEvent): void {
		if (!this.drag) {
			return;
		}
		this.drag = null;
		if (this.frameEl.hasPointerCapture(evt.pointerId)) {
			this.frameEl.releasePointerCapture(evt.pointerId);
		}
		// 微小框（点一下没拖）视为误触清空
		if (this.sel && (this.sel.w < MIN_SELECT || this.sel.h < MIN_SELECT)) {
			this.sel = null;
		}
		this.renderSelection();
	}

	/** 渲染遮罩四块 + 选框 + 尺寸标签 + 确认按钮可用态 */
	private renderSelection(): void {
		const sel = this.sel;
		const [top, bottom, left, right] = this.masks;
		if (!sel) {
			// 无选区：整画面暗化（顶块铺满）、其余遮罩与选框隐藏
			place(top, 0, 0, this.dispW, this.dispH);
			place(bottom, 0, 0, 0, 0);
			place(left, 0, 0, 0, 0);
			place(right, 0, 0, 0, 0);
			this.boxEl.setCssStyles({ display: "none" });
			this.confirmBtn?.setDisabled(true);
			return;
		}
		place(top, 0, 0, this.dispW, sel.y);
		place(bottom, 0, sel.y + sel.h, this.dispW, this.dispH - sel.y - sel.h);
		place(left, 0, sel.y, sel.x, sel.h);
		place(right, sel.x + sel.w, sel.y, this.dispW - sel.x - sel.w, sel.h);
		this.boxEl.setCssStyles({ display: "block" });
		place(this.boxEl, sel.x, sel.y, sel.w, sel.h);
		// 尺寸标签取物理像素口径（与最终剪贴板内容一致）
		const phys = physicalCropRect(
			sel,
			this.dispW,
			this.dispH,
			this.imgEl.naturalWidth || 1,
			this.imgEl.naturalHeight || 1,
		);
		this.sizeEl.setText(`${phys.sw} × ${phys.sh}`);
		this.confirmBtn?.setDisabled(false);
	}

	/** 确认：物理像素裁剪（共用 image-crop）→ PNG 写剪贴板（不落盘）→ 关闭并提示可粘贴成卡 */
	private async confirm(): Promise<void> {
		if (this.busy || !this.sel) {
			return;
		}
		const screen = this.screens[this.active];
		if (!screen) {
			return;
		}
		this.busy = true;
		this.confirmBtn.setDisabled(true).setButtonText("复制中…");
		try {
			const crop = await cropScreenRegion(screen, this.sel, this.dispW, this.dispH);
			if (!crop) {
				throw new Error("PNG 编码失败（环境异常）");
			}
			const ok = await writePngToClipboard(crop.blob, crop.dataUrl);
			if (!ok) {
				throw new Error("写入剪贴板失败（浏览器与系统通道均不可用）");
			}
			this.close();
			new Notice("截图已复制到剪贴板；在阅读器中按 Ctrl+V 可保存为图片卡", 5000);
		} catch (err) {
			new Notice(err instanceof Error ? err.message : String(err), 5000);
			console.error("[MarinMind] 截图复制失败", err);
			this.busy = false;
			if (this.confirmBtn?.buttonEl.isConnected) {
				this.confirmBtn.setDisabled(false).setButtonText("复制截图");
			}
		}
	}
}
