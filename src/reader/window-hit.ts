/**
 * 跨窗口命中换算（79-6 跨 popout 拖卡，桌面端专用）：
 * popout 窗口与主窗共享同一 JS 上下文，但各自的 elementFromPoint 只认本窗
 * 视口的 client 坐标——源窗拖拽期间拿到的 screenX/Y 需换算到目标窗 client
 * 坐标才能驱动他窗脑图的落点提示与落卡。
 *
 * 浏览器不暴露窗口视口的精确屏幕原点，采用近似：
 * - 横向：screenX + (outerWidth − innerWidth) / 2（左右边框均摊）
 * - 纵向：screenY + (outerHeight − innerHeight)（chrome 全部归顶——
 *   标题栏+标签栏在上、底部边框≈0，Windows 通用形态）
 * 混合 DPI 多屏下偏差数 px——落点命中是节点/画布级粗粒度，可容忍（已知近似）。
 * 纯函数零 obsidian 依赖，可单测。
 */

/** 换算所需的最小窗口几何快照（可从 Window 抽取，也可测试手造） */
export interface WindowGeom {
	screenX: number;
	screenY: number;
	outerWidth: number;
	outerHeight: number;
	innerWidth: number;
	innerHeight: number;
}

/** 从 Window 抽取几何快照（Pick 收窄便于测试传 fake 对象） */
export function geomOf(win: Pick<Window, keyof WindowGeom>): WindowGeom {
	return {
		screenX: win.screenX,
		screenY: win.screenY,
		outerWidth: win.outerWidth,
		outerHeight: win.outerHeight,
		innerWidth: win.innerWidth,
		innerHeight: win.innerHeight,
	};
}

/** 视口原点（屏幕坐标）：横边框均摊、纵 chrome 归顶的近似 */
export function viewportOrigin(g: WindowGeom): { x: number; y: number } {
	return {
		x: g.screenX + Math.round((g.outerWidth - g.innerWidth) / 2),
		y: g.screenY + (g.outerHeight - g.innerHeight),
	};
}

/**
 * 屏幕坐标 → 目标窗 client 坐标；指针不在该窗视口内返回 null。
 * 边缘 1px 收缩：视口边界处的浮点/近似误差不误判为窗外。
 */
export function clientFromScreen(
	g: WindowGeom,
	sx: number,
	sy: number,
): { x: number; y: number } | null {
	const o = viewportOrigin(g);
	const x = sx - o.x;
	const y = sy - o.y;
	if (x < 1 || y < 1 || x > g.innerWidth - 1 || y > g.innerHeight - 1) {
		return null;
	}
	return { x, y };
}
