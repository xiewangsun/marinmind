import { Notice, TFile } from "obsidian";
import type MarinMindPlugin from "../main";
import { readExternalBinary } from "../storage/external-file";
import { docExtOf, fsBasename } from "../storage/paths";
import { applyRelink } from "./relink";

/**
 * 一键复制入库（㊳）：把库外文档（㊼ 起 PDF/EPUB）复制到 vault 根目录，
 * 并把记录改道到库内副本。
 *
 * - 改道复用 applyRelink（目标为新建文件必无记录，占用防御同源保留）
 * - title 不需跟随：fsBasename 与 TFile.basename 同义，renamePath 不改 title，
 *   后续 upsertByPath 同路径同标题只内存 touch 不落盘
 * - 入库后备份可打包该文档（导出只收库内文件）、跨机器不再失联
 * @returns 目标 TFile（vault 根内副本）；读取/写入失败 Notice 已提示并返回 null
 */
export async function copyExternalIntoVault(
	plugin: MarinMindPlugin,
	filePath: string,
): Promise<TFile | null> {
	const doc = plugin.documents.getByPath(filePath);
	if (!doc) {
		return null;
	}
	const base = fsBasename(filePath);
	// ㊼ 后缀跟随源扩展名（.epub 保留 .epub）；无扩展名罕见，兜底 pdf
	const ext = docExtOf(filePath) || "pdf";
	// 目标名冲突：vault 根下 ${base}.${ext} 已存在则 -2/-3 递增（与备份导入同名跳过
	// 不同——这里刻意造新名：用户点了"复制入库"就是要一份库内副本，不该静默改道到既有文件）
	const vault = plugin.app.vault;
	let target = `${base}.${ext}`;
	for (let i = 2; vault.getAbstractFileByPath(target) != null; i++) {
		target = `${base}-${i}.${ext}`;
	}
	let bytes: ArrayBuffer;
	try {
		bytes = await readExternalBinary(filePath);
	} catch (err) {
		new Notice(
			`MarinMind：复制入库失败（${err instanceof Error ? err.message : String(err)}）`,
			6000,
		);
		return null;
	}
	try {
		await vault.createBinary(target, bytes);
	} catch (err) {
		new Notice(
			`MarinMind：写入库内文件失败（${err instanceof Error ? err.message : String(err)}）`,
			6000,
		);
		return null;
	}
	applyRelink(plugin.documents, plugin.cards, doc, target);
	const file = vault.getAbstractFileByPath(target);
	return file instanceof TFile ? file : null;
}
