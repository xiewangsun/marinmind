import type {
	BookDocument,
	Card,
	CardLink,
	DocumentBookmark,
	Mindmap,
	MindmapNode,
	ReviewState,
} from "../types";
import { now } from "../utils";
import { cardTitle } from "../review/map-context";
import type { ListableStorageAdapter } from "../storage/vault-rooted-adapter";
import {
	MD_FORMAT_VERSION,
	MINDMAPS_SUBDIR,
	ORPHAN_BOOK_FILENAME,
	ORPHAN_BOOK_PATH,
	BOOKS_SUBDIR,
	linkOwnerId,
	linkId,
	parseBookMd,
	sanitizeFileName,
	serializeBookMd,
	type ParsedBookFile,
} from "./book-format";
import { runLayoutMigration, type LayoutMigrationResult } from "./layout-migrate";
import { parseMindmapMd, serializeMindmapMd } from "./mindmap-format";
import {
	REVIEW_LOG_FILENAME,
	REVIEW_LOG_SCOPE,
	parseReviewLogMd,
	serializeReviewLogMd,
	type ReviewLogData,
} from "./review-log";
import {
	DECKS_FILENAME,
	DECKS_SCOPE,
	FOLDERS_FILENAME,
	FOLDERS_SCOPE,
	addToGroupList,
	groupListFilename,
	groupListHasChildren,
	groupListScope,
	parseGroupListMd,
	removeSubtreeFromGroupList,
	renamePrefixInGroupList,
	serializeGroupListMd,
	type GroupKind,
} from "./group-list";

/**
 * MarinMind Markdown 存储引擎（㉚）：内存权威 + 脏粒度分文件防抖落盘。
 *
 * 运行时模型与旧 sql.js 方案同构（内存库 + 防抖 2s 整库导出 → 内存 Map + 防抖 2s
 * 按脏 scope 重写受影响文件）。仓储层是唯一消费方（六个仓储在此之上实现领域逻辑：
 * 排序/判重/事件 emit），跨集合的数据完整性级联（删卡 → 节点/链接/复习）由本引擎
 * 的 *Cascade 方法承担——SQLite 外键删除后必须以应用逻辑复刻。
 *
 * 落盘契约：
 * - markDirty(scope)：scope = docId | mapId | "orphan"（孤儿文件）| "reviewlog"
 *   （66 复习日志）；2s 防抖后 flush。
 * - flush 只重写脏 scope 对应文件，**内容 === lastWritten 才写**（零写入契约，可断言）。
 * - 文件删除走 pendingDeletes 队列（书/图删除、文件改名）。
 *
 * 外部修改回灌（vault 事件，见 main.ts 装配）：用户手编磁盘即权威——非脏窗口整文件
 * 覆盖内存；脏窗口（插件有未写变更）对书文件做五字段合并（磁盘的 文本/批注/标签/颜色/
 * 线型 覆盖内存，几何与复习状态保内存）+ warning，脑图以内存为准 + warning。
 * fs 数据根（桌面绝对路径）无 vault 事件，不支持回灌。
 */

/** 落盘防抖间隔（毫秒）——沿用旧数据库层的写放大控制 */
const SAVE_DEBOUNCE_MS = 2000;

/** 孤儿 scope 键（documentId=null 的卡路由到 未归类卡片.md，不进文档列表） */
export const ORPHAN_SCOPE = "orphan";

/** 书文件的内存状态（一书一文件） */
export interface BookState {
	/** 数据根相对路径（如 "books/书籍A.md"） */
	relPath: string;
	doc: BookDocument;
	/** 本书卡片（id → card）；孤儿文件中卡的 documentId 保持 null */
	cards: Map<string, Card>;
	bookmarks: Map<string, DocumentBookmark>;
	/** 未知 frontmatter 行原样保留 */
	extraFrontmatter: string[];
}

/** 脑图文件的内存状态（一图一文件） */
export interface MapState {
	/** 数据根相对路径（如 "mindmaps/学习图.md"） */
	relPath: string;
	map: Mindmap;
	nodes: Map<string, MindmapNode>;
	extraFrontmatter: string[];
}

/** 外部修改回灌的结果（main.ts 据此发 cardBus 事件与 Notice） */
export interface ExternalChangeResult {
	/** 被外部删除的卡片（视图 DOM 清理需要快照） */
	removedCards: Card[];
	warnings: string[];
}

/**
 * 旧 SQLite 库的整库数据集（legacy-import 转换产物；v1 备份包兼容导入共用）。
 * 字段与 types.ts 领域模型一一对应，id/时间戳保持原值。
 */
export interface LegacyImportData {
	documents: BookDocument[];
	cards: Card[];
	bookmarks: DocumentBookmark[];
	links: CardLink[];
	reviews: ReviewState[];
	mindmaps: Mindmap[];
	nodes: MindmapNode[];
}

/** 旧库一次性迁移灌入的结果（调用方 Notice 聚合用） */
export interface LegacyImportResult {
	warnings: string[];
}

export class MarinMindStore {
	private readonly booksById = new Map<string, BookState>();
	private readonly booksByPath = new Map<string, BookState>();
	private readonly mapsById = new Map<string, MapState>();
	private readonly mapsByPath = new Map<string, MapState>();
	private readonly orphan: BookState;
	private readonly reviewsById = new Map<string, ReviewState>();
	private readonly linksById = new Map<string, CardLink>();
	/** 66 复习日志：按日聚合计数（派生统计，权威在每卡 ReviewState） */
	private reviewLog: ReviewLogData = {};
	/** 76 分类/卡组清单：用户显式创建的分组路径（空分组持久存在的载体） */
	private readonly groupLists: Record<GroupKind, string[]> = { folders: [], decks: [] };
	private readonly dirtyScopes = new Set<string>();
	private readonly pendingDeletes = new Set<string>();
	/** relPath → 上次写入内容（自写回声过滤 + 零写入契约基准） */
	private readonly lastWritten = new Map<string, string>();
	private saveTimer?: ReturnType<typeof setTimeout>;
	private closed = false;

	private constructor(private readonly adapter: ListableStorageAdapter) {
		this.orphan = {
			relPath: ORPHAN_BOOK_PATH,
			doc: {
				id: ORPHAN_SCOPE,
				filePath: "",
				title: "未归类卡片",
				category: null,
				collectMapId: null,
				autoFlashcard: false,
				lastPage: null, // 80 阅读位置记忆：孤儿书无阅读场景，恒 null
				createdAt: 0,
				updatedAt: 0,
			},
			cards: new Map(),
			bookmarks: new Map(),
			extraFrontmatter: [],
		};
	}

