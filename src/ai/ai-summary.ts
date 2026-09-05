import type { AiUsage } from "./ai-provider";
import { chunkText, SUMMARY_CHUNK_CHARS } from "./ai-context";
import {
	buildSummaryMapMessages,
	buildSummaryReduceMessages,
	buildSummaryMessages,
} from "./ai-prompts";
import { sendChat, type AiSettingsView } from "./ai-service";

/** 摘要进度（98）：map 逐块 / reduce 合并 / done 完成；UI 据此渲染进度行 */
export interface SummaryProgress {
	stage: "map" | "reduce" | "done";
	/** 已完成请求数 / 总请求数（done 计 reduce 那次在内） */
	done: number;
	total: number;
}

/**
 * 文档摘要编排（98 P2）：短文直出；长文 map-reduce（分块逐块提炼要点 →
 * 合并为整体摘要）。map 逐块**顺序**执行（并发请求易触发限流，且进度行
 * 才有意义）；每步走 sendChat 统一守卫与用量上报。纯 prompt 构造在
 * ai-prompts（vitest 覆盖），分块在 ai-context（vitest 覆盖）。
 */
export async function summarizeText(
	settings: AiSettingsView,
	text: string,
	opts: {
		onProgress?: (progress: SummaryProgress) => void;
		onUsage?: (usage: AiUsage) => void;
		signal?: AbortSignal;
	} = {},
): Promise<string> {
	const chunks = chunkText(text, SUMMARY_CHUNK_CHARS);
	if (chunks.length <= 1) {
		opts.onProgress?.({ stage: "done", done: 0, total: 1 });
		const out = await sendChat(settings, buildSummaryMessages(text), {
			signal: opts.signal,
			onUsage: opts.onUsage,
		});
		opts.onProgress?.({ stage: "done", done: 1, total: 1 });
		return out;
	}
	const maps: string[] = [];
	for (let i = 0; i < chunks.length; i++) {
		opts.onProgress?.({ stage: "map", done: i, total: chunks.length + 1 });
		maps.push(
			await sendChat(settings, buildSummaryMapMessages(chunks[i]), {
				signal: opts.signal,
				onUsage: opts.onUsage,
			}),
		);
	}
	opts.onProgress?.({ stage: "reduce", done: chunks.length, total: chunks.length + 1 });
	const out = await sendChat(settings, buildSummaryReduceMessages(maps), {
		signal: opts.signal,
		onUsage: opts.onUsage,
	});
	opts.onProgress?.({ stage: "done", done: chunks.length + 1, total: chunks.length + 1 });
	return out;
}
