import { Notice } from "obsidian";
import type { App, WorkspaceLeaf, WorkspaceSplit } from "obsidian";
import { MarinMindMindmapView, MINDMAP_VIEW_TYPE } from "../mindmap/mindmap-view";
import { MarinMindReaderView, READER_VIEW_TYPE } from "../reader/reader-view";
import { MarinMindReviewView, REVIEW_VIEW_TYPE } from "../review/review-view";
import { HOME_VIEW_TYPE } from "../home/home-view";
import { PdfPickerModal, pickTarget } from "../reader/pdf-picker-modal";
import type { ViewMode } from "./view-mode-bar";
import type MarinMindPlugin from "../main";

/**
 * 多窗格工作区编排（139-H 自 main.ts 下沉）：学习/研究/深度复习预设、四档
 * 视图模式切换、窗格分裂/交换/归并、隐藏侧恢复等布局操作。
 * 与插件生命周期零耦合（onload/onunload 不触及），状态字段（viewModeIntent/
 * lastReaderState 等）仍留插件类——本模块经 plugin 公开面读写（服务定位器
 * 中间态，后续「窄接口注入」批次再收敛）；联动门控与互关（syncLinkedMindmap/
 * linkedClose*）属事件接线留 main。逻辑为逐字搬移零行为变化。
 */

/** 工作区预设标识（自 main.ts 随 openWorkspace 迁入） */
export type WorkspaceMode = "study" | "research" | "deep";

/** 93 批：阅读标签是否在脑图标签左侧——两窗格 containerEl 视口 x 坐标比较；
 * 同组叠加（后台标签，x 相等）按文档左常态处理。 */
export function readerIsLeft(reader: WorkspaceLeaf, map: WorkspaceLeaf): boolean {
	const r = reader.view?.containerEl.getBoundingClientRect().left ?? 0;
	const m = map.view?.containerEl.getBoundingClientRect().left ?? 0;
	return r <= m;
}

/**
 * 保证 anchor 右侧并排存在一个 viewType 窗格（79-4 严格布局）：
 * - 无目标视图标签 → 从 anchor 右侧分裂新 leaf（split 铁律：setActiveLeaf
 *   与 getLeaf 之间零 await），**不装载视图**（调用方以 getViewState().type
 *   判定新空 leaf 后自行 setViewState）；
 * - 有且与 anchor 不同 tab 组（真并排 / 独立 popout）→ 原样复用返回
 *   （用户显式摆出的布局——含 popout——尊重不动）；
 * - 有且与 anchor 同组（被拖拽合并成后台标签）→ duplicateLeaf 以该标签为锚
 *   在右侧复制（视图 state 随之），校验复制出的类型不符或抛错则**回退手工
 *   搬运**：getViewState → anchor 右侧新 leaf setViewState；成功后 detach
 *   原后台标签——"阅读器组"里不再藏脑图/复习卡。
 * 返回就位 leaf；焦点与装载由调用方负责。
 */
async function ensureSideLeaf(
	app: App,
	anchor: WorkspaceLeaf,
	viewType: string,
): Promise<WorkspaceLeaf> {
	const ws = app.workspace;
	const side = ws.getLeavesOfType(viewType)[0];
	if (!side) {
		// 新分裂路径（零 await 铁律段，同 ensureSidePane 原实现）
		ws.setActiveLeaf(anchor, { focus: true });
		return ws.getLeaf("split", "vertical"); // 'vertical' = 右侧
	}
	// 桌面端 leaf 恒挂 WorkspaceTabs：parent 不同 = 不同组（并排或跨窗口）
	if (side.parent !== anchor.parent) {
		return side;
	}
	// 同组后台标签：复制到 anchor 右侧再撤离原标签
	try {
		const dup = await ws.duplicateLeaf(side, "vertical");
		// 保守校验：duplicateLeaf 对自定义视图的 state 搬运不符即走回退
		if (dup.getViewState().type !== viewType) {
			throw new Error("duplicateLeaf 未搬运视图状态");
		}
		side.detach();
		return dup;
	} catch (err) {
		console.warn("[MarinMind] duplicateLeaf 拆分失败，回退手工搬运视图状态", err);
	}
	// 回退：手工搬运 getViewState → 新 leaf setViewState → 撤离原标签
	const st = side.getViewState();
	ws.setActiveLeaf(anchor, { focus: true });
	const fresh = ws.getLeaf("split", "vertical");
	await fresh.setViewState(st);
	side.detach();
	return fresh;
}