	/** 最近一次布局迁移统计（open 时执行；main.ts 据此发 Notice，null = 未经过 open） */
	lastLayoutMigration: LayoutMigrationResult | null = null;

	/**
	 * 打开（或创建）存储：先布局迁移（123：根层书 md → books/、脑图/ → mindmaps/，
	 * 幂等），再扫根层系统文件与 books/、mindmaps/ 子目录，认领全部 MarinMind md。
	 */
	static async open(adapter: ListableStorageAdapter): Promise<MarinMindStore> {
		const store = new MarinMindStore(adapter);
		store.lastLayoutMigration = await runLayoutMigration(adapter);
		await store.loadAll();
		return store;
	}

	private async loadAll(): Promise<void> {
		// 目录列举与文件读取全部并行（IO 等待占启动耗时大头；adapter.list 对不存在
		// 目录返回空，子目录缺失无碍）；解析吸收保持文件顺序串行——Map 插入
		// 顺序即文档列表顺序，不得随读取完成顺序漂移。根层仍保留书 md 扫描：
		// 布局迁移单文件失败/中断的残留在此兜底认领（下次启动迁移再搬）。
		const [root, booksDir, mmDir] = await Promise.all([
			this.adapter.list(""),
			this.adapter.list(BOOKS_SUBDIR),
			this.adapter.list(MINDMAPS_SUBDIR),
		]);
		const rootMd = root.files.filter((f) => f.endsWith(".md"));
		const bookFiles = booksDir.files.filter((f) => f.endsWith(".md"));
		const mapFiles = mmDir.files.filter((f) => f.endsWith(".md"));
		const buffers = await Promise.all(
			[...rootMd, ...bookFiles, ...mapFiles].map((f) => this.adapter.readBinary(f)),
		);
		let i = 0;
		for (const file of rootMd) {
			const text = decodeUtf8(buffers[i++]);
			// 66 复习日志：机器层为锚灌入；损坏（null）保内存空态且 lastWritten 记磁盘原文
			// ——此后一旦有新评分标脏，flush 即用完整内存覆盖回规范格式
			if (file === REVIEW_LOG_FILENAME) {
				const log = parseReviewLogMd(text);
				if (log) this.reviewLog = log;
				this.lastWritten.set(file, text);
				continue;
			}
			// 76 分类/卡组清单：行权威灌入；损坏（null）保内存空态且 lastWritten 记磁盘
			// 原文——此后一旦有新建分组标脏，flush 即用完整内存覆盖回规范格式
			if (file === FOLDERS_FILENAME || file === DECKS_FILENAME) {
				const kind: GroupKind = file === FOLDERS_FILENAME ? "folders" : "decks";
				const list = parseGroupListMd(text, kind);
				if (list) this.groupLists[kind] = list;
				this.lastWritten.set(file, text);
				continue;
			}
			const parsed = parseBookMd(text, { fileName: file.split("/").pop() });
			// 孤儿文件根层残留（迁移中断）：状态跟随实际磁盘位置，flush 不另起新文件
			if (file === ORPHAN_BOOK_FILENAME) {
				this.orphan.relPath = file;
				this.absorbOrphan(parsed);
				this.lastWritten.set(file, text);
				continue;
			}
			if (!parsed.claimed) continue; // 用户放进数据根的普通笔记——不认领
			this.absorbBook(file, parsed);
			this.lastWritten.set(file, text);
		}
		for (const file of bookFiles) {
			const text = decodeUtf8(buffers[i++]);
			const parsed = parseBookMd(text, { fileName: file.split("/").pop() });
			if (file === ORPHAN_BOOK_PATH) {
				this.absorbOrphan(parsed);
				this.lastWritten.set(file, text);
				continue;
			}
			if (!parsed.claimed) continue; // 用户拷进 books/ 的普通笔记——不认领
			this.absorbBook(file, parsed);
			this.lastWritten.set(file, text);
		}
		for (const file of mapFiles) {
			const text = decodeUtf8(buffers[i++]);
			const parsed = parseMindmapMd(text, { fileName: file.split("/").pop() });
			if (!parsed.claimed) continue;
			this.absorbMap(file, parsed);
			this.lastWritten.set(file, text);
		}
	}

	// -----------------------------------------------------------------------
	// 状态访问（仓储层消费）
	// -----------------------------------------------------------------------

	get books(): ReadonlyMap<string, BookState> {
		return this.booksById;
	}

	get maps(): ReadonlyMap<string, MapState> {
		return this.mapsById;
	}

	/** 孤儿文件状态（documentId=null 卡片集；不进文档列表） */
	get orphanState(): BookState {
		return this.orphan;
	}

	get reviews(): ReadonlyMap<string, ReviewState> {
		return this.reviewsById;
	}

	get links(): ReadonlyMap<string, CardLink> {
		return this.linksById;
	}

	get formatVersion(): number {
		return MD_FORMAT_VERSION;
	}

	/** 启动日志 / 统计命令用 */
	stats(): { documents: number; cards: number; mindmaps: number; nodes: number } {
		let cards = this.orphan.cards.size;
		let nodes = 0;
		for (const b of this.booksById.values()) cards += b.cards.size;
		for (const m of this.mapsById.values()) nodes += m.nodes.size;
		return { documents: this.booksById.size, cards, mindmaps: this.mapsById.size, nodes };
	}

	/** 按 vault 路径找书（documents.getByPath 消费；书籍数个人规模线性扫无碍） */
	bookByFilePath(filePath: string): BookState | undefined {
		for (const b of this.booksById.values()) {
			if (b.doc.filePath === filePath) return b;
		}
		return undefined;
	}

	/** 卡片归属的书状态（含孤儿） */
	bookOfCard(cardId: string): BookState | undefined {
		for (const b of this.booksById.values()) {
			if (b.cards.has(cardId)) return b;
		}
		return this.orphan.cards.has(cardId) ? this.orphan : undefined;
	}

	/** 卡片所属脏 scope（找不到卡时归孤儿——无文件可脏，标记无害） */
	scopeOfCard(cardId: string): string {
		const book = this.bookOfCard(cardId);
		if (!book) return ORPHAN_SCOPE;
		return book === this.orphan ? ORPHAN_SCOPE : book.doc.id;
	}

