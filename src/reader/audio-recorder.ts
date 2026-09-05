/** 录音编解码候选：Electron/Chromium 支持 webm；Safari/移动端走 mp4/ogg 回退 */
const MIME_CANDIDATES = [
	"audio/webm;codecs=opus",
	"audio/webm",
	"audio/mp4",
	"audio/ogg;codecs=opus",
];

/**
 * 选择当前环境支持的录音 MIME 类型（纯函数：isTypeSupported 可注入，便于测试回退链）。
 * 全部不支持返回 undefined（MediaRecorder 用默认编码）。
 */
export function pickAudioMime(isTypeSupported?: (mime: string) => boolean): string | undefined {
	const check =
		isTypeSupported ?? ((mime: string) => MediaRecorder.isTypeSupported?.(mime) ?? false);
	return MIME_CANDIDATES.find((m) => check(m));
}

/** MIME → 文件扩展名（不认识的按 webm 存，播放器按容器嗅探） */
function extFromMime(mime: string | undefined): string {
	if (mime?.includes("mp4")) {
		return "m4a";
	}
	if (mime?.includes("ogg")) {
		return "ogg";
	}
	return "webm";
}

/** 录音结果：字节 + 扩展名 + 时长（时长供调用方落库 durationSec / 展示） */
export interface AudioRecording {
	bytes: ArrayBuffer;
	ext: string;
	durationMs: number;
}

/** 波形采样间隔（84-B）：约 12.5 个峰值/秒——10 分钟录音仅 7500 个 number */
const PEAK_SAMPLE_MS = 80;

/**
 * Uint8 时间域样本 → 峰值振幅（0-1，84-B）：128 = 静音中线，
 * max(|v−128|)/128；静音返回 0、满幅接近 1。
 */
export function peakOfSamples(buf: Uint8Array): number {
	let peak = 0;
	for (let i = 0; i < buf.length; i++) {
		const v = Math.abs(buf[i] - 128) / 128;
		if (v > peak) {
			peak = v;
		}
	}
	return peak;
}

/**
 * 波形降采样（84-B）：源峰值序列按比例折进 bins 桶，每桶取最大值（视觉不丢峰）。
 * 源短于桶数时右对齐保留原值、左侧补 0（最新样本靠右，与波形条滚动方向一致）。
 */
export function downsamplePeaks(peaks: readonly number[], bins: number): number[] {
	if (bins <= 0 || peaks.length === 0) {
		return [];
	}
	const out = new Array<number>(bins).fill(0);
	if (peaks.length <= bins) {
		for (let i = 0; i < peaks.length; i++) {
			out[bins - peaks.length + i] = peaks[i];
		}
		return out;
	}
	for (let b = 0; b < bins; b++) {
		const start = Math.floor((b * peaks.length) / bins);
		const end = Math.max(start + 1, Math.floor(((b + 1) * peaks.length) / bins));
		let max = 0;
		for (let i = start; i < end && i < peaks.length; i++) {
			if (peaks[i] > max) {
				max = peaks[i];
			}
		}
		out[b] = max;
	}
	return out;
}

/** 毫秒时长 → 整秒（四舍五入，84-B 落库用：durationSec 字段） */
export function audioDurationSec(ms: number): number {
	return Math.round(ms / 1000);
}