/**
 * 工作区预设：阅读窗格 + 右侧复习（study）/ 脑图（research）。
 * 已有阅读器标签则复用；没有则弹 PDF 选择器新标签页打开
 * （选择器取消无回调 → 放弃布局，不动用户当前笔记）。
 */
export async function openWorkspace(plugin: MarinMindPlugin, mode: WorkspaceMode): Promise<void> {
	// 79-5 深度复习是三窗格独立编排，分流到专属方法
	if (mode === "deep") {
		await openDeepWorkspace(plugin);
		return;
	}
	// ㊿ 记录显式意图：研究模式 = 阅读+脑图联动（sync 自动跟随），学习模式无脑图
	plugin.viewModeIntent = mode === "research" ? "linked" : "doc";
	const reader = plugin.app.workspace.getLeavesOfType(READER_VIEW_TYPE)[0];
	if (reader) {
		await ensureSidePane(plugin, reader, mode);
		return;
	}
	new PdfPickerModal(
		plugin.app,
		(pick) =>
			void (async () => {
				const leaf = await plugin.openInReader(pickTarget(pick));
				await ensureSidePane(plugin, leaf, mode);
			})(),
		plugin.recentExternalDocs(),
		{ plugin },
	).open();
}

/**
 * 保证右侧窗格存在并就位（幂等）：
 * 已有目标视图标签则复用（复习重启会话，脑图保持当前图）；没有则从阅读窗格右侧分裂。
 */
async function ensureSidePane(
	plugin: MarinMindPlugin,
	readerLeaf: WorkspaceLeaf,
	mode: WorkspaceMode,
): Promise<void> {
	const target = mode === "study" ? REVIEW_VIEW_TYPE : MINDMAP_VIEW_TYPE;
	// 79-4 严格布局：目标视图藏在阅读器同组后台标签时强制拆出右侧再复用
	const side = await ensureSideLeaf(plugin.app, readerLeaf, target);
	// 新空 leaf（type 不符）装载视图；复用/拆分搬运而来的叶子 state 已就位
	if (side.getViewState().type !== target) {
		// ㊴ 研究模式选图：本书摘录目标图 > 上次浏览的图；皆 null（文档加载中）
		// 不建空态脑图（㊿ 空态 onOpen 会弹选图器），由 loadFromPath 尾部 sync 补建
		const mapId =
			mode === "research"
				? (plugin.bookTargetMapId(readerLeaf) ?? plugin.restoreMapId())
				: null;
		if (mode !== "research" || mapId) {
			await side.setViewState(
				mapId ? { type: MINDMAP_VIEW_TYPE, state: { mapId } } : { type: target },
			);
			// 同 splitMindmapPane 双保险（㊿-A）：新视图 onOpen 先于 setState
			if (mapId && side.view instanceof MarinMindMindmapView) {
				side.view.loadMap(mapId);
			}
		}
		// 学习模式焦点还给阅读器（研究模式此刻脑图侧可能未建，无焦点可让）
		plugin.app.workspace.setActiveLeaf(readerLeaf, { focus: mode === "study" });
		return;
	}
	// 复用既有（或拆分搬运而来）窗格：后台标签可能是延迟加载的占位视图，需先加载
	await side.loadIfDeferred();
	if (mode === "study" && side.view instanceof MarinMindReviewView) {
		// 与"开始复习"命令一致：进入学习状态即重启会话；㊷ 学习模式必有阅读器——
		// 复习窗格跟随其当前书（无文档/库外读失败时为全部书籍）。卡组批起
		// scope 是判别联合：必须显式传 null（省略参数 = 保持当前范围，语义相反）
		const readerDocId =
			readerLeaf.view instanceof MarinMindReaderView ? readerLeaf.view.docId : null;
		await side.view.startSession(
			readerDocId != null ? { kind: "book", docId: readerDocId } : null,
		);
	}
	plugin.app.workspace.setActiveLeaf(readerLeaf, { focus: true });
	// 研究模式复用脑图窗格时纠正到本书目标图（㊿ 一对一，弃「保持当前图」）
	if (mode === "research") {
		await plugin.syncLinkedMindmap({ explicit: true }); // 79-1 显式编排绕过门控
	}
}

