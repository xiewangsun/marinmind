import { describe, expect, it } from "vitest";
import {
	audioDurationSec,
	downsamplePeaks,
	formatDurSec,
	peakOfSamples,
	pickAudioMime,
} from "../../src/reader/audio-recorder";

describe("录音 MIME 选择 pickAudioMime", () => {
	it("优先返回第一个支持的候选（opus 编码的 webm）", () => {
		const mime = pickAudioMime(() => true);
		expect(mime).toBe("audio/webm;codecs=opus");
	});

	it("逐项回退：首选不支持时取次选", () => {
		const mime = pickAudioMime((m) => m === "audio/mp4");
		expect(mime).toBe("audio/mp4");
	});

	it("全部不支持返回 undefined（MediaRecorder 用默认编码）", () => {
		expect(pickAudioMime(() => false)).toBeUndefined();
	});

	it("部分支持时保持候选顺序（webm 先于 mp4）", () => {
		const supported = new Set(["audio/webm", "audio/mp4"]);
		expect(pickAudioMime((m) => supported.has(m))).toBe("audio/webm");
	});
});

describe("84-B 波形峰值 peakOfSamples", () => {
	it("全 128（静音中线）返回 0", () => {
		expect(peakOfSamples(new Uint8Array([128, 128, 128]))).toBe(0);
	});

	it("满幅（0 或 255）取 |v−128|/128 上限（127/128）", () => {
		expect(peakOfSamples(new Uint8Array([128, 255, 128]))).toBe(127 / 128);
		expect(peakOfSamples(new Uint8Array([0, 128]))).toBe(1);
	});

	it("一般波形取最大偏移（|v−128|/128）", () => {
		// |156-128|/128 = 0.21875、|100-128|/128 = 0.21875、|90-128|/128 = 0.296875
		expect(peakOfSamples(new Uint8Array([156, 100, 90, 128]))).toBeCloseTo(0.296875, 6);
	});
});

describe("84-B 波形降采样 downsamplePeaks", () => {
	it("bins 小于源长：按比例折桶取每桶最大值（视觉不丢峰）", () => {
		// 6 峰折 3 桶：[0.1,0.9]→0.9、[0.2,0.3]→0.3、[0.5,0.4]→0.5
		expect(downsamplePeaks([0.1, 0.9, 0.2, 0.3, 0.5, 0.4], 3)).toEqual([0.9, 0.3, 0.5]);
	});

	it("bins 大于源长：右对齐保留原值、左侧补 0（与波形滚动方向一致）", () => {
		expect(downsamplePeaks([0.3, 0.7], 4)).toEqual([0, 0, 0.3, 0.7]);
	});

	it("空数组 / bins ≤ 0 返回空数组", () => {
		expect(downsamplePeaks([], 10)).toEqual([]);
		expect(downsamplePeaks([0.5], 0)).toEqual([]);
	});

	it("单元素：恰好填入最右桶", () => {
		expect(downsamplePeaks([0.6], 3)).toEqual([0, 0, 0.6]);
	});
});

describe("84-B 时长换算 audioDurationSec / formatDurSec", () => {
	it("毫秒四舍五入到整秒", () => {
		expect(audioDurationSec(1234)).toBe(1);
		expect(audioDurationSec(59999)).toBe(60);
		expect(audioDurationSec(0)).toBe(0);
	});

	it("秒 → m:ss 格式（个位秒补零）", () => {
		expect(formatDurSec(65)).toBe("1:05");
		expect(formatDurSec(0)).toBe("0:00");
		expect(formatDurSec(600)).toBe("10:00");
	});
});
