import { MarinMindDatabase } from "../db/database";
import { DB_FILENAME } from "../constants";
import { normalizeAssetRef } from "../storage/paths";
import { isBranchStyle, type BranchStyle } from "../types";
import type {
	BookDocument,
	Card,
	CardLink,
	DocumentBookmark,
	Mindmap,
	MindmapNode,
	ReviewState,
	SrsPhase,
} from "../types";
import type { StorageAdapter } from "../storage/adapter";
import type { ListableStorageAdapter } from "../storage/vault-rooted-adapter";
import { MarinMindStore, type LegacyImportData } from "./marinmind-store";

/**
 * 旧版 SQLite 数据读取与转换（㉚ 迁移期保留 sql.js）：
 * - 启动检测到旧库（数据根或历史默认目录 .marinmind/ 下的 marinmind.db）→ main.ts 引导迁移；
 * - v1 备份包兼容导入（backup-service）读包内 marinmind.db 复用本转换。
 *
 * 旧库经 applyMigrations 在内存升到 schema v8 后读取（不回写文件），字段映射零业务改写；
 * excerpt_ref 归一为数据根相对路径（旧前缀 .marinmind/assets/ 剥离）。
 */

/** 复习阶段合法集（旧库 CHECK 保证；转换层再归一一次防御历史脏值） */
const SRS_PHASES = new Set<string>(["new", "learning", "review", "relearning"]);

/**
 * 打开旧 SQLite 库（存在性由调用方检测）。迁移链在内存应用，不回写源文件。
 * WASM 二进制按需取用：插件 bundle（CJS require 可用）内联进产物；Node/vitest
 * 环境省略，由 sql.js 自行定位——静态 import 会让 vitest 尝试以 ESM 解析 .wasm 而崩。
 */
export async function openLegacyDb(
	adapter: ListableStorageAdapter,
	path = "marinmind.db",
): Promise<MarinMindDatabase> {
	let wasmBinary: Uint8Array | undefined;
	if (typeof require === "function") {
		try {
			// esbuild CJS 产物会内联解析此相对 require（binary loader 打包 .wasm）
			wasmBinary = (require("../db/wasm-bytes") as { default: Uint8Array }).default;
		} catch {
			// vitest 等 ESM 环境：require 形态存在但解析不了相对模块——交给 sql.js 自行定位
		}
	}
	return MarinMindDatabase.open({
		adapter,
		path,
		...(wasmBinary ? { wasmBinary } : {}),
	});
}

/** 打开库字节（v1 备份包内的 marinmind.db；只读，不回写） */
export async function openLegacyDbBytes(dbBytes: Uint8Array): Promise<MarinMindDatabase> {
	const adapter: StorageAdapter = {
		exists: (path) => Promise.resolve(path === DB_FILENAME),
		mkdir: () => Promise.resolve(),
		readBinary: (path) =>
			path === DB_FILENAME
				? Promise.resolve(dbBytes.slice().buffer as ArrayBuffer)
				: Promise.reject(new Error(`文件不存在: ${path}`)),
		writeBinary: () => Promise.resolve(), // 转换只读，不会触发
	};
	return openLegacyDb(adapter as ListableStorageAdapter, DB_FILENAME);
}

/** v1 备份包库字节 → md 文件集：临时内存 store 灌入落盘（书/图 wikilink 全格式序列化） */
export async function legacyDbBytesToNotes(
	dbBytes: Uint8Array,
): Promise<{ notes: { path: string; bytes: Uint8Array }[]; warnings: string[] }> {
	const db = await openLegacyDbBytes(dbBytes);
	let converted: ReturnType<typeof convertLegacyDb>;
	try {
		converted = convertLegacyDb(db);
	} finally {
		db.close();
	}
	const mem = new MemoryStorageAdapter();
	const store = await MarinMindStore.open(mem);
	const result = store.importLegacy(converted);
	await store.flush();
	store.close();
	return {
		notes: [...mem.files.entries()].map(([path, data]) => ({
			path,
			bytes: new Uint8Array(data),
		})),
		warnings: [...converted.warnings, ...result.warnings],
	};
}

/**
 * 全内存可列举适配器（legacyDbBytesToNotes 的中转落盘目标；不进生产数据路径）。
 * list 语义与 VaultRootedAdapter 一致：返回含目录前缀的完整相对路径。
 */
