import { describe, expect, it } from "vitest";
import { VISION_MAX_EDGE, shouldResizeForVision } from "../../src/attachments/vision-image";

/**
 * 视觉图片准备（104-C）纯函数部分：imageToDataUrl 依赖 DOM 解码/画布
 * （attachments 耦合层不单测惯例，靠 Obsidian 内手工验证矩阵）。
 */
describe("shouldResizeForVision", () => {
	it("任一边超 2048 即缩", () => {
		expect(shouldResizeForVision(2049, 100)).toBe(true);
		expect(shouldResizeForVision(100, 2049)).toBe(true);
		expect(shouldResizeForVision(3000, 4000)).toBe(true);
	});

	it("恰 2048 边不缩（边界含）", () => {
		expect(shouldResizeForVision(VISION_MAX_EDGE, 100)).toBe(false);
		expect(shouldResizeForVision(1920, 1080)).toBe(false);
	});
});