/**
 * 深度复习工作区（79-5，MN4 学习集式三窗格）：阅读 + 脑图 + 复习。
 * 编排：阅读窗格就位（复用/选择器，取消即放弃）→ 研究模式编排补脑图侧
 * （ensureSidePane 含 79-4 严格布局 + 显式纠正本书目标图）→ 脑图右侧
 * ensureSideLeaf 就位复习窗格（同样防同组后台标签）→ 焦点复习 + 全部书籍
 * 开练。viewModeIntent 置 doc（同学习模式）：脑图由复习卡深度导航驱动，
 * 不做切文档的书级自动跟随。脑图未建（文档加载中）时复习退居阅读器右侧
 * 二窗格，脑图稍后由 loadFromPath 尾部 sync 补建。
 */
async function openDeepWorkspace(plugin: MarinMindPlugin): Promise<void> {
	plugin.viewModeIntent = "doc";
	plugin.lastDeepCardId = null; // 新会话：首张当前卡也要导航
	const ws = plugin.app.workspace;
	let reader = ws.getLeavesOfType(READER_VIEW_TYPE)[0];
	if (!reader) {
		const file = await plugin.pickPdfFile();
		if (!file) {
			return; // 选择器取消：放弃布局，不动用户当前笔记
		}
		reader = await plugin.openInReader(file);
	}
	await ensureSidePane(plugin, reader, "research");
	// 复习窗格锚在脑图右侧（无脑图时退居阅读器右侧）
	const anchor = ws.getLeavesOfType(MINDMAP_VIEW_TYPE)[0] ?? reader;
	const review = await ensureSideLeaf(plugin.app, anchor, REVIEW_VIEW_TYPE);
	if (review.getViewState().type !== REVIEW_VIEW_TYPE) {
		await review.setViewState({ type: REVIEW_VIEW_TYPE });
	}
	// 焦点给复习（键盘评分依赖 activeLeaf === 复习 leaf）；null = 全部书籍（显式传参）
	ws.setActiveLeaf(review, { focus: true });
	await review.loadIfDeferred();
	if (review.view instanceof MarinMindReviewView) {
		await review.view.startSession(null);
	}
}

/**
 * 切换到目标视图模式。隐藏 = detach 标签（Obsidian 无"收起窗格"API），
 * 隐藏侧状态先存内存缓存（文件 + 页码 / 图 id），切回时原位恢复；
 * 取消选择器等一切路径都保证通知切换条刷新（finally）。
 */
export async function setViewMode(plugin: MarinMindPlugin, mode: ViewMode): Promise<void> {
	plugin.viewModeIntent = mode; // ㊿ 记录显式意图：联动 sync 仅在任一联动档（isLinkedIntent）下自动跟随
	// ㊿ 模式切换 detach 隐藏侧期间抑制联动互关（防级联关掉保留侧）
	plugin.suppressLinkedClose = true;
	try {
		await plugin.whenReady();
		if (!plugin.store) {
			new Notice("MarinMind：数据层未就绪，无法切换视图");
			return;
		}
		await applyViewMode(plugin, mode);
	} catch (err) {
		// 布局编排失败要可见可诊断，不能变成 "Uncaught (in promise)" 静默搁浅
		console.error("[MarinMind] 视图模式切换失败", err);
		new Notice("MarinMind：视图切换失败，详见控制台");
	} finally {
		plugin.suppressLinkedClose = false;
		plugin.notifyViewMode();
	}
}

