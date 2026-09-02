import { describe, expect, it } from "vitest";
import {
	DECKS_FILENAME,
	FOLDERS_FILENAME,
	addToGroupList,
	groupListFilename,
	groupListHasChildren,
	parseGroupListMd,
	removeSubtreeFromGroupList,
	renamePrefixInGroupList,
	serializeGroupListMd,
} from "../../src/store/group-list";

/** 标准清单文件样例（serialize 产物形制） */
function sampleFoldersMd(): string {
	return serializeGroupListMd("folders", ["学习", "学习/英语"]);
}

describe("group-list 解析（76）", () => {
	it("frontmatter 认领 + 行解析（folders/decks 各自标记）", () => {
		expect(parseGroupListMd(sampleFoldersMd(), "folders")).toEqual(["学习", "学习/英语"]);
		expect(parseGroupListMd(serializeGroupListMd("decks", ["英语"]), "decks")).toEqual(["英语"]);
	});

	it("标记不符（folders 文件按 decks 解析）不认领 → null", () => {
		expect(parseGroupListMd(sampleFoldersMd(), "decks")).toBeNull();
	});

	it("无 frontmatter / 无闭合 --- → null（普通笔记不认领）", () => {
		expect(parseGroupListMd("# 分类\n- 学习", "folders")).toBeNull();
		expect(parseGroupListMd("---\nmarinmind: folders", "folders")).toBeNull();
	});

	it("认领但无有效行 → []（手编删光 = 空清单合法）", () => {
		expect(parseGroupListMd(sampleFoldersMd().split("\n").slice(0, 4).join("\n"), "folders")).toEqual([]);
	});

	it("行归一化（空白变体归并）+ 去重 + 无效行跳过", () => {
		const md = [
			"---",
			"marinmind: folders",
			"---",
			"- 学习  /英语", // 段内空白折叠 → 学习/英语
			"- 学习/英语", // 与上行归一后重复 → 去重
			"-   ", // 空白行（归一 null）跳过
			"* 工作", // * 开头同样认
			"普通文字行不认", // 非列表行跳过
			"",
		].join("\n");
		expect(parseGroupListMd(md, "folders")).toEqual(["学习/英语", "工作"]);
	});
});

describe("group-list 序列化（76）", () => {
	it("确定性：同数据两次序列化字节相同；路径按拼音序", () => {
		const a = serializeGroupListMd("decks", ["英语", "工作", "学习"]);
		const b = serializeGroupListMd("decks", ["学习", "英语", "工作"]);
		expect(a).toBe(b);
		// 用「- 」列表行前缀定位——头部提示文案含示例路径会干扰裸 indexOf
		// 拼音序：工作(g) < 学习(x) < 英语(y)
		expect(a.indexOf("- 工作")).toBeLessThan(a.indexOf("- 学习"));
		expect(a.indexOf("- 学习")).toBeLessThan(a.indexOf("- 英语"));
	});

	it("roundtrip：parse(serialize(x)) === x（按拼音序排序后）", () => {
		const paths = ["学习", "学习/英语", "工作"];
		// serialize 内部按拼音序排序（工作 g < 学习 x），roundtrip 结果即排序序
		expect(parseGroupListMd(serializeGroupListMd("folders", paths), "folders")).toEqual([
			"工作",
			"学习",
			"学习/英语",
		]);
	});

	it("空清单产出合法空文档（认领标记在）", () => {
		const md = serializeGroupListMd("folders", []);
		expect(parseGroupListMd(md, "folders")).toEqual([]);
	});

	it("kind → 文件名", () => {
		expect(groupListFilename("folders")).toBe(FOLDERS_FILENAME);
		expect(groupListFilename("decks")).toBe(DECKS_FILENAME);
	});
});

describe("group-list 增删改纯函数（76）", () => {
	it("addToGroupList：追加；已存在返回原引用（零写入判定依据）", () => {
		const list = ["学习"];
		expect(addToGroupList(list, "工作")).toEqual(["学习", "工作"]);
		expect(addToGroupList(list, "学习")).toBe(list);
	});

	it("removeSubtreeFromGroupList：移除子树（含自身）；无命中原引用", () => {
		const list = ["学习", "学习/英语", "工作"];
		expect(removeSubtreeFromGroupList(list, "学习")).toEqual(["工作"]);
		// 斜杠边界：「学」不匹配「学习」
		const l2 = ["学习"];
		expect(removeSubtreeFromGroupList(l2, "学")).toBe(l2);
	});

	it("renamePrefixInGroupList：前缀级联（自身替换 + 子路径跟随）；无命中原引用", () => {
		const list = ["学习", "学习/英语", "工作"];
		expect(renamePrefixInGroupList(list, "学习", "study")).toEqual(["study", "study/英语", "工作"]);
		const l2 = ["工作"];
		expect(renamePrefixInGroupList(l2, "学习", "study")).toBe(l2);
	});

	it("groupListHasChildren：仅严格子孙（斜杠边界），自身不算", () => {
		const list = ["学习", "学习/英语", "学"];
		expect(groupListHasChildren(list, "学习")).toBe(true);
		expect(groupListHasChildren(list, "学")).toBe(false); // 「学习」非「学/」前缀
		expect(groupListHasChildren(list, "工作")).toBe(false);
	});
});
