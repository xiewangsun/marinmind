import { ASSETS_DIR } from "../constants";
import type { StorageAdapter } from "../db/database";
import { newId } from "../utils";

/** 附件存储需要的适配器面（Obsidian DataAdapter 天然满足；测试用内存实现） */
export interface MediaStorageAdapter extends StorageAdapter {
	remove(path: string): Promise<void>;
}

/** 单个附件的大小上限（照片/短录音足够；防误贴超大文件撑爆库目录） */
const MAX_ASSET_BYTES = 20 * 1024 * 1024;

/**
 * 媒体附件存取：照片 / 手写 PNG / 录音写入 `.marinmind/assets/`，
 * 以 uid 命名（一卡一附件，删除卡片时可直接删文件）。
 * excerptRef 存 save 返回的完整 vault 相对路径，自包含无隐式前缀。
 */
export class AttachmentStore {
	constructor(private readonly adapter: MediaStorageAdapter) {}

	/** 保存附件字节，返回 vault 相对路径 */
	async save(data: ArrayBuffer, ext: string): Promise<string> {
		if (data.byteLength > MAX_ASSET_BYTES) {
			throw new Error("附件超过 20MB 上限");
		}
		if (!(await this.adapter.exists(ASSETS_DIR))) {
			// 父目录 .marinmind 由数据库打开时保证存在，这里只需建一层
			await this.adapter.mkdir(ASSETS_DIR);
		}
		const path = `${ASSETS_DIR}/${newId()}.${ext}`;
		await this.adapter.writeBinary(path, data);
		return path;
	}

	/** 读取附件字节（渲染为 img/audio 的 blob URL 用） */
	read(path: string): Promise<ArrayBuffer> {
		return this.adapter.readBinary(path);
	}

	/** 删除附件文件（不存在时静默；删除卡片时级联调用） */
	async remove(path: string): Promise<void> {
		if (await this.adapter.exists(path)) {
			await this.adapter.remove(path);
		}
	}
}
