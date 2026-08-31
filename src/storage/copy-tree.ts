import type { ListableStorageAdapter } from "./vault-rooted-adapter";

/**
 * 递归复制 src 根下 relDir 子树到 dst 的同名位置（逐文件 read → write）。
 *
 * 失败语义：任一文件失败即中断上抛——源目录自始至终不受影响；
 * 目标可能残留部分文件（迁移是复制式，旧位置数据即完整回退依据，残留无害）。
 */
export async function copyTree(
	src: ListableStorageAdapter,
	dst: ListableStorageAdapter,
	relDir: string,
): Promise<{ fileCount: number }> {
	const listed = await src.list(relDir);
	let fileCount = 0;
	// list 返回根相对路径，直接按原路径写入目标
	for (const file of listed.files) {
		await dst.writeBinary(file, await src.readBinary(file));
		fileCount++;
	}
	for (const folder of listed.folders) {
		fileCount += (await copyTree(src, dst, folder)).fileCount;
	}
	return { fileCount };
}
