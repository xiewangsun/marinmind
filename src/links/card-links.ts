/**
 * 卡片互链构造（㊻-A，纯函数，零 obsidian 依赖，vitest 直接覆盖）
 *
 * 卡片以标准 md 存储（数据根 `books/<书名>.md` 内 `> [!excerpt]` callout +
 * 尾随 `^card-<id>` 块锚点），Obsidian 原生解析 `[[文件#^card-id|标题]]`
 * 链接与 `![[文件#^card-id]]` 嵌入（普通笔记与 Canvas 白板均可）——
 * 本模块只负责把卡片解析成这两种文本，供「复制卡片链接 / 复制嵌入代码」入口使用。
 *
 * 注意：书文件随书名改名跟随（store refreshBookPath），链接必须**点击时现算**，不可缓存。
 */

import { joinRel } from "../storage/paths";
import { escapeWikiTitle } from "../store/mindmap-format";
import { cardTitle } from "../review/map-context";
import type { Card } from "../types";

/**
 * 卡片链接目标（`MarinMind/books/书名#^card-<id>` 形态，无 `.md` 扩展名——
 * Obsidian 链接惯例）。rootDir 为空（数据根即 vault 根）时直接用书文件相对路径。
 */
export function cardLinkTarget(rootDir: string, bookRelPath: string, cardId: string): string {
	const filePath = joinRel(rootDir, bookRelPath).replace(/\.md$/, "");
	return `${filePath}#^card-${cardId}`;
}

/** 完整 wikilink：`[[MarinMind/书名#^card-id|标题]]`（标题方括号转全角防破坏语法） */
export function buildCardLink(target: string, title: string): string {
	return `[[${target}|${escapeWikiTitle(title)}]]`;
}

/** 嵌入语法：`![[MarinMind/书名#^card-id]]`——普通笔记与 Canvas 白板均渲染整卡 callout */
export function buildCardEmbed(target: string): string {
	return `![[${target}]]`;
}

/** 复制模式：「复制卡片链接」出 wikilink，「复制嵌入代码」出嵌入语法 */
export type CardCopyMode = "link" | "embed";

/**
 * 从卡片构造待复制的链接/嵌入文本（标题源与脑图节点标题栏同源 cardTitle）。
 * 调用方负责解析书文件相对路径（store.bookOfCard）与 fs 数据根降级。
 */
export function buildCardCopyText(
	mode: CardCopyMode,
	rootDir: string,
	bookRelPath: string,
	card: Card,
): string {
	const target = cardLinkTarget(rootDir, bookRelPath, card.id);
	return mode === "embed" ? buildCardEmbed(target) : buildCardLink(target, cardTitle(card));
}
