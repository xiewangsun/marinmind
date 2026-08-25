import initSqlJs, { type Database } from "sql.js";
import { applyMigrations } from "./schema";

/**
 * 持久化适配器：结构上与 Obsidian 的 DataAdapter 兼容（vault.adapter 可直接传入），
 * 测试中用内存实现替代，使数据层不依赖 obsidian 模块。
 */
export interface StorageAdapter {
	exists(path: string): Promise<boolean>;
	mkdir(path: string): Promise<void>;
	readBinary(path: string): Promise<ArrayBuffer>;
	writeBinary(path: string, data: ArrayBuffer): Promise<void>;
}

/** SQL 绑定参数（对应 sql.js 的 SqlValue） */
export type SqlParam = string | number | Uint8Array | null;

/** 落盘防抖间隔（毫秒）：sql.js 每次保存导出整库，避免高频写放大 */
const SAVE_DEBOUNCE_MS = 2000;

export interface OpenOptions {
	/** 内嵌的 WASM 二进制（插件 bundle 使用）；省略时由 sql.js 自行定位（Node/测试环境） */
	wasmBinary?: Uint8Array;
	/** 提供则启用持久化；缺省为纯内存数据库 */
	adapter?: StorageAdapter;
	path?: string;
}

/**
 * MarinMind 数据库门面：
 * - 封装 sql.js 的 prepare/step 样板（run / get / all / tx）
 * - 写操作自动标记脏，防抖导出整库写回 StorageAdapter
 */
export class MarinMindDatabase {
	private db: Database;
	private adapter?: StorageAdapter;
	private path?: string;
	private saveTimer?: ReturnType<typeof setTimeout>;
	private dirty = false;

	private constructor(db: Database, adapter?: StorageAdapter, path?: string) {
		this.db = db;
		this.adapter = adapter;
		this.path = path;
	}

	/** 打开（或创建）数据库：确保目录 → 读取已有文件 → 建内存库 → 应用迁移 */
	static async open(opts: OpenOptions = {}): Promise<MarinMindDatabase> {
		if (opts.adapter && opts.path) {
			const dir = parentDir(opts.path);
			if (dir && !(await opts.adapter.exists(dir))) {
				await opts.adapter.mkdir(dir);
			}
		}

		// SqlJsConfig 类型未收录 wasmBinary 字段，但运行时支持——经 unknown 断言传入
		const config = (opts.wasmBinary !== undefined ? { wasmBinary: opts.wasmBinary } : {}) as unknown as Parameters<
			typeof initSqlJs
		>[0];
		const SQL = await initSqlJs(config);

		let existing: Uint8Array | undefined;
		if (opts.adapter && opts.path && (await opts.adapter.exists(opts.path))) {
			existing = new Uint8Array(await opts.adapter.readBinary(opts.path));
		}
		const db = new SQL.Database(existing ?? null);
		applyMigrations(db);
		return new MarinMindDatabase(db, opts.adapter, opts.path);
	}

	/** 执行写语句（自动标记脏以安排落盘） */
	run(sql: string, params: SqlParam[] = []): void {
		const stmt = this.db.prepare(sql);
		try {
			stmt.run(params);
		} finally {
			stmt.free();
		}
		this.markDirty();
	}

	/** 查询多行（行类型由调用方指定，蛇形命名列） */
	all<T>(sql: string, params: SqlParam[] = []): T[] {
		const stmt = this.db.prepare(sql);
		try {
			stmt.bind(params);
			const rows: T[] = [];
			while (stmt.step()) {
				rows.push(stmt.getAsObject() as unknown as T);
			}
			return rows;
		} finally {
			stmt.free();
		}
	}

	/** 查询单行 */
	get<T>(sql: string, params: SqlParam[] = []): T | undefined {
		return this.all<T>(sql, params)[0];
	}

	/** 在单个事务中执行多个写操作（任一失败整体回滚） */
	tx(fn: () => void): void {
		this.db.run("BEGIN");
		try {
			fn();
			this.db.run("COMMIT");
		} catch (err) {
			this.db.run("ROLLBACK");
			throw err;
		}
		this.markDirty();
	}

	/** 当前 schema 版本（PRAGMA user_version） */
	get version(): number {
		const row = this.get<{ user_version: number }>("PRAGMA user_version");
		return row?.user_version ?? 0;
	}

	private markDirty(): void {
		this.dirty = true;
		if (this.adapter && this.saveTimer === undefined) {
			this.saveTimer = setTimeout(() => {
				this.saveTimer = undefined;
				void this.flush();
			}, SAVE_DEBOUNCE_MS);
		}
	}

	/** 立即落盘（同时取消防抖定时器） */
	async flush(): Promise<void> {
		if (this.saveTimer !== undefined) {
			clearTimeout(this.saveTimer);
			this.saveTimer = undefined;
		}
		if (!this.dirty || !this.adapter || !this.path) {
			return;
		}
		await this.adapter.writeBinary(this.path, this.exportBytes());
		this.dirty = false;
	}

	/** 导出整库字节（内存权威快照；备份/导入前快照用，不改变落盘状态） */
	exportBytes(): ArrayBuffer {
		const data = this.db.export();
		// 复制独立 buffer，避免依赖导出视图的生命周期
		return data.buffer.slice(
			data.byteOffset,
			data.byteOffset + data.byteLength,
		) as ArrayBuffer;
	}

	/** 关闭内存库（调用前应先 flush 未落盘的写入） */
	close(): void {
		if (this.saveTimer !== undefined) {
			clearTimeout(this.saveTimer);
			this.saveTimer = undefined;
		}
		this.db.close();
	}
}

/** 取路径的父目录（无分隔符时返回空串） */
function parentDir(path: string): string {
	const i = path.lastIndexOf("/");
	return i === -1 ? "" : path.slice(0, i);
}
