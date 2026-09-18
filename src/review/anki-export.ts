import { Notice } from "obsidian";
import type MarinMindPlugin from "../main";
import type { Card } from "../types";

/**
 * Anki CSV 导出（139-G）：闪卡出口通道——vault 根 `.csv` 文件，Anki「文件导入」
 * 直接可用（首两行 # 指令声明分隔符与 html 语义，Anki 2.1.55+ 自动识别列）。
 * 正反面沿用复习视图 MN4 语义（批注 = 问题正面，摘录 = 答案背面）；只有单侧
 * 内容时正面兜底摘录文字、背面留空；无任何文字字段（纯媒体且无批注）的卡跳过
 * ——CSV 不承载媒体（音频/照片/手写快照），宁缺不误导；携带媒体的 .apkg
 * 通道后议（见《后续优化方向》）。
 */

/** CSV 单元格转义：含逗号/引号/换行时整体加引号、内部引号翻倍；纯文本原样 */
export function csvEscape(value: string): string {
	if (/[",\r\n]/.test(value)) {
		return `"${value.replace(/"/g, '""')}"`;
	}
	return value;
}

/** Anki 行：正反面 + 标签列（Anki 第三列按空格分多标签） */
export interface AnkiRow {
	front: string;
	back: string;
	tags: readonly string[];
}

/**
 * 卡片 → Anki 行。null = 跳过（无批注且无摘录文字——纯媒体卡 CSV 无法表达）。
 * 正反面映射：批注+摘录 → 批注正面/摘录背面；仅批注 → 批注正面/背面空；
 * 仅摘录文字 → 摘录正面/背面空。
 */
export function ankiRowOf(card: Card): AnkiRow | null {
	const note = card.note?.trim() ?? "";
	const excerpt = card.excerptText?.trim() ?? "";
	if (!note && !excerpt) {
		return null;
	}
	return {
		front: note || excerpt,
		back: note && excerpt ? excerpt : "",
		tags: card.tags.map((t) => t.trim()).filter((t) => t.length > 0),
	};
}

/**
 * 组装 CSV 文本：UTF-8 BOM 起头（Excel 双击打开不乱码，Anki 导入自动剥除）
 * + Anki 指令行（#separator:Comma / #html:false——旧版 Anki 不识别指令时会
 * 当作笔记导入，2.1.55（2022）起支持，现状可放心依赖）+ 数据行
 * Front,Back,Tags 三列。无整数字段内换行语义不受影响（quoted cell 承载）。
 */
export function buildAnkiCsv(cards: readonly Card[]): string {
	const lines = ["#separator:Comma", "#html:false"];
	for (const card of cards) {
		const row = ankiRowOf(card);
		if (!row) {
			continue;
		}
		lines.push(
			[csvEscape(row.front), csvEscape(row.back), csvEscape(row.tags.join(" "))].join(","),
		);
	}
	return `\uFEFF${lines.join("\n")}\n`;
}

/** 命令入口：全库闪卡（判定源复习态，镜像主页「只显示闪卡」口径）→ vault 根 CSV */
export async function exportAnkiCsv(plugin: MarinMindPlugin): Promise<void> {
	await plugin.whenReady();
	// 闪卡 id 集：卡上无 isFlashcard 字段，判定源在 ReviewState（home-pages 同款收集）
	const flashIds = new Set<string>();
	for (const r of plugin.store?.reviews.values() ?? []) {
		if (r.isFlashcard) flashIds.add(r.cardId);
	}
	const cards = plugin.cards.listAll().filter((c) => flashIds.has(c.id));
	if (cards.length === 0) {
		new Notice("MarinMind：还没有转为闪卡的卡片——先在卡片菜单「转为闪卡」再导出");
		return;
	}
	const rows = cards.map(ankiRowOf).filter((r): r is AnkiRow => r !== null);
	if (rows.length === 0) {
		new Notice("MarinMind：闪卡全部为纯媒体卡（无批注与文字），CSV 无可导出内容");
		return;
	}
	const csv = buildAnkiCsv(cards);
	// 写 vault 根（大纲导出/复制入库的冲突 -2/-3 先例：同名递增避覆盖）
	const vault = plugin.app.vault;
	let target = "MarinMind 闪卡.csv";
	for (let i = 2; vault.getAbstractFileByPath(target) != null; i++) {
		target = `MarinMind 闪卡-${i}.csv`;
	}
	try {
		await vault.create(target, csv);
	} catch (err) {
		console.error("[MarinMind] Anki CSV 导出失败", err);
		new Notice("MarinMind：Anki CSV 导出失败：无法写入笔记文件", 6000);
		return;
	}
	new Notice(
		`MarinMind：已导出 ${rows.length} 张闪卡：${target}（Anki 文件导入，列 = 正面/背面/标签）` +
			(rows.length < cards.length
				? `；另有 ${cards.length - rows.length} 张纯媒体卡未导出（CSV 不含媒体）`
				: ""),
		6000,
	);
}
