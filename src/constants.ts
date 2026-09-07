/** 数据目录与文件路径集中定义（备份 / 附件 / 设置等模块共用） */

/** 默认数据目录（vault 相对路径，㉚ md 存储起改为显式目录名，用户在文件列表可见可管理） */
export const DEFAULT_DATA_DIR = "MarinMind";

/** 旧版 SQLite 时代的默认数据目录（㉚ 启动迁移检测的回溯位置；库文件在 <该目录>/marinmind.db） */
export const LEGACY_DATA_DIR = ".marinmind";

/** 默认备份导出目录（vault 内可见路径，便于用户拷走/同步） */
export const DEFAULT_BACKUP_DIR = "Backups/MarinMind";

/** 旧默认网页剪藏目录（113 版，vault 相对）：124 起剪藏迁入数据根 clips/，此值仅供存量迁移检测回溯 */
export const DEFAULT_WEBCLIP_FOLDER = "WebClips";

/** 剪藏子目录（124，数据根相对：网页剪藏与屏幕剪藏 md 的落点，图片统一走 assets/） */
export const CLIPS_SUBDIR = "clips";

/** SQLite 库文件名（数据根相对路径） */
export const DB_FILENAME = "marinmind.db";

/** 媒体附件子目录（数据根相对路径，照片/手写/语音） */
export const ASSETS_SUBDIR = "assets";

/** 导入前安全快照目录（数据根下，存现有 md 树副本，只保留最近一份；㉚ md 存储版） */
export const SNAPSHOT_DIR = "pre-import-snapshot";

/** 旧版 SQLite 快照文件名前缀（导入时顺带清理历史 .db 快照） */
export const SNAPSHOT_PREFIX = "pre-import-snapshot-";

/**
 * 库外文档移动端打开限制提示（P3-1 抽常量防 4 处文案漂移；
 * 消费方：文档管理面板 / 主页 openDoc / main.ts openInReader 与 openCardSource）
 */
export const MSG_EXTERNAL_DOC_MOBILE = "该文档在库外，移动端暂不支持打开";
