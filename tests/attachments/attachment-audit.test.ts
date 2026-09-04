import { describe, expect, it } from "vitest";
import { diffAssetFiles } from "../../src/attachments/attachment-audit";

// scanAttachments / removeOrphanAttachments 走 plugin + adapter（DOM/插件耦合），
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
		const r = diffAssetFiles(["assets/orphan.png", "assets/ok.png"], [
			"assets/ok.png",
			"assets/gone.webm",
		]);
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
});