class MemoryStorageAdapter implements ListableStorageAdapter {
	readonly files = new Map<string, ArrayBuffer>();

	exists(path: string): Promise<boolean> {
		return Promise.resolve(this.files.has(path));
	}
	mkdir(): Promise<void> {
		return Promise.resolve();
	}
	readBinary(path: string): Promise<ArrayBuffer> {
		const data = this.files.get(path);
		return data ? Promise.resolve(data) : Promise.reject(new Error(`文件不存在: ${path}`));
	}
	writeBinary(path: string, data: ArrayBuffer): Promise<void> {
		this.files.set(path, data);
		return Promise.resolve();
	}
	remove(path: string): Promise<void> {
		this.files.delete(path);
		return Promise.resolve();
	}
	list(dir: string): Promise<{ files: string[]; folders: string[] }> {
		const prefix = dir ? `${dir}/` : "";
		const files: string[] = [];
		const folders: string[] = [];
		for (const p of this.files.keys()) {
			if (!p.startsWith(prefix)) continue;
			const rest = p.slice(prefix.length);
			const slash = rest.indexOf("/");
			if (slash >= 0) {
				const folder = prefix + rest.slice(0, slash);
				if (!folders.includes(folder)) folders.push(folder);
			} else {
				files.push(p);
			}
		}
		return Promise.resolve({ files, folders });
	}
}