/** 模式切换布局编排（dbReady + db 判空已由 setViewMode 保证） */
async function applyViewMode(plugin: MarinMindPlugin, mode: ViewMode): Promise<void> {
	const ws = plugin.app.workspace;
	if (mode === "doc") {
		// 脑图侧：先记下当前图（优先激活标签），再补齐阅读窗格，最后才关脑图标签——
		// 顺序不能反：先 detach 会把工作区清空，后续 getLeaf("tab") 抛
		// "No tab group found"（⑲-2 修复，newTabLeaf 兜底为第二道防线）
		const maps = ws.getLeavesOfType(MINDMAP_VIEW_TYPE);
		const active = maps.find((l) => l === ws.activeLeaf) ?? maps[0];
		const st = (active?.getViewState().state ?? {}) as { mapId?: string };
		if (typeof st.mapId === "string") {
			plugin.lastMapId = st.mapId;
		}
		await ensureReaderPane(plugin);
		if (ws.getLeavesOfType(READER_VIEW_TYPE).length === 0) {
			return; // PDF 选择器被取消：无阅读窗格可切，中止切换保持现状（脑图不关）
		}
		// 102-B 修：摘除脑图侧**之前**先把主页并入阅读器标签组——顺序后置时，
		// 藏在脑图组的主页（上一轮联动·脑图左并入的）会先被孤悬成左分屏，
		// await 间隙肉眼可见"主页短暂弹出"再被尾部并入收走；前置后摘除
		// 脑图即收回空组，主页全程是后台标签
		const readerPane = ws.getLeavesOfType(READER_VIEW_TYPE)[0];
		if (readerPane) {
			await mergeHomeIntoPane(plugin, readerPane);
		}
		for (const leaf of maps) {
			leaf.detach();
		}
		// 79-3 跨会话持久化：隐藏侧脑图写回设置（重启后联动/map 模式可恢复）；
		// 选择器取消早退路径（上方 return）不写——缓存只反映真实完成的隐藏
		if (maps.length > 0) {
			plugin.settings.workspaceHidden = plugin.lastMapId ? { mapId: plugin.lastMapId } : null;
			await plugin.saveData({ ...plugin.settings });
		}
		return;
	}
	if (mode === "map") {
		// 阅读侧：保存文件 + 当前页码（优先激活标签），先补齐脑图窗格再关闭全部阅读标签
		// （同上：先 detach 会空置工作区，⑲-2 修复）。
		// 页码来自 reader.getState 的实时值——手写/录音由 detach 触发的
		// onClose → cleanupContent 自动提交，不丢内容
		const readers = ws.getLeavesOfType(READER_VIEW_TYPE);
		const active = readers.find((l) => l === ws.activeLeaf) ?? readers[0];
		const st = (active?.getViewState().state ?? {}) as { file?: string; page?: number };
		if (typeof st.file === "string") {
			plugin.lastReaderState = {
				file: st.file,
				page: typeof st.page === "number" ? st.page : null,
			};
		}
		await ensureMindmapPane(plugin);
		// 102-B 修：摘除阅读侧之前先把主页并入脑图标签组（同 doc 分支动机）；
		// 选图器异步未建脑图时本轮跳过——建图走 newTabLeaf 自然落在激活标签组
		const mapPane = ws.getLeavesOfType(MINDMAP_VIEW_TYPE)[0];
		if (mapPane) {
			await mergeHomeIntoPane(plugin, mapPane);
		}
		// 脑图侧选图器是异步用户交互（无法在此等待）：选图回调补开脑图时工作区
		// 可能已空，由 newTabLeaf 兜底；取消选择则空工作区可经「文档」一键恢复
		// （lastReaderState 已在上方缓存）。
		for (const leaf of readers) {
			leaf.detach();
		}
		// 79-3 跨会话持久化：隐藏侧阅读状态写回设置（同 doc 分支，取消路径不写）
		if (readers.length > 0) {
			plugin.settings.workspaceHidden = plugin.lastReaderState
				? { reader: { ...plugin.lastReaderState } }
				: null;
			await plugin.saveData({ ...plugin.settings });
		}
		return;
	}
	// linked / linked-swapped（93 批四档拆分：文档左常态 / 脑图左镜像）：
	// 先确保两侧齐备并排（缺侧从对侧右侧分裂补齐），再按目标方位归位——
	// 方位不符时交换（swapLinkedOrientation），最后 syncLinkedMindmap 纠正
	// 脑图侧到本书目标图（㊿ 一对一：空态/无关图标签一律被拉回）。
	const wantMapLeft = mode === "linked-swapped";
	let reader = ws.getLeavesOfType(READER_VIEW_TYPE)[0];
	let map = ws.getLeavesOfType(MINDMAP_VIEW_TYPE)[0];
	if (!reader && !map) {
		// 两侧皆无：先开阅读器（必经选择器），再从其右侧分裂脑图（方位随后统一归位）
		const file = await plugin.pickPdfFile();
		if (!file) {
			return;
		}
		const leaf = await plugin.openInReader(file);
		await splitMindmapPane(plugin, leaf);
		reader = ws.getLeavesOfType(READER_VIEW_TYPE)[0];
		map = ws.getLeavesOfType(MINDMAP_VIEW_TYPE)[0];
		if (!reader || !map) {
			return; // 选图器取消/文档未加载完：脑图未建，保持现状（loadFromPath 尾部 sync 补）
		}
	} else if (reader && !map) {
		await splitMindmapPane(plugin, reader);
		map = ws.getLeavesOfType(MINDMAP_VIEW_TYPE)[0];
		if (!map) {
			return; // 选图器取消/文档加载中：无脑图可编排
		}
	} else if (!reader && map) {
		const file = await plugin.pickRestoredPdf();
		if (!file) {
			return; // 取消选择：不动布局
		}
		ws.setActiveLeaf(map, { focus: true });
		const side = ws.getLeaf("split", "vertical");
		await plugin.openInReader(file, undefined, undefined, side);
		reader = ws.getLeavesOfType(READER_VIEW_TYPE)[0];
		if (!reader) {
			return;
		}
	}
	// 两侧齐备：79-4 严格布局——脑图若被拖进阅读器同组（后台标签）先强制拆出
	if (!reader || !map) {
		return; // 类型收窄守卫（上方各分支理论上都已 return 或补齐）
	}
	await ensureSideLeaf(plugin.app, reader, MINDMAP_VIEW_TYPE);
	const mapLeftNow = !readerIsLeft(reader, map);
	if (mapLeftNow !== wantMapLeft) {
		await swapLinkedOrientation(plugin, wantMapLeft);
		reader = ws.getLeavesOfType(READER_VIEW_TYPE)[0];
		map = ws.getLeavesOfType(MINDMAP_VIEW_TYPE)[0];
		if (!reader || !map) {
			return; // 交换失败（无状态可重开）：按现状保持
		}
	}
	ws.setActiveLeaf(reader, { focus: true });
	await plugin.syncLinkedMindmap({ explicit: true }); // 79-1 切换条显式编排绕过门控
	// 102 修：主页并入左侧窗格标签组（文档左/脑图左各取其左）作后台标签——
	// 方位交换重开对侧后主页最易被孤悬成分屏；sync 可能重建脑图叶，此处现取
	const leftPane = ws.getLeavesOfType(wantMapLeft ? MINDMAP_VIEW_TYPE : READER_VIEW_TYPE)[0];
	if (leftPane) {
		await mergeHomeIntoPane(plugin, leftPane);
	}
}

