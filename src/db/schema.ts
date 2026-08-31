import type { Database } from "sql.js";

/** 当前 schema 版本（每新增一条迁移 +1，须与 MIGRATIONS 长度一致） */
export const SCHEMA_VERSION = 8;

/**
 * 按版本顺序排列的迁移脚本：MIGRATIONS[i] 将库从版本 i 升级到 i+1。
 * 只允许追加、不允许修改历史脚本，保证老库可平滑升级。
 */
export const MIGRATIONS: string[] = [
	// v0 → v1 初始 schema：文档 / 卡片（中心模型）/ 卡片双向链接 / 闪卡复习状态
	`
	CREATE TABLE documents (
		id          TEXT PRIMARY KEY,
		title       TEXT NOT NULL,
		file_path   TEXT NOT NULL UNIQUE,   -- 库内相对路径，唯一业务键
		created_at  INTEGER NOT NULL,
		updated_at  INTEGER NOT NULL
	);

	CREATE TABLE cards (
		id            TEXT PRIMARY KEY,
		document_id   TEXT REFERENCES documents(id) ON DELETE CASCADE,
		page          INTEGER,              -- 原文回链：PDF 页码
		rects         TEXT NOT NULL DEFAULT '[]',  -- 原文回链：归一化矩形 JSON 数组
		excerpt_type  TEXT NOT NULL CHECK (excerpt_type IN ('text','area','handwriting','audio','photo')),
		excerpt_text  TEXT,                 -- 摘录文字（text 或 OCR 结果）
		excerpt_ref   TEXT,                 -- 媒体附件引用（手写/语音/照片）
		note          TEXT,                 -- 用户批注
		color         TEXT,
		tags          TEXT NOT NULL DEFAULT '[]',
		created_at    INTEGER NOT NULL,
		updated_at    INTEGER NOT NULL
	);
	CREATE INDEX idx_cards_document ON cards(document_id);

	CREATE TABLE card_links (
		id          TEXT PRIMARY KEY,
		source_id   TEXT NOT NULL REFERENCES cards(id) ON DELETE CASCADE,
		target_id   TEXT NOT NULL REFERENCES cards(id) ON DELETE CASCADE,
		created_at  INTEGER NOT NULL,
		UNIQUE (source_id, target_id)
	);
	CREATE INDEX idx_links_source ON card_links(source_id);
	CREATE INDEX idx_links_target ON card_links(target_id);

	CREATE TABLE review_states (
		card_id           TEXT PRIMARY KEY REFERENCES cards(id) ON DELETE CASCADE,
		is_flashcard      INTEGER NOT NULL DEFAULT 0,
		phase             TEXT NOT NULL DEFAULT 'new' CHECK (phase IN ('new','learning','review','relearning')),
		ease              REAL    NOT NULL DEFAULT 2.5,
		interval_days     REAL    NOT NULL DEFAULT 0,
		repetitions       INTEGER NOT NULL DEFAULT 0,
		due_at            INTEGER NOT NULL,
		last_reviewed_at  INTEGER,
		lapses            INTEGER NOT NULL DEFAULT 0
	);
	CREATE INDEX idx_review_due ON review_states(due_at) WHERE is_flashcard = 1;
	`,
	// v1 → v2 思维导图：多张命名脑图 + 图内节点（节点引用既有卡片，跨书混排）
	`
	CREATE TABLE mindmaps (
		id          TEXT PRIMARY KEY,
		name        TEXT NOT NULL,
		created_at  INTEGER NOT NULL,
		updated_at  INTEGER NOT NULL
	);

	CREATE TABLE mindmap_nodes (
		id          TEXT PRIMARY KEY,
		map_id      TEXT NOT NULL REFERENCES mindmaps(id) ON DELETE CASCADE,
		card_id     TEXT NOT NULL REFERENCES cards(id) ON DELETE CASCADE,
		parent_id   TEXT REFERENCES mindmap_nodes(id) ON DELETE SET NULL,  -- 空即根节点（森林）
		x           INTEGER NOT NULL,
		y           INTEGER NOT NULL,
		created_at  INTEGER NOT NULL,
		UNIQUE (map_id, card_id)   -- 一张图内同一卡片只出现一次
	);
	CREATE INDEX idx_mmindmap_nodes_map ON mindmap_nodes(map_id);
	CREATE INDEX idx_mmindmap_nodes_parent ON mindmap_nodes(parent_id);
	CREATE INDEX idx_mmindmap_nodes_card ON mindmap_nodes(card_id);
	`,
	// v2 → v3 脑图折叠态持久化：折叠是用户的组织成果，重启后保留
	`
	ALTER TABLE mindmap_nodes ADD COLUMN collapsed INTEGER NOT NULL DEFAULT 0;
	`,
	// v3 → v4 摘录形态补全：cards.excerpt_type 的 CHECK 补入 'lasso'（套索）与
	// 'blank'（留白）——SQLite 无法 ALTER CHECK 约束，按标准十二步法重建表
	// （建新表 → 搬数据 → 删旧表 → 改名 → 重建索引）。引用 cards 的外键
	// （card_links/review_states/mindmap_nodes）按列名解析，改名后自然重新指向新表。
	`
	CREATE TABLE cards_v4 (
		id            TEXT PRIMARY KEY,
		document_id   TEXT REFERENCES documents(id) ON DELETE CASCADE,
		page          INTEGER,              -- 原文回链：PDF 页码
		rects         TEXT NOT NULL DEFAULT '[]',  -- 原文回链：归一化矩形 JSON 数组
		excerpt_type  TEXT NOT NULL CHECK (excerpt_type IN ('text','area','lasso','blank','handwriting','audio','photo')),
		excerpt_text  TEXT,                 -- 摘录文字（text 或 OCR 结果）
		excerpt_ref   TEXT,                 -- 媒体附件引用（手写/语音/照片）
		note          TEXT,                 -- 用户批注
		color         TEXT,
		tags          TEXT NOT NULL DEFAULT '[]',
		created_at    INTEGER NOT NULL,
		updated_at    INTEGER NOT NULL
	);
	INSERT INTO cards_v4 (id, document_id, page, rects, excerpt_type, excerpt_text,
		excerpt_ref, note, color, tags, created_at, updated_at)
	SELECT id, document_id, page, rects, excerpt_type, excerpt_text,
		excerpt_ref, note, color, tags, created_at, updated_at FROM cards;
	DROP TABLE cards;
	ALTER TABLE cards_v4 RENAME TO cards;
	CREATE INDEX idx_cards_document ON cards(document_id);
	`,
	// v4 → v5 套索形状保持原状：cards 增 polygon 列（归一化多边形顶点 JSON）——
	// 此前凸包三列矩形近似，不规则形状高亮带空白。rects 继续存单个包围盒
	// （跳转锚点用；存量三列矩形旧卡无 polygon，回显走既有 rects 路径）
	`
	ALTER TABLE cards ADD COLUMN polygon TEXT;
	`,
	// v5 → v6 脑图分支样式（⑱）：图级默认 + 节点级覆盖（NULL=继承：祖先覆盖 → 图默认）。
	// 刻意不加 CHECK 约束——后续新增样式（如树形3/4）只需追加代码枚举，
	// 避免 cards.excerpt_type 那种无法 ALTER CHECK、要整表重建的代价；
	// 非法值在读取层经 isBranchStyle 归一为默认样式
	`
	ALTER TABLE mindmap_nodes ADD COLUMN branch_style TEXT;
	ALTER TABLE mindmaps ADD COLUMN default_branch_style TEXT NOT NULL DEFAULT 'tree';
	`,
	// v6 → v7 文档书签（㉓ 目录/书签侧栏）：用户手动添加的阅读位置标记。
	// 与 PDF 内嵌大纲（outline，随文件只读）互补——用户 PDF 常无大纲，
	// 书签是自定义目录。删文档级联删书签。
	`
	CREATE TABLE document_bookmarks (
		id           TEXT PRIMARY KEY,
		document_id  TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
		page         INTEGER NOT NULL,
		label        TEXT NOT NULL,
		created_at   INTEGER NOT NULL
	);
	CREATE INDEX idx_bookmarks_document ON document_bookmarks(document_id);
	`,
	// v7 → v8 默认书籍脑图 + 固定根节点（㉗）：
	// document_id —— 一本书一张默认脑图（摘录自动入图的目标；UNIQUE 保证 get-or-create
	//   不歧义；删文档 SET NULL，图退化为普通图不丢）；
	// fixed_root_node_id —— 全局唯一的固定根节点（设定后所有新摘录直挂其下；应用层
	//   设定时先清空其他图保证唯一；删节点由外键 SET NULL 自动解钉，无需清理逻辑）。
	// ALTER ADD COLUMN 带 REFERENCES 且 DEFAULT NULL 为 SQLite 允许形态（v5/v6 同款先例）。
	`
	ALTER TABLE mindmaps ADD COLUMN document_id TEXT REFERENCES documents(id) ON DELETE SET NULL;
	ALTER TABLE mindmaps ADD COLUMN fixed_root_node_id TEXT REFERENCES mindmap_nodes(id) ON DELETE SET NULL;
	CREATE UNIQUE INDEX idx_mindmaps_document ON mindmaps(document_id);
	`,
];

/** 应用未执行的迁移（基于 PRAGMA user_version），并开启外键约束 */
export function applyMigrations(db: Database): void {
	const result = db.exec("PRAGMA user_version")[0];
	let version = result?.values?.length ? Number(result.values[0][0]) : 0;

	for (; version < MIGRATIONS.length; version++) {
		db.run("BEGIN");
		try {
			db.exec(MIGRATIONS[version]);
			db.exec(`PRAGMA user_version = ${version + 1}`);
			db.run("COMMIT");
		} catch (err) {
			db.run("ROLLBACK");
			throw err;
		}
	}

	// sql.js 默认关闭外键，需按连接显式开启（级联删除依赖它）
	db.run("PRAGMA foreign_keys = ON");
}
