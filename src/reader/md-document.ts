import { MarkdownRenderer } from "obsidian";
import type { App, Component } from "obsidian";

/**
 * 库内 Markdown 文档渲染会话（㊻-B 核心版）：vault.cachedRead 取文本 +
 * MarkdownRenderer 渲染为 Obsidian 原生预览排版，标题目录抽取在 md-outline.ts。
 *
 * 与 PdfDocument 的分工：本模块只承担「文本 → 渲染 DOM」，页容器/高亮回显/
 * 摘录几何全部复用阅读器既有管线（划选建卡是通用 DOM 算法、矩形/套索/留白
 * 是纯几何，与 PDF 无关）。
 */
export class MdDocument {
	constructor(
		private readonly app: App,
		/** 源文件 vault 路径（内链相对解析与权限提示用） */
		private readonly sourcePath: string,
		/** 渲染宿主 Component（ItemView；卸载时自动终止渲染） */
		private readonly component: Component,
	) {}

	/**
	 * 把 md 文本渲染进容器。容器需已挂 `markdown-preview-view` 类吃原生排版
	 * （含内链/标签渲染样式）；内部链接渲染后可点（openLinkText 分流）。
	 * MarkdownRenderer.render 是异步分块推进——调用方须以 loadToken 守卫
	 * 丢弃换文档后的过期渲染（镜像 reader-view openPath 竞态防护）。
	 */
	async renderInto(el: HTMLElement, text: string): Promise<void> {
		await MarkdownRenderer.render(this.app, text, el, this.sourcePath, this.component);
		// 内链点击分流：MarkdownRenderer 产出 <a.internal-link data-href>，默认
		// 无点击行为——委托 openLinkText 走 Obsidian 标准解析（外链走默认浏览器）
		el.addEventListener("click", (evt) => {
			const anchor = (evt.target as HTMLElement | null)?.closest?.("a.internal-link");
			if (!(anchor instanceof HTMLElement)) return;
			const href = anchor.dataset.href;
			if (!href) return;
			evt.preventDefault();
			void this.app.workspace.openLinkText(href, this.sourcePath, false);
		});
	}
}
