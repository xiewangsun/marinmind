import { Notice } from "obsidian";
import type MarinMindPlugin from "../main";
import { CLIPS_SUBDIR, DEFAULT_WEBCLIP_FOLDER } from "../constants";
import { joinRel } from "../storage/paths";

/**
 * 存量剪藏一次性迁移（124，onload 执行）：vault 内旧剪藏目录（113 版设置
 * webclipFolder，默认 WebClips/）→ 数据根 clips/，图片从 `<名>.assets/N.ext`
 * 经 attachments.save 统一入数据根 assets/（与全部媒体附件同仓）。
 *
 * 设计要点：
 * - **幂等**：clips/ 已有同名 md 的篇目跳过（旧文件留原处，用户可自行处理）；
 *  无旧目录 / 目录为空则零动作——每次启动跑一遍也无副作用。
 * - **卡片无损**：已登记文档经 documents.renamePath(vault 旧路径 → 新键) 同步
 *  业务键（documentId 不变，摘录卡片回链照常）；从未打开过的剪藏无记录、无动作。
 * - **逐篇容错**：单篇失败（图片读坏等）console.warn 后继续下一篇，不中断整体。
 * - **保守删除**：旧 md 与其被引用的图片删掉；未被引用的文件（用户手放）不动，
 *  目录非空则保留（下次启动对剩余篇目续跑）。
 * - 迁移先于任何剪藏 UI（onload 串行 await），与 vault 事件无并发双处理
 *  （旧目录在数据根外，delete 事件不触数据根回灌；新 md 由 vault.createBinary
 *  落盘产生的 create 事件无监听方）。
 */

/** 旧版图片引用形态：`<名>.assets/<序号>.<ext>`（相对 md 所在目录） */
const LEGACY_ASSET_REF = /\.assets\/\d+\.[A-Za-z0-9]+$/;

/**
 * 抽取 md 文本中全部旧图片引用目标（含 mdLinkTarget 转义形态：空格 %20、
 * 括号 <> 包裹——旧 saveWebclip 产物的三种合法写法）。
 */
export function collectLegacyClipImageRefs(text: string): string[] {
	const out: string[] = [];
	for (const m of text.matchAll(/!\[[^\]]*\]\((<[^>]+>|[^)\s]+)\)/g)) {
		let target = m[1]!;
		if (target.startsWith("<") && target.endsWith(">")) {
			target = target.slice(1, -1);
		}
		if (LEGACY_ASSET_REF.test(target) && !out.includes(target)) {
			out.push(target);
		}
	}
	return out;
}

/** 迁移执行结果（全零 = 无存量；main 据此发 Notice） */
export interface WebclipMigrationResult {
	/** 成功迁入 clips/ 的篇数 */
	moved: number;
	/** clips/ 已有同名而跳过的篇数（幂等重入） */
	skipped: number;
	/** 单篇失败数（console.warn 可查） */
	failed: number;
}

/** 引用目标 → 实际文件名（%20 等编码还原；坏编码回退原字面） */
function decodeRefTarget(target: string): string {
	try {
		return decodeURIComponent(target);
	} catch {
		return target;
	}
}

/**
 * 迁移单篇剪藏：读文本 → 旧图引用逐个转 assets/（attachments.save）→
 * 引用重写 → md 落 clips/ → 业务键同步 → 删旧文件。任一步抛错由调用方计失败。
 */