	/** 写入/覆盖复习状态（标脏所属书文件） */
	putReview(review: ReviewState): void {
		this.reviewsById.set(review.cardId, review);
		this.markDirty(this.scopeOfCard(review.cardId));
	}

	/** 复习日志快照（66；统计面板/新卡配额/撤销回退经纯函数消费，不改内存） */
	getReviewLog(): ReviewLogData {
		return this.reviewLog;
	}

	/**
	 * 变更复习日志（评分 +1 / 撤销回退 -1）：fn 原地改动后统一标脏独立 scope——
	 * store 不理解复习语义，记什么由仓储层决定（镜像 markDirty 粒度设计）。
	 */
	mutateReviewLog(fn: (log: ReviewLogData) => void): void {
		fn(this.reviewLog);
		this.markDirty(REVIEW_LOG_SCOPE);
	}

	// -----------------------------------------------------------------------
	// 分类/卡组清单（76：空分组持久存在的载体；主页文件夹树/右键归入/设卡组选择器消费）
	// -----------------------------------------------------------------------

	/** 分类清单快照（树构建 union 用；调用方只读） */
	getFolders(): readonly string[] {
		return this.groupLists.folders;
	}

	/** 卡组清单快照 */
	getDecks(): readonly string[] {
		return this.groupLists.decks;
	}

	/** 追加分类（主页「新建分类」等显式创建入口；已存在时零写入） */
	addFolder(path: string): void {
		this.addToList("folders", path);
	}

	/** 追加卡组（同构） */
	addDeck(path: string): void {
		this.addToList("decks", path);
	}

	/** 移除分类子树清单项（删除分类时与文档置 null 配套） */
	removeFoldersUnder(path: string): void {
		this.removeFromList("folders", path);
	}

	/** 移除卡组子树清单项（同构） */
	removeDecksUnder(path: string): void {
		this.removeFromList("decks", path);
	}

	/** 清单内是否仍有子分组（主页"纯空组删除免确认"判定用） */
	groupListHasChildren(kind: GroupKind, path: string): boolean {
		return groupListHasChildren(this.groupLists[kind], path);
	}

	/** 分类前缀级联重命名（「学习」→「study」时清单内「学习/英语」跟随） */
	renameFoldersPrefix(oldName: string, newName: string): void {
		this.renameInList("folders", oldName, newName);
	}

	/** 卡组前缀级联重命名（同构） */
	renameDecksPrefix(oldName: string, newName: string): void {
		this.renameInList("decks", oldName, newName);
	}

	private addToList(kind: GroupKind, path: string): void {
		const next = addToGroupList(this.groupLists[kind], path);
		if (next === this.groupLists[kind]) return; // 已存在：零写入契约
		this.groupLists[kind] = [...next];
		this.markDirty(groupListScope(kind));
	}

	private removeFromList(kind: GroupKind, path: string): void {
		const next = removeSubtreeFromGroupList(this.groupLists[kind], path);
		if (next === this.groupLists[kind]) return; // 清单内无此子树：零写入
		this.groupLists[kind] = [...next];
		this.markDirty(groupListScope(kind));
	}

	private renameInList(kind: GroupKind, oldName: string, newName: string): void {
		const next = renamePrefixInGroupList(this.groupLists[kind], oldName, newName);
		if (next === this.groupLists[kind]) return; // 清单内无命中：零写入
		this.groupLists[kind] = [...next];
		this.markDirty(groupListScope(kind));
	}

	/** 新建链接（id 规范化派生；持有方文件标脏）。已存在（含反向）时覆盖同 id 条目 */
	addLink(sourceId: string, targetId: string, createdAt: number): CardLink {
		const link: CardLink = {
			id: sourceId < targetId ? `${sourceId}|${targetId}` : `${targetId}|${sourceId}`,
			sourceId: sourceId < targetId ? sourceId : targetId,
			targetId: sourceId < targetId ? targetId : sourceId,
			createdAt,
		};
		this.linksById.set(link.id, link);
		this.markDirty(this.scopeOfCard(linkOwnerId(link.sourceId, link.targetId)));
		return link;
	}

	/** 按 id 删链接（持有方文件标脏）；不存在返回 false */
	removeLink(linkId: string): boolean {
		const link = this.linksById.get(linkId);
		if (!link) return false;
		this.linksById.delete(linkId);
		this.markDirty(this.scopeOfCard(linkOwnerId(link.sourceId, link.targetId)));
		return true;
	}

	// -----------------------------------------------------------------------
	// 书 / 图 状态维护（文档与脑图仓储消费）
	// -----------------------------------------------------------------------

	/** 新建或更新文档元数据：无则建 BookState（按标题分配文件名），有则改元数据并按新标题重命名文件 */
	upsertBook(doc: BookDocument): BookState {
		let state = this.booksById.get(doc.id);
		if (!state) {
			const relPath = this.allocateBookPath(doc.title, doc.id);
			state = { relPath, doc, cards: new Map(), bookmarks: new Map(), extraFrontmatter: [] };
			this.booksById.set(doc.id, state);
			this.booksByPath.set(relPath, state);
		} else {
			state.doc = doc;
			this.refreshBookPath(state);
		}
		this.markDirty(doc.id);
		return state;
	}

	/**
	 * 仅打开（touch）：内存更新 updatedAt，不标脏不落盘。
	 * 打开文档曾每次触发整书序列化 + 重写（updated_at 在 frontmatter，内容必变，
	 * writeIfChanged 拦不住）——现在落盘由后续实质变更（建卡/批注等）顺带携带；
	 * 无变更重启后回退到上次落盘时间，最近文档排序略旧，可接受。
	 */
	touchBookOpen(docId: string): void {
		const state = this.booksById.get(docId);
		if (state) {
			state.doc = { ...state.doc, updatedAt: now() };
		}
	}

	/** 新建或更新脑图元数据（文件名跟随图名） */
	upsertMap(map: Mindmap): MapState {
		let state = this.mapsById.get(map.id);
		if (!state) {
			const relPath = this.allocateMapPath(map.name, map.id);
			state = { relPath, map, nodes: new Map(), extraFrontmatter: [] };
			this.mapsById.set(map.id, state);
			this.mapsByPath.set(relPath, state);
		} else {
			state.map = map;
			this.refreshMapPath(state);
		}
		this.markDirty(map.id);
		return state;
	}

