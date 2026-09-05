/**
 * 套索摘录：simplifyPath + pathToNormPolygon 纯函数测试
 *
 * 目标：验证路径抽稀与归一化多边形/包围盒计算正确性（保持原始轮廓，
 * 不做凸包近似），与具体渲染环境解耦。
 */
import { describe, it, expect } from "vitest";
import { simplifyPath, pathToNormPolygon } from "../../src/reader/lasso-tracker";

describe("simplifyPath", () => {
	it("近邻点抽稀：阈值内中间点丢弃，首末点必留", () => {
		const pts = [
			{ x: 0, y: 0 },
			{ x: 0.5, y: 0.5 }, // 距起点 0.707 < 2 → 丢
			{ x: 1, y: 1 }, // 距起点 1.41 < 2 → 丢
			{ x: 10, y: 10 }, // 保留
			{ x: 10.5, y: 10.5 }, // 距 (10,10) 0.707 < 2 → 丢
			{ x: 20, y: 20 }, // 末点必留
		];
		const out = simplifyPath(pts, 2);
		expect(out).toEqual([
			{ x: 0, y: 0 },
			{ x: 10, y: 10 },
			{ x: 20, y: 20 },
		]);
	});

	it("少于三点原样返回拷贝", () => {
		const pts = [
			{ x: 0, y: 0 },
			{ x: 3, y: 3 },
		];
		const out = simplifyPath(pts, 2);
		expect(out).toEqual(pts);
		expect(out).not.toBe(pts); // 拷贝不共享引用
	});
});

describe("pathToNormPolygon", () => {
	it("空/两点/共线 → null", () => {
		expect(pathToNormPolygon([], 100, 100)).toBeNull();
		expect(
			pathToNormPolygon(
				[
					{ x: 0, y: 0 },
					{ x: 1, y: 1 },
				],
				100,
				100,
			),
		).toBeNull();
	});

	it("小抖动（< 2px 包围盒）→ null", () => {
		const pts = [
			{ x: 10, y: 10 },
			{ x: 11, y: 10 },
			{ x: 11, y: 11 },
			{ x: 10, y: 11 },
		];
		expect(pathToNormPolygon(pts, 100, 100)).toBeNull();
	});

	it("正方形 → 顶点归一 + bbox 覆盖", () => {
		const pts = [
			{ x: 20, y: 20 },
			{ x: 80, y: 20 },
			{ x: 80, y: 80 },
			{ x: 20, y: 80 },
		];
		const shape = pathToNormPolygon(pts, 100, 100)!;
		expect(shape.polygon).toHaveLength(4);
		expect(shape.polygon[0]).toEqual({ x: 0.2, y: 0.2 });
		expect(shape.bbox).toEqual({ x: 0.2, y: 0.2, w: 0.6, h: 0.6 });
	});

	it("菱形 → 顶点原样保留（与凸包近似的本质差异），bbox 为 AABB", () => {
		const pts = [
			{ x: 50, y: 10 }, // 顶
			{ x: 90, y: 50 }, // 右
			{ x: 50, y: 90 }, // 底
			{ x: 10, y: 50 }, // 左
		];
		const shape = pathToNormPolygon(pts, 100, 100)!;
		expect(shape.polygon).toHaveLength(4);
		expect(shape.polygon.map((p) => p.x)).toEqual([0.5, 0.9, 0.5, 0.1]);
		expect(shape.bbox.x).toBeCloseTo(0.1, 2);
		expect(shape.bbox.w).toBeCloseTo(0.8, 2);
	});

	it("凹多边形（L 形）→ 顶点不丢失", () => {
		const pts = [
			{ x: 10, y: 10 },
			{ x: 90, y: 10 },
			{ x: 90, y: 90 },
			{ x: 50, y: 90 },
			{ x: 50, y: 50 }, // 凹点，凸包实现会把它磨掉
			{ x: 10, y: 50 },
		];
		const shape = pathToNormPolygon(pts, 100, 100)!;
		expect(shape.polygon).toHaveLength(6);
		expect(shape.polygon[4]).toEqual({ x: 0.5, y: 0.5 });
	});
});
