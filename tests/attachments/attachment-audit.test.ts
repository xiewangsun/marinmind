import { describe, expect, it } from "vitest";
import { diffAssetFiles, scanAttachments } from "../../src/attachments/attachment-audit";
import type MarinMindPlugin from "../../src/main";
import { MemoryAdapter, writeText } from "../helpers/memory-adapter";

// removeOrphanAttachments 走 plugin + adapter（DOM/插件耦合），
// 对账规则由 diffAssetFiles 纯函数锁死——误删风险全在这一个函数里。

describe("84-E diffAssetFiles 附件对账", () => {
	it("纯孤儿：文件无卡引用", () => {
		const r = diffAssetFiles(["assets/a.png", "assets/b.webm"], ["assets/b.webm"]);
		expect(r.orphans).toEqual(["assets/a.png"]);
		expect(r.missing).toEqual([]);
	});

	it("纯缺失：卡有 ref 但仓中无文件", () => {
		const r = diffAssetFiles(["assets/a.png"], ["assets/a.png", "assets/gone.jpg"]);
		expect(r.orphans).toEqual([]);
		expect(r.missing).toEqual(["assets/gone.jpg"]);
	});

	it("双向并存：孤儿与缺失同报", () => {
		const r = diffAssetFiles(
			["assets/orphan.png", "assets/ok.png"],
			["assets/ok.png", "assets/gone.webm"],
		);
		expect(r.orphans).toEqual(["assets/orphan.png"]);
		expect(r.missing).toEqual(["assets/gone.webm"]);
	});

	it("旧前缀归一命中：.marinmind/assets/ 引用与 assets/ 文件互认（不误删）", () => {
		const r = diffAssetFiles(["assets/a.png"], [".marinmind/assets/a.png"]);
		expect(r.orphans).toEqual([]);
		expect(r.missing).toEqual([]);
	});

	it("重复 ref 去重：多卡引用同一文件不重复报缺失", () => {
		const r = diffAssetFiles([], ["assets/x.png", "assets/x.png"]);
		expect(r.missing).toEqual(["assets/x.png"]);
	});

	it("null/undefined/空串 ref 忽略（无附件的文本卡）", () => {
		const r = diffAssetFiles(["assets/a.png"], [null, undefined, ""]);
		expect(r.missing).toEqual([]);
		expect(r.orphans).toEqual(["assets/a.png"]);
	});

	it("124 scanAttachments：clips md 引用进保留集（无卡引用的剪藏图不判孤儿）", async () => {
		const adapter = new MemoryAdapter();
		writeText(
			adapter,
			"clips/网页剪藏.md",
			"![a](assets/clip-1.png)\n\n![b](assets/clip-2.jpg)\n",
		);
		writeText(adapter, "assets/clip-1.png", "图1");
		writeText(adapter, "assets/clip-2.jpg", "图2");
		const plugin = {
			dataLoc: { adapter },
			cards: { listAll: () => [] }, // 无任何卡片——引用全部来自剪藏 md
		} as unknown as MarinMindPlugin;

		const r = await scanAttachments(plugin);
		expect(r.orphans).toEqual([]);
		expect(r.missing).toEqual([]);
	});

	it("124 scanAttachments：剪藏引用但仓中缺失的图照常报 missing", async () => {
		const adapter = new MemoryAdapter();
		writeText(adapter, "clips/网页剪藏.md", "![a](assets/gone.png)\n");
		const plugin = {
			dataLoc: { adapter },
			cards: { listAll: () => [] },
		} as unknown as MarinMindPlugin;

		const r = await scanAttachments(plugin);
		expect(r.orphans).toEqual([]);
		expect(r.missing).toEqual(["assets/gone.png"]);
	});
});