	/** 删除文档：级联 卡片（→复习/链接/脑图节点）/书签 + 图 document_id SET NULL + 文件删除排队 */
	deleteBook(docId: string): boolean {
		const state = this.booksById.get(docId);
		if (!state) return false;
		for (const cardId of [...state.cards.keys()]) {
			this.deleteCardCascade(cardId);
		}
		this.booksById.delete(docId);
		this.booksByPath.delete(state.relPath);
		this.pendingDeletes.add(state.relPath);
		this.lastWritten.delete(state.relPath);
		for (const ms of this.mapsById.values()) {
			if (ms.map.documentId === docId) {
				ms.map = { ...ms.map, documentId: null, updatedAt: now() };
				this.markDirty(ms.map.id);
			}
		}
		return true;
	}

	/** 删除脑图：级联节点 + 文件删除排队（卡片保留）；引用它的摘录目标覆盖一并清空（㊴） */
	deleteMap(mapId: string): boolean {
		const state = this.mapsById.get(mapId);
		if (!state) return false;
		this.mapsById.delete(mapId);
		this.mapsByPath.delete(state.relPath);
		this.pendingDeletes.add(state.relPath);
		this.lastWritten.delete(state.relPath);
		// 摘录目标覆盖指向本图的书回退默认同名图（读取层另有悬空守卫兜底）
		for (const bs of this.books.values()) {
			if (bs.doc.collectMapId === mapId) {
				bs.doc = { ...bs.doc, collectMapId: null };
				this.markDirty(bs.doc.id);
			}
		}
		return true;
	}

	/**
	 * 删除卡片：级联 复习状态 / 链接（双侧任一为本卡）/ 全部脑图节点
	 * （被删节点是固定根则解钉）。返回被删卡片快照（事件 emit 用）。
	 */
	deleteCardCascade(cardId: string): Card | undefined {
		const state = this.bookOfCard(cardId);
		if (!state) return undefined;
		const card = state.cards.get(cardId);
		if (!card) return undefined;
		state.cards.delete(cardId);
		this.reviewsById.delete(cardId);
		// 链接：持有方可能在另一本书的文件里——那一侧也要标脏（links 段消失）
		for (const link of [...this.linksById.values()]) {
			if (link.sourceId !== cardId && link.targetId !== cardId) continue;
			this.linksById.delete(link.id);
			const other = link.sourceId === cardId ? link.targetId : link.sourceId;
			this.markDirty(this.scopeOfCard(other));
		}
		this.cascadeNodesForRemovedCard(cardId);
		this.markDirty(state === this.orphan ? ORPHAN_SCOPE : state.doc.id);
		return card;
	}

	/** 卡片消失后的脑图节点级联：删引用节点 + 固定根解钉 + 子节点上浮为根（SET NULL）+ 涉事图标脏 */
	private cascadeNodesForRemovedCard(cardId: string): void {
		for (const ms of this.mapsById.values()) {
			let touched = false;
			let unpin = false;
			const deletedIds = new Set<string>();
			for (const node of [...ms.nodes.values()]) {
				if (node.cardId !== cardId) continue;
				if (ms.map.fixedRootNodeId === node.id) unpin = true;
				deletedIds.add(node.id);
				ms.nodes.delete(node.id);
				touched = true;
			}
			if (touched) {
				// 被删节点的子节点上浮为根（对齐旧库 parent_id ON DELETE SET NULL，防静默丢子树）
				for (const node of ms.nodes.values()) {
					if (node.parentId !== null && deletedIds.has(node.parentId)) {
						node.parentId = null;
					}
				}
				ms.map = {
					...ms.map,
					updatedAt: now(),
					fixedRootNodeId: unpin ? null : ms.map.fixedRootNodeId,
				};
				this.markDirty(ms.map.id);
			}
		}
	}

	/**
	 * 旧库一次性迁移灌入（legacy-import / v1 备份包兼容导入消费）：
	 * 按原样吸收全部集合（id/时间戳不变），冲突防御在此收口——
	 * file_path 已被占用的文档整组跳过（对齐旧库 UNIQUE）、归属缺失的卡兜底孤儿
	 * （不静默丢卡）、引用缺失的书签/复习/链接/节点跳过（对齐旧库外键）。
	 * 灌入后全部 scope 标脏，由调用方 flush 落盘。
	 */
	importLegacy(data: LegacyImportData): LegacyImportResult {
		const warnings: string[] = [];
		// 文档：file_path 判重（库内已有同路径的其他文档 → 整组跳过）
		for (const doc of data.documents) {
			if (this.booksById.has(doc.id)) continue; // 幂等防御（重复导入）
			const occupied = doc.filePath ? this.bookByFilePath(doc.filePath) : undefined;
			if (occupied) {
				warnings.push(
					`文档《${doc.title}》（${doc.filePath}）与现有文档《${occupied.doc.title}》路径相同，未导入`,
				);
				continue;
			}
			this.upsertBook(doc);
		}
		// 卡片：按 documentId 路由；文档未导入（路径冲突/引用悬空）→ 孤儿兜底
		let orphaned = 0;
		for (const card of data.cards) {
			if (this.bookOfCard(card.id)) continue; // 幂等防御
			const book = card.documentId ? this.booksById.get(card.documentId) : undefined;
			if (book) {
				book.cards.set(card.id, card);
			} else {
				this.orphan.cards.set(card.id, { ...card, documentId: null });
				orphaned += 1;
			}
		}
		if (orphaned > 0) {
			warnings.push(`${orphaned} 张卡片的归属文档未导入，已放入「未归类卡片」`);
		}
		// 书签 / 复习 / 链接：任一端引用缺失即跳过（对齐旧库外键拒绝）
		for (const bm of data.bookmarks) {
			const book = this.booksById.get(bm.documentId);
			if (book && !book.bookmarks.has(bm.id)) book.bookmarks.set(bm.id, bm);
		}
		for (const r of data.reviews) {
			if (this.bookOfCard(r.cardId)) this.reviewsById.set(r.cardId, r);
		}
		for (const l of data.links) {
			if (!this.bookOfCard(l.sourceId) || !this.bookOfCard(l.targetId)) continue;
			const id = linkId(l.sourceId, l.targetId); // 规范化派生（md 机器层的键形态）
			this.linksById.set(id, { ...l, id });
		}
		// 脑图：documentId 引用悬空或一书一图冲突 → 退化为普通图（对齐 SET NULL + UNIQUE）
		for (const map of data.mindmaps) {
			if (this.mapsById.has(map.id)) continue; // 幂等防御
			let documentId = map.documentId;
			if (documentId != null) {
				const bindable =
					this.booksById.has(documentId) &&
					![...this.mapsById.values()].some((ms) => ms.map.documentId === documentId);
				if (!bindable) documentId = null;
			}
			this.upsertMap({ ...map, documentId });
		}
		// 节点：图或卡片缺失即跳过（对齐旧库外键）；fixedRoot 悬空引用由
		// repo fixedRoot() 的存在性过滤兜底（与 SQL EXISTS 过滤脏行同语义）
		for (const node of data.nodes) {
			const ms = this.mapsById.get(node.mapId);
			if (!ms || ms.nodes.has(node.id)) continue;
			if (!this.bookOfCard(node.cardId)) continue;
			ms.nodes.set(node.id, node);
		}
		// 全量标脏（导入是显式动作，立即安排落盘；调用方通常再显式 flush）
		for (const id of this.booksById.keys()) this.markDirty(id);
		for (const id of this.mapsById.keys()) this.markDirty(id);
		if (this.orphan.cards.size > 0) this.markDirty(ORPHAN_SCOPE);
		return { warnings };
	}

