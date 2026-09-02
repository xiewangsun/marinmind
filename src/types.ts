/**
 * MarinMind 领域模型
 *
 * 核心设计：以"卡片"为中心 —— 摘录即卡片，
 * 卡片既是（未来的）脑图节点又是闪卡：一份数据三种用途（脑图、复习、回链原文）。
 */

/** 摘录形式：text（划选文字）/ area（矩形框选）/ lasso（套索圈选）/ blank（留白备注）/ handwriting（手写）/ audio（录音）/ photo（照片） */
export type ExcerptType = "text" | "area" | "lasso" | "blank" | "handwriting" | "audio" | "photo";

/** 原文位置矩形：相对页面的归一化坐标（0-1），与缩放/设备无关 */
export interface DocRect {
	x: number;
	y: number;
	w: number;
	h: number;
}

/** 套索摘录的归一化多边形顶点（0-1 相对页面；闭合由首尾隐含） */
export interface NormPoint {
	x: number;
	y: number;
}

/** 文档（被阅读的书籍，PDF/EPUB 等） */
export interface BookDocument {
	id: string;
	/**
	 * 文档路径，作为文档的唯一业务键：库内 vault 相对路径，
	 * 或桌面绝对路径（库外文档，㉞——仅桌面可读，md 存储往返经 yamlQuote 冒号转义安全）
	 */
	filePath: string;
	title: string;
	/** 文档分类（㉟ 主页虚拟文件夹）：单层，null = 未分类；存书文件 frontmatter 单行标量 */
	category: string | null;
	/**
	 * 摘录目标脑图覆盖（㊴ 按书切换）：null = 用同名默认图；指向任意图 id
	 * （含别的书的图——该书摘录会在目标图内建《书名》分组卡）。存 frontmatter，
	 * null 省略整行（零写入契约）；目标图删除时由 store 级联置 null
	 */
	collectMapId: string | null;
	/**
	 * 按书自动转闪卡开关（㊷）：开启后该书新摘录自动进入复习队列。
	 * 存书文件 frontmatter `auto_flashcard: true`，false 省略整行（零写入契约）
	 */
	autoFlashcard: boolean;
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
	/** 套索摘录：用户绘制的原始轮廓（归一化多边形顶点）；其余形态为 null。
	 *  rects 此时只存单个包围盒（跳转锚点与无多边形旧卡的兜底渲染用） */
	polygon: NormPoint[] | null;
	/** 摘录文字（text 类型或 OCR 结果） */
	excerptText: string | null;
	/** 媒体附件引用（手写/语音/照片），后续接附件存储 */
	excerptRef: string | null;
	/** 用户批注 */
	note: string | null;
	color: string | null;
	/**
	 * 文字摘录线型（77）：仅 text 形态高亮消费（下划线/波浪线/删除线）；
	 * null = 下划线（默认），镜像 color 的 null=回退默认。改回下划线 = update 传 null。
	 * 序列化只落 squiggle/strikethrough（机器层短键 line，键序 deck 后 occ 前），
	 * null/underline 省键——存量卡字节不变（零写入契约，镜像 title/deck 模式）
	 */
	lineStyle: LineStyle | null;
	/**
	 * 卡片标题（㊺，MN3 一卡一对象一标题）：脑图节点标题栏与各处显示链的最高优先级；
	 * 写入前 trim 空串归一为 null（零写入契约：null 序列化省略机器层键）
	 */
	title: string | null;
	/**
	 * 卡组名（复习卡分组管理）：每卡至多属一个卡组，null = 未分组
	 * （镜像 BookDocument.category 模式——无实体表，卡组由卡片设置派生）。
	 * 写入前 trim 空串归一为 null（零写入契约：null 序列化省略机器层键）
	 */
	deck: string | null;
	/**
	 * 闪卡遮挡区域（㊷；71 photo 亦支持）：复习正面遮住（可揭开）、翻面自动显示；
	 * 阅读器只画虚线标记不遮内容。空数组序列化省略（零写入契约）。
	 * 编辑面：有页矩形的形态（text/area/lasso/handwriting/blank）在阅读器划框
	 * （71 起 text 卡拖框垂直吸附整行、「遮住全部文字行」一键模板）；
	 * photo 卡在卡片预览弹窗拖框（图内 0-1 坐标，渲染端 bounds 恒整图天然对位）；
	 * audio 无页面视觉不给入口
	 */
	occlusions: DocRect[];
	/**
	 * 目录章节骨架卡（55，PDF 目录转脑图框架）：按书目录一键建的章节占位卡，
	 * page 存章节起始页（归章判定与跳原文共用），不作摘录展示。
	 * 零写入契约：仅 true 序列化机器层 `outline: true` 键，false/缺省省略——
	 * 存量卡字节不变（镜像 title/deck 模式）
	 */
	outline?: boolean;
	tags: string[];
	createdAt: number;
	updatedAt: number;
}

