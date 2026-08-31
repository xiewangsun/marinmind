/**
 * 持久化适配器接口：结构上与 Obsidian 的 DataAdapter 兼容（vault.adapter 可直接传入），
 * 测试中用内存实现替代，使数据层不依赖 obsidian 模块。
 *
 * （㉚ 从 src/db/database.ts 迁出——Markdown 存储引擎与附件体系共用，
 * 消除 storage/ → db/ 的反向依赖；database.ts 保留 re-export 兼容旧引用。）
 */
export interface StorageAdapter {
	exists(path: string): Promise<boolean>;
	mkdir(path: string): Promise<void>;
	readBinary(path: string): Promise<ArrayBuffer>;
	writeBinary(path: string, data: ArrayBuffer): Promise<void>;
}
