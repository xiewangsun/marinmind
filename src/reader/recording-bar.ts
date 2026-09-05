import type { App } from "obsidian";
import { downsamplePeaks, formatDurSec, type AudioRecorder } from "./audio-recorder";
import { ConfirmModal } from "../mindmap/confirm-modal";

/** 录音状态条配置（84-B）：宿主元素 + 数据源 + 保存/丢弃回调（84-C 起全局复用） */
export interface RecordingBarOpts {
	/** R3（W-10）：丢弃前二次确认需要（ConfirmModal 依赖宿主 app） */
	app: App;
	/** 挂载宿主：reader contentEl（阅读内录音）或 document.body（84-C 全局自由卡录音） */
	host: HTMLElement;
	/** 数据源：计时 elapsedMs + 波形 peaks */
	recorder: AudioRecorder;
	onSave(): void;
	onDiscard(): void;
}

/** 波形列步进（CSS 像素）：列宽 1px + 间隔 2px */
const WAVE_STEP_PX = 3;

/**
 * 录音状态条组件（84-B，自 reader-view showRecBar 抽出）：红点呼吸 + 滚动波形
 * + 计时 + 保存/丢弃。自含 250ms 刷新定时器，destroy 时清理；宿主负责互斥与
 * 保存流程（reader 内锚定当前文档页，全局锚定未归类）。
 */
export class RecordingBar {
	private readonly el: HTMLElement;
	private readonly timeEl: HTMLElement;
	private readonly canvas: HTMLCanvasElement;
	private timer: ReturnType<typeof setInterval> | null = null;

	constructor(private readonly opts: RecordingBarOpts) {
		this.el = opts.host.createDiv({ cls: "marinmind-rec-bar" });
		this.el.createSpan({ cls: "marinmind-rec-dot" });
		this.canvas = this.el.createEl("canvas", { cls: "marinmind-rec-wave" });
		this.timeEl = this.el.createSpan({ cls: "marinmind-rec-time" });
		const save = this.el.createEl("button", { text: "保存并建卡" });
		save.addEventListener("click", () => this.opts.onSave());
		const drop = this.el.createEl("button", { text: "丢弃" });
		// R3（W-10）：录音不可恢复，丢弃前二次确认（镜像媒体预览「重录」先例）
		drop.addEventListener("click", () => {
			new ConfirmModal(this.opts.app, "丢弃录音", "删除当前录音？此操作不可恢复。", () =>
				this.opts.onDiscard(),
			).open();
		});
		this.refresh();
		this.timer = setInterval(() => this.refresh(), 250);
	}

	destroy(): void {
		if (this.timer !== null) {
			clearInterval(this.timer);
			this.timer = null;
		}
		this.el.remove();
	}

	/** 刷新计时与波形（250ms 周期；构造时先同步刷一次避免空白帧） */
	private refresh(): void {
		this.timeEl.textContent = formatDurSec(Math.floor(this.opts.recorder.elapsedMs / 1000));
		this.drawWave();
	}

	/** 右对齐滚动柱状波形（最新在右）；无峰值数据时收起画布（降级纯计时） */
	private drawWave(): void {
		const peaks = this.opts.recorder.peaks;
		this.canvas.classList.toggle("is-silent", peaks.length === 0);
		if (peaks.length === 0) {
			return;
		}
		const cssW = this.canvas.clientWidth || 120;
		const cssH = this.canvas.clientHeight || 28;
		const dpr = Math.min(2, window.devicePixelRatio || 1);
		const needW = Math.round(cssW * dpr);
		const needH = Math.round(cssH * dpr);
		// 尺寸变化时重设（重设会清空画布，随后整幅重画正好）
		if (this.canvas.width !== needW || this.canvas.height !== needH) {
			this.canvas.width = needW;
			this.canvas.height = needH;
		}
		const ctx = this.canvas.getContext("2d");
		if (!ctx) {
			return;
		}
		ctx.clearRect(0, 0, needW, needH);
		const step = WAVE_STEP_PX * dpr;
		const values = downsamplePeaks(peaks, Math.max(1, Math.floor(cssW / WAVE_STEP_PX)));
		ctx.fillStyle = "#e93147"; // 与红点同色（canvas 不解析 CSS 变量，取同值）
		for (let i = 0; i < values.length; i++) {
			const x = needW - (values.length - i) * step;
			if (x < 0) {
				break;
			}
			const h = Math.max(2 * dpr, values[i] * needH);
			ctx.fillRect(x, (needH - h) / 2, Math.max(1, dpr), h);
		}
	}
}
