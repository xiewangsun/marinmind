import type { Card } from "../types";

/**
 * 卡片变更事件总线（纯 TS，零 obsidian/DOM 依赖）。
 *
 * - 由 CardRepository 构造注入并在写方法内 emit——任何调用方（视图/弹窗/未来命令）
 *   都无法绕过通知。
 * - **契约：订阅回调禁止写库，只做 DOM/内存快照更新**——emit 同步执行，
 *   回调只读即无回环；一旦回调再写 cards 表会形成无限循环。
 * - 视图订阅后必须在销毁时退订（返回的函数即退订器）。
 */
export class CardEventBus {
	private readonly changedHandlers = new Set<(card: Card) => void>();
	private readonly removedHandlers = new Set<(cardId: string, last: Card) => void>();

	/** 订阅卡片创建/更新事件；返回退订函数 */
	onCardChanged(fn: (card: Card) => void): () => void {
		this.changedHandlers.add(fn);
		return () => this.changedHandlers.delete(fn);
	}

	/**
	 * 订阅卡片删除事件；last 为删除前的最后快照
	 * （订阅方需要 page/documentId 等信息做 DOM 清理，删除后已查不到）。
	 */
	onCardRemoved(fn: (cardId: string, last: Card) => void): () => void {
		this.removedHandlers.add(fn);
		return () => this.removedHandlers.delete(fn);
	}

	emitCardChanged(card: Card): void {
		for (const fn of this.changedHandlers) {
			fn(card);
		}
	}

	emitCardRemoved(cardId: string, last: Card): void {
		for (const fn of this.removedHandlers) {
			fn(cardId, last);
		}
	}
}