/** 秒 → m:ss（84-B 媒体标签共用：录音条计时 / 语音卡时长标签） */
export function formatDurSec(sec: number): string {
	const s = Math.max(0, Math.floor(sec));
	return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

/**
 * 麦克风录音封装：getUserMedia + MediaRecorder（84-B 起附带波形采样）。
 * start 抛错（无权限/无设备）由调用方 Notice 降级；
 * stop 汇总 chunks 为单个 Blob；discard 丢弃录音并立即释放麦克风。
 */
export class AudioRecorder {
	private recorder: MediaRecorder | null = null;
	private stream: MediaStream | null = null;
	private chunks: Blob[] = [];
	private startedAt = 0;
	/** 84-B 会话级波形峰值序列（约 12.5 个/秒；不落库，仅录音条绘制用） */
	readonly peaks: number[] = [];
	private audioCtx: AudioContext | null = null;
	private analyser: AnalyserNode | null = null;
	// TS 5.7 泛型 TypedArray：getByteTimeDomainData 要求确切 ArrayBuffer 底层
	private sampleBuf: Uint8Array<ArrayBuffer> | null = null;
	private peakTimer: ReturnType<typeof setInterval> | null = null;

	get active(): boolean {
		return this.recorder !== null;
	}

	get elapsedMs(): number {
		return this.active ? Date.now() - this.startedAt : 0;
	}

	async start(): Promise<void> {
		if (this.active) {
			return;
		}
		this.stream = await navigator.mediaDevices.getUserMedia({ audio: true });
		const mime = pickAudioMime();
		this.recorder = mime
			? new MediaRecorder(this.stream, { mimeType: mime })
			: new MediaRecorder(this.stream);
		this.chunks = [];
		this.peaks.length = 0;
		this.recorder.ondataavailable = (evt) => {
			if (evt.data && evt.data.size > 0) {
				this.chunks.push(evt.data);
			}
		};
		this.startedAt = Date.now();
		// timeslice：每秒吐一次数据，中途崩溃也最多丢 1s
		this.recorder.start(1000);
		this.startPeakSampling();
	}

	/** 停止并取得录音（未在录音时抛错） */
	async stop(): Promise<AudioRecording> {
		const rec = this.recorder;
		if (!rec) {
			throw new Error("录音尚未开始");
		}
		const mime = rec.mimeType;
		const durationMs = this.elapsedMs;
		const stopped = new Promise<void>((resolve) => {
			rec.onstop = () => resolve();
		});
		rec.stop();
		await stopped;
		const blob = new Blob(this.chunks, { type: mime || "audio/webm" });
		this.release();
		return {
			bytes: await blob.arrayBuffer(),
			ext: extFromMime(mime),
			durationMs,
		};
	}

	/** 丢弃录音（幂等；立即释放麦克风） */
	discard(): void {
		if (this.recorder && this.recorder.state !== "inactive") {
			try {
				this.recorder.stop();
			} catch {
				// 状态异常时忽略（已 inactive 等）
			}
		}
		this.release();
	}

	/** 释放设备与内部状态 */
	private release(): void {
		if (this.peakTimer !== null) {
			clearInterval(this.peakTimer);
			this.peakTimer = null;
		}
		this.analyser = null;
		this.sampleBuf = null;
		if (this.audioCtx) {
			// close 返回 promise，失败静默（上下文可能已关闭）
			void this.audioCtx.close().catch(() => undefined);
			this.audioCtx = null;
		}
		for (const track of this.stream?.getTracks() ?? []) {
			track.stop();
		}
		this.stream = null;
		this.recorder = null;
		this.chunks = [];
	}

	/**
	 * 波形采样（84-B）：AudioContext + AnalyserNode 时间域峰值，PEAK_SAMPLE_MS 一个。
	 * analyser 不连 destination（只分析不回放，避免回授啸叫）；AudioContext 构造
	 * 失败（环境不支持/无手势）静默降级——peaks 恒空，录音条只显示计时。
	 */
	private startPeakSampling(): void {
		try {
			const Ctor =
				typeof AudioContext !== "undefined"
					? AudioContext
					: (
							window as unknown as {
								webkitAudioContext?: typeof AudioContext;
							}
						).webkitAudioContext;
			if (!Ctor || !this.stream) {
				return;
			}
			this.audioCtx = new Ctor();
			const source = this.audioCtx.createMediaStreamSource(this.stream);
			this.analyser = this.audioCtx.createAnalyser();
			this.analyser.fftSize = 2048;
			this.sampleBuf = new Uint8Array(this.analyser.fftSize);
			source.connect(this.analyser);
			this.peakTimer = setInterval(() => {
				const analyser = this.analyser;
				const buf = this.sampleBuf;
				if (!analyser || !buf) {
					return;
				}
				analyser.getByteTimeDomainData(buf);
				this.peaks.push(peakOfSamples(buf));
			}, PEAK_SAMPLE_MS);
		} catch (err) {
			console.debug("[MarinMind] 波形采样不可用，降级为纯计时", err);
		}
	}
}