/** 旧库全量行 → md 数据集。warnings 收集转换期异常（JSON 损坏等），不中断整体。 */
export function convertLegacyDb(db: MarinMindDatabase): LegacyImportData & { warnings: string[] } {
	const warnings: string[] = [];

	interface DocumentRow {
		id: string;
		title: string;
		file_path: string;
		created_at: number;
		updated_at: number;
	}
	const documents: BookDocument[] = db
		.all<DocumentRow>("SELECT id, title, file_path, created_at, updated_at FROM documents ORDER BY created_at, id")
		.map((r) => ({
			id: r.id,
			filePath: r.file_path,
			title: r.title,
			category: null, // 旧库无分类列（㉟ 新增字段，导入文档一律未分类）
			collectMapId: null, // 旧库无摘录目标覆盖列（㊴），导入一律用同名默认图
			autoFlashcard: false, // 旧库无自动转闪卡开关（㊷），导入一律关闭
			lastPage: null, // 旧库无阅读页码列（80），导入一律从头读起
			createdAt: r.created_at,
			updatedAt: r.updated_at,
		}));

	interface CardRow {
		id: string;
		document_id: string | null;
		page: number | null;
		rects: string;
		excerpt_type: string;
		excerpt_text: string | null;
		excerpt_ref: string | null;
		note: string | null;
		color: string | null;
		tags: string;
		polygon: string | null;
		created_at: number;
		updated_at: number;
	}
	const cards: Card[] = db
		.all<CardRow>("SELECT * FROM cards ORDER BY created_at, id")
		.map((r) => ({
			id: r.id,
			documentId: r.document_id,
			page: r.page,
			rects: parseJsonArray(r.rects, "rects", r.id, warnings),
			excerptType: r.excerpt_type as Card["excerptType"], // 旧库 CHECK 保证合法
			polygon: r.polygon ? parseJsonArray(r.polygon, "polygon", r.id, warnings) : null,
			excerptText: r.excerpt_text,
			excerptRef: r.excerpt_ref ? normalizeAssetRef(r.excerpt_ref) : null,
			note: r.note,
			// ㊹ 读取归一：旧库文字摘录的 blue 视觉一直是黄（MN 黄历史值），
			// 四色化后 blue = 浅蓝真义，导入时归一为 yellow（与 book-format 解析同源）
			color: r.color === "blue" ? "yellow" : r.color,
			lineStyle: null, // 旧库无线型列（77），导入一律下划线
			occlusions: [], // 旧库无遮挡列（㊷），导入一律无遮挡
			title: null, // 旧库无标题列（㊺），导入一律无标题
			deck: null, // 旧库无卡组（本次新增），导入一律未分组
			tags: parseTags(r.tags, r.id, warnings),
			createdAt: r.created_at,
			updatedAt: r.updated_at,
		}));

// 81 书名分组卡标记：旧库组卡（同书 page null + 文本恰为《书名》）导入即标记，
// 与 book-format 解析层推导同源——否则导入落盘的 md 首载前仍漏进卡片视角
const titleById = new Map(documents.map((d) => [d.id, d.title]));
for (const c of cards) {
	if (
		c.page == null &&
		c.documentId != null &&
		c.excerptType === "text" &&
		c.excerptText === `《${titleById.get(c.documentId) ?? ""}》`
	) {
		c.group = true;
	}
}

	interface LinkRow {
		id: string;
		source_id: string;
		target_id: string;
		created_at: number;
	}
	const links: CardLink[] = db
		.all<LinkRow>("SELECT id, source_id, target_id, created_at FROM card_links ORDER BY created_at, id")
		.map((r) => ({ id: r.id, sourceId: r.source_id, targetId: r.target_id, createdAt: r.created_at }));

	interface ReviewRow {
		card_id: string;
		is_flashcard: number;
		phase: string;
		ease: number;
		interval_days: number;
		repetitions: number;
		due_at: number;
		last_reviewed_at: number | null;
		lapses: number;
	}
	const reviews: ReviewState[] = db
		.all<ReviewRow>("SELECT * FROM review_states ORDER BY card_id")
		.map((r) => ({
			cardId: r.card_id,
			isFlashcard: r.is_flashcard !== 0,
			phase: (SRS_PHASES.has(r.phase) ? r.phase : "new") as SrsPhase,
			ease: r.ease,
			intervalDays: r.interval_days,
			repetitions: r.repetitions,
			dueAt: r.due_at,
			lastReviewedAt: r.last_reviewed_at,
			lapses: r.lapses,
		}));

	interface MapRow {
		id: string;
		name: string;
		default_branch_style: string;
		document_id: string | null;
		fixed_root_node_id: string | null;
		created_at: number;
		updated_at: number;
	}
	const mindmaps: Mindmap[] = db
		.all<MapRow>("SELECT * FROM mindmaps ORDER BY created_at, id")
		.map((r) => ({
			id: r.id,
			name: r.name,
			defaultBranchStyle: (isBranchStyle(r.default_branch_style)
				? r.default_branch_style
				: "tree") as BranchStyle,
			documentId: r.document_id,
			fixedRootNodeId: r.fixed_root_node_id,
			createdAt: r.created_at,
			updatedAt: r.updated_at,
		}));

	interface NodeRow {
		id: string;
		map_id: string;
		card_id: string;
		parent_id: string | null;
		x: number;
		y: number;
		collapsed: number;
		branch_style: string | null;
		created_at: number;
	}
	const nodes: MindmapNode[] = db
		.all<NodeRow>("SELECT * FROM mindmap_nodes ORDER BY created_at, id")
		.map((r) => ({
			id: r.id,
			mapId: r.map_id,
			cardId: r.card_id,
			parentId: r.parent_id,
			x: r.x,
			y: r.y,
			collapsed: r.collapsed !== 0,
			branchStyle: r.branch_style && isBranchStyle(r.branch_style) ? r.branch_style : null,
			childMapId: null, // 61 旧库无子脑图概念，一律普通节点
			createdAt: r.created_at,
		}));

	interface BookmarkRow {
		id: string;
		document_id: string;
		page: number;
		label: string;
		created_at: number;
	}
	const bookmarks: DocumentBookmark[] = db
		.all<BookmarkRow>("SELECT * FROM document_bookmarks ORDER BY created_at, id")
		.map((r) => ({
			id: r.id,
			documentId: r.document_id,
			page: r.page,
			label: r.label,
			createdAt: r.created_at,
		}));

	return { documents, cards, links, reviews, mindmaps, nodes, bookmarks, warnings };
}

/** 解析 JSON 数组列（rects/polygon）；损坏时降级空数组并记 warning，不拖垮整卡 */
function parseJsonArray<T>(raw: string, field: string, cardId: string, warnings: string[]): T[] {
	try {
		const parsed = JSON.parse(raw) as unknown;
		return Array.isArray(parsed) ? (parsed as T[]) : [];
	} catch {
		warnings.push(`卡片 ${cardId} 的 ${field} 字段损坏，已按空值处理`);
		return [];
	}
}

function parseTags(raw: string, cardId: string, warnings: string[]): string[] {
	try {
		const parsed = JSON.parse(raw) as unknown;
		if (!Array.isArray(parsed)) return [];
		return parsed.filter((t): t is string => typeof t === "string");
	} catch {
		warnings.push(`卡片 ${cardId} 的 tags 字段损坏，已按空值处理`);
		return [];
	}
}
