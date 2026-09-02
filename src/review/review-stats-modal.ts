import { Modal } from "obsidian";
import type { App } from "obsidian";
import type MarinMindPlugin from "../main";
import {
	flashcardCount,
	heatmapCells,
	futureDueBuckets,
	reviewLogDayKey,
	streakFromLog,
	totalReviewsApprox,
} from "../store/review-log";

/**
 * 复习统计面板（69）：统计砖（今日/连续/累计/闪卡数）+ 库统计行 + 13 周热力图 +
 * 未来 7 天到期分布条形。**快照渲染**——onOpen 取一次数据，打开期间不实时刷新
 * （复习结束后重开即新；面板是回顾性视图，无需订阅 cardBus/reviews 变更）。
 *
 * 口径脚注：今日/连续/热力图取复习日志（当日聚合），累计复习为 SM-2 字段近似
 * （Σ repetitions+lapses——日志只从启用日起记，历史以调度字段回推）。
 */
export class ReviewStatsModal extends Modal {
	constructor(app: App, private readonly plugin: MarinMindPlugin) {
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
		this.brick(bricks, String(totalReviewsApprox(store.reviews.values())), "累计复习（近似）");
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
			const el = grid.createDiv({
				cls: `marinmind-stats-cell${cell.future ? " is-future" : ` lv${cell.level}`}`,
			});
			if (!cell.future) {
				el.title = cell.count > 0 ? `${cell.dateKey} · 复习 ${cell.count} 张` : cell.dateKey;
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
			track.createDiv({ cls: "marinmind-stats-bar" }).style.height = `${Math.round((n / max) * 100)}%`;
			col.createDiv({ cls: "marinmind-stats-bar-count", text: n > 0 ? String(n) : "" });
			col.createDiv({ cls: "marinmind-stats-bar-label", text: i === 0 ? "今天" : `+${i}` });
		});

		contentEl.createDiv({
			cls: "marinmind-stats-footnote",
			text: "今日/连续/热力图取自复习日志；累计复习按 SM-2 调度字段近似（含重来）。统计为打开时快照，重开面板刷新。",
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
