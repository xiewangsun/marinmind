import { Notice } from "obsidian";
import type MarinMindPlugin from "../main";
import { snapshotElementRegion, type CloneOptions } from "../reader/dom-snapshot";
import type { PixelRect } from "../reader/region-snapshot";
import { sanitizeFileName } from "../store/book-format";

/**
 * 脑图整图 PNG 导出（63）：编排层在脑图侧（dom-snapshot 保持阅读器快照模块
 * 边界，只暴露 snapshotElementRegion 通用入口）。取景窗口直读 edgesSvg 的
 * viewBox——drawEdges 每次重画按可见节点包围盒同步维护它，是窗口的唯一权威
 * 来源（复刻包围盒计算必与画布漂移）。
 *
 * obsidian/DOM 耦合不单测（镜像 md-outline-measure 分层先例）；文件名分配
 * allocateExportPath 为纯函数 vitest 覆盖。
 */

/** 导出等待节点媒体加载的总超时（毫秒）：blob URL 通常瞬时，兜大图慢网 */
const IMAGE_WAIT_MS = 1500;

/** 导出文件名分配：图名净化 + 已存在 -2/-3 递增（copy-into-vault/大纲导出先例；纯函数可测） */
export function allocateExportPath(
	name: string,
	ext: string,
	exists: (path: string) => boolean,
): string {
	const base = sanitizeFileName(name); // 空名自兜底「未命名」
	let target = `${base}.${ext}`;
	for (let i = 2; exists(target); i++) {
		target = `${base}-${i}.${ext}`;
	}
	return target;
}

/**
 * 等待 world 内未就绪图片（已设 src 且 !complete）加载完成或超时。
 * 返回超时后仍未就绪的数量（调用方据此提示留白）；无待等图返回 0。
 */
async function waitForImages(worldEl: HTMLElement, timeoutMs: number): Promise<number> {
	const pending = Array.from(worldEl.querySelectorAll("img")).filter(
		(img) => (img.getAttribute("src") ?? "") !== "" && !img.complete,
	);
	if (pending.length === 0) {
		return 0;
	}
	await new Promise<void>((resolve) => {
		let left = pending.length;
		const timer = window.setTimeout(resolve, timeoutMs);
		const settle = (): void => {
			left -= 1;
			if (left === 0) {
				// 全部就绪即提前收束；总超时先到则 setTimeout 兜底 resolve
				window.clearTimeout(timer);
				resolve();
			}
		};
		for (const img of pending) {
			// once：load/error 任一信号即计数（同一 img 两者只发其一）
			img.addEventListener("load", settle, { once: true });
			img.addEventListener("error", settle, { once: true });
		}
	});
	return pending.filter((img) => !img.complete).length;
}

/**
 * 导出当前脑图为 PNG 写入 vault 根。失败路径全部 Notice 降级（不抛出）：
 * 空图 / 未就绪媒体留白 / 大图降倍率（16M 像素钳制）/ 内容过大 / 写盘失败。
 * 导出全程零写库。
 */
export async function exportMindmapPng(
	plugin: MarinMindPlugin,
	worldEl: HTMLElement,
	edgesSvg: SVGSVGElement,
	mapName: string,
): Promise<void> {
	// viewBox = 可见节点包围盒 + PAD（drawEdges 维护）；无 viewBox 即空图/未画线
	const vb = edgesSvg.viewBox.baseVal;
	if (!(vb.width > 0) || !(vb.height > 0)) {
		new Notice("画布为空，无可导出内容");
		return;
	}
	const notReady = await waitForImages(worldEl, IMAGE_WAIT_MS);
	// 主题底色解析为具体值：镜像文档无 CSS 变量环境，var() 字符串内联无效
	const themeBg =
		getComputedStyle(document.body).getPropertyValue("--background-primary").trim() ||
		"#ffffff";
	const opts: CloneOptions = {
		// 插入线/吸附参考线是拖拽瞬态元素，不该出现在导出图里
		excludeSelectors: [".marinmind-mm-insert-line", ".marinmind-mm-guide"],
		// 选中/落点/闪烁/拖拽/子树半透明等操作痕迹同摘除（原树临时摘除，计算值不带状态）
		stripClasses: [
			"marinmind-mm-selected",
			"marinmind-mm-droptarget",
			"marinmind-mm-node-droptarget",
			"marinmind-mm-flash",
			"marinmind-mm-dragging",
			"marinmind-mm-subtree-dim",
		],
		rootBackground: themeBg,
		stripRootTransform: true, // world 的平移缩放属视口不属于内容，不剥则整图二次位移
	};
	const win: PixelRect = { sx: vb.x, sy: vb.y, sw: vb.width, sh: vb.height };
	const result = await snapshotElementRegion(worldEl, win, opts);
	if (!result) {
		new Notice("图片导出失败：内容过大或渲染超时", 6000);
		return;
	}
	const want = Math.min(2, window.devicePixelRatio || 1);
	if (result.scale < want) {
		new Notice(`图片较大，导出倍率由 ${want.toFixed(1)}x 降至 ${result.scale.toFixed(2)}x`);
	}
	// 强制 PNG（不复用摘录快照的 WebP 偏好——交换格式，PNG 通用性优先）
	const blob = await new Promise<Blob | null>((resolve) =>
		result.canvas.toBlob(resolve, "image/png"),
	);
	if (!blob) {
		new Notice("图片导出失败：PNG 编码失败", 6000);
		return;
	}
	const bytes = await blob.arrayBuffer();
	const vault = plugin.app.vault;
	const target = allocateExportPath(
		mapName,
		"png",
		(p) => vault.getAbstractFileByPath(p) != null,
	);
	try {
		await vault.createBinary(target, bytes);
	} catch (err) {
		console.error("[MarinMind] PNG 导出失败", err);
		new Notice("图片导出失败：无法写入笔记文件", 6000);
		return;
	}
	if (notReady > 0) {
		new Notice(`有 ${notReady} 张节点图片未加载完成，导出图中为留白`, 5000);
	}
	new Notice(`已导出图片：${target}`);
}
