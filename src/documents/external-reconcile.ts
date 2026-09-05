/**
 * 库外文档对账决策（㊳ fs watcher 自动跟随）：
 * 旧路径消失时判断"该记录应该跟随哪个新文件"。
 * 纯函数零依赖（镜像 relink.ts 分层），vitest 直测。
 *
 * 判定哲学 = 宁拒不赌（与 planRelink 一致）：
 * - 旧路径仍在 → none（无事发生）
 * - 消失 + 同目录恰一个新增 pdf（不在任何记录、不在上次快照）→ follow（自动跟随改名）
 * - 消失且无候选 → missing（跨目录移动也落此——新目录无从猜测，刻意不赌）
 * - 候选或失联 ≥2 → ambiguous（无法确定对应关系，只提示手动重关联）
 */

/** 库外文档记录的最小画像（对账只需要这两样） */
export interface ExternalRecordInput {
	id: string;
	filePath: string;
}

/** 单条记录的对账决策 */
export type ExternalReconcileDecision =
	| { kind: "none"; index: number }
	| { kind: "follow"; index: number; newPath: string }
	| { kind: "missing"; index: number }
	| { kind: "ambiguous"; index: number; reason: string };

/**
 * 库外绝对路径的父目录（`\`/`/` 通吃）：保留结尾分隔符（`D:\books\a.pdf` → `D:\books\`），
 * 便于 拼回路径 与 作为目录键 统一同源；无分隔符返回空串（不会匹配任何观察目录）。
 */
export function externalParentDir(absPath: string): string {
	let i = absPath.length - 1;
	while (i >= 0 && absPath[i] !== "/" && absPath[i] !== "\\") {
		i--;
	}
	if (i <= 0) {
		return i === 0 ? absPath.slice(0, 1) : "";
	}
	return absPath.slice(0, i + 1);
}

/** 库外绝对路径的末段文件名（镜像 externalParentDir 的切分逻辑） */
export function externalBasename(absPath: string): string {
	return absPath.slice(externalParentDir(absPath).length);
}

/**
 * 对账决策主体。
 * @param input.records 库外记录集
 * @param input.exists 与 records 对齐：旧路径当前是否存在
 * @param input.dirFiles 目录 → 当前 pdf 文件名集合（保留原名；比较时小写归一）
 * @param input.dirFilesBefore 目录 → 上次对账（或建观察）时的 pdf 集合；
 *   缺目录 = 快照缺失，无法判定何为"新增"，保守按无候选处理（只报失联不自动跟）
 * @returns 与 records 顺序对齐的决策数组
 */
export function planExternalReconcile(input: {
	records: ExternalRecordInput[];
	exists: boolean[];
	dirFiles: Map<string, Set<string>>;
	dirFilesBefore: Map<string, Set<string>>;
}): ExternalReconcileDecision[] {
	const { records, exists, dirFiles, dirFilesBefore } = input;
	const decisions: ExternalReconcileDecision[] = records.map((_, i) => ({
		kind: "none",
		index: i,
	}));

	// 全部记录的 basename 集合（小写归一）：与任一记录同名的新文件不算候选——
	// 它更可能是另一条记录的跨目录移动，归属不明宁拒不赌
	const recordedBasenames = new Set(
		records.map((r) => externalBasename(r.filePath).toLowerCase()),
	);

	// 按父目录分组失联记录（同目录内配对判定）
	const missingByDir = new Map<string, number[]>();
	for (let i = 0; i < records.length; i++) {
		if (exists[i]) {
			continue;
		}
		const dir = externalParentDir(records[i].filePath);
		const list = missingByDir.get(dir) ?? [];
		list.push(i);
		missingByDir.set(dir, list);
	}

	for (const [dir, missing] of missingByDir) {
		// 候选新增 = 当前集合 − 上次快照 − 已被任何记录占用的名字（比较全部小写归一）
		const before = dirFilesBefore.get(dir);
		const now = dirFiles.get(dir);
		const candidates: string[] = [];
		if (before && now) {
			const beforeLower = new Set([...before].map((n) => n.toLowerCase()));
			for (const name of now) {
				const lower = name.toLowerCase();
				if (!beforeLower.has(lower) && !recordedBasenames.has(lower)) {
					candidates.push(name);
				}
			}
		}
		if (missing.length === 1 && candidates.length === 1) {
			// 唯一失联 × 唯一新增：跟随（目录键带结尾分隔符，直接拼接）
			decisions[missing[0]] = {
				kind: "follow",
				index: missing[0],
				newPath: dir + candidates[0],
			};
			continue;
		}
		for (const i of missing) {
			decisions[i] =
				candidates.length === 0
					? { kind: "missing", index: i }
					: {
							kind: "ambiguous",
							index: i,
							reason: "同目录存在多个失联记录或多个新增文件，无法确定对应关系",
						};
		}
	}
	return decisions;
}