/**
 * 主页并入 primary 所在标签组（102 修）：视图模式编排（分裂补侧、detach 隐藏侧、
 * 方位交换重开）可能把主页孤悬成独立窗格——与文档/脑图并排形成分屏。约定：
 * 文档/脑图单侧视图并入唯一窗格、联动视图并入左侧窗格，作**后台标签**——
 * 随时点标签回主页，不再占一块分屏。已同组（从主页开文档的常态）幂等跳过；
 * popout 独立窗口的主页不动（getRoot 跨窗口判定，尊重用户显式布局）。
 * 并入 = 记录视图状态 → detach 原叶 → createLeafInParent 组尾建**后台标签**
 * （102-A：不激活不切可见页——getLeaf("tab") 会把新标签顶成组内可见页，
 * 主页渲染完才切回，肉眼可见"主页弹出几秒才缩回标签"）→ 恢复状态并剥离
 * active 位（导航页随 getState 持久化）。
 */
async function mergeHomeIntoPane(plugin: MarinMindPlugin, primary: WorkspaceLeaf): Promise<void> {
	const ws = plugin.app.workspace;
	let merged = false;
	for (const home of ws.getLeavesOfType(HOME_VIEW_TYPE)) {
		if (home.parent === primary.parent) {
			continue; // 已在目标组（前台/后台标签皆算）
		}
		if (home.getRoot() !== primary.getRoot()) {
			continue; // 跨窗口（popout）：不把主页拉离用户显式摆放的窗口
		}
		const st = home.getViewState();
		home.detach();
		// children 不在 public .d.ts：运行时取组内标签数作插入位（桌面端
		// parent 恒挂 WorkspaceTabs，同 ensureSideLeaf 假设）
		const count = (primary.parent as { children?: unknown[] }).children?.length ?? 0;
		const fresh = ws.createLeafInParent(primary.parent as WorkspaceSplit, count);
		// 剥离 active 位：并入的是后台标签，不抢组内可见页
		await fresh.setViewState({ ...st, active: false });
		merged = true;
	}
	if (merged) {
		// 双保险：若 setViewState 激活了新叶，激活标签还回主窗格
		ws.setActiveLeaf(primary, { focus: false });
	}
}

