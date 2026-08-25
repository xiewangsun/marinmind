import type { Database } from "sql.js";

/** 当前 schema 版本（每新增一条迁移 +1，须与 MIGRATIONS 长度一致） */
export const SCHEMA_VERSION = 1;

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
