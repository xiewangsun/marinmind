import type { ItemView } from "obsidian";

/**
 * 活跃视图注册表（147 通知机制收敛）：视图 onOpen 自注册 / onClose 自注销
 * （按 viewType 分桶），插件层按类型广播或取快照——与 cardBus（数据事件，
 * events/card-bus.ts）构成「数据事件 + 视图注册表」两层通知机制，取代此前
 * 的模块级 Set（mindmap-view activeViews）与 leaf 扫描式中介广播
 * （main.refreshReaderBookmarks / applyExternalRename）。
 *
 * 注册语义与「leaf 扫描 + instanceof」等价（视图构造即 onOpen、detach 即
 * onClose、deferred 叶两者都跳过）；迭代顺序为注册序而非工作区标签序——
 * 仅用于「逐视图独立动作」的广播与快照，**带激活标签位置语义的查询**
 * （如 activeReaderDocId）不收敛、仍走 leaf 扫描。订阅式 API
 * （onViewModeChange 返回退订函数）形态不同，不并入本表。
 */
const viewsByType = new Map<string, Set<ItemView>>();

/** 视图 onOpen 调用：加入本类型活跃集（幂等——Set 语义天然去重） */
export function registerActiveView(view: ItemView): void {
	let bucket = viewsByType.get(view.getViewType());
	if (!bucket) {
		bucket = new Set();
		viewsByType.set(view.getViewType(), bucket);
	}
	bucket.add(view);
}

/** 视图 onClose 调用：移出活跃集（桶空即撤，防长期累积空桶） */
export function unregisterActiveView(view: ItemView): void {
	const bucket = viewsByType.get(view.getViewType());
	if (!bucket) {
		return;
	}
	bucket.delete(view);
	if (bucket.size === 0) {
		viewsByType.delete(view.getViewType());
	}
}

/** 本类型活跃视图快照（注册序；只读用途——调用方不得依赖工作区标签序） */
export function activeViewsOf<T extends ItemView>(viewType: string): T[] {
	return [...(viewsByType.get(viewType) ?? [])] as T[];
}

/** 向本类型全部活跃视图广播（每视图独立动作，无顺序语义） */
export function broadcastToViews<T extends ItemView>(
	viewType: string,
	fn: (view: T) => void,
): void {
	for (const view of activeViewsOf<T>(viewType)) {
		fn(view);
	}
}