/**
 * 93 批：交换联动布局方位。Obsidian 无公开 API 把已有窗格移到另一侧
 * （getLeaf("split") 只向激活标签右侧分裂）——采用"记状态 → detach 一侧 →
 * 从锚定侧右侧重开"实现交换：
 * - 目标脑图左：缓存文件+页码（优先激活标签，同 map 分支），detach 全部阅读
 *   标签，从脑图右侧重开阅读器（页码原位恢复；detach 触发的 onClose 自动
 *   提交手写/录音，不丢内容）；
 * - 目标文档左：detach 全部脑图标签，从阅读侧右侧按选图优先级重开
 *   （splitMindmapPane：本书目标图 > lastMapId）。
 * 调用方保证两侧标签齐备且方位确需交换。
 */
async function swapLinkedOrientation(plugin: MarinMindPlugin, wantMapLeft: boolean): Promise<void> {
	const ws = plugin.app.workspace;
	const readers = ws.getLeavesOfType(READER_VIEW_TYPE);
	const maps = ws.getLeavesOfType(MINDMAP_VIEW_TYPE);
	if (readers.length === 0 || maps.length === 0) {
		return;
	}
	if (wantMapLeft) {
		const active = readers.find((l) => l === ws.activeLeaf) ?? readers[0];
		const st = (active?.getViewState().state ?? {}) as { file?: string; page?: number };
		if (typeof st.file !== "string") {
			return; // 无文件状态可重开：保持现状
		}
		const page = typeof st.page === "number" ? st.page : null;
		plugin.lastReaderState = { file: st.file, page };
		const map = maps[0];
		// 102-B 修：摘除阅读侧之前先把主页并入脑图组（幸存侧）——后置会在
		// openInReader 的 PDF 秒级重载间隙里把主页孤悬成可见分屏
		await mergeHomeIntoPane(plugin, map);
		for (const leaf of readers) {
			leaf.detach();
		}
		ws.setActiveLeaf(map, { focus: true });
		const side = ws.getLeaf("split", "vertical");
		await plugin.openInReader(st.file, page ?? undefined, undefined, side);
		ws.setActiveLeaf(map, { focus: false });
		return;
	}
	const reader = readers[0];
	// 102-B 修：同上，摘除脑图侧之前并入幸存的阅读组
	await mergeHomeIntoPane(plugin, reader);
	for (const leaf of maps) {
		leaf.detach();
	}
	await splitMindmapPane(plugin, reader);
}

