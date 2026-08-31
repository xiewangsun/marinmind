import type { Card } from "../types";

/**
 * 卡片变更事件总线（纯 TS，零 obsidian/DOM 依赖）。
 *
 * - 由 CardRepository 构造注入并在写方法内 emit——任何调用方（视图/弹窗/未来命令）
 *   都无法绕过通知。
 * - **契约：订阅回调禁止写库，只做 DOM/内存快照更新**——emit 同步执行，
 *   回调只读即无回环；一旦回调再写 cards 表会形成无限循环。
 *   需要写库的订阅方（脑图自动收录）必须把写动作延迟到 emit 返回之后
 *   （queueMicrotask），且自身发出的 created 事件要能被自己的过滤条件拦住。
 * - 视图订阅后必须在销毁时退订（返回的函数即退订器）。
 */
export class CardEventBus {
	private readonly createdHandlers = new Set<(card: Card) => void>();
	private readonly changedHandlers = new Set<(card: Card) => void>();
	private readonly removedHandlers = new Set<(cardId: string, last: Card) => void>();

	/**
	 * 订阅卡片创建事件（仅 create 发出；update 只发 changed）。
	 * 需要区分"新建"与"编辑"的订阅方（脑图自动收录）用它，
	 * 兼容旧语义的跨标签同步仍走 onCardChanged（create 时两类都发）。
	 */
	onCardCreated(fn: (card: Card) => void): () => void {
		this.createdHandlers.add(fn);
		return () => this.createdHandlers.delete(fn);
	}

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

	emitCardCreated(card: Card): void {
		for (const fn of this.createdHandlers) {
			fn(card);
		}
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
