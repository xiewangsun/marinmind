import { Platform, TFile } from "obsidian";
import type { App } from "obsidian";
import { externalFileExists } from "../storage/external-file";
import { isAbsoluteFsPath } from "../storage/paths";

/**
 * 文档记录的就位状态（㉞ 起库外路径与库内分流判定）：
 * - ok / missing：库内路径经 vault 解析 TFile（目录占位/缺失都算失联）
 * - external-*：库外绝对路径，桌面端 stat 探活；移动端无法访问库外文件 → unknown 不断言
 *
 * ㉟ 从 DocumentManagerModal 抽出（原 private resolvePresence）——主页文档页复用同一判定。
 */
export type DocPresence =
	"ok" | "missing" | "external-ok" | "external-missing" | "external-unknown";

/** 判定文档路径就位状态（库内 vault 解析 / 库外桌面 stat 探活 / 移动端库外不断言） */
export async function resolveDocPresence(app: App, filePath: string): Promise<DocPresence> {
	if (isAbsoluteFsPath(filePath)) {
		if (Platform.isMobile) {
			return "external-unknown";
		}
		return (await externalFileExists(filePath)) ? "external-ok" : "external-missing";
	}
	return app.vault.getAbstractFileByPath(filePath) instanceof TFile ? "ok" : "missing";
}
