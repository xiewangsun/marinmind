import { describe, expect, it } from "vitest";
import { parseJsonLoose } from "../../src/ai/ai-json";

describe("parseJsonLoose", () => {
	it("纯 JSON 直接解析（主流路径）", () => {
		expect(parseJsonLoose('{"a":1}')).toEqual({ a: 1 });
		expect(parseJsonLoose(' [1, 2, "x"] ')).toEqual([1, 2, "x"]);
	});

	it("```json 围栏剥离后解析（模型最常见的不听话形态）", () => {
		expect(parseJsonLoose('```json\n{"a":1}\n```')).toEqual({ a: 1 });
		// 无语言标注的围栏同样支持
		expect(parseJsonLoose("```\n[1,2]\n```")).toEqual([1, 2]);
	});

	it("围栏内是坏 JSON 时继续降级到首尾截取", () => {
		// 围栏包裹 + 前后解释文字的复合形态
		const raw = '好的，以下是结果：```json\n[{"q":"a"}]\n``` 希望有帮助';
		expect(parseJsonLoose(raw)).toEqual([{ q: "a" }]);
	});

	it("前后杂文本：截取首个 { 到末个 } / 首个 [ 到末个 ]", () => {
		expect(parseJsonLoose('结果如下：{"a":{"b":1}} 完毕')).toEqual({ a: { b: 1 } });
		expect(parseJsonLoose("列表是 [1, 2, 3] 请查收")).toEqual([1, 2, 3]);
	});

	it("对象与数组同时出现：按先出现者定类型并配对同型末位", () => {
		// { 在前：取 {...}，不误吞后面的数组
		expect(parseJsonLoose('x {"a":[1]} y [2]')).toEqual({ a: [1] });
		// [ 在前：取 [...]，对象在数组内部
		expect(parseJsonLoose('x [{"a":1}] y {"b":2}')).toEqual([{ a: 1 }]);
	});

	it("空串抛中文错", () => {
		expect(() => parseJsonLoose("")).toThrow("AI 返回内容为空");
		expect(() => parseJsonLoose("   ")).toThrow("AI 返回内容为空");
	});

	it("全部降级失败抛中文重试引导", () => {
		expect(() => parseJsonLoose("抱歉，我无法生成。")).toThrow(
			"AI 返回内容无法解析为结构化数据",
		);
		// 只有起始没有闭合：截取仍失败
		expect(() => parseJsonLoose("开头 {没闭合")).toThrow("无法解析为结构化数据");
	});
});
