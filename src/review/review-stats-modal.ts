import { Modal } from "obsidian";
import type { App } from "obsidian";
import type MarinMindPlugin from "../main";
import {
	flashcardCount,
	heatmapCells,
	futureDueBuckets,
	loggedReviewTotal,
	reviewLogDayKey,
	streakFromLog,
} from "../store/review-log";

/**
 * 复习统计面板（69）：统计砖（今日/连续/累计/闪卡数）+ 库统计行 + 13 周热力图 +
 * 未来 7 天到期分布条形。**快照渲染**——onOpen 取一次数据，打开期间不实时刷新
 * （复习结束后重开即新；面板是回顾性视图，无需订阅 cardBus/reviews 变更）。
 *
 * 口径（103-C 统一）：全部指标同源于复习日志——「累计复习」= 历史基线
 * （插件启动时一次性迁移的日志前历史量，存设置 reviewStatsBaseline）
 * + 日志总和；不再直接展示 SM-2 字段近似。
 */
export class ReviewStatsModal extends Modal {
	constructor(
		app: App,
		private readonly plugin: MarinMindPlugin,
	) {
		super(app);
	}

	onOpen(): void {
		this.titleEl.setText("复习统计");
		const { contentEl } = this;
		contentEl.empty();
		contentEl.addClass("marinmind-stats");
		const store = this.plugin.store;
		if (!store) {
			contentEl.createEl("p", { text: "数据层未就绪。" });
			return;
		}
		const nowMs = Date.now();
		const log = store.getReviewLog();
		const todayKey = reviewLogDayKey(nowMs);

		// 统计砖：今日复习 / 连续天数 / 累计复习 / 闪卡数
		const bricks = contentEl.createDiv({ cls: "marinmind-stats-bricks" });
		const today = log[todayKey]?.reviews ?? 0;
		this.brick(bricks, String(today), "今日复习");
		this.brick(bricks, `${streakFromLog(log, todayKey)} 天`, "连续复习");
		// 103-C 口径统一：基线（日志前历史，一次性迁移）+ 日志总和——与今日/连续同源
		this.brick(
			bricks,
			String((this.plugin.settings.reviewStatsBaseline ?? 0) + loggedReviewTotal(log)),
			"累计复习",
		);
		this.brick(bricks, String(flashcardCount(store.reviews.values())), "闪卡数");

		// 库统计行（吸收原 showStats Notice 内容：文档/卡片/脑图）
		contentEl.createDiv({
			cls: "marinmind-stats-libline",
			text: `文档 ${this.plugin.documents.count()} · 卡片 ${this.plugin.cards.count()} · 脑图 ${this.plugin.mindmaps.list().length}`,
		});

		// 13 周热力图（列 = 周 旧→新，行 = 周一…周日；GitHub 风格五档）
		contentEl.createDiv({ cls: "marinmind-stats-h", text: "近 13 周复习热力图" });
		const grid = contentEl.createDiv({ cls: "marinmind-stats-heatmap" });
		for (const cell of heatmapCells(log, nowMs, 13)) {
			// R3（W-15）：title 仅悬停可见，补 aria-label 供读屏逐格播报；未来格纯装饰隐藏
			const label = cell.count > 0 ? `${cell.dateKey} · 复习 ${cell.count} 张` : cell.dateKey;
			const el = grid.createDiv({
				cls: `marinmind-stats-cell${cell.future ? " is-future" : ` lv${cell.level}`}`,
				attr: cell.future ? { "aria-hidden": "true" } : { "aria-label": label },
			});
			if (!cell.future) {
				el.title = label;
			}
		}

		// 未来 7 天到期分布（横向条形；第 0 桶 = 今天，含全部逾期）
		contentEl.createDiv({ cls: "marinmind-stats-h", text: "未来 7 天到期分布" });
		const buckets = futureDueBuckets(store.reviews.values(), nowMs, 7);
		const chart = contentEl.createDiv({ cls: "marinmind-stats-bars" });
		const max = Math.max(1, ...buckets);
		buckets.forEach((n, i) => {
			const col = chart.createDiv({ cls: "marinmind-stats-bar-col" });
			const track = col.createDiv({ cls: "marinmind-stats-bar-track" });
			track.createDiv({ cls: "marinmind-stats-bar" }).setCssStyles({
				height: `${Math.round((n / max) * 100)}%`,
			});
			col.createDiv({ cls: "marinmind-stats-bar-count", text: n > 0 ? String(n) : "" });
			col.createDiv({ cls: "marinmind-stats-bar-label", text: i === 0 ? "今天" : `+${i}` });
		});

		contentEl.createDiv({
			cls: "marinmind-stats-footnote",
			text: "全部指标取自复习日志；「累计复习」= 日志启用前的历史基线 + 日志总和。统计为打开时快照，重开面板刷新。",
		});
	}

	onClose(): void {
		this.contentEl.empty();
	}

	private brick(parent: HTMLElement, value: string, label: string): void {
		const el = parent.createDiv({ cls: "marinmind-stats-brick" });
		el.createDiv({ cls: "marinmind-stats-brick-value", text: value });
		el.createDiv({ cls: "marinmind-stats-brick-label", text: label });
	}
}
