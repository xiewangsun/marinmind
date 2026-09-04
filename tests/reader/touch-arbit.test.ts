import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TouchHoldArbiter } from "../../src/reader/touch-arbit";

/** 造一个记录回调的 hooks（每用例独立） */
function makeHooks() {
	return {
		armed: vi.fn(),
		settled: vi.fn(),
	};
}

describe("TouchHoldArbiter（79-7 触摸长按仲裁）", () => {
	beforeEach(() => {
		vi.useFakeTimers();
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	it("499ms 未升级：仍在 pending，onArmed 未触发", () => {
		const h = makeHooks();
		const arb = new TouchHoldArbiter({ onArmed: h.armed, onSettled: h.settled });
		arb.onDown(100, 100);
		vi.advanceTimersByTime(499);
		expect(arb.state).toBe("pending");
		expect(h.armed).not.toHaveBeenCalled();
	});

	it("500ms 升级：onArmed 触发进入 armed（默认 holdMs）", () => {
		const h = makeHooks();
		const arb = new TouchHoldArbiter({ onArmed: h.armed, onSettled: h.settled });
		arb.onDown(100, 100);
		vi.advanceTimersByTime(500);
		expect(arb.state).toBe("armed");
		expect(h.armed).toHaveBeenCalledTimes(1);
		expect(h.settled).not.toHaveBeenCalled();
	});

	it("pending 超阈移动让位：onSettled('move')，此后计时到不再升级", () => {
		const h = makeHooks();
		const arb = new TouchHoldArbiter({ onArmed: h.armed, onSettled: h.settled });
		arb.onDown(100, 100);
		vi.advanceTimersByTime(100);
		arb.onMove(111, 100); // 位移 11px > 容差 10
		expect(arb.state).toBe("settled");
		expect(h.settled).toHaveBeenCalledWith("move");
		vi.advanceTimersByTime(500);
		expect(h.armed).not.toHaveBeenCalled();
	});

	it("阈内抖动不让位（容差 10 内）：继续等待后升级", () => {
		const h = makeHooks();
		const arb = new TouchHoldArbiter({ onArmed: h.armed, onSettled: h.settled });
		arb.onDown(100, 100);
		arb.onMove(105, 96); // 位移 √41 ≈ 6.4px < 10
		expect(arb.state).toBe("pending");
		vi.advanceTimersByTime(500);
		expect(arb.state).toBe("armed");
	});

	it("pending 抬起/取消分别让位 up/cancel", () => {
		const up = makeHooks();
		const arbUp = new TouchHoldArbiter({ onArmed: up.armed, onSettled: up.settled });
		arbUp.onDown(0, 0);
		arbUp.onUp();
		expect(up.settled).toHaveBeenCalledWith("up");

		const c = makeHooks();
		const arbC = new TouchHoldArbiter({ onArmed: c.armed, onSettled: c.settled });
		arbC.onDown(0, 0);
		arbC.onCancel();
		expect(c.settled).toHaveBeenCalledWith("cancel");
	});

	it("armed 后 move/up/cancel 一律 no-op（拖卡已接管，不让位）", () => {
		const h = makeHooks();
		const arb = new TouchHoldArbiter({ onArmed: h.armed, onSettled: h.settled });
		arb.onDown(0, 0);
		vi.advanceTimersByTime(500);
		arb.onMove(999, 999);
		arb.onUp();
		arb.onCancel();
		expect(arb.state).toBe("armed");
		expect(h.settled).not.toHaveBeenCalled();
	});

	it("重复 onDown 重置计时：旧计时作废从新按下重新计 500ms", () => {
		const h = makeHooks();
		const arb = new TouchHoldArbiter({ onArmed: h.armed, onSettled: h.settled });
		arb.onDown(0, 0);
		vi.advanceTimersByTime(300);
		arb.onDown(50, 50); // 重按：计时重启
		vi.advanceTimersByTime(300); // 距首按 600ms，距重按 300ms
		expect(arb.state).toBe("pending");
		vi.advanceTimersByTime(200);
		expect(arb.state).toBe("armed");
		// 新起点生效：容差从重按位置起算（50,50）+11px 才让位
		expect(h.armed).toHaveBeenCalledTimes(1);
	});

	it("reset() 清计时器回 idle 且不触发回调（销毁/收尾用）", () => {
		const h = makeHooks();
		const arb = new TouchHoldArbiter({ onArmed: h.armed, onSettled: h.settled });
		arb.onDown(0, 0);
		vi.advanceTimersByTime(100);
		arb.reset();
		expect(arb.state).toBe("idle");
		vi.advanceTimersByTime(500);
		expect(h.armed).not.toHaveBeenCalled();
		expect(h.settled).not.toHaveBeenCalled();
	});

	it("schedule/clear 注入可用（自驱动假时钟，不依赖全局定时器）", () => {
		const h = makeHooks();
		let fired: (() => void) | null = null;
		const arb = new TouchHoldArbiter(
			{ onArmed: h.armed, onSettled: h.settled },
			{
				holdMs: 250,
				schedule: (fn) => {
					fired = fn;
					return "handle-1";
				},
				clear: vi.fn(),
			},
		);
		arb.onDown(0, 0);
		expect(fired).not.toBeNull();
		expect(arb.state).toBe("pending");
		fired?.(); // 手动触发定时
		expect(arb.state).toBe("armed");
		expect(h.armed).toHaveBeenCalledTimes(1);
	});
});
