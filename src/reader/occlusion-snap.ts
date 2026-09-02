import type { DocRect } from "../types";

/**
 * 遮挡纯函数集（71 行吸附 + 74 文字遮罩合并；零 obsidian 零 DOM，vitest 直测）。
 *
 * **行数据源 = card.rects 本身**：text 卡的 rects 即逐行矩形
 * （collectSelectionLines 逐字符测量按 y 聚类的产物；md/epub 的 DOM 版
 * 同样产出逐行矩形）——无需页 textContent，全部文档形态同源生效。
 *
 * 吸附语义：用户拖的遮挡框若覆盖文字行，垂直方向吸附为命中行的并集上下边
 * （整行遮严不露半行残字），水平方向保持用户拖框（行宽常大于目标词，
 * 全行吸附会连同行尾无关内容一起遮住）。
 */

/** 垂直重叠判定的行高占比阈值（重叠 ≥ 0.5×行高视为命中该行） */
const DEFAULT_OVERLAP_RATIO = 0.5;

/**
 * 遮挡框吸附到命中文字行：
 * - 命中行 = 与遮挡框垂直重叠 ≥ threshold×行高的行（threshold 缺省 0.5）
 * - 命中多行取并集上下边（top=最上命中行顶、bottom=最下命中行底）
 * - 水平 x/w 保持原样；无命中行原样返回（宁拒不赌——不猜最近行）
 * - lines 为空原样返回（非 text 卡调用方本就不该进来，防御）
 */
export function snapOcclusionToLines(
	occ: DocRect,
	lines: readonly DocRect[],
	opts?: { overlapThreshold?: number },
): DocRect {
	if (lines.length === 0) {
		return { ...occ };
	}
	const threshold = opts?.overlapThreshold ?? DEFAULT_OVERLAP_RATIO;
	// 重叠高度 = min(底) - max(顶)，> 0 才有重叠
	const occTop = occ.y;
	const occBottom = occ.y + occ.h;
	let hitTop = Infinity;
	let hitBottom = -Infinity;
	for (const line of lines) {
		const overlap = Math.min(occBottom, line.y + line.h) - Math.max(occTop, line.y);
		if (overlap > 0 && overlap >= threshold * line.h) {
			hitTop = Math.min(hitTop, line.y);
			hitBottom = Math.max(hitBottom, line.y + line.h);
		}
	}
	if (hitTop === Infinity) {
		return { ...occ }; // 无命中行：原样返回
	}
	return { x: occ.x, y: hitTop, w: occ.w, h: hitBottom - hitTop };
}

/** 去重判定的四字段容差（页归一化坐标下的亚像素测量抖动） */
const RECT_EPSILON = 1e-3;

/** 四字段容差内全等视为同一遮挡块 */
function sameRect(a: DocRect, b: DocRect): boolean {
	return (
		Math.abs(a.x - b.x) <= RECT_EPSILON &&
		Math.abs(a.y - b.y) <= RECT_EPSILON &&
		Math.abs(a.w - b.w) <= RECT_EPSILON &&
		Math.abs(a.h - b.h) <= RECT_EPSILON
	);
}

/**
 * 文字遮罩去重合并（74）：划选产出的逐行矩形追加进既有遮挡。
 * 与既有块（及本批已追加的块）四字段容差全等则跳过——重复划选同段文字
 * 只有测量级亚像素抖动，不去重会叠出双层块（单删一块后仍遮着的观感错乱）。
 * added 浅克隆追加（与建卡管线产物无共享引用之虞，防御性保持独立对象）。
 */
export function mergeTextOcclusions(
	existing: readonly DocRect[],
	added: readonly DocRect[],
): DocRect[] {
	const result: DocRect[] = [...existing];
	for (const rect of added) {
		if (result.some((e) => sameRect(e, rect))) {
			continue;
		}
		result.push({ ...rect });
	}
	return result;
}
