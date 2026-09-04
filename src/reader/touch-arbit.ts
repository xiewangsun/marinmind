/**
 * 触摸长按仲裁器（79-7 触摸端拖卡）：纯状态机，零 DOM/obsidian 依赖可单测。
 *
 * 触摸端不能像鼠标一样按下即 setPointerCapture——触摸同时是滚动手势的
 * 输入源，立即捕获会让页面失去滚动能力；且触摸指针不会跨元素续派发
 * （隐式捕获到按下目标，与鼠标 capture 跨窗派发不同）。策略：按下记
 * pending，长按 holdMs 不动 → armed（此刻才捕获指针、启动拖卡）；
 * pending 期移动超容差 / 抬起 / 取消 → settled 让位（手势是滚动或点按，
 * 按旧行为放行）。
 *
 * 状态流转：idle →（onDown）pending →（定时到）armed（终态，拖卡接管，
 * 后续事件本仲裁器一律 no-op）；
 * pending →（超阈 move / up / cancel）settled（终态，回调让位原因）。
 * onDown 可从任意状态重新开始（重复按下重置计时）。
 * schedule/clear 可注入：fake-timer 友好。
 */

/** 让位原因：move = 超容差移动（滚动接管）/ up = 抬起（点按）/ cancel = 系统打断 */
export type TouchHoldOutcome = "move" | "up" | "cancel";

export interface TouchHoldHooks {
	/** pending → armed：调用方此刻捕获指针、启动拖卡 */
	onArmed(): void;
	/** pending 期让位（未升级成功）；outcome = 让位原因 */
	onSettled(outcome: TouchHoldOutcome): void;
}

export interface TouchHoldOptions {
	/** 长按时长（ms，默认 500） */
	holdMs?: number;
	/** pending 期位移容差（px，默认 10）：超过视为滚动手势让位 */
	moveTolerance?: number;
	/** 定时器注入（默认全局 setTimeout；测试传 fake） */
	schedule?: (fn: () => void, ms: number) => unknown;
	clear?: (handle: unknown) => void;
}

export class TouchHoldArbiter {
	private phase: "idle" | "pending" | "armed" | "settled" = "idle";
	private startX = 0;
	private startY = 0;
	private timer: unknown = null;
	private readonly holdMs: number;
	private readonly tolerance: number;
	private readonly schedule: (fn: () => void, ms: number) => unknown;
	private readonly clearTimer: (handle: unknown) => void;

	constructor(
		private readonly hooks: TouchHoldHooks,
		opts: TouchHoldOptions = {},
	) {
		this.holdMs = opts.holdMs ?? 500;
		this.tolerance = opts.moveTolerance ?? 10;
		this.schedule =
			opts.schedule ?? ((fn, ms) => globalThis.setTimeout(fn, ms));
		this.clearTimer = opts.clear ?? ((h) => globalThis.clearTimeout(h as number));
	}

	/** 当前阶段（只读，测试/诊断用） */
	get state(): "idle" | "pending" | "armed" | "settled" {
		return this.phase;
	}

	/** 按下（任意状态可重新开始）：记起点、（重）启长按计时 */
	onDown(x: number, y: number): void {
		this.clearPendingTimer();
		this.startX = x;
		this.startY = y;
		this.phase = "pending";
		this.timer = this.schedule(() => this.arm(), this.holdMs);
	}

	/** 移动：pending 期超容差让位（滚动）；armed/settled/idle 无事可做 */
	onMove(x: number, y: number): void {
		if (this.phase !== "pending") {
			return;
		}
		const dx = x - this.startX;
		const dy = y - this.startY;
		if (dx * dx + dy * dy > this.tolerance * this.tolerance) {
			this.settle("move");
		}
	}

	/** 抬起：pending 期 = 点按让位；armed 后由拖卡状态机自行处理 */
	onUp(): void {
		if (this.phase === "pending") {
			this.settle("up");
		}
	}

	/** 系统打断（来电/手势接管）：pending 期让位 */
	onCancel(): void {
		if (this.phase === "pending") {
			this.settle("cancel");
		}
	}

	/** 外部重置（拖卡结束/销毁）：清计时器回 idle，不触发任何回调 */
	reset(): void {
		this.clearPendingTimer();
		this.phase = "idle";
	}

	private arm(): void {
		this.timer = null;
		if (this.phase !== "pending") {
			return; // 计时期间已让位（settle 已清计时器，此为双保险）
		}
		this.phase = "armed";
		this.hooks.onArmed();
	}

	private settle(outcome: TouchHoldOutcome): void {
		this.clearPendingTimer();
		this.phase = "settled";
		this.hooks.onSettled(outcome);
	}

	private clearPendingTimer(): void {
		if (this.timer !== null) {
			this.clearTimer(this.timer);
			this.timer = null;
		}
	}
}
