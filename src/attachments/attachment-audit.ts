import { ASSETS_SUBDIR } from "../constants";
import type MarinMindPlugin from "../main";
import { normalizeAssetRef } from "../storage/paths";
import type { ListableStorageAdapter } from "../storage/vault-rooted-adapter";

/**
 * 附件仓健康对账（84-E）：assets/ 实际文件 ↔ 卡片 excerptRef 交叉比对——
 * 孤儿（文件无卡引用：删卡级联中断/异常残留，纯占库体积）与缺失（卡有 ref
 * 无文件：附件被外部移动/删除，媒体卡显示占位）。删除动作必须经用户确认
 * （默认取消，宁拒不赌——误删的附件无法从库内恢复）。
 */

/** 对账结果：paths 均为数据根相对路径（如 assets/xxx.png） */
export interface AssetAuditResult {
	/** 孤儿：仓内有文件但无任何卡片引用 */
	orphans: string[];
	/** 缺失：卡片引用了但仓中无文件 */
	missing: string[];
}

/**
 * 纯函数对账（测试锁死归一规则）：files = 仓内实际文件路径，refs = 卡片引用。
 * 两侧均先 normalizeAssetRef 归一（旧 .marinmind/assets/ 前缀兼容）；
 * null/undefined 引用忽略；重复 ref 天然去重（Set）。
 */
export function diffAssetFiles(
	files: string[],
	refs: (string | null | undefined)[],
): AssetAuditResult {
	const refSet = new Set<string>();
	for (const ref of refs) {
		if (ref) {
			refSet.add(normalizeAssetRef(ref));
		}
	}
	const fileSet = new Set(files.map((f) => normalizeAssetRef(f)));
	return {
		orphans: files.filter((f) => !refSet.has(normalizeAssetRef(f))),
		missing: [...refSet].filter((r) => !fileSet.has(r)),
	};
}

/** 递归列出目录下全部文件（根相对路径）；目录不存在返回空
 *  （镜像 backup-service 私有 collectFiles——各域内聚，不跨域导出） */
async function collectFiles(adapter: ListableStorageAdapter, dir: string): Promise<string[]> {
	if (!(await adapter.exists(dir))) return [];
	const listed = await adapter.list(dir);
	const files = [...listed.files];
	for (const sub of listed.folders) {
		files.push(...(await collectFiles(adapter, sub)));
	}
	return files;
}

/** 全库扫描：枚举 assets/ 实际文件，对照全部卡片的 excerptRef */
export async function scanAttachments(plugin: MarinMindPlugin): Promise<AssetAuditResult> {
	const files = await collectFiles(plugin.dataLoc.adapter, ASSETS_SUBDIR);
	return diffAssetFiles(
		files,
		plugin.cards.listAll().map((c) => c.excerptRef),
	);
}

/** 删除孤儿附件（逐个走 attachments.remove——幂等，不存在静默）；返回成功删除数 */
export async function removeOrphanAttachments(
	plugin: MarinMindPlugin,
	paths: string[],
): Promise<number> {
	let removed = 0;
	for (const path of paths) {
		try {
			await plugin.attachments.remove(path);
			removed++;
		} catch (err) {
			console.warn("[MarinMind] 孤儿附件删除失败", path, err);
		}
	}
	return removed;
}
