import { normalizeCategory } from "../home/home-data";

/**
 * 分类/卡组清单文件（76）：数据根 `分类.md` / `卡组.md`——用户显式创建的分组
 * 路径清单，让**空分组持久存在**（分类/卡组本体仍由 document.category /
 * card.deck 派生，清单只负责"建过就保留"）。
 *
 * 设计取舍（区别于复习日志的「机器层为锚」）：
 * - **行即权威**：每行 `- 路径`，用户手编加一行 = 建分组、删一行 = 删分组，
 *   无机器层——清单是用户会直接编辑的实体数据，行语义最自然；解析侧逐行
 *   归一化（normalizeCategory 单源，防手编变体分裂同名分组）、无效行跳过。
 * - 空清单不落盘：store 侧清空即删文件（镜像孤儿文件「清空即删」）——空清单
 *   无阅读价值，从未建过分组的库数据根保持干净。
 * - 序列化确定性：路径按拼音序（与主页文件夹树 sortCategoryNodes 同序）——
 *   同数据两次序列化字节相同（零写入契约基础）。
 * - 纯函数零 obsidian 依赖，vitest 直测（分层铁律，镜像 review-log）。
 */

/** 数据根内的分类清单文件名（与书/图/复习日志文件平级；备份 collectMdFiles 自动收） */
export const FOLDERS_FILENAME = "分类.md";

/** 数据根内的卡组清单文件名 */
export const DECKS_FILENAME = "卡组.md";

/** 分类清单的脏 scope 键（store 层 flush 分支用） */
export const FOLDERS_SCOPE = "folders";

/** 卡组清单的脏 scope 键 */
export const DECKS_SCOPE = "decks";

/** 清单种类（决定文件名与认领标记） */
export type GroupKind = "folders" | "decks";

/** kind → 文件名 */
export function groupListFilename(kind: GroupKind): string {
	return kind === "folders" ? FOLDERS_FILENAME : DECKS_FILENAME;
}

/** kind → 脏 scope */
export function groupListScope(kind: GroupKind): string {
	return kind === "folders" ? FOLDERS_SCOPE : DECKS_SCOPE;
}

/** 分组标题文案（序列化可读层） */
function groupListTitle(kind: GroupKind): string {
	return kind === "folders" ? "文档分类" : "卡组";
}

/** 分组引导文案（写明可手编与空组保留语义） */
function groupListHint(kind: GroupKind): string {
	const noun = kind === "folders" ? "分类" : "卡组";
	const entry = kind === "folders" ? "新建分类" : "新建卡组";
	return `由主页「${entry}」创建并维护；每行一个路径，支持多层（如：学习/英语）。可直接增删行，空${noun}也会保留。`;
}

/**
 * 解析清单文件：frontmatter `marinmind: folders|decks` 认领 + 每行 `- 路径`。
 * 不认领（无 frontmatter / 标记不符）返回 null——调用方（loadAll 跳过、外部
 * 修改保内存）按"宁拒不赌"处理；认领但无有效行返回 []（手编删光 = 空清单合法）。
 */
export function parseGroupListMd(text: string, kind: GroupKind): string[] | null {
	const lines = text.split(/\r?\n/);
	// frontmatter 认领：首行 --- 到闭合 ---，其中须有 marinmind: folders|decks
	if (lines[0]?.trim() !== "---") return null;
	const end = lines.findIndex((l, idx) => idx > 0 && l.trim() === "---");
	if (end < 0) return null;
	const marker = kind === "folders" ? "folders" : "decks";
	let claimed = false;
	for (let i = 1; i < end; i++) {
		if (new RegExp(`^marinmind:\\s*${marker}\\s*$`).test(lines[i])) claimed = true;
	}
	if (!claimed) return null;
	// 行解析：`- 路径` / `* 路径`（容忍缩进）；逐行归一化，无效（空/超长）跳过
	const out: string[] = [];
	const seen = new Set<string>();
	for (const line of lines) {
		const m = /^\s*[-*]\s+(.+?)\s*$/.exec(line);
		if (!m) continue;
		const normalized = normalizeCategory(m[1]);
		if (normalized === null || seen.has(normalized)) continue;
		seen.add(normalized);
		out.push(normalized);
	}
	return out;
}

/**
 * 序列化清单文件：frontmatter 认领标记 + 引导文案 + 拼音序路径行。空清单产出
 * 合法空文档（认领标记在、占位说明）——store 侧空清单走删文件不调本函数，
 * 纯函数完备性与测试圆环仍覆盖。
 */
export function serializeGroupListMd(kind: GroupKind, paths: readonly string[]): string {
	const sorted = [...paths].sort((a, b) => a.localeCompare(b, "zh-Hans-CN"));
	const out: string[] = [
		"---",
		`marinmind: ${kind === "folders" ? "folders" : "decks"}`,
		"---",
		"",
		`# ${groupListTitle(kind)}`,
		"",
		`> ${groupListHint(kind)}`,
		"",
	];
	if (sorted.length === 0) {
		out.push("（暂无分组）", "");
	}
	for (const p of sorted) {
		out.push(`- ${p}`);
	}
	out.push("");
	return out.join("\n");
}

/** 路径是否在目标子树内（自身或以「目标/」为前缀；斜杠边界——与 home-data inPathSubtree 同构，store 层内联避免跨层依赖面扩大） */
function inSubtree(path: string, target: string): boolean {
	return path === target || path.startsWith(`${target}/`);
}

/**
 * 清单增删改（store 的 addFolder/removeFoldersUnder/renameFoldersPrefix 消费）：
 * 纯函数返回新数组，无变化时原样返回引用（调用方据此免标脏）。
 */

/** 追加路径（归一化；已存在时原样返回） */
export function addToGroupList(list: readonly string[], path: string): readonly string[] {
	if (list.includes(path)) return list;
	return [...list, path];
}

/** 移除子树内全部路径（含自身；空树无变化原样返回） */
export function removeSubtreeFromGroupList(list: readonly string[], path: string): readonly string[] {
	const next = list.filter((p) => !inSubtree(p, path));
	return next.length === list.length ? list : next;
}

/** 前缀级联重命名（「学习」→「study」时「学习/英语」→「study/英语」）；无命中原样返回 */
export function renamePrefixInGroupList(
	list: readonly string[],
	oldName: string,
	newName: string,
): readonly string[] {
	let changed = false;
	const next = list.map((p) => {
		if (p === oldName) {
			changed = true;
			return newName;
		}
		if (p.startsWith(`${oldName}/`)) {
			changed = true;
			return newName + p.slice(oldName.length);
		}
		return p;
	});
	return changed ? next : list;
}

/** 清单内是否仅有自身、无子孙（"纯空组"判定——主页删除空组免确认用） */
export function groupListHasChildren(list: readonly string[], path: string): boolean {
	return list.some((p) => p.startsWith(`${path}/`));
}
