import { getIcon, setIcon } from "obsidian";

/**
 * 图标名兜底解析（90 批）：依序返回第一个在 Obsidian 图标注册表中
 * 实际存在的候选名。getIcon 对无效名返回 null（obsidian.d.ts:3351），
 * 而 setIcon 对无效名不报错只渲染空白按钮——用 getIcon 判空可做
 * 确定性的运行时兜底，避免低版本 Obsidian 缺少新 Lucide 名时出空按钮。
 * 全部候选都不存在时返回最后一个候选（与旧行为一致：渲染空白）。
 */
export function resolveIcon(candidates: readonly string[]): string {
	let resolved = candidates[candidates.length - 1] ?? "";
	for (const name of candidates) {
		if (getIcon(name)) {
			resolved = name;
			break;
		}
	}
	return resolved;
}

/**
 * 带兜底的 setIcon：候选名依序尝试，首个实际存在的生效。
 * 例：setIconSafe(el, "network", "share-2", "git-fork")
 */
export function setIconSafe(el: HTMLElement, ...candidates: string[]): void {
	if (candidates.length === 0) return;
	setIcon(el, resolveIcon(candidates));
}
