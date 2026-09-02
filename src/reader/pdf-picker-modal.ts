import { FuzzySuggestModal, Platform } from "obsidian";
import type { App, FuzzyMatch, TFile } from "obsidian";
import { pickExternalPath } from "../storage/external-file";
import type MarinMindPlugin from "../main";

/**
 * 选择结果双形态（㉞）：库内文件（TFile）或库外绝对路径（桌面直读）。
 * 调用方按 kind 分流，两种形态最终都走 openInReader(TFile | string)。
 */
export type PdfPickResult = { kind: "vault"; file: TFile } | { kind: "external"; absPath: string };

/** 选择器列表选项（㊻-B）：默认 PDF + Markdown + EPUB；纯 PDF 场景（重关联）传 ["pdf"] */
export interface PdfPickerOptions {
	/** 列出的库内文件扩展名（默认 pdf + md + epub） */
	extensions?: string[];
	/**
	 * 插件实例：提供数据根判定——数据根内的 md 是插件自身数据（书文件/脑图），
	 * 绝不能作为可阅读文档列出（upsertByPath 双认领 + 事件双重路由）。缺省不排除。
	 */
	plugin?: MarinMindPlugin;
}

/** 两种形态归一为 openInReader 的目标参数（TFile 或库外绝对路径字符串） */
export function pickTarget(pick: PdfPickResult): TFile | string {
	return pick.kind === "vault" ? pick.file : pick.absPath;
}

/**
 * 最近打开的库外文档条目（㉞-A 重开入口）：来自文档记录（打开即 upsert，
 * updatedAt = 最近打开时间），供选择器列出可一键重开的历史库外文件。
 */
export interface ExternalDocEntry {
	absPath: string;
	title: string;
	updatedAt: number;
}

/**
 * 文档快速选择弹窗（命令面板入口；㊻-B 起兼收库内 Markdown，㊼ 起 EPUB）。
 * 列表 = 库内全部 PDF/Markdown/EPUB（排除数据根）+ 最近打开的库外文档（桌面端置顶，
 * 模糊搜索可直接重开）；桌面端弹窗底部另有「打开库外文档」按钮经系统对话框选新文件。
 */
export class PdfPickerModal extends FuzzySuggestModal<PdfPickResult> {
	/** 默认扩展名：PDF + 库内 md（㊻-B）+ EPUB（㊼） */
	private static readonly DEFAULT_EXTENSIONS = ["pdf", "md", "epub"];

	constructor(
		app: App,
		private readonly onChoose: (pick: PdfPickResult) => void,
		/** 最近打开的库外文档（调用方从 documents 记录取，按 updatedAt 倒序） */
		private readonly recentExternal: ExternalDocEntry[] = [],
		/** ㊻-B 列表选项（扩展名 + 数据根排除）；缺省 PDF+md+epub 全列 */
		private readonly options?: PdfPickerOptions,
	) {
		super(app);
		// 占位文案随实际扩展名组合（㊼ 三态起改为动态拼接——重关联只列单格式时不误提其余）
		const kinds: string[] = [];
		if (this.extensions.includes("pdf")) {
			kinds.push("PDF");
		}
		if (this.extensions.includes("md")) {
			kinds.push("Markdown");
		}
		if (this.extensions.includes("epub")) {
			kinds.push("EPUB");
		}
		this.setPlaceholder(
			kinds.length > 1
				? `选择要阅读的文档（${kinds.join(" / ")}）…`
				: `选择要阅读的${kinds[0] ?? "文档"}…`,
		);
	}

	/** 生效扩展名列表（去重防御空数组） */
	private get extensions(): string[] {
		return this.options?.extensions ?? PdfPickerModal.DEFAULT_EXTENSIONS;
	}

