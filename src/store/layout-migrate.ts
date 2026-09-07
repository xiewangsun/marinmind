import type { ListableStorageAdapter } from "../storage/vault-rooted-adapter";
import { DECKS_FILENAME, FOLDERS_FILENAME } from "./group-list";
import { REVIEW_LOG_FILENAME } from "./review-log";
import { BOOKS_SUBDIR, LEGACY_MINDMAPS_SUBDIR, MINDMAPS_SUBDIR } from "./book-format";

/**
 * 数据目录布局 v1 → v2 一次性迁移（123）：
 * - v1（旧）：书 md 平铺数据根 + 脑图在中文目录「脑图/」；
 * - v2（新）：书 md（含 未归类卡片.md）归 books/、脑图归 mindmaps/；
 *   复习日志.md / 分类.md / 卡组.md 等系统文件留根，assets/ 与快照不动。
 *
 * 设计要点：
 * - **启动自动执行**（MarinMindStore.open 内、loadAll 之前），每次运行幂等——
 *   已迁移库根层无书 md、无 脑图/ 子目录，扫描即零动作。
 * - **崩溃安全**：逐文件 copy + delete；中断在 copy 与 delete 之间时，下次
 *   运行发现源与目标同名同内容，补删源即收敛（见 conflicts 分支）。
 * - **只搬 MarinMind 书文件**：根层 md 逐一探针 frontmatter（marinmind: book），
 *   用户放进数据根的普通笔记不动；系统文件名（复习日志/分类/卡组）直接排除。
 * - 内存索引键（booksByPath 等）在迁移后的 loadAll 重建，迁移本身无需触碰
 *   store 内存态；frontmatter 的 file_path 是文档本体（PDF）路径而非书 md 自身
 *   路径，迁移不涉及文档业务键。
 */
export interface LayoutMovePlan {
	/** 源路径（数据根相对） */
	from: string;
	/** 目标路径（数据根相对） */
	to: string;
}

/** planLayoutMigration 的输入（执行器完成内容探针与目标存在性收集后传入） */
export interface LayoutPlanInput {
	/** 根层已判定为 MarinMind 书 md 的文件（数据根相对路径） */
	booksAtRoot: string[];
	/** 旧「脑图/」子目录下的直接文件（全量搬移——该目录为插件专属） */
	mindmapsAtLegacy: string[];
	/** 目标位置已存在的路径（books/ 与 mindmaps/ 现有文件并集） */
	existing: ReadonlySet<string>;
}

/** 布局迁移计划：moves 可直接执行；conflicts 目标同名需执行器读字节判同异 */
export interface LayoutMigrationPlan {
	moves: LayoutMovePlan[];
	conflicts: LayoutMovePlan[];
}

/** 迁移执行结果（全零 = 已是 v2 布局；main.ts 据此发 Notice） */
export interface LayoutMigrationResult {
	/** 迁入 books/ 的书 md 个数（含 未归类卡片.md 与中断搬迁的补删收敛） */
	booksMoved: number;
	/** 脑图/ → mindmaps/ 迁移个数 */
	mapsMoved: number;
	/** 目标同名且内容不同而跳过的文件数（源文件留在原处照常可用） */
	conflictsSkipped: number;
}

/**
 * 根层 md 是否为 MarinMind 书文件（frontmatter `marinmind: book`）。
 * 轻量探针不整篇 parseBookMd——迁移只搬书文件，用户普通笔记不动。
 * 探针失灵（手编把 marinmind 行挪出 frontmatter 等）的最坏结果是文件
 * 留在根层：loadAll 对根层书 md 仍认领（兜底），下次启动迁移再试。
 */
export function isBookMdText(text: string): boolean {
	const lines = text.split(/\r?\n/, 60); // frontmatter 远短于 60 行，提前截断省内存
	if (lines[0]?.trim() !== "---") return false;
	for (let i = 1; i < lines.length; i++) {
		const line = lines[i];
		if (line.trim() === "---") return false; // frontmatter 结束仍未命中
		if (/^marinmind:\s?book\s*$/.test(line)) return true;
	}
	return false;
}

/** 纯函数：由已探明的输入生成迁移计划（测试锁定；目标同名进 conflicts） */
export function planLayoutMigration(input: LayoutPlanInput): LayoutMigrationPlan {
	const moves: LayoutMovePlan[] = [];
	const conflicts: LayoutMovePlan[] = [];
	for (const from of input.booksAtRoot) {
		const to = `${BOOKS_SUBDIR}/${from}`;
		(input.existing.has(to) ? conflicts : moves).push({ from, to });
	}
	for (const from of input.mindmapsAtLegacy) {
		const name = from.slice(LEGACY_MINDMAPS_SUBDIR.length + 1);
		const to = `${MINDMAPS_SUBDIR}/${name}`;
		(input.existing.has(to) ? conflicts : moves).push({ from, to });
	}
	return { moves, conflicts };
}

/**
 * 备份包 note 路径布局归一（123，纯函数）：旧 v2 包的平铺书 md → books/、
 * 「脑图/」前缀 → mindmaps/；系统文件与新布局路径原样返回。导入端使用，
 * 不升 BACKUP_VERSION（zip 内路径仅是落点提示，内容自描述）。
 */
