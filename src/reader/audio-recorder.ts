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
export function pickAudioMime(
	isTypeSupported?: (mime: string) => boolean,
): string | undefined {
	const check =
		isTypeSupported ??
		((mime: string) => MediaRecorder.isTypeSupported?.(mime) ?? false);
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

/** 录音结果：字节 + 扩展名 + 时长（时长仅供调用方展示/过滤用） */
export interface AudioRecording {
	bytes: ArrayBuffer;
	ext: string;
	durationMs: number;
}

/**
 * 麦克风录音封装：getUserMedia + MediaRecorder。
 * start 抛错（无权限/无设备）由调用方 Notice 降级；
 * stop 汇总 chunks 为单个 Blob；discard 丢弃录音并立即释放麦克风。
 */
export class AudioRecorder {
	private recorder: MediaRecorder | null = null;
	private stream: MediaStream | null = null;
	private chunks: Blob[] = [];
	private startedAt = 0;

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
		this.recorder.ondataavailable = (evt) => {
			if (evt.data && evt.data.size > 0) {
				this.chunks.push(evt.data);
			}
		};
		this.startedAt = Date.now();
		// timeslice：每秒吐一次数据，中途崩溃也最多丢 1s
		this.recorder.start(1000);
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
		for (const track of this.stream?.getTracks() ?? []) {
			track.stop();
		}
		this.stream = null;
		this.recorder = null;
		this.chunks = [];
	}
}
