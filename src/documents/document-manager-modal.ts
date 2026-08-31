import { ButtonComponent, Modal, Notice, Platform, TFile } from "obsidian";
import type { App } from "obsidian";
import { ConfirmModal } from "../mindmap/confirm-modal";
import { PdfPickerModal } from "../reader/pdf-picker-modal";
import { isAbsoluteFsPath, docExtOf } from "../storage/paths";
import type MarinMindPlugin from "../main";
import { applyRelink, planRelink } from "./relink";
import { copyExternalIntoVault } from "./copy-into-vault";
import { resolveDocPresence, type DocPresence } from "./doc-presence";
import { MSG_EXTERNAL_DOC_MOBILE } from "../constants";
import type { BookDocument } from "../types";

/**
 * 文档管理面板：列出全部文档记录，标记失联（库内：文件不在 vault；库外：绝对路径已失效），
 * 支持【重关联】（重新指定路径，卡片原地跟随；目标可为库内或库外路径）与【删除记录】
 * （级联清理，含附件）。低频维护操作：不承诺与打开中的视图实时同步（与备份导入一致的取舍）。
 */
export class DocumentManagerModal extends Modal {
	constructor(app: App, private readonly plugin: MarinMindPlugin) {
		super(app);
	}

	async onOpen(): Promise<void> {
		await this.plugin.whenReady();
		this.titleEl.setText("文档管理");
		if (!this.plugin.store) {
			this.contentEl.createEl("p", { text: "数据层未就绪，无法管理文档。" });
			return;
		}
		await this.renderList();
	}

	private async renderList(): Promise<void> {
		const { contentEl } = this;
		contentEl.empty();

		const docs = this.plugin.documents.list();
		// 库外路径探活是异步 stat：逐文档并发判定后一次性渲染（㉟ 抽出共享判定，主页同源）
		const presences = await Promise.all(docs.map((doc) => resolveDocPresence(this.app, doc.filePath)));
		const missing = presences.filter((p) => p === "missing" || p === "external-missing").length;
		const external = presences.filter((p) => p.startsWith("external")).length;
		contentEl.createEl("p", {
			cls: "marinmind-doc-summary",
			text:
				`共 ${docs.length} 个文档，${missing} 个已失联（文件不在库中或库外路径已失效）` +
				(external > 0 ? `，其中 ${external} 个为库外文档（桌面绝对路径，不进备份包）。` : "。") +
				"重关联后卡片与复习进度全部保留；库内文件改名/移动通常会自动同步，" +
				"库外文件同目录改名桌面端自动跟随（㊳），跨目录移动需手动重关联。",
		});

		const listEl = contentEl.createDiv({ cls: "marinmind-doc-list" });
		docs.forEach((doc, i) => {
			this.renderRow(listEl, doc, presences[i]);
		});
	}

	private renderRow(listEl: HTMLElement, doc: BookDocument, presence: DocPresence): void {
		const cardCount = this.plugin.cards.count(doc.id);
		const missing = presence === "missing" || presence === "external-missing";
		const external = presence.startsWith("external");

		const row = listEl.createDiv({ cls: "marinmind-doc-row" });
		const main = row.createDiv({ cls: "marinmind-doc-main" });
		main.createDiv({ cls: "marinmind-doc-title", text: doc.title });
		main.createDiv({ cls: "marinmind-doc-path", text: doc.filePath });

		// 徽标：库外用中性色区别于库内失联红；库外失联双标叠加；移动端库外不断言就位
		const badgeCls = external
			? "marinmind-doc-badge marinmind-doc-badge-external"
			: "marinmind-doc-badge";
		const badgeText =
			presence === "external-ok" || presence === "external-unknown"
				? "库外"
				: presence === "external-missing"
					? "库外·已失联"
					: missing
						? "已失联"
						: "正常";
		row.createDiv({
			cls: missing ? `${badgeCls} marinmind-doc-badge-missing` : badgeCls,
			text: badgeText,
		});
		row.createDiv({ cls: "marinmind-doc-cards", text: `${cardCount} 卡` });

		const actions = row.createDiv({ cls: "marinmind-doc-actions" });
		new ButtonComponent(actions)
			.setButtonText("重关联")
			.onClick(() => this.pickNewFile(doc));
		if (missing) {
			new ButtonComponent(actions)
				.setButtonText("删除记录")
				.setWarning()
				.onClick(() => this.confirmDelete(doc, cardCount));
		} else if (!external || !Platform.isMobile) {
			// 移动端打不开库外文档（无 fs 直读），只留重关联
			new ButtonComponent(actions)
				.setButtonText("打开")
				.onClick(() => void this.openDoc(doc));
		}
		// ㊳ 一键复制入库（仅桌面库外就位文档）：复制到 vault 根并改道记录——
		// 备份可打包、跨机器不再失联
		if (presence === "external-ok" && Platform.isDesktopApp) {
			new ButtonComponent(actions)
				.setButtonText("复制入库")
				.onClick(() => void this.copyIntoVault(doc));
		}
	}