	// -----------------------------------------------------------------------
	// 落盘
	// -----------------------------------------------------------------------

	/** 标记脏（scope = docId | mapId | "orphan"），防抖 2s 后 flush */
	markDirty(scope: string): void {
		if (this.closed) return;
		this.dirtyScopes.add(scope);
		if (this.saveTimer === undefined) {
			this.saveTimer = setTimeout(() => {
				this.saveTimer = undefined;
				void this.flush();
			}, SAVE_DEBOUNCE_MS);
		}
	}

	/** 立即落盘（取消防抖定时器）：先执行删除队列，再重写脏 scope 文件 */
	async flush(): Promise<void> {
		if (this.saveTimer !== undefined) {
			clearTimeout(this.saveTimer);
			this.saveTimer = undefined;
		}
		for (const rel of this.pendingDeletes) {
			await this.adapter.remove(rel);
			this.lastWritten.delete(rel);
		}
		this.pendingDeletes.clear();
		for (const scope of this.dirtyScopes) {
			if (scope === ORPHAN_SCOPE) {
				await this.flushOrphan();
				continue;
			}
			if (scope === REVIEW_LOG_SCOPE) {
				await this.flushReviewLog();
				continue;
			}
			// 76 分类/卡组清单：清空即删文件（空清单无阅读价值，区别于日志常驻）
			if (scope === FOLDERS_SCOPE || scope === DECKS_SCOPE) {
				await this.flushGroupList(scope === FOLDERS_SCOPE ? "folders" : "decks");
				continue;
			}
			const book = this.booksById.get(scope);
			if (book) await this.flushBook(book);
			const map = this.mapsById.get(scope);
			if (map) await this.flushMap(map);
		}
		this.dirtyScopes.clear();
	}

	/** 停写（调用前应先 flush；此后 markDirty 静默忽略） */
	close(): void {
		if (this.saveTimer !== undefined) {
			clearTimeout(this.saveTimer);
			this.saveTimer = undefined;
		}
		this.closed = true;
	}

	/**
	 * 确保某书文件已按当前序列化格式落盘（㊻-A-2）：零写入契约下，㊻-A 之前写入
	 * 且此后再未改动的书文件磁盘上没有 `^card-<id>` 块锚点行——指向其中卡片的
	 * wikilink/嵌入会解析失败。复制卡片链接前调用本方法保底（flush 同款序列化 +
	 * writeIfChanged，磁盘已最新则零写）。docId 为 ORPHAN_SCOPE 时保底孤儿文件。
	 */
	async ensureBookWritten(docId: string): Promise<void> {
		if (this.closed) return;
		if (docId === ORPHAN_SCOPE) {
			await this.flushOrphan();
			return;
		}
		const book = this.booksById.get(docId);
		if (book) await this.flushBook(book);
	}

	private async flushBook(state: BookState): Promise<void> {
		const text = serializeBookMd({
			doc: state.doc,
			cards: [...state.cards.values()],
			reviews: this.reviewsById,
			bookmarks: [...state.bookmarks.values()],
			links: [...this.linksById.values()],
			extraFrontmatter: state.extraFrontmatter,
		});
		await this.writeIfChanged(state.relPath, text);
	}

	private async flushOrphan(): Promise<void> {
		if (this.orphan.cards.size === 0) {
			// 孤儿集清空：曾写过文件则删除，从没写过则什么都不做
			if (this.lastWritten.has(this.orphan.relPath)) {
				await this.adapter.remove(this.orphan.relPath);
				this.lastWritten.delete(this.orphan.relPath);
			}
			return;
		}
		const text = serializeBookMd({
			doc: this.orphan.doc,
			cards: [...this.orphan.cards.values()],
			reviews: this.reviewsById,
			bookmarks: [],
			links: [...this.linksById.values()],
			extraFrontmatter: this.orphan.extraFrontmatter,
		});
		await this.writeIfChanged(this.orphan.relPath, text);
	}

	private async flushMap(state: MapState): Promise<void> {
		const text = serializeMindmapMd(
			state.map,
			[...state.nodes.values()],
			{
				resolveCard: (cardId) => {
					const book = this.bookOfCard(cardId);
					const card = book?.cards.get(cardId);
					if (!book || !card) return undefined;
					// wikilink 目标取 basename（[[书名]]）：书文件迁入 books/ 后链接形态
					// 不变，Obsidian 按文件名解析不受目录影响（123 布局 v2）
					return {
						fileBase: book.relPath.split("/").pop()!.replace(/\.md$/, ""),
						title: cardTitle(card),
					};
				},
			},
			state.extraFrontmatter,
		);
		await this.writeIfChanged(state.relPath, text);
	}

	/**
	 * 66 复习日志落盘。与孤儿文件「清空即删」不同：日志文件常驻数据根供用户阅读，
	 * 空日志也是合法文档（serializeReviewLogMd 产出占位文案）。外部删除后若不再有
	 * 评分则不复活（handleExternalChange 删脏），有评分自然重建——「暂无记录」态。
	 */
	private async flushReviewLog(): Promise<void> {
		await this.writeIfChanged(REVIEW_LOG_FILENAME, serializeReviewLogMd(this.reviewLog));
	}