/**
 * 从 anchor 右侧分裂脑图窗格：选图优先级见 bookTargetMapId（㊴），回退
 * lastMapId（过渡展示，加载完成后 syncLinkedMindmap 会纠正到本书目标图）。
 * 两者皆 null（文档加载中未 upsert）时**不建空态脑图**——空态 onOpen 会弹
 * 选图器（㊿ 消灭联动弹窗路径），由 loadFromPath 尾部的 sync 补建。
 */
export async function splitMindmapPane(
	plugin: MarinMindPlugin,
	anchor: WorkspaceLeaf,
): Promise<void> {
	const ws = plugin.app.workspace;
	const mapId = plugin.bookTargetMapId(anchor) ?? plugin.restoreMapId();
	if (!mapId) {
		// 文档尚未加载完成：联动 sync（loadFromPath 尾部）稍后补建，此处静默
		return;
	}
	// split 锚点是"调用时刻的激活 leaf"：setActiveLeaf 与 getLeaf 之间不得有 await
	ws.setActiveLeaf(anchor, { focus: true });
	const side = ws.getLeaf("split", "vertical");
	await side.setViewState({ type: MINDMAP_VIEW_TYPE, state: { mapId } });
	// 双保险（㊿-A）：Obsidian 新视图 onOpen 先于 setState——若 mapId 未及
	// 送达（版本差异），此处显式加载；已加载则幂等重拉
	if (side.view instanceof MarinMindMindmapView) {
		side.view.loadMap(mapId);
	}
	ws.setActiveLeaf(anchor, { focus: false });
}

/** 保证阅读窗格存在：已有则聚焦；缓存可恢复则带页码重开；否则弹 PDF 选择器 */
async function ensureReaderPane(plugin: MarinMindPlugin): Promise<void> {
	const ws = plugin.app.workspace;
	const reader = ws.getLeavesOfType(READER_VIEW_TYPE)[0];
	if (reader) {
		ws.setActiveLeaf(reader, { focus: true });
		return;
	}
	const file = await plugin.pickRestoredPdf();
	if (file) {
		// 79-3 页码同走合并读取（内存优先、持久回退），重开回到隐藏前页
		await plugin.openInReader(file, plugin.hiddenReaderState()?.page ?? undefined);
	}
}

/** 保证脑图窗格存在：已有则聚焦；选图优先级见 bookTargetMapId（㊴），否则弹选图器 */
async function ensureMindmapPane(plugin: MarinMindPlugin): Promise<void> {
	const ws = plugin.app.workspace;
	const map = ws.getLeavesOfType(MINDMAP_VIEW_TYPE)[0];
	if (map) {
		ws.setActiveLeaf(map, { focus: true });
		return;
	}
	// 调用时机（applyViewMode map 分支）阅读标签尚未 detach，可解析本书目标图
	const readers = ws.getLeavesOfType(READER_VIEW_TYPE);
	const mapId =
		plugin.bookTargetMapId(readers.find((l) => l === ws.activeLeaf) ?? readers[0]) ??
		plugin.restoreMapId();
	if (mapId) {
		await plugin.openMindmap(mapId);
	} else {
		plugin.openMindmapPicker();
	}
}
