import { describe, expect, it } from "vitest";
import { CardEventBus } from "../../src/events/card-bus";
import type { Card } from "../../src/types";

function makeCard(id = "c1"): Card {
	return {
		id,
		documentId: null,
		page: 1,
		rects: [],
		excerptType: "area",
		excerptText: null,
		excerptRef: null,
		note: null,
		color: "yellow",
		tags: [],
		createdAt: 0,
		updatedAt: 0,
	};
}

describe("CardEventBus", () => {
	it("changed：订阅后 emit 收到卡片；退订后不再收到", () => {
		const bus = new CardEventBus();
		const got: string[] = [];
		const off = bus.onCardChanged((card) => got.push(card.id));
		bus.emitCardChanged(makeCard("a"));
		off();
		bus.emitCardChanged(makeCard("b"));
		expect(got).toEqual(["a"]);
	});

	it("removed：携带删除前快照 last", () => {
		const bus = new CardEventBus();
		let last: Card | undefined;
		bus.onCardRemoved((_id, l) => {
			last = l;
		});
		const victim = makeCard("x");
		bus.emitCardRemoved("x", victim);
		expect(last).toBe(victim);
	});

	it("多订阅者均收到（脑图 + 多个阅读标签）", () => {
		const bus = new CardEventBus();
		let n = 0;
		const off1 = bus.onCardChanged(() => ++n);
		const off2 = bus.onCardChanged(() => ++n);
		bus.emitCardChanged(makeCard());
		expect(n).toBe(2);
		off1();
		bus.emitCardChanged(makeCard());
		expect(n).toBe(3);
		off2();
	});

	it("changed 与 removed 互不串扰", () => {
		const bus = new CardEventBus();
		const events: string[] = [];
		bus.onCardChanged(() => events.push("changed"));
		bus.onCardRemoved(() => events.push("removed"));
		bus.emitCardRemoved("a", makeCard("a"));
		expect(events).toEqual(["removed"]);
	});
});