async function migrateOneClip(
	plugin: MarinMindPlugin,
	folder: string,
	mdName: string,
): Promise<void> {
	const vault = plugin.app.vault;
	const vaultAdapter = vault.adapter;
	const oldVaultPath = joinRel(folder, mdName);
	const text = new TextDecoder().decode(await vaultAdapter.readBinary(oldVaultPath));

	let body = text;
	const oldTargets: string[] = [];
	for (const target of collectLegacyClipImageRefs(text)) {
		const fileName = decodeRefTarget(target);
		const srcVaultPath = joinRel(folder, fileName);
		const bytes = await vaultAdapter.readBinary(srcVaultPath);
		const ext = fileName.slice(fileName.lastIndexOf(".") + 1);
		const newRef = await plugin.attachments.save(bytes, ext);
		// 全局替换（split/join 防 $ 序列被误解释；<> 包裹形态整体换掉更干净）
		body = body.split(`<${target}>`).join(newRef).split(target).join(newRef);
		oldTargets.push(srcVaultPath);
	}

	const rel = `${CLIPS_SUBDIR}/${mdName}`;
	const bytesOut = new TextEncoder().encode(body);
	const loc = plugin.dataLoc;
	if (loc.kind === "vault") {
		await vaultAdapter.mkdir(joinRel(loc.rootDir, CLIPS_SUBDIR)).catch(() => {});
		await vault.createBinary(joinRel(loc.rootDir, rel), bytesOut.slice().buffer as ArrayBuffer);
	} else {
		await loc.adapter.writeBinary(rel, bytesOut.slice().buffer as ArrayBuffer);
	}

	// 业务键同步（未登记过的剪藏 renamePath 返回 false，无动作）
	plugin.documents.renamePath(oldVaultPath, plugin.clipOpenTarget(rel));

	// 删旧：md + 已迁图片；失败仅告警（残留文件下次启动对同名篇目走幂等跳过）
	await vaultAdapter.remove(oldVaultPath);
	for (const img of oldTargets) {
		await vaultAdapter.remove(img);
	}
}

/**
 * 执行存量剪藏迁移（onload 在 store 就绪后调用）。
 * @param legacyFolder 旧设置提取的自定义剪藏目录（null = 只扫默认 WebClips/）
 */
export async function migrateLegacyWebclips(
	plugin: MarinMindPlugin,
	legacyFolder: string | null,
): Promise<WebclipMigrationResult> {
	const result: WebclipMigrationResult = { moved: 0, skipped: 0, failed: 0 };
	const candidates = [...new Set([legacyFolder, DEFAULT_WEBCLIP_FOLDER])].filter(
		(v): v is string => v !== null,
	);
	const vaultAdapter = plugin.app.vault.adapter;

	for (const folder of candidates) {
		if (!(await vaultAdapter.exists(folder))) {
			continue;
		}
		const listed = await vaultAdapter.list(folder);
		const mdFiles = listed.files.filter((f) => f.endsWith(".md"));
		for (const file of mdFiles) {
			const mdName = file.slice(file.lastIndexOf("/") + 1);
			const rel = `${CLIPS_SUBDIR}/${mdName}`;
			try {
				if (await plugin.dataLoc.adapter.exists(rel)) {
					result.skipped++; // 幂等：clips 已有同名（上次迁移残留或用户自建）
					continue;
				}
				await migrateOneClip(plugin, folder, mdName);
				result.moved++;
			} catch (err) {
				result.failed++;
				console.warn("[MarinMind] 剪藏迁移失败（该篇留在原处）", file, err);
			}
		}
		// 目录搬空则清理（尽力而为；有残留文件/子目录则保留待续跑）
		try {
			const remaining = await vaultAdapter.list(folder);
			if (remaining.files.length === 0 && remaining.folders.length === 0) {
				await vaultAdapter.rmdir(folder, false);
			}
		} catch {
			// 目录残留无害（默认目录不在任何扫描路径上）
		}
	}

	if (result.moved > 0) {
		const parts = [`已迁移 ${result.moved} 篇剪藏到数据目录 ${CLIPS_SUBDIR}/`];
		if (result.skipped > 0) {
			parts.push(`${result.skipped} 篇同名跳过`);
		}
		if (result.failed > 0) {
			parts.push(`${result.failed} 篇失败（详见控制台）`);
		}
		new Notice(`MarinMind：${parts.join("，")}`, 8000);
	}
	return result;
}
