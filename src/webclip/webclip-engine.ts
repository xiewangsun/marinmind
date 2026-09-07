import { extractArticle } from "./extract-content";
import { domToMarkdown, type MdImageRef } from "./html-to-md";

/**
 * 剪藏引擎纯编排层（113-A）：解码后的 HTML → { 标题, markdown 正文, 图片引用表 }。
 * 全流程零网络零 vault（fetch 在 webclip-service，charset 在 html-charset），
 * 是「描述对象进、结果出」的总装点——vitest 端到端样本页锁死整条管线行为。
 * frontmatter（source/clipped 时间戳）由服务层拼装（含 Date，不进纯函数层）。
 */

/** 引擎产物：markdown 为正文（不含 frontmatter）；images 供服务层下载回填 */
export interface ClipResult {
	title: string;
	markdown: string;
	images: MdImageRef[];
}

/**
 * 剪藏单个网页正文。
 * @param html 完整 HTML 文本（charset 已解码）
 * @param opts.baseUrl 页面地址（相对链接/图片绝对化基准）；titleOverride 手填标题（空串视为未填）
 * @returns 正文提取失败（SPA 空壳等，extractArticle 返回 null）返回 null
 */
export function clipWebpage(
	html: string,
	opts: { baseUrl: string; titleOverride?: string },
): ClipResult | null {
	const extracted = extractArticle(html);
	if (!extracted) {
		return null;
	}
	const { markdown, images } = domToMarkdown(extracted.root, { baseUrl: opts.baseUrl });
	// 标题回退链：手填 > <title> > 域名 > 兜底文案
	let hostname = "";
	try {
		hostname = new URL(opts.baseUrl).hostname.replace(/^www\./, "");
	} catch {
		// baseUrl 已在上游 normalizeClipUrl 校验，此处防御性兜底
	}
	const title =
		(opts.titleOverride ?? "").trim() || extracted.title.trim() || hostname || "网页剪藏";
	return { title, markdown, images };
}
