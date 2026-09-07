import { ASSETS_SUBDIR } from "../constants";

/**
 * 剪藏 md 的 assets 引用处理（124，纯函数层）：
 * - collectClipAssetRefs：从 clip md 文本抽取 `assets/<uid>.<ext>` 引用——
 *   附件审计的保留集增源（无卡片引用的剪藏图不判孤儿）；
 * - localizeClipImageRefs：渲染前把文本内 assets 引用替换为 blob URL——
 *   clip md 存数据根 clips/，MarkdownRenderer 的相对解析对数据根内路径无能为力
 *   （vault 场景解析到 clips/assets/ 不存在；fs 数据根无 vault 路径可解析），
 *   故统一走 attachments.read → blob 直塞（excerpt-visual 同款先例）。
 *
 * 引用形态约定（saveWebclip 产出 / webclip-migrate 重写产物）：
 * `![alt](assets/<uid>.<ext>)`——uid 是 newId() 的安全字符集，无空格/括号，
 * 无需 URL 编码；http(s)/data: 远程链接不在此列（原样保留）。
 */

/** assets 引用正则：括号包裹形态 `](assets/xxx.png)` 的目标部分（宽松抓取，宁多保留不漏） */
const ASSET_REF = new RegExp(`${ASSETS_SUBDIR}/[A-Za-z0-9._-]+`, "g");

/** 抽取文本中全部数据根 assets 引用（去重不排序无意义，保持出现序即可） */
export function collectClipAssetRefs(text: string): string[] {
	const out: string[] = [];
	for (const m of text.matchAll(ASSET_REF)) {
		if (!out.includes(m[0])) {
			out.push(m[0]);
		}
	}
	return out;
}

/**
 * 把文本中的 assets 引用逐个替换为 blob URL（读取经 readBytes 注入——
 * 附件仓或测试桩）。读取失败的引用保留原字面（渲染为裂图，比抹除更诚实）。
 * 返回替换后文本与创建的 blob URL 列表（调用方视图卸载时逐一 revoke）。
 */
export async function localizeClipImageRefs(
	text: string,
	readBytes: (ref: string) => Promise<ArrayBuffer>,
	createUrl: (bytes: ArrayBuffer) => string,
): Promise<{ text: string; blobUrls: string[] }> {
	const refs = collectClipAssetRefs(text);
	const urlOf = new Map<string, string>();
	const blobUrls: string[] = [];
	for (const ref of refs) {
		try {
			const url = createUrl(await readBytes(ref));
			urlOf.set(ref, url);
			blobUrls.push(url);
		} catch (err) {
			console.warn("[MarinMind] 剪藏图片读取失败（保留原引用）", ref, err);
		}
	}
	if (urlOf.size === 0) {
		return { text, blobUrls };
	}
	const replaced = text.replace(ASSET_REF, (ref) => urlOf.get(ref) ?? ref);
	return { text: replaced, blobUrls };
}