	getItems(): PdfPickResult[] {
		const exts = this.extensions;
		const plugin = this.options?.plugin;
		const vaultPicks = this.app.vault
			.getFiles()
			.filter((f) => exts.includes(f.extension))
			// 数据根排除（㊻-B）：MarinMind/ 内 md 是插件数据，不作为可阅读文档列出
			.filter((f) => !plugin || plugin.dataRootRelPath(f.path) === null)
			.map((file): PdfPickResult => ({ kind: "vault", file }));
		// 库外条目仅桌面列出（移动端打不开）；置顶 = 空查询时最近打开可见
		if (!Platform.isDesktopApp) {
			return vaultPicks;
		}
		const externalPicks = this.recentExternal.map(
			(e): PdfPickResult => ({ kind: "external", absPath: e.absPath }),
		);
		return [...externalPicks, ...vaultPicks];
	}

	/** 模糊匹配文本：库内用完整路径（目录名可命中）；库外兼含标题（改名后旧名仍可搜到）与绝对路径 */
	getItemText(item: PdfPickResult): string {
		if (item.kind === "vault") {
			return item.file.path;
		}
		const entry = this.recentExternal.find((e) => e.absPath === item.absPath);
		return entry ? `${entry.title} ${entry.absPath}` : item.absPath;
	}

	/** 主行文件名 + 次行所在路径（textContent 渲染，无注入风险；库根文件无次行） */
	renderSuggestion(match: FuzzyMatch<PdfPickResult>, el: HTMLElement): void {
		if (match.item.kind === "external") {
			const head = el.createDiv({ cls: "marinmind-picker-name" });
			// R2（E2-07）：标题入具名 span——匿名 flex 文本节点无法施加截断三件套
			const title = head.createSpan({ cls: "marinmind-picker-title" });
			title.textContent = this.titleOf(match.item.absPath);
			head.createSpan({ cls: "marinmind-picker-ext-badge", text: "库外" });
			const dir = el.createDiv({ cls: "marinmind-picker-dir" });
			dir.textContent = match.item.absPath; // 绝对路径整行次级展示（CSS 省略）
			return;
		}
		const file = match.item.file;
		// R2（E2-07）：主行与库外行同构（picker-name + picker-title），长名单行省略
		const name = document.createElement("div");
		name.className = "marinmind-picker-name";
		const title = document.createElement("span");
		title.className = "marinmind-picker-title";
		title.textContent = file.basename;
		name.appendChild(title);
		el.appendChild(name);

		// 库根目录的 path 是 "/"，直接显示会读成 "文件名/"——根下文件省略次行
		const dirPath = file.parent?.path ?? "";
		if (dirPath && dirPath !== "/") {
			const dir = document.createElement("div");
			dir.className = "marinmind-picker-dir";
			dir.textContent = dirPath;
			el.appendChild(dir);
		}
	}

	onChooseItem(item: PdfPickResult): void {
		this.onChoose(item);
	}

	/** 库外条目显示标题：文档记录的 title（文件改名未重开时保留旧名，仍可辨识） */
	private titleOf(absPath: string): string {
		return this.recentExternal.find((e) => e.absPath === absPath)?.title ?? absPath;
	}

	/**
	 * 桌面端向弹窗容器底部追加「打开库外文档」按钮（㉞；㊼ 起收 PDF/EPUB）。
	 * FuzzySuggestModal 无原生静态行插槽，且 modal DOM 每次 open 重建——
	 * 在此钩子随插随建正好覆盖重建；移动端不出现（库外仅桌面可读）。
	 */
	onOpen(): void {
		super.onOpen();
		if (!Platform.isDesktopApp) {
			return;
		}
		const footer = this.modalEl.createEl("div", { cls: "marinmind-picker-external" });
		const btn = footer.createEl("button", {
			text: "📂 打开库外文档…",
		});
		btn.addEventListener("click", async () => {
			const absPath = await pickExternalPath();
			if (!absPath) {
				return; // 取消 / 环境不支持：静默保留弹窗，用户仍可从列表选择
			}
			this.close();
			this.onChoose({ kind: "external", absPath });
		});
	}
}
