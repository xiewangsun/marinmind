/**
 * 界面语言词条（148 i18n）：键 = 中文源串（调用处 t("中文原文")），值 = 英文。
 * 中文即键的取舍：抽取是机械包 t() 不需要另起键名体系；缺词条自动回退中文
 * （渐进双语——词条随批次补齐，未覆盖面保持中文可用）。改中文措辞会使词条
 * 失配（回退中文，不报错）——调整文案时同步更新本表。
 *
 * 术语表（中 → 英，保持一致）：
 *   摘录 excerpt · 文字摘录 text excerpt · 区域摘录 area excerpt · 套索 lasso
 *   留白 marginal note · 手写 handwriting · 闪卡 flashcard · 卡组 deck
 *   脑图 mind map · 复习 review · 到期 due · 重来 Again · 翻面 reveal
 *   联动 linked view · 工作区 workspace · 摘录预览 excerpt preview
 *   卡片 card · 批注 note · 标签 tag · 归档 archive/categorize · 失联 missing
 *   库外 outside-vault · 剪藏 clip · 遮挡 occlusion · 转为闪卡 Mark as flashcard
 */
export const EN: Record<string, string> = {
	// ---- 149 第一批：命令面板（main.ts 26 条命令名） ----
	"打开 MarinMind 主页": "Open MarinMind home",
	"打开 MarinMind 阅读器（选择文档）": "Open MarinMind reader (choose document)",
	"打开库外文档（桌面）": "Open document outside vault (desktop)",
	"截图并复制到剪贴板（桌面）": "Capture screenshot to clipboard (desktop)",
	"截图其他窗口（隐藏本窗口后拍摄，桌面）":
		"Screenshot another window (hide this window first, desktop)",
	"剪藏屏幕区域为笔记（桌面）": "Clip screen region as note (desktop)",
	保存网页为笔记文档: "Save webpage as note document",
	"开始复习（到期闪卡）": "Start review (due flashcards)",
	"按卡组复习（选择卡组）": "Review by deck (choose deck)",
	"导出闪卡为 Anki CSV": "Export flashcards to Anki CSV",
	"打开思维导图（选择 / 新建脑图）": "Open mind map (choose / create)",
	"打开 AI 助手（当前文档问答）": "Open AI assistant (ask about current document)",
	"学习模式工作区（阅读 + 复习）": "Study workspace (reader + review)",
	"研究模式工作区（阅读 + 脑图）": "Research workspace (reader + mind map)",
	"深度复习工作区（阅读 + 脑图 + 复习）": "Deep review workspace (reader + mind map + review)",
	"切换视图：单文档（隐藏脑图）": "Switch view: document only (hide mind map)",
	"切换视图：单脑图（隐藏文档）": "Switch view: mind map only (hide document)",
	"切换视图：联动（左文档右脑图）": "Switch view: linked (document left, mind map right)",
	"切换视图：联动（左脑图右文档）": "Switch view: linked (mind map left, document right)",
	"复习统计（热力图 / 到期分布 / 库统计）":
		"Review statistics (heatmap / due distribution / library stats)",
	"导出备份（.marginpkg）": "Export backup (.marginpkg)",
	"导入备份（.marginpkg）": "Import backup (.marginpkg)",
	"文档管理（重关联失联文档）": "Manage documents (relink missing files)",
	捕捉照片为自由卡片: "Capture photo as free card",
	"录音摘录（自由卡片）": "Voice excerpt (free card)",
	"扫描并清理附件…": "Scan and clean up attachments…",
	// ---- 148：语言切换提示 ----
	"语言已切换——已打开的界面需重开（或重启 Obsidian）后完全生效":
		"Language switched — reopen views (or restart Obsidian) to fully apply",
	// ---- 149 第二批：复习界面核心 ----
	重来: "Again",
	困难: "Hard",
	良好: "Good",
	简单: "Easy",
	问题: "Question",
	内容: "Answer",
	翻面看答案: "Reveal answer",
	无出处信息: "No source info",
	自由卡片: "Free card",
	"已考 · {grade}": "Graded · {grade}",
	"后面的卡 · 未考": "Upcoming · not reviewed",
	"AI 提示": "AI hint",
	选择题自测: "Multiple-choice self-quiz",
	"AI 解释": "AI explain",
	"第 {i} / {n} 张": "Card {i} / {n}",
	"剩余 {n} 张": "{n} left",
	"按 1-4 评分 · ← → 切换卡片": "Rate 1-4 · ← → to navigate cards",
	"空格 / 回车翻面 · ← → 切换卡片": "Space / Enter to reveal · ← → to navigate cards",
	"已考过的卡（只读）· ← → 继续浏览": "Reviewed card (read-only) · ← → to keep browsing",
	"后面的卡（只看正面）· ← → 切换": "Upcoming card (front only) · ← → to navigate",
	// ---- 149 第三批：视图标签名 + 设置分区标题 ----
	"AI 助手": "AI assistant",
	"MarinMind 主页": "MarinMind home",
	"MarinMind 思维导图": "MarinMind mind map",
	"MarinMind 阅读器": "MarinMind reader",
	"MarinMind 复习": "MarinMind review",
	常规: "General",
	工作区: "Workspace",
	外观: "Appearance",
	数据存储: "Data storage",
	阅读: "Reading",
	"文字识别 (OCR)": "Text recognition (OCR)",
	翻译: "Translation",
	复习: "Review",
	网页剪藏: "Web clipper",
	屏幕截图: "Screenshot",
	备份: "Backup",
};