/** 文档书签（用户手动添加的阅读位置标记，㉓ 目录侧栏用；区别于 PDF 内嵌大纲） */
export interface DocumentBookmark {
	id: string;
	documentId: string;
	/** 书签指向的页码（1 基） */
	page: number;
	/** 显示标签（默认"第 N 页"，可自定义） */
	label: string;
	createdAt: number;
}

/** 卡片间的双向链接（脑图中两卡片手动建立的关联） */
export interface CardLink {
	id: string;
	sourceId: string;
	targetId: string;
	createdAt: number;
}

/**
 * 脑图分支样式（参照 MarginNote 4 分支样式，⑱；57 扩展三种）：
 * tree=树形（右，默认）/ tree-left=树形（左，镜像）/ tree-down=树形（下，组织架构图）/
 * tree-slant-down=斜右下树（57，MN4 树形3：父顶对齐首子、子级瀑布向下）/
 * tree-slant-up=斜右上树（57，MN4 树形4：父底对齐子块底、子级瀑布向上）/
 * line=直线（横向链条，57 起端点带圆点）/ line-elbow=直角连线（57，直线细节差异：
 * 挂出后垂直总线直角折线）/ bidir=双向（根居中左右对称）/ frame=框架（收纳框代替连线，
 * 57 起父节点嵌框内顶部作标题栏）。
 * 样式归属父节点——决定其子节点如何挂出（连线形状 + 自动布局排列），作用于该节点的子树。
 */
export const BRANCH_STYLES = [
	"tree",
	"tree-left",
	"tree-down",
	"tree-slant-down",
	"tree-slant-up",
	"line",
	"line-elbow",
	"bidir",
	"frame",
] as const;
export type BranchStyle = (typeof BRANCH_STYLES)[number];

/** 分支样式的界面显示名（菜单与选择器共用） */
export const BRANCH_STYLE_LABELS: Record<BranchStyle, string> = {
	tree: "树形（右）",
	"tree-left": "树形（左）",
	"tree-down": "树形（下）",
	"tree-slant-down": "斜树（右下）",
	"tree-slant-up": "斜树（右上）",
	line: "直线",
	"line-elbow": "直角连线",
	bidir: "双向",
	frame: "框架",
};

/** 校验 DB/外部值是否为合法分支样式（非法值按未设置处理，读取层归一） */
export function isBranchStyle(v: unknown): v is BranchStyle {
	return typeof v === "string" && (BRANCH_STYLES as readonly string[]).includes(v);
}

/**
 * 文字摘录线型（77，划选工具栏/高亮菜单/设置页三入口）：
 * underline=下划线（默认，序列化省键）/ squiggle=波浪线 / strikethrough=删除线。
 * 仅作用于 text 形态高亮；null 与 underline 语义等价（改回下划线 = update 传 null）。
 * 名单源放本文件与 BRANCH_STYLES 同构——store 解析层（book-format）与
 * 视图层双端消费，不引入 store→reader 依赖
 */
export const LINE_STYLES = ["underline", "squiggle", "strikethrough"] as const;
export type LineStyle = (typeof LINE_STYLES)[number];

/** 线型的界面显示名（工具栏菜单/高亮菜单/设置下拉共用） */
export const LINE_STYLE_LABELS: Record<LineStyle, string> = {
	underline: "下划线",
	squiggle: "波浪线",
	strikethrough: "删除线",
};

/** 校验机器层/外部值是否为合法线型（非法值按未设置处理，读取层归一） */
export function isLineStyle(v: unknown): v is LineStyle {
	return typeof v === "string" && (LINE_STYLES as readonly string[]).includes(v);
}

/** 思维导图（命名脑图，任何书的卡片可混排进同一张图） */
export interface Mindmap {
	id: string;
	name: string;
	/** 图级默认分支样式（v6）：节点未覆盖时生效 */
	defaultBranchStyle: BranchStyle;
	/** 绑定的文档（v8，㉗）：该书的默认脑图（摘录自动入图目标）；普通图为 null */
	documentId: string | null;
	/** 固定根节点（v8，㉗）：全局唯一——设定后所有新摘录直挂该节点下；节点删除由外键 SET NULL 自动解钉 */
	fixedRootNodeId: string | null;
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
	/** 分支样式覆盖（v6）：null = 继承（祖先覆盖 → 图默认） */
	branchStyle: BranchStyle | null;
	/** 子脑图 id（61 子脑图坍缩）：非 null 时节点是 portal（子树已坍缩进该图，双击进入）；
	 *  null = 普通节点。必填字段同 collapsed 模式（避免 null/undefined 双态）。
	 *  md 机器层键名 sub，null 省略键（零写入契约） */
	childMapId: string | null;
	/** 兄弟序（㉜，手动重排）：同父兄弟的显示/堆叠顺序；缺省回退创建序。
	 *  md 存储不落该字段——由文件中嵌套列表的顺序承载（序列化按 order 排、解析按下标赋） */
	order?: number;
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