	/**
	 * 76 清单落盘。与复习日志「常驻」不同：空清单即删文件（镜像孤儿「清空即删」
	 * ——从未建过分组的库数据根保持干净）；外部删除后若不再有新建分组则不复活
	 * （handleExternalChange 删脏），有新建自然重建。
	 */
	private async flushGroupList(kind: GroupKind): Promise<void> {
		const rel = groupListFilename(kind);
		const list = this.groupLists[kind];
		if (list.length === 0) {
			if (this.lastWritten.has(rel)) {
				await this.adapter.remove(rel);
				this.lastWritten.delete(rel);
			}
			return;
		}
		await this.writeIfChanged(rel, serializeGroupListMd(kind, list));
	}

	/** 零写入契约：内容与上次写入相同则不碰磁盘 */
	private async writeIfChanged(relPath: string, content: string): Promise<void> {
		if (this.lastWritten.get(relPath) === content) return;
		await this.adapter.writeBinary(relPath, encodeUtf8(content));
		this.lastWritten.set(relPath, content);
	}

	// -----------------------------------------------------------------------
	// 文件名分配（标题跟随 + 冲突加 id 短后缀）
	// -----------------------------------------------------------------------

	/** 分配书文件路径（books/ 下同名冲突加 id 短后缀）；selfPath=自己现占的路径不算冲突 */
	private allocateBookPath(title: string, id: string, selfPath?: string): string {
		const base = sanitizeFileName(title);
		const name = `${base}.md`;
		const rel = `${BOOKS_SUBDIR}/${name}`;
		if (rel === selfPath) {
			return rel;
		}
		// 66 复习日志 / 76 清单文件占用守卫：书名恰为「复习日志」「分类」「卡组」时
		// 让路加后缀，防与数据根专属系统文件同形（books/ 内虽不同目录，仍避开命名）
		return this.booksByPath.has(rel) ||
			name === REVIEW_LOG_FILENAME ||
			name === FOLDERS_FILENAME ||
			name === DECKS_FILENAME
			? `${BOOKS_SUBDIR}/${base} (${id.slice(0, 4)}).md`
			: rel;
	}

	private allocateMapPath(name: string, id: string, selfPath?: string): string {
		const base = sanitizeFileName(name);
		const rel = `${MINDMAPS_SUBDIR}/${base}.md`;
		if (rel === selfPath) {
			return rel;
		}
		return this.mapsByPath.has(rel) ? `${MINDMAPS_SUBDIR}/${base} (${id.slice(0, 4)}).md` : rel;
	}

	/** 标题变更 → 文件改名（旧路径删除排队、lastWritten 跟随、全部脑图标脏刷新 wikilink） */
	private refreshBookPath(state: BookState): void {
		// 传 selfPath：标题未变（documents.update 只改 category 等元数据）时
		// 目标路径被自己占用不算冲突——否则文件会在 书名.md ↔ 书名 (id).md 间反复翻转
		const desired = this.allocateBookPath(state.doc.title, state.doc.id, state.relPath);
		if (desired === state.relPath) return;
		this.pendingDeletes.add(state.relPath);
		this.lastWritten.delete(state.relPath);
		this.booksByPath.delete(state.relPath);
		state.relPath = desired;
		this.booksByPath.set(desired, state);
		// 书文件名变了，各脑图 wikilink 目标跟随——全部重写
		for (const mapId of this.mapsById.keys()) this.markDirty(mapId);
	}

	private refreshMapPath(state: MapState): void {
		const desired = this.allocateMapPath(state.map.name, state.map.id, state.relPath);
		if (desired === state.relPath) return;
		this.pendingDeletes.add(state.relPath);
		this.lastWritten.delete(state.relPath);
		this.mapsByPath.delete(state.relPath);
		state.relPath = desired;
		this.mapsByPath.set(desired, state);
	}

	// -----------------------------------------------------------------------
	// 外部修改回灌（vault modify / rename / delete 事件，main.ts 装配）
	// -----------------------------------------------------------------------

