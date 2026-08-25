import { describe, expect, it } from "vitest";
import { pickAudioMime } from "../../src/reader/audio-recorder";

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
