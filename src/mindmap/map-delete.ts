import { Notice } from "obsidian";
import type { App } from "obsidian";
import { ConfirmModal } from "./confirm-modal";
import type MarinMindPlugin from "../main";
import type { Mindmap } from "../types";

/**
 * 删除脑图记录（单源）：主页脑图页右键「删除脑图…」与脑图视图内 ⋯ 菜单共用语义。
 * 仅删脑图组织结构（图 md 文件、节点引用、portal 接线、collectMapId 绑定），
 * 卡片本身保留在书文件里——级联由 mindmaps.delete → store.deleteMap 完成。
 * 打开中的脑图视图不主动关闭：调用方在 onDeleted 里调 refreshActiveMindmaps，
 * 命中视图 loadMap 自愈（Notice + 清画布 + 回选图器）——本模块刻意不
 * import mindmap-view（保持轻依赖画像与 doc-delete 一致，测试免拉视图巨依赖）。
 */

/** 确认弹窗 + 删除：节点数内部取（文案与计数同源），确认后执行 deleteMindmapRecord */
export function confirmDeleteMindmap(
	app: App,
	plugin: MarinMindPlugin,
	map: Mindmap,
	onDeleted?: () => void,
): void {
	const nodeCount = plugin.mindmaps.countNodes(map.id);
	new ConfirmModal(
		app,
		"删除脑图",
		`确定删除《${map.name}》吗？共 ${nodeCount} 个节点。卡片本身保留，仅移除脑图组织结构。\n` +
			"正被打开的脑图视图将自动切回选图器。此操作不可撤销。继续？",
		() =>
			void deleteMindmapRecord(plugin, map).then((ok) => {
				if (ok) {
					onDeleted?.();
				}
			}),
	).open();
}

/** 实际删除（导出供测试）：删图（级联清节点/portal/collectMapId/图 md 文件）→ Notice；图已不存在返回 false 不弹成功提示 */
export async function deleteMindmapRecord(plugin: MarinMindPlugin, map: Mindmap): Promise<boolean> {
	try {
		// 主页入口无弹窗 onOpen 的就绪等待，这里统一补上（已就绪时为空等，弹窗路径无害）
		await plugin.whenReady();
		const ok = plugin.mindmaps.delete(map.id);
		if (ok) {
			new Notice("脑图已删除");
		}
		return ok;
	} catch (err) {
		console.error("[MarinMind] 删除脑图失败", err);
		new Notice(`删除失败：${err instanceof Error ? err.message : String(err)}`);
		return false;
	}
}