	/**
	 * 数据根内 md 被外部修改/删除。磁盘即权威：
	 * 非脏窗口整文件覆盖内存；脏窗口书文件三字段合并、脑图以内存为准（均记 warning）。
	 */
	async handleExternalChange(
		relPath: string,
		content: string | null,
	): Promise<ExternalChangeResult> {
		const removedCards: Card[] = [];
		const warnings: string[] = [];
		// 自写回声：磁盘内容 === 上次写入 → 插件自己的落盘事件
		if (content !== null && this.lastWritten.get(relPath) === content) {
			return { removedCards, warnings };
		}

		// 66 复习日志：聚合计数是派生统计（权威在每卡 ReviewState），无三字段合并
		// 基线——合并必赌。采纳外部 / 损坏保内存写回 / 删除清空不复活，
		// 损失面封顶 2s 防抖窗口的当日计数。
		if (relPath === REVIEW_LOG_FILENAME) {
			if (content === null) {
				// 尊重删除意图：清内存并撤脏——不撤的话防抖 flush 会用内存重新写回复活
				this.reviewLog = {};
				this.lastWritten.delete(relPath);
				this.dirtyScopes.delete(REVIEW_LOG_SCOPE);
				return { removedCards, warnings };
			}
			const log = parseReviewLogMd(content);
			if (log) {
				// 用户手编数字即权威：整文件覆盖内存。不动 dirtyScopes——若日志恰在
				// 脏集合，flush 用外部数据做规范化重写（自洽无害，零写入契约兜底）
				this.reviewLog = log;
				this.lastWritten.set(relPath, content);
			}
			// 损坏（半截写入）：内存不动、lastWritten 保旧——下次 flush 用更完整的
			// 内存副本覆盖回，防幽灵计数
			return { removedCards, warnings };
		}

		if (relPath === FOLDERS_FILENAME || relPath === DECKS_FILENAME) {
			// 76 清单：行权威数据无合并基线——采纳外部 / 损坏保内存 / 删除清空撤脏
			// （三态镜像复习日志决策表；若恰在脏集合，flush 用外部数据规范化重写自洽无害）
			const kind: GroupKind = relPath === FOLDERS_FILENAME ? "folders" : "decks";
			if (content === null) {
				// 尊重删除意图：清内存并撤脏——不撤的话防抖 flush 会重新写回复活
				this.groupLists[kind] = [];
				this.lastWritten.delete(relPath);
				this.dirtyScopes.delete(groupListScope(kind));
				return { removedCards, warnings };
			}
			const list = parseGroupListMd(content, kind);
			if (list) {
				this.groupLists[kind] = list;
				this.lastWritten.set(relPath, content);
			}
			// 损坏（frontmatter 缺失/半截写入）：内存不动、lastWritten 保旧——下次
			// flush 用更完整的内存副本覆盖回，防清单幽灵回退
			return { removedCards, warnings };
		}

		// 孤儿文件：books/ 规范位置 + 根层迁移残留两种路径（状态跟随实际磁盘位置）
		if (relPath === ORPHAN_BOOK_PATH || relPath === ORPHAN_BOOK_FILENAME) {
			if (content === null) {
				removedCards.push(...this.orphan.cards.values());
				this.orphan.cards.clear();
				this.lastWritten.delete(relPath);
				return { removedCards, warnings };
			}
			const parsed = parseBookMd(content, { fileName: ORPHAN_BOOK_FILENAME });
			if (!parsed.claimed) {
				warnings.push("未归类卡片.md 的 MarinMind frontmatter 缺失，外部修改被忽略");
				return { removedCards, warnings };
			}
			if (this.dirtyScopes.has(ORPHAN_SCOPE)) {
				this.mergeBookCards(this.orphan, parsed, warnings);
			} else {
				this.replaceOrphan(parsed, removedCards);
			}
			this.orphan.relPath = relPath;
			this.lastWritten.set(relPath, content);
			return { removedCards, warnings };
		}

		const book = this.booksByPath.get(relPath);
		if (book) {
			if (content === null) {
				removedCards.push(...book.cards.values());
				this.deleteBook(book.doc.id);
				return { removedCards, warnings };
			}
			const parsed = parseBookMd(content, { fileName: relPath.split("/").pop() });
			if (!parsed.claimed) {
				warnings.push(`《${book.doc.title}》的 MarinMind frontmatter 缺失，外部修改被忽略`);
				return { removedCards, warnings };
			}
			if (this.dirtyScopes.has(book.doc.id)) {
				this.mergeBookCards(book, parsed, warnings);
			} else {
				this.replaceBook(book, parsed, removedCards);
			}
			this.lastWritten.set(relPath, content);
			return { removedCards, warnings };
		}

		const map = this.mapsByPath.get(relPath);
		if (map) {
			if (content === null) {
				this.deleteMap(map.map.id);
				return { removedCards, warnings };
			}
			const parsed = parseMindmapMd(content, { fileName: relPath.split("/").pop() });
			if (!parsed.claimed) {
				warnings.push(
					`脑图《${map.map.name}》的 MarinMind frontmatter 缺失，外部修改被忽略`,
				);
				return { removedCards, warnings };
			}
			if (this.dirtyScopes.has(map.map.id)) {
				warnings.push(`脑图《${map.map.name}》在插件写入窗口内有外部修改，以插件内存为准`);
			} else {
				map.map = parsed.map;
				map.nodes = new Map(parsed.nodes.map((n) => [n.id, n]));
				map.extraFrontmatter = parsed.extraFrontmatter;
			}
			this.lastWritten.set(relPath, content);
			return { removedCards, warnings };
		}

		// 未知文件新出现（用户拷入书/图文件）：认领入库
		if (content !== null) {
			if (relPath.startsWith(`${MINDMAPS_SUBDIR}/`)) {
				const parsed = parseMindmapMd(content, { fileName: relPath.split("/").pop() });
				if (parsed.claimed) this.absorbMap(relPath, parsed);
			} else if (relPath === ORPHAN_BOOK_PATH) {
				// 未归类卡片.md 重新出现（外部删除后又拷回）：按孤儿文件吸收，
				// 不当普通书认领——其 frontmatter id 是哨兵 "orphan"，进 booksById
				// 会造出幽灵文档并使孤儿路由失效
				const parsed = parseBookMd(content, { fileName: ORPHAN_BOOK_FILENAME });
				if (parsed.claimed) {
					if (this.dirtyScopes.has(ORPHAN_SCOPE)) {
						this.mergeBookCards(this.orphan, parsed, warnings);
					} else {
						this.replaceOrphan(parsed, removedCards);
					}
					this.orphan.relPath = relPath;
					this.lastWritten.set(relPath, content);
				}
			} else {
				const parsed = parseBookMd(content, { fileName: relPath.split("/").pop() });
				if (parsed.claimed && !this.booksById.has(parsed.doc.id)) {
					if (parsed.doc.filePath && this.bookByFilePath(parsed.doc.filePath)) {
						warnings.push(`新文件 ${relPath} 的 file_path 与已有文档冲突，未认领`);
					} else {
						this.absorbBook(relPath, parsed);
					}
				}
			}
			if (this.lastWritten.has(relPath) || this.absorbedPaths.has(relPath)) {
				this.lastWritten.set(relPath, content);
			}
		}
		return { removedCards, warnings };
	}

	/**
	 * 数据根内 md 被外部重命名：迁移 state 路径与 lastWritten 键，
	 * 标题/图名跟随新文件名（用户改文件名即改名——插件不会把它改回去）。
	 * （书改名会连带全部脑图 wikilink 失准——标记全部脑图脏，下次落盘重写。）
	 */
	handleExternalRename(oldRel: string, newRel: string): void {
		const baseName = newRel.split("/").pop()?.replace(/\.md$/, "") ?? newRel;
		const book = this.booksByPath.get(oldRel);
		if (book) {
			this.booksByPath.delete(oldRel);
			book.relPath = newRel;
			book.doc = { ...book.doc, title: baseName };
			this.booksByPath.set(newRel, book);
			const prev = this.lastWritten.get(oldRel);
			if (prev !== undefined) {
				this.lastWritten.delete(oldRel);
				this.lastWritten.set(newRel, prev);
			}
			this.markDirty(book.doc.id); // frontmatter title 同步
			for (const mapId of this.mapsById.keys()) this.markDirty(mapId);
			return;
		}
		const mapState = this.mapsByPath.get(oldRel);
		if (mapState) {
			this.mapsByPath.delete(oldRel);
			mapState.relPath = newRel;
			mapState.map = { ...mapState.map, name: baseName };
			this.mapsByPath.set(newRel, mapState);
			const prev = this.lastWritten.get(oldRel);
			if (prev !== undefined) {
				this.lastWritten.delete(oldRel);
				this.lastWritten.set(newRel, prev);
			}
			this.markDirty(mapState.map.id);
		}
	}

	/** absorbXxx 认领过的路径集合（外部新文件回灌时补 lastWritten 用） */
	private readonly absorbedPaths = new Set<string>();

