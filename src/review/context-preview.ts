import { TFile } from "obsidian";
import type MarinMindPlugin from "../main";
import type { Card } from "../types";
import type { PdfDocument } from "../reader/pdf-document";
import { acquirePdf, pdfCacheKey, type PdfHandle } from "../reader/pdf-cache";
import { paintCardHighlights } from "../reader/region-snapshot";
import { readExternalBinary } from "../storage/external-file";
import { docExtOf, isAbsoluteFsPath } from "../storage/paths";

/** 上下文缩略图的目标渲染宽度（CSS 像素）：足够辨认版面布局，不喧宾夺主 */
const CONTEXT_WIDTH = 460;

/** 同时缓存的 PDF 文档数上限（超出销毁最久未用的，控制 worker 侧内存） */
const MAX_OPEN_DOCS = 2;

/**
 * 复习视图的「溯源上下文 · 文档栏」渲染器（㉒，MN4 全屏复习翻面后按需查看）：
 * 按需打开卡片所属 PDF，把摘录所在页渲染为缩略图并叠加高亮区域
 * （rects 黄色半透明、套索 polygon 描边），帮助回忆摘录在版面中的位置。
 *
 * - PDF 文档按 documentId 缓存（LRU ≤ 2 份），onClose 统一 destroy
 * - 渲染走 PdfDocument.renderTo 的 isolated 路径（与任何阅读器互不抢占）
 * - 失联文档 / 无矩形（photo/audio）/ 渲染失败一律静默跳过——上下文是增强不是依赖
 */
export class ContextPreviewRenderer {
	/** documentId → 持有的共享句柄（Map 迭代序即使用序，重 touch 用 delete+set；㊳ 缓存） */
	private readonly docs = new Map<string, PdfHandle>();

	constructor(private readonly plugin: MarinMindPlugin) {}

	/** 渲染卡片的原文页缩略图并追加到 container（异步；视图翻页重绘由 isConnected 守卫丢弃） */
	async renderInto(container: HTMLElement, card: Card): Promise<void> {
		if (card.page == null || card.rects.length === 0) {
			return; // 无页面定位（photo/audio/异常数据）——无上下文可展示
		}
		const documentId = card.documentId;
		if (!documentId) {
			return;
		}
		const doc = this.plugin.documents.get(documentId);
		if (!doc) {
			return;
		}
		// ㊼ 溯源缩略图仅对 PDF 成立（md/epub 无 pdf.js 位图，读字节解析纯属浪费）：
		// 直接跳过——与 photo/audio 同语义（提示改看脑图栏）
		if (docExtOf(doc.filePath) !== "pdf") {
			return;
		}
		// 库外绝对路径（㉞）不做前置校验——桌面直读失败 / 移动端 fs 不可用都在
		// openDoc 抛错走 catch 静默跳过（与库内失联同语义：上下文是增强不是依赖）
		if (
			!isAbsoluteFsPath(doc.filePath) &&
			!(this.plugin.app.vault.getAbstractFileByPath(doc.filePath) instanceof TFile)
		) {
			return; // 库内文档失联（文件已移出/删除）——跳原文有管理入口，这里静默
		}
		try {
			const pdf = await this.openDoc(documentId, doc.filePath);
			const page = card.page;
			const base = await pdf.getPageSize(page);
			// 离屏渲染完成后再挂载：避免半成品画布随翻页闪现
			const canvas = document.createElement("canvas");
			const scale = CONTEXT_WIDTH / base.width;
			const ticket = pdf.renderTo(canvas, page, scale, { isolated: true });
			await ticket.done;
			// 㶈 起画笔抽至 region-snapshot.paintCardHighlights（与主页卡片预览共用配色）
			paintCardHighlights(canvas, card);
			if (!container.isConnected) {
				return; // 渲染期间视图已翻页重绘——丢弃
			}
			const wrap = container.createDiv({ cls: "marinmind-review-context" });
			wrap.createDiv({
				cls: "marinmind-review-context-label",
				text: `📍 原文上下文 · 第 ${page} 页`,
			});
			wrap.appendChild(canvas);
			// 71 点击缩略图跳原文：openCardSource 统一入口（精确定位 + 闪烁高亮），
			// title 提示可点（CSS .marinmind-review-context 挂 cursor/hover 态）
			wrap.addClass("is-clickable");
			wrap.setAttribute("title", "点击跳转到原文位置");
			wrap.addEventListener("click", () => {
				void this.plugin.openCardSource(card);
			});
		} catch (err) {
			// 上下文是增强能力：任何失败（文件读不了/pdf.js 报错/页码越界）都不打扰复习
			console.debug("[MarinMind] 上下文缩略图渲染跳过", err);
		}
	}

	/** 释放全部持有引用（复习视图 onClose 调用；幂等；销毁由引用计数归零触发） */
	async destroy(): Promise<void> {
		const docs = [...this.docs.values()];
		this.docs.clear();
		for (const handle of docs) {
			handle.release();
		}
	}

	/** 打开（或复用缓存的）PDF 文档，LRU 淘汰最久未用的一份 */
	private async openDoc(documentId: string, filePath: string): Promise<PdfDocument> {
		const cached = this.docs.get(documentId);
		if (cached) {
			// touch：删掉重插维持 Map 迭代序 = 最近使用序
			this.docs.delete(documentId);
			this.docs.set(documentId, cached);
			return cached.doc;
		}
		// 路径双语义（㉞）：库外绝对路径桌面 fs 直读；库内经 vault（缺失抛错由调用方 catch 静默）
		const buf = isAbsoluteFsPath(filePath)
			? await readExternalBinary(filePath)
			: await this.plugin.app.vault.readBinary(
					this.plugin.app.vault.getAbstractFileByPath(filePath) as TFile,
				);
		// ㊳ 共享缓存：与阅读器/AI 摘录弹窗共用同一次解析（首开变快）；
		// 本渲染器的 renderTo 全部 isolated，与显示渲染互不抢占
		const handle = await acquirePdf(pdfCacheKey(filePath), buf);
		this.docs.set(documentId, handle);
		while (this.docs.size > MAX_OPEN_DOCS) {
			const oldestKey = this.docs.keys().next().value;
			if (oldestKey === undefined) {
				break;
			}
			const oldest = this.docs.get(oldestKey);
			this.docs.delete(oldestKey);
			oldest?.release();
		}
		return handle.doc;
	}
}
