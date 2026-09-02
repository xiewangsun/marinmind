import { MarkdownRenderer } from "obsidian";
import type { App, Component } from "obsidian";
import { outlineFromDom } from "../reader/md-outline";
import type { OutlineEntry } from "../reader/pdf-document";

/**
 * md 文档目录量测（62 目录框架三态泛化）：md 的标题树静态可得（outlineFromDom），
 * 但归一化锚点 y 必须真实布局一次——本模块隐藏渲染全文（820px 列宽与阅读器
 * computeFitScale 的 md 阅读形态同源）后按标题元素 offsetTop / 容器滚动高归一。
 *
 * obsidian 耦合不单测（MarkdownRenderer/布局均运行时），分层镜像 md-document：
 * 树形逻辑在 md-outline.ts 纯函数（vitest 覆盖），本模块只补"y 从哪来"。
 */

/** 量测产物：OutlineEntry 树 + 每条目录项的归一化锚点 y（0-1；与建卡合成 rect 同源） */
export interface MeasuredOutlineEntry extends OutlineEntry {
	/** 标题元素顶部相对全文的归一化位置；空标题外的条目必有值 */
	anchorY: number | null;
	children: MeasuredOutlineEntry[];
}

/**
 * 渲染 md 全文并量测标题树（一次性成本：大 md 秒级，调用方 Notice 预告）。
 * component 传调用方视图（ItemView 即 Component——内链等渲染副作用挂在视图
 * 生命周期上，视图关闭即回收）。容器 fixed 定位移出视口（不引发可见滚动
 * 跳动），finally 必移除。渲染失败/无标题返回空数组（调用方按"没有可用
 * 的目录"提示）。
 */
export async function measureMdOutline(
	app: App,
	component: Component,
	text: string,
): Promise<MeasuredOutlineEntry[]> {
	// width 820 与阅读器 md 列宽一致（换行位置不同 → 标题 y 会有小幅漂移，
	// 归章/跳原文都按此 y 语义自洽，无需与阅读器逐像素对齐）
	const host = document.createElement("div");
	host.className = "markdown-preview-view";
	host.style.cssText =
		"position:fixed;left:-10000px;top:0;width:820px;visibility:hidden;pointer-events:none;";
	document.body.appendChild(host);
	try {
		await MarkdownRenderer.render(app, text, host, "", component);
		const entries = outlineFromDom(host);
		if (entries.length === 0) {
			return [];
		}
		// scrollHeight：隐藏容器无滚动条但内容高度照常布局（fixed 定位不折叠）
		const total = host.scrollHeight || 1;
		const measure = (entry: OutlineEntry): MeasuredOutlineEntry => ({
			...entry,
			anchorY: entry.anchor ? Math.min(entry.anchor.offsetTop / total, 1) : null,
			children: entry.children.map(measure),
		});
		return entries.map(measure);
	} catch (err) {
		console.error("[MarinMind] md 目录量测渲染失败", err);
		return [];
	} finally {
		host.remove();
	}
}
