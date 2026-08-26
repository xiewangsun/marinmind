/**
 * MarinMind 领域模型
 *
 * 核心设计：以"卡片"为中心 —— 摘录即卡片，
 * 卡片既是（未来的）脑图节点又是闪卡：一份数据三种用途（脑图、复习、回链原文）。
 */

/** 摘录形式 */
export type ExcerptType = "text" | "area" | "handwriting" | "audio" | "photo";

/** 原文位置矩形：相对页面的归一化坐标（0-1），与缩放/设备无关 */
export interface DocRect {
	x: number;
	y: number;
	w: number;
	h: number;
}

/** 文档（被阅读的书籍，PDF/EPUB 等） */
export interface BookDocument {
	id: string;
	/** 库内相对路径，作为文档的唯一业务键 */
	filePath: string;
	title: string;
	createdAt: number;
	updatedAt: number;
}

/** 知识卡片：由文档摘录生成，脑图节点与闪卡的共同载体 */
export interface Card {
	id: string;
	/** 所属文档；纯手工卡片可为空 */
	documentId: string | null;
	/** 原文回链：PDF 页码（EPUB 等流式文档可为空） */
	page: number | null;
	/** 原文回链：摘录区域（归一化矩形列表，支持折线/多区域摘录） */
	rects: DocRect[];
	excerptType: ExcerptType;
	/** 摘录文字（text 类型或 OCR 结果） */
	excerptText: string | null;
	/** 媒体附件引用（手写/语音/照片），后续接附件存储 */
	excerptRef: string | null;
	/** 用户批注 */
	note: string | null;
	color: string | null;
	tags: string[];
	createdAt: number;
	updatedAt: number;
}

/** 卡片间的双向链接（脑图中两卡片手动建立的关联） */
export interface CardLink {
	id: string;
	sourceId: string;
	targetId: string;
	createdAt: number;
}

/** 思维导图（命名脑图，任何书的卡片可混排进同一张图） */
export interface Mindmap {
	id: string;
	name: string;
	createdAt: number;
	updatedAt: number;
}

/** 脑图节点：图内世界坐标 + 父子结构（parentId 为空即根节点，模型支持森林） */
export interface MindmapNode {
	id: string;
	mapId: string;
	cardId: string;
	parentId: string | null;
	x: number;
	y: number;
	/** 子树折叠态（v3）：折叠时后代不渲染，节点显示子树计数徽标 */
	collapsed: boolean;
	createdAt: number;
}

/** 视图层节点快照：附带卡片本体（listNodes 的 JOIN 产物） */
export interface MindmapNodeWithCard extends MindmapNode {
	card: Card;
}

/** 复习评分（四档按钮） */
export type ReviewGrade = "again" | "hard" | "good" | "easy";

/** 间隔重复所处阶段 */
export type SrsPhase = "new" | "learning" | "review" | "relearning";

/** 闪卡复习状态（SM-2 字段集；后续可整体替换为 FSRS） */
export interface ReviewState {
	cardId: string;
	/** 是否已转为闪卡：卡片默认只是摘录，需显式启用复习 */
	isFlashcard: boolean;
	phase: SrsPhase;
	/** 难度系数（SM-2 的 EF 因子） */
	ease: number;
	/** 当前间隔（天；小数表示分钟级学习步长） */
	intervalDays: number;
	/** 连续答对次数 */
	repetitions: number;
	/** 下次到期时间（毫秒时间戳） */
	dueAt: number;
	lastReviewedAt: number | null;
	/** 遗忘次数 */
	lapses: number;
}