	/** 复制入库（㊳）：成功后同步 watcher 观察集并刷新列表（记录已改道为库内路径） */
	private async copyIntoVault(doc: BookDocument): Promise<void> {
		const file = await copyExternalIntoVault(this.plugin, doc.filePath);
		if (file) {
			new Notice(`已复制入库：${file.path}（卡片与复习进度保留）`);
			this.plugin.externalWatcher?.sync();
			await this.renderList();
		}
	}

	private pickNewFile(doc: BookDocument): void {
		// 复用文档选择器：库内列表选 TFile，历史库外路径置顶可选（重关联到另一库外位置），
		// 或底部按钮经系统对话框选新的库外绝对路径。㊼ 重关联目标**限源文档同格式**
		//（pdf 页码 vs epub 章号语义错乱，宁拒不赌；无扩展名罕见兜底 pdf）
		const ext = docExtOf(doc.filePath) || "pdf";
		new PdfPickerModal(
			this.app,
			(pick) => {
				void this.relink(doc, pick.kind === "vault" ? pick.file.path : pick.absPath);
			},
			this.plugin.recentExternalDocs(),
			{ plugin: this.plugin, extensions: [ext] },
		).open();
	}

	private async relink(doc: BookDocument, targetPath: string): Promise<void> {
		if (targetPath === doc.filePath) {
			return; // 原路径，无需操作
		}
		const target = this.plugin.documents.getByPath(targetPath);
		const plan = planRelink(
			{ id: doc.id, cardCount: this.plugin.cards.count(doc.id) },
			target ? { id: target.id, cardCount: this.plugin.cards.count(target.id) } : null,
		);
		if (plan.action === "reject") {
			new Notice(plan.message, 6000);
			return;
		}
		const run = () => {
			try {
				applyRelink(this.plugin.documents, this.plugin.cards, doc, targetPath);
			} catch (err) {
				console.error("[MarinMind] 重关联失败", err);
				new Notice(`重关联失败：${err instanceof Error ? err.message : String(err)}`);
				return;
			}
			new Notice(`已重关联到 ${targetPath}（卡片与复习进度保留）`);
			void this.renderList();
		};
		if (plan.action === "takeover-empty-target") {
			new ConfirmModal(
				this.app,
				"重关联",
				`${plan.message}。\n若该文档正被阅读器打开，请先关闭对应标签页（重关联不触发文件事件，视图状态需重开刷新）。继续？`,
				run,
			).open();
			return;
		}
		run();
	}

	private confirmDelete(doc: BookDocument, cardCount: number): void {
		new ConfirmModal(
			this.app,
			"删除文档记录",
			`将删除「${doc.title}」的记录，并级联删除其 ${cardCount} 张卡片、复习状态与脑图节点引用，媒体附件文件一并清除。\n` +
				"此操作不可撤销。若该文档正被阅读器打开，请先关闭对应标签页。继续？",
			() => void this.deleteDoc(doc),
		).open();
	}

	private async deleteDoc(doc: BookDocument): Promise<void> {
		try {
			// 附件清理是发起方职责（对齐 reader-view 删卡清附件的模式）：
			// 先捕获卡片快照逐个删附件文件，再删文档行（级联清卡片等 DB 数据）
			for (const card of this.plugin.cards.listByDocument(doc.id)) {
				if (card.excerptRef) {
					await this.plugin.attachments.remove(card.excerptRef).catch(() => {
						// 单个附件缺失不阻断整体清理
					});
				}
			}
			this.plugin.documents.delete(doc.id);
			new Notice("文档记录已删除");
			void this.renderList();
		} catch (err) {
			console.error("[MarinMind] 删除文档记录失败", err);
			new Notice(`删除失败：${err instanceof Error ? err.message : String(err)}`);
		}
	}

	private async openDoc(doc: BookDocument): Promise<void> {
		if (isAbsoluteFsPath(doc.filePath)) {
			// 库外文档桌面直读；移动端打不开（fs 不可用）
			if (Platform.isMobile) {
				new Notice(MSG_EXTERNAL_DOC_MOBILE);
				return;
			}
			await this.plugin.openInReader(doc.filePath);
			this.close();
			return;
		}
		const file = this.app.vault.getAbstractFileByPath(doc.filePath);
		if (!(file instanceof TFile)) {
			new Notice("文件不在库中");
			return;
		}
		await this.plugin.openInReader(file);
		this.close();
	}
}
