import { Notice } from "obsidian";
import type MarinMindPlugin from "../main";
import { t } from "../i18n/i18n";

/**
 * 互链反向入口（167）：普通笔记 / Canvas 里的 `[[MarinMind/books/书名#^card-id|标题]]`
 * 链接，Obsidian 默认点击打开书文件预览——本处理器把点击改道为**跳进插件**：
 * openCardSource 打开阅读器并精确定位该卡（无文档锚点的卡由其内部降级提示）。
 * 与「复制卡片链接」（㊻-A）构成正反双向：复制出口产链接、点击入口回插件。
 *
 * 仅拦 `a.internal-link` 且 data-href 以 `#^card-<id>` 块锚收尾者；嵌入
 * `![[...]]` 渲染为卡片 callout 本体（非链接），不经此路。data-href 由
 * Obsidian 渲染期生成（书文件改名后 Obsidian 自行重算链接），点击时现取
 * 不缓存（镜像 card-links 的「链接点击时现算」契约）。
 */
export function registerCardLinkHandler(plugin: MarinMindPlugin): void {
	plugin.registerMarkdownPostProcessor((el) => {
		for (const a of el.querySelectorAll<HTMLAnchorElement>("a.internal-link")) {
			const href = a.dataset.href ?? "";
			const m = /#\^card-([0-9a-fA-F][0-9a-fA-F-]+)$/.exec(href);
			if (!m) {
				continue;
			}
			const cardId = m[1]!;
			a.addEventListener("click", (evt) => {
				evt.preventDefault(); // 阻止 Obsidian 默认打开书文件
				const card = plugin.cards?.get(cardId);
				if (!card) {
					new Notice(t("链接指向的卡片已不存在"));
					return;
				}
				void plugin.openCardSource(card);
			});
		}
	});
}
