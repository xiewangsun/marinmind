/**
 * 剪藏文件命名纯函数（113-A）：Windows 非法字符/保留名防御 + 冲突递增。
 * 剪藏 md 与其图片子目录共用（<名>.md / <名>.assets/）；服务层传 taken
 * 集合（目标目录既有文件名），-2/-3 递增逻辑纯函数化便于 vitest 覆盖
 * （先例：documents/copy-into-vault.ts 的内联 for 循环）。
 */

/** Windows 保留设备名（大小写不敏感，不带扩展名比对；加后缀防整盘不可创建） */
const RESERVED_NAMES = new Set([
	"CON",
	"PRN",
	"AUX",
	"NUL",
	"COM1",
	"COM2",
	"COM3",
	"COM4",
	"COM5",
	"COM6",
	"COM7",
	"COM8",
	"COM9",
	"LPT1",
	"LPT2",
	"LPT3",
	"LPT4",
	"LPT5",
	"LPT6",
	"LPT7",
	"LPT8",
	"LPT9",
]);

/** 文件名最大长度（字符，码点计）：80 对网页标题绰绰有余且远避各文件系统 255 字节限 */
const MAX_NAME_LENGTH = 80;

/**
 * 净化为合法文件名：去首尾空白、Windows 非法字符与控制符替换为空格、折叠连续
 * 空白、去尾随点/空格（Windows 禁）、截断到 80 字符、保留名加后缀、空结果回
 * fallback。全角字符/中文原样保留（NTFS/APFS 均合法）。
 */
export function sanitizeFileName(raw: string, fallback: string): string {
	// 非法标点走正则；控制符（码点 < 0x20）走码点判断——避免源码/正则字面量内嵌
	// 控制字符（编辑器/格式化器会静默改写）
	let name = raw.replace(/[\\/:*?"<>|]/g, " ");
	name = Array.from(name)
		.map((ch) => ((ch.codePointAt(0) ?? 0x100) < 0x20 ? " " : ch))
		.join("");
	name = name
		.replace(/\s+/g, " ")
		.trim()
		// 尾随点/空格在 Windows 上会被资源管理器静默剥离导致路径错位，先去掉
		.replace(/[. ]+$/, "");
	if (!name) {
		return fallback;
	}
	// 码点截断（Array.from 防代理对截半，CJK 扩展 B 区 emoji 类场景）
	name = Array.from(name)
		.slice(0, MAX_NAME_LENGTH)
		.join("")
		.replace(/[. ]+$/, "");
	if (!name) {
		return fallback;
	}
	if (RESERVED_NAMES.has(name.toUpperCase())) {
		name = `${name}-note`;
	}
	return name;
}

/**
 * 取不冲突的文件名：目标名未被占用原样返回，占用则 -2/-3 递增
 * （"foo.md" → "foo-2.md" → "foo-3.md"；先例 copy-into-vault 同款语义）。
 * @param base 已净化的主名（不含扩展名）
 * @param ext 扩展名（不含点，如 "md"）
 * @param taken 目标目录既有文件名集合（如 new Set(["foo.md"])）
 */
export function nextFileName(base: string, ext: string, taken: ReadonlySet<string>): string {
	const dotExt = ext ? `.${ext}` : "";
	for (let i = 1; ; i++) {
		const candidate = i === 1 ? `${base}${dotExt}` : `${base}-${i}${dotExt}`;
		if (!taken.has(candidate)) {
			return candidate;
		}
	}
}
