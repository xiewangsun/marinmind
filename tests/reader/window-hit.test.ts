import { describe, expect, it } from "vitest";
import {
	clientFromScreen,
	geomOf,
	viewportOrigin,
	type WindowGeom,
} from "../../src/reader/window-hit";

/**
 * 构造典型桌面窗口几何（79-6 近似模型）：100,50 起，外框 1016×746、
 * 视口 1000×700 → 横边框均摊 8px、纵向 chrome 46px 全归顶。
 */
const GEOM: WindowGeom = {
	screenX: 100,
	screenY: 50,
	outerWidth: 1016,
	outerHeight: 746,
	innerWidth: 1000,
	innerHeight: 700,
};

describe("viewportOrigin（79-6 视口原点近似）", () => {
	it("横边框均摊、纵向 chrome 全归顶", () => {
		expect(viewportOrigin(GEOM)).toEqual({ x: 108, y: 96 });
	});

	it("奇数边框差取整（outer-inner=15 → 7.5 归 8）", () => {
		expect(viewportOrigin({ ...GEOM, outerWidth: 1015 }).x).toBe(108);
	});

	it("无 chrome（全屏 popup：outer === inner）原点即窗口原点", () => {
		expect(
			viewportOrigin({
				screenX: 0,
				screenY: 0,
				outerWidth: 800,
				outerHeight: 600,
				innerWidth: 800,
				innerHeight: 600,
			}),
		).toEqual({ x: 0, y: 0 });
	});
});

describe("clientFromScreen（79-6 屏幕坐标 → 目标窗 client）", () => {
	it("视口中心命中：屏幕坐标减视口原点", () => {
		expect(clientFromScreen(GEOM, 608, 446)).toEqual({ x: 500, y: 350 });
	});

	it("视口四角附近命中（1px 收缩内）", () => {
		expect(clientFromScreen(GEOM, 109, 97)).toEqual({ x: 1, y: 1 });
		expect(clientFromScreen(GEOM, 1106, 794)).toEqual({ x: 998, y: 698 });
	});

	it("四向出窗返回 null（含视口边缘 1px 收缩带）", () => {
		expect(clientFromScreen(GEOM, 100, 400)).toBeNull(); // 左：屏幕原点左侧区域
		expect(clientFromScreen(GEOM, 2000, 400)).toBeNull(); // 右
		expect(clientFromScreen(GEOM, 400, 10)).toBeNull(); // 上（chrome 区）
		expect(clientFromScreen(GEOM, 400, 900)).toBeNull(); // 下
		expect(clientFromScreen(GEOM, 108, 96)).toBeNull(); // 正好压原点：0,0 被收缩带挡掉
	});

	it("源窗自检用途：指针在源窗内返回非 null（hitForeignMindmap 据此走常规路径）", () => {
		// 指针在 GEOM 视口内 → 非 null；同一点对另一个不相交窗口 → null
		expect(clientFromScreen(GEOM, 608, 446)).not.toBeNull();
		const elsewhere: WindowGeom = { ...GEOM, screenX: 2000, screenY: 900 };
		expect(clientFromScreen(elsewhere, 608, 446)).toBeNull();
	});
});

describe("geomOf（几何抽取）", () => {
	it("从 Window 形状对象逐字段拷贝（测试可传 fake）", () => {
		const fake = {
			screenX: 11,
			screenY: 22,
			outerWidth: 33,
			outerHeight: 44,
			innerWidth: 21,
			innerHeight: 32,
		};
		expect(geomOf(fake)).toEqual(fake);
	});
});