	// -----------------------------------------------------------------------
	// 内部：解析结果吸收 / 替换 / 合并
	// -----------------------------------------------------------------------

	private absorbBook(relPath: string, parsed: ParsedBookFile): void {
		const state: BookState = {
			relPath,
			doc: parsed.doc,
			cards: new Map(parsed.cards.map((c) => [c.id, c])),
			bookmarks: new Map(parsed.bookmarks.map((b) => [b.id, b])),
			extraFrontmatter: parsed.extraFrontmatter,
		};
		this.booksById.set(state.doc.id, state);
		this.booksByPath.set(relPath, state);
		this.absorbedPaths.add(relPath);
		for (const r of parsed.reviews) this.reviewsById.set(r.cardId, r);
		for (const l of parsed.links) this.linksById.set(l.id, l);
	}

	private absorbMap(
		relPath: string,
		parsed: { map: Mindmap; nodes: MindmapNode[]; extraFrontmatter: string[] },
	): void {
		const state: MapState = {
			relPath,
			map: parsed.map,
			nodes: new Map(parsed.nodes.map((n) => [n.id, n])),
			extraFrontmatter: parsed.extraFrontmatter,
		};
		this.mapsById.set(state.map.id, state);
		this.mapsByPath.set(relPath, state);
		this.absorbedPaths.add(relPath);
	}

	private absorbOrphan(parsed: ParsedBookFile): void {
		// 哨兵文档字段保留内存初值；卡片 documentId 归 null（路由语义）
		this.orphan.cards = new Map(parsed.cards.map((c) => [c.id, { ...c, documentId: null }]));
		this.orphan.extraFrontmatter = parsed.extraFrontmatter;
		for (const r of parsed.reviews) this.reviewsById.set(r.cardId, r);
		for (const l of parsed.links) this.linksById.set(l.id, l);
	}

	/** 整文件覆盖内存（非脏窗口的外部修改）：消失的卡级联节点，removedCards 供事件 emit */
	private replaceBook(state: BookState, parsed: ParsedBookFile, removedCards: Card[]): void {
		const before = state.cards;
		state.doc = parsed.doc;
		state.cards = new Map(parsed.cards.map((c) => [c.id, c]));
		state.bookmarks = new Map(parsed.bookmarks.map((b) => [b.id, b]));
		state.extraFrontmatter = parsed.extraFrontmatter;
		// 消失的卡：复习状态清理 + 脑图节点级联 + 事件快照
		for (const [id, card] of before) {
			if (state.cards.has(id)) continue;
			removedCards.push(card);
			this.reviewsById.delete(id);
			this.cascadeNodesForRemovedCard(id);
		}
		// 复习状态与链接按磁盘重建（本文件的）
		for (const r of parsed.reviews) this.reviewsById.set(r.cardId, r);
		for (const [lid, link] of [...this.linksById]) {
			const owner = linkOwnerId(link.sourceId, link.targetId);
			if (before.has(owner) || before.has(link.sourceId) || before.has(link.targetId)) {
				this.linksById.delete(lid);
			}
		}
		for (const l of parsed.links) this.linksById.set(l.id, l);
	}

	private replaceOrphan(parsed: ParsedBookFile, removedCards: Card[]): void {
		const before = this.orphan.cards;
		this.orphan.cards = new Map(parsed.cards.map((c) => [c.id, { ...c, documentId: null }]));
		this.orphan.extraFrontmatter = parsed.extraFrontmatter;
		for (const [id, card] of before) {
			if (this.orphan.cards.has(id)) continue;
			removedCards.push(card);
			this.reviewsById.delete(id);
			this.cascadeNodesForRemovedCard(id);
		}
		for (const r of parsed.reviews) this.reviewsById.set(r.cardId, r);
		for (const [lid, link] of [...this.linksById]) {
			const owner = linkOwnerId(link.sourceId, link.targetId);
			if (before.has(owner) || before.has(link.sourceId) || before.has(link.targetId)) {
				this.linksById.delete(lid);
			}
		}
		for (const l of parsed.links) this.linksById.set(l.id, l);
	}

	/**
	 * 五字段合并（脏窗口内的书文件外部修改）：
	 * 磁盘的 文本/批注/标签/颜色/线型 覆盖内存；几何/页码/复习状态保内存（插件待写值）。
	 * 磁盘新增的卡并入内存；内存独有的卡（插件刚建）保留。
	 */
	private mergeBookCards(state: BookState, parsed: ParsedBookFile, warnings: string[]): void {
		warnings.push(
			`《${state.doc.title}》在插件写入窗口内有外部修改，已按“文本/批注/标签取磁盘、几何与复习取内存”合并`,
		);
		// 文档级只合并 title / category / collectMapId / autoFlashcard（㉟/㊴/㊷）：
		// 其余 doc 字段保内存；不并入的话，2s 防抖窗口内用户手编 frontmatter 的
		// 这些字段会被内存值静默回退
		state.doc = {
			...state.doc,
			title: parsed.doc.title,
			category: parsed.doc.category,
			collectMapId: parsed.doc.collectMapId,
			autoFlashcard: parsed.doc.autoFlashcard,
		};
		state.bookmarks = new Map(parsed.bookmarks.map((b) => [b.id, b]));
		state.extraFrontmatter = parsed.extraFrontmatter;
		for (const disk of parsed.cards) {
			const mem = state.cards.get(disk.id);
			if (!mem) {
				// 磁盘新卡（用户手编新增）→ 直接并入
				state.cards.set(
					disk.id,
					state === this.orphan ? { ...disk, documentId: null } : disk,
				);
				const r = parsed.reviews.find((x) => x.cardId === disk.id);
				if (r) this.reviewsById.set(disk.id, r);
				continue;
			}
			state.cards.set(disk.id, {
				...mem,
				excerptText: disk.excerptText,
				note: disk.note,
				tags: disk.tags,
				color: disk.color,
				// 线型（77）：与 color 同入磁盘胜名单——手编机器层 JSON 的线型即时生效
				lineStyle: disk.lineStyle,
			});
		}
	}
}

/** UTF-8 编解码（TextEncoder/TextDecoder 在 Obsidian 与 Node 均内置） */
function encodeUtf8(text: string): ArrayBuffer {
	const bytes = new TextEncoder().encode(text);
	return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

function decodeUtf8(data: ArrayBuffer): string {
	return new TextDecoder().decode(data);
}