export function normalizeBackupNotePath(path: string, bytes: Uint8Array): string {
	if (path.startsWith(`${LEGACY_MINDMAPS_SUBDIR}/`)) {
		return `${MINDMAPS_SUBDIR}/${path.slice(LEGACY_MINDMAPS_SUBDIR.length + 1)}`;
	}
	// 仅根层 md 需要探针：子目录路径（books/…、pre-import-snapshot/…）已是分层形态
	if (!path.includes("/") && path.endsWith(".md") && isBookMdText(decode(bytes))) {
		return `${BOOKS_SUBDIR}/${path}`;
	}
	return path;
}

/** 数据根根层的系统数据文件（迁移与书 md 探针双重排除） */
const SYSTEM_FILENAMES = new Set([REVIEW_LOG_FILENAME, FOLDERS_FILENAME, DECKS_FILENAME]);

/**
 * 执行布局迁移（MarinMindStore.open 在 loadAll 前调用）。
 * 任何单文件失败不中断整体（catch 计入 conflictsSkipped 语义的跳过面），
 * 下一轮启动对剩余文件续跑。
 */
export async function runLayoutMigration(
	adapter: ListableStorageAdapter,
): Promise<LayoutMigrationResult> {
	const result: LayoutMigrationResult = { booksMoved: 0, mapsMoved: 0, conflictsSkipped: 0 };
	const root = await adapter.list("");

	// 根层书 md 探针：md 且非系统文件才读字节（普通笔记不读不搬）
	const booksAtRoot: string[] = [];
	for (const file of root.files) {
		if (!file.endsWith(".md") || file.includes("/") || SYSTEM_FILENAMES.has(file)) continue;
		try {
			if (isBookMdText(decode(await adapter.readBinary(file)))) booksAtRoot.push(file);
		} catch (err) {
			console.warn("[MarinMind] 布局迁移探针失败（文件留在原处）", file, err);
		}
	}

	const [legacyDir, booksDir, mmDir] = await Promise.all([
		adapter.list(LEGACY_MINDMAPS_SUBDIR),
		adapter.list(BOOKS_SUBDIR),
		adapter.list(MINDMAPS_SUBDIR),
	]);
	const plan = planLayoutMigration({
		booksAtRoot,
		mindmapsAtLegacy: legacyDir.files,
		existing: new Set([...booksDir.files, ...mmDir.files]),
	});

	for (const move of plan.moves) {
		try {
			await moveFile(adapter, move);
			countMove(move, result);
		} catch (err) {
			console.warn("[MarinMind] 布局迁移搬迁失败（下次启动续跑）", move.from, err);
		}
	}
	for (const move of plan.conflicts) {
		try {
			// 同名同内容 = 上次搬迁在 copy 与 delete 之间中断 → 补删源即收敛；
			// 内容不同（用户在两处各有同名文件）→ 跳过，源文件留原处照常被认领
			if (await sameContent(adapter, move.from, move.to)) {
				await adapter.remove(move.from);
				countMove(move, result);
			} else {
				result.conflictsSkipped++;
			}
		} catch (err) {
			console.warn("[MarinMind] 布局迁移冲突判定失败（跳过）", move.from, err);
			result.conflictsSkipped++;
		}
	}

	// 搬空后清理旧目录（尽力而为：适配器不支持 rmdir 或目录非空则静默保留）
	if (legacyDir.files.length > 0 && legacyDir.folders.length === 0) {
		try {
			const remaining = await adapter.list(LEGACY_MINDMAPS_SUBDIR);
			if (remaining.files.length === 0 && remaining.folders.length === 0) {
				await adapter.rmdir?.(LEGACY_MINDMAPS_SUBDIR);
			}
		} catch {
			// 目录残留无害（loadAll 不扫描该目录）
		}
	}
	return result;
}

/** copy + delete 搬迁单文件（writeBinary 自动建父目录；中断由 conflicts 分支收敛） */
async function moveFile(adapter: ListableStorageAdapter, move: LayoutMovePlan): Promise<void> {
	const bytes = await adapter.readBinary(move.from);
	await adapter.writeBinary(move.to, bytes.slice(0));
	await adapter.remove(move.from);
}

/** 两文件字节逐一相同（冲突收敛判定） */
async function sameContent(
	adapter: ListableStorageAdapter,
	a: string,
	b: string,
): Promise<boolean> {
	const [x, y] = await Promise.all([adapter.readBinary(a), adapter.readBinary(b)]);
	if (x.byteLength !== y.byteLength) return false;
	const ux = new Uint8Array(x);
	const uy = new Uint8Array(y);
	for (let i = 0; i < ux.length; i++) {
		if (ux[i] !== uy[i]) return false;
	}
	return true;
}

function countMove(move: LayoutMovePlan, result: LayoutMigrationResult): void {
	if (move.to.startsWith(`${BOOKS_SUBDIR}/`)) result.booksMoved++;
	else result.mapsMoved++;
}

function decode(data: ArrayBuffer | Uint8Array): string {
	return new TextDecoder().decode(data);
}
