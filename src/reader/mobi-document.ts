/**
 * MOBI/AZW3/AZW/PRC 解析纯函数（㊽；零 obsidian 依赖，vitest 直测——镜像
 * epub-document.ts 分层先例）。
 *
 * 产出「虚拟 EPUB」：parseMobi 返回 EpubBook 形状——章节合成路径 c/0001.xhtml、
 * 图片 img/0001.jpg，readEntry 惰性返回 UTF-8 章节字节 / 原始图片记录字节，
 * 下游 EpubSession 渲染 / 摘录 / 回链 / 搜索 / AI 上下文全链路与 EPUB 共用
 * （章=页模型：page = 章序号 + 1）。
 *
 * 格式层次（对照 foliate-js mobi.js（MIT）与 kindleunpack 移植，不引依赖）：
 * - 容器：PDB（Palm Database）记录表；record 0 = PalmDOC 头 + MOBI 头 + EXTH
 * - 文本：记录 1..textRecordCount 剥尾部条目后按 PalmDOC（LZ77 变体）或
 *   HUFF/CDIC 解压，拼接为全文字节流
 * - MOBI6：全文按 <mbp:pagebreak> 切章；filepos（字节偏移）锚点；
 *   目录 = guide reference[type=toc] 所指节内的 a[filepos] 链接
 * - KF8（AZW3，version ≥ 8）：FDST 流表 + skel/frag（INDX 索引）字节重组分章 +
 *   NCX（INDX）目录；图片/脚注走 kindle:embed:NNNN（32 进制）/ kindle:flow:NNNN
 * - combo 文件（kindlegen 的 MOBI6+KF8 合一）：EXTH 121 boundary 指向 KF8 头记录
 *
 * 与 EPUB 的差异取舍：分章/锚点/重组都作用在拼接后的全文字节上，解压在
 * parse 期一次性完成（readEntry 只做廉价编码）；DRM（PalmDOC encryption）一律
 * 拒收（镜像 EPUB encryption.xml 拒收）；书籍自带 CSS 本就不采用（统一主题
 * 排版），KF8 的 RESC/字体记录跳过；图片扩展名由 embed 的 mime 参数或字节
 * 魔数嗅探。
 */
import { strFromU8, strToU8 } from "fflate";
import type { EpubBook, EpubSpineItem, EpubTocNode } from "./epub-document";

// ── 基础读取（大端，PDB/MOBI 全大端）──────────────────────────────────────

/** 单字节读取（越界按 0，头字段缺失时调用方按无效值处理） */
const u8at = (b: Uint8Array, o: number): number => (o >= 0 && o < b.length ? b[o] : 0);

const u16be = (b: Uint8Array, o: number): number => (u8at(b, o) << 8) | u8at(b, o + 1);

const u32be = (b: Uint8Array, o: number): number =>
	((u8at(b, o) << 24) | (u8at(b, o + 1) << 16) | (u8at(b, o + 2) << 8) | u8at(b, o + 3)) >>> 0;

/**
 * latin1 视图（1 字节 = 1 字符）：filepos/skel/frag 偏移都是字节偏移，切分与
 * 锚点插入必须在字节语义下进行（UTF-8 多字节会使 charCodeAt 偏移失真）。
 */
function latin1Of(b: Uint8Array): string {
	let out = "";
	for (let i = 0; i < b.length; i += 0x8000) {
		out += String.fromCharCode.apply(null, b.subarray(i, i + 0x8000) as unknown as number[]);
	}
	return out;
}

/** CP1252（windows-1252）0x80–0x9F 特殊字符表；其余码位与 latin1 一致 */
const CP1252_HIGH = [
	"€",
	"",
	"‚",
	"ƒ",
	"„",
	"…",
	"†",
	"‡",
	"ˆ",
	"‰",
	"Š",
	"‹",
	"Œ",
	"",
	"Ž",
	"",
	"",
	"‘",
	"’",
	"“",
	"”",
	"•",
	"–",
	"—",
	"˜",
	"™",
	"š",
	"›",
	"œ",
	"",
	"ž",
	"Ÿ",
];

/**
 * CP1252 解码：Node small-icu 构建下 TextDecoder("windows-1252") 可能抛
 * RangeError，自带查表保证测试与生产同码（编码 1252 的老 MOBI 常见）。
 */
function cp1252Of(b: Uint8Array): string {
	let out = "";
	for (let i = 0; i < b.length; i += 0x8000) {
		const part = b.subarray(i, i + 0x8000);
		let s = "";
		for (let j = 0; j < part.length; j++) {
			const c = part[j];
			s += c < 0x80 || c >= 0xa0 ? String.fromCharCode(c) : CP1252_HIGH[c - 0x80];
		}
		out += s;
	}
	return out;
}

/** 书籍字节按声明编码解码（65001=UTF-8；1252 及未知编码兜底按 CP1252） */
function decodeBookBytes(b: Uint8Array, encoding: number): string {
	return encoding === 65001 ? strFromU8(b) : cp1252Of(b);
}

function concatBytes(parts: Uint8Array[]): Uint8Array {
	const total = parts.reduce((n, p) => n + p.length, 0);
	const out = new Uint8Array(total);
	let pos = 0;
	for (const p of parts) {
		out.set(p, pos);
		pos += p.length;
	}
	return out;
}

/** 前向 varlen（7 位/字节，最高位=1 结束；INDX 值区/CNCX 长度前缀共用） */
function varlenAt(b: Uint8Array, pos: number): { value: number; length: number } {
	let value = 0;
	let length = 0;
	for (let i = pos; i < b.length && length < 4; i++) {
		const byte = b[i];
		value = ((value << 7) | (byte & 0x7f)) >>> 0;
		length++;
		if (byte & 0x80) {
			break;
		}
	}
	return { value, length };
}

/**
 * 尾部 varlen（从数据末尾回读：扫描最后 ≤4 字节，遇最高位=1 重置——即该字节
 * 是数值的最高有效组；PalmDOC trailing entry 的长度编码）。
 */
function varlenFromEnd(b: Uint8Array): number {
	let value = 0;
	for (let i = Math.max(0, b.length - 4); i < b.length; i++) {
		if (b[i] & 0x80) {
			value = 0;
		}
		value = ((value << 7) | (b[i] & 0x7f)) >>> 0;
	}
	return value;
}

function countBitsSet(x: number): number {
	let c = 0;
	while (x > 0) {
		c += x & 1;
		x >>>= 1;
	}
	return c;
}

function countUnsetEnd(x: number): number {
	let c = 0;
	while (x > 0 && (x & 1) === 0) {
		x >>>= 1;
		c++;
	}
	return c;
}

/** 常见 HTML 实体最小反转义（EXTH 标题/目录标签常含 &amp; 等） */
function unescapeMinimal(s: string): string {
	return s
		.replace(/&amp;/g, "&")
		.replace(/&lt;/g, "<")
		.replace(/&gt;/g, ">")
		.replace(/&quot;/g, '"')
		.replace(/(?:&#39;|&apos;)/g, "'");
}

// ── 容器层：PDB 记录 + PalmDOC/MOBI/EXTH 头 ───────────────────────────────

/** record 0 解析产物（字段偏移为 record 0 内绝对偏移，全大端） */
interface MobiHeader {
	/** 1=无压缩 2=PalmDOC 17480=HUFF/CDIC */
	compression: number;
	textRecordCount: number;
	/** 0=无加密；非 0 = DRM（老 MOBI=1 / 新 DRM=2）——一律拒收 */
	encryption: number;
	/** MOBI 头长度（EXTH 紧随其后：16 + mobiLength） */
	mobiLength: number;
	encoding: number;
	version: number;
	titleBytes: Uint8Array | null;
	resourceStart: number;
	huffcdic: number;
	numHuffcdic: number;
	exthFlag: number;
	fdst: number;
	numFdst: number;
	trailingFlags: number;
	indx: number;
	frag: number;
	skel: number;
}

/**
 * PDB 容器切分：numRecords@76（u16），偏移表@78 起 8 字节/条（偏移 u32 + 属性
 * u32）；记录 i = [offsets[i], offsets[i+1])，末条到文件尾。
 */
function pdbRecordsOf(bytes: Uint8Array): Uint8Array[] {
	if (bytes.length < 86) {
		throw new Error("不是有效的 MOBI 文件（文件过短）");
	}
	const creator = latin1Of(bytes.subarray(64, 68));
	const type = latin1Of(bytes.subarray(60, 64));
	if (type.startsWith("TPZ") || creator.startsWith("TPZ")) {
		throw new Error("该文件是 Topaz 格式（旧 .azw），暂不支持");
	}
	// type@60 + creator@64 合起来才是完整魔数 "BOOKMOBI"
	if (latin1Of(bytes.subarray(60, 68)) !== "BOOKMOBI") {
		throw new Error("不是有效的 MOBI 文件（缺少 BOOKMOBI 标识）");
	}
	const numRecords = u16be(bytes, 76);
	if (numRecords === 0 || 78 + numRecords * 8 > bytes.length) {
		throw new Error("MOBI 结构损坏：记录表越界");
	}
	const tableEnd = 78 + numRecords * 8;
	const records: Uint8Array[] = [];
	for (let i = 0; i < numRecords; i++) {
		const start = Math.max(u32be(bytes, 78 + i * 8), tableEnd);
		const end =
			i + 1 < numRecords
				? Math.min(u32be(bytes, 78 + (i + 1) * 8), bytes.length)
				: bytes.length;
		records.push(start <= end ? bytes.subarray(start, end) : new Uint8Array(0));
	}
	return records;
}

function readMobiHeader(record0: Uint8Array): MobiHeader {
	if (record0.length < 20 || latin1Of(record0.subarray(16, 20)) !== "MOBI") {
		throw new Error("MOBI 结构损坏：record 0 缺少 MOBI 头魔数");
	}
	const mobiLength = u32be(record0, 20);
	const titleOffset = u32be(record0, 84);
	const titleLength = u32be(record0, 88);
	const titleBytes =
		titleOffset > 0 && titleLength > 0 && titleOffset + titleLength <= record0.length
			? record0.subarray(titleOffset, titleOffset + titleLength)
			: null;
	return {
		compression: u16be(record0, 0),
		textRecordCount: u16be(record0, 8),
		encryption: u16be(record0, 12),
		mobiLength,
		encoding: u32be(record0, 28),
		version: u32be(record0, 36),
		titleBytes,
		resourceStart: u32be(record0, 108),
		huffcdic: u32be(record0, 112),
		numHuffcdic: u32be(record0, 116),
		exthFlag: u32be(record0, 128),
		fdst: u32be(record0, 192),
		numFdst: u32be(record0, 196),
		trailingFlags: u32be(record0, 240),
		indx: u32be(record0, 244),
		frag: u32be(record0, 248),
		skel: u32be(record0, 252),
	};
}

/** EXTH（扩展元数据）记录表：type → 数据列表（同 type 可重复） */
function parseExth(record0: Uint8Array, header: MobiHeader): Map<number, Uint8Array[]> | null {
	if (!(header.exthFlag & 0x40)) {
		return null;
	}
	const start = 16 + header.mobiLength;
	if (start + 12 > record0.length || latin1Of(record0.subarray(start, start + 4)) !== "EXTH") {
		return null;
	}
	const count = u32be(record0, start + 8);
	const map = new Map<number, Uint8Array[]>();
	let off = start + 12;
	for (let i = 0; i < count && off + 8 <= record0.length; i++) {
		const type = u32be(record0, off);
		const len = u32be(record0, off + 4);
		if (len < 8 || off + len > record0.length) {
			break;
		}
		const data = record0.subarray(off + 8, off + len);
		const list = map.get(type);
		if (list) {
			list.push(data);
		} else {
			map.set(type, [data]);
		}
		off += len;
	}
	return map;
}

/** EXTH 首 u32 值（0xFFFFFFFF 视为缺失） */
function exthU32(exth: Map<number, Uint8Array[]> | null, type: number): number | null {
	const data = exth?.get(type)?.[0];
	if (!data || data.length < 4) {
		return null;
	}
	const v = u32be(data, 0);
	return v === 0xffffffff ? null : v;
}

/** EXTH 首文本值（按书籍编码解码） */
function exthText(
	exth: Map<number, Uint8Array[]> | null,
	type: number,
	encoding: number,
): string | null {
	const data = exth?.get(type)?.[0];
	return data ? decodeBookBytes(data, encoding) : null;
}

/** DRM 拒收（镜像 EPUB encryption.xml 拒收；encryption 非 0 即 DRM） */
function assertNoDrm(header: MobiHeader): void {
	if (header.encryption !== 0) {
		throw new Error("该 MOBI 文件含加密内容（DRM），暂不支持");
	}
}

/** 容器解析产物：记录数组 + combo 后的头定位（rec 为 KF8 部件相对寻址） */
interface MobiContainer {
	records: Uint8Array[];
	header: MobiHeader;
	exth: Map<number, Uint8Array[]> | null;
	/** 头所在记录号（combo 文件 = boundary）；record(i) = records[base + i] */
	base: number;
	rec: (i: number) => Uint8Array;
}

/** 容器 + 头 + EXTH + DRM + combo（EXTH 121 boundary → KF8 头，优先 KF8） */
function parseContainer(bytes: Uint8Array): MobiContainer {
	const records = pdbRecordsOf(bytes);
	let base = 0;
	let header = readMobiHeader(records[0]);
	assertNoDrm(header);
	let exth = parseExth(records[0], header);
	const boundary = exthU32(exth, 121);
	if (header.version < 8 && boundary !== null && boundary > 0 && boundary < records.length) {
		try {
			// combo（kindlegen MOBI6+KF8 合一）：重定位 KF8 头（两段头任一命中
			// DRM 即拒；KF8 头无效则保持 MOBI6——KF8 部件相对寻址由 rec 统一加 base）
			const kf8Header = readMobiHeader(records[boundary]);
			assertNoDrm(kf8Header);
			header = kf8Header;
			base = boundary;
			exth = parseExth(records[boundary], kf8Header);
		} catch {
			// KF8 头损坏：回退 MOBI6 管线
		}
	}
	const baseRec = base;
	return {
		records,
		header,
		exth,
		base: baseRec,
		rec: (i: number): Uint8Array => records[baseRec + i] ?? new Uint8Array(0),
	};
}

// ── 文本层：尾部剥除 + 解压 ───────────────────────────────────────────────

/**
 * 文本记录尾部条目剥除：trailingFlags bit0 = multibyte 尾（末字节 & 3 + 1），
 * bit1 起每个置位位对应一个 varlen-from-end 尾部条目（EXTH/索引指针等）。
 */
function stripTrailingEntries(rec: Uint8Array, trailingFlags: number): Uint8Array {
	let arr = rec;
	const num = countBitsSet(trailingFlags >>> 1);
	for (let i = 0; i < num && arr.length > 0; i++) {
		const len = varlenFromEnd(arr);
		if (len <= 0 || len >= arr.length) {
			return new Uint8Array(0); // 畸形防御：宁空不赌
		}
		arr = arr.subarray(0, arr.length - len);
	}
	if (trailingFlags & 1 && arr.length > 0) {
		const len = (arr[arr.length - 1] & 0x3) + 1;
		if (len >= arr.length) {
			return new Uint8Array(0);
		}
		arr = arr.subarray(0, arr.length - len);
	}
	return arr;
}

/**
 * PalmDOC 解压（LZ77 变体；导出供测试直测）：
 * 0x00 透传；0x01–0x08 拷贝后随 1-8 字节；0x09–0x7F 字面量；
 * 0x80–0xBF 双字节距离-长度对（14 位距离 + 3 位长度+3）；
 * 0xC0–0xFF 空格 + (byte ^ 0x80)。
 */
export function palmDocDecompress(input: Uint8Array): Uint8Array {
	const out: number[] = [];
	for (let i = 0; i < input.length; i++) {
		const byte = input[i];
		if (byte === 0) {
			out.push(0);
		} else if (byte <= 8) {
			for (let j = 0; j < byte; j++) {
				out.push(input[i + 1 + j] ?? 0);
			}
			i += byte;
		} else if (byte <= 0x7f) {
			out.push(byte);
		} else if (byte <= 0xbf) {
			const pair = ((byte << 8) | input[i + 1]) & 0xffff;
			i += 1;
			const distance = (pair & 0x3fff) >>> 3;
			const length = (pair & 7) + 3;
			if (distance === 0 || distance > out.length) {
				break; // 畸形：距离越过已解压区，截断
			}
			for (let j = 0; j < length; j++) {
				out.push(out[out.length - distance]);
			}
		} else {
			out.push(32, byte ^ 0x80);
		}
	}
	return Uint8Array.from(out);
}

/** HUFF/CDIC 字典条目（decompressed = 0 时 bytes 本身仍是 HUFF 码流，递归展开） */
interface HuffDictEntry {
	bytes: Uint8Array;
	decompressed: boolean;
}

/**
 * HUFF/CDIC 解压器装配：HUFF 记录两表（表1 按首字节索引 / 表2 按码长索引）+
 * CDIC 字典记录。返回 null = 结构损坏（调用方按无法解压抛错）。
 */
function loadHuffcdic(
	rec: (i: number) => Uint8Array,
	header: MobiHeader,
): ((bytes: Uint8Array) => Uint8Array) | null {
	const huff = rec(header.huffcdic);
	if (header.numHuffcdic < 2 || latin1Of(huff.subarray(0, 4)) !== "HUFF") {
		return null;
	}
	const offset1 = u32be(huff, 8);
	const offset2 = u32be(huff, 12);
	// 表1（按码流首字节索引）：[found, codeLength, value]
	const table1: Array<[boolean, number, number]> = [];
	for (let i = 0; i < 256; i++) {
		const x = u32be(huff, offset1 + i * 4);
		table1.push([!!(x & 0x80), x & 0x1f, x >>> 8]);
	}
	// 表2（按码长索引）：[minCode, value]（下标 0 弃用；offset2 处首对即码长 1，
	// 对齐 foliate 的 table2[(i - 1) * 2]）
	const table2: Array<[number, number] | null> = [null];
	for (let i = 1; i <= 32; i++) {
		table2.push([u32be(huff, offset2 + (i - 1) * 8), u32be(huff, offset2 + (i - 1) * 8 + 4)]);
	}
	const dictionary: HuffDictEntry[] = [];
	for (let i = 1; i < header.numHuffcdic; i++) {
		const cdic = rec(header.huffcdic + i);
		if (latin1Of(cdic.subarray(0, 4)) !== "CDIC") {
			return null;
		}
		const cdicLength = u32be(cdic, 4);
		const numEntries = u32be(cdic, 8);
		const codeLength = u32be(cdic, 12);
		const n = Math.min(1 << codeLength, numEntries - dictionary.length);
		const buffer = cdic.subarray(Math.min(cdicLength, cdic.length));
		for (let j = 0; j < n; j++) {
			const off = u16be(buffer, j * 2);
			const x = u16be(buffer, off);
			const length = x & 0x7fff;
			dictionary.push({
				bytes: buffer.subarray(off + 2, off + 2 + length),
				decompressed: !!(x & 0x8000),
			});
		}
	}
	// 32 位窗口读取（不依赖 BigInt：5 字节窗口右移 8-s，使起始于位 p 的码对齐
	// 到 32 位顶——p 的字节内偏移 s 落在顶字节的高 s 位之后）
	const readBits32 = (b: Uint8Array, bitPos: number): number => {
		let v = 0;
		for (let i = 0; i < 5; i++) {
			v = v * 256 + u8at(b, (bitPos >> 3) + i);
		}
		return (Math.floor(v / 2 ** (8 - (bitPos & 7))) & 0xffffffff) >>> 0;
	};
	const expand = (entry: HuffDictEntry): Uint8Array => {
		if (!entry.decompressed) {
			entry.bytes = decompress(entry.bytes); // 递归展开 + 就地缓存
			entry.decompressed = true;
		}
		return entry.bytes;
	};
	const decompress = (input: Uint8Array): Uint8Array => {
		const parts: Uint8Array[] = [];
		const bitLength = input.length * 8;
		for (let i = 0; i < bitLength;) {
			const bits = readBits32(input, i);
			const [found, len0, val0] = table1[bits >>> 24];
			let codeLength = len0;
			let value = val0;
			if (!found) {
				while (
					codeLength < 32 &&
					table2[codeLength] !== null &&
					bits >>> (32 - codeLength) < table2[codeLength]![0]
				) {
					codeLength += 1;
				}
				if (codeLength > 32 || table2[codeLength] === null) {
					return concatBytes(parts); // 畸形防御：截断已解压部分
				}
				value = table2[codeLength]![1];
			}
			if (codeLength < 1) {
				return concatBytes(parts);
			}
			i += codeLength;
			if (i > bitLength) {
				break;
			}
			const code = value - (bits >>> (32 - codeLength));
			const entry = dictionary[code];
			if (!entry) {
				break; // 字典越界：截断
			}
			parts.push(expand(entry));
		}
		return concatBytes(parts);
	};
	return decompress;
}

/** 文本记录 1..N：剥尾 → 解压 → 拼接为全文字节流 */
function loadTextBytes(rec: (i: number) => Uint8Array, header: MobiHeader): Uint8Array {
	const decompress =
		header.compression === 1
			? (b: Uint8Array): Uint8Array => b
			: header.compression === 2
				? palmDocDecompress
				: header.compression === 17480
					? loadHuffcdic(rec, header)
					: null;
	if (!decompress) {
		throw new Error(`MOBI 结构损坏：未知压缩类型 ${header.compression}`);
	}
	const parts: Uint8Array[] = [];
	for (let i = 0; i < header.textRecordCount; i++) {
		parts.push(decompress(stripTrailingEntries(rec(1 + i), header.trailingFlags)));
	}
	const full = concatBytes(parts);
	if (full.length === 0) {
		throw new Error("MOBI 结构损坏：无正文内容");
	}
	return full;
}

// ── INDX/TAGX/CNCX（KF8 的 skel/frag/NCX 三处共用）─────────────────────────

/** INDX 条目：name（长度前缀字符串）+ tag → varlen 值列表 */
interface IndxEntry {
	name: string;
	tags: Map<number, number[]>;
}

interface IndxData {
	entries: IndxEntry[];
	/** CNCX 字符串池：键 = 池内字节偏移（跨 CNCX 记录按 0x10000 递增） */
	cncx: Map<number, string>;
}

/**
 * 通用 INDX 解析（skel/frag/NCX 三处复用）。头记录 = INDX 头 + TAGX 标签表；
 * 其后 numEntryRecords 个条目记录（自带 INDX 头 + IDXT 偏移表）；再其后
 * numCncx 个 CNCX 字符串池记录（varlen 长度前缀 + 编码字节，无记录头）。
 * 结构异常返回 null（调用方降级，不抛）。
 */
function parseIndx(rec: (i: number) => Uint8Array, idx: number): IndxData | null {
	if (idx <= 0) {
		return null;
	}
	const head = rec(idx);
	if (head.length < 0x40 || latin1Of(head.subarray(0, 4)) !== "INDX") {
		return null;
	}
	const hdrLength = u32be(head, 4);
	const encoding = u32be(head, 28);
	const numEntryRecords = u32be(head, 24);
	const numCncx = u32be(head, 52);
	// TAGX 标签表（紧随 INDX 头）：tag u8 + valuesPerEntry u8 + mask u8 + end u8
	const tagx = head.subarray(Math.min(hdrLength, head.length));
	if (tagx.length < 12 || latin1Of(tagx.subarray(0, 4)) !== "TAGX") {
		return null;
	}
	const tagxLength = u32be(tagx, 4);
	const numControlBytes = u32be(tagx, 8);
	const tagTable: Array<[number, number, number, number]> = [];
	const numTags = Math.floor((tagxLength - 12) / 4);
	for (let i = 0; i < numTags; i++) {
		const o = 12 + i * 4;
		tagTable.push([tagx[o], tagx[o + 1], tagx[o + 2], tagx[o + 3]]);
	}
	// CNCX 字符串池
	const cncx = new Map<number, string>();
	let cncxOffset = 0;
	for (let i = 0; i < numCncx; i++) {
		const r = rec(idx + numEntryRecords + i + 1);
		let pos = 0;
		while (pos < r.length) {
			const index = pos;
			const { value, length } = varlenAt(r, pos);
			pos += length;
			if (value === 0 || pos + value > r.length) {
				break; // 畸形防御
			}
			cncx.set(cncxOffset + index, decodeBookBytes(r.subarray(pos, pos + value), encoding));
			pos += value;
		}
		cncxOffset += 0x10000;
	}
	const entries: IndxEntry[] = [];
	for (let i = 0; i < numEntryRecords; i++) {
		const r = rec(idx + 1 + i);
		if (r.length < 0x20 || latin1Of(r.subarray(0, 4)) !== "INDX") {
			continue;
		}
		const innerIdxt = u32be(r, 20);
		const innerCount = u32be(r, 24);
		for (let j = 0; j < innerCount; j++) {
			const offset = u16be(r, innerIdxt + 4 + j * 2);
			if (offset <= 0 || offset >= r.length) {
				continue;
			}
			const nameLen = r[offset];
			const name = latin1Of(r.subarray(offset + 1, offset + 1 + nameLen));
			entries.push({
				name,
				tags: parseEntryTags(r, offset + 1 + nameLen, numControlBytes, tagTable),
			});
		}
	}
	return entries.length ? { entries, cncx } : null;
}

/**
 * 单条目 tag 值解析：startPos 起 numControlBytes 个控制字节（tag 的 mask 在其
 * 内取值），值区紧随（varlen 序列）。控制位全 1 且 mask 多位 → varlen 字节
 * 长度后跟该长度的 varlen 值；单 bit → 1 组 numValues 个值；否则控制位右移
 * 末零位数 = 值组数。
 */
function parseEntryTags(
	r: Uint8Array,
	startPos: number,
	numControlBytes: number,
	tagTable: Array<[number, number, number, number]>,
): Map<number, number[]> {
	const tags = new Map<number, number[]>();
	// [tag, mode(0=count|1=bytes), n, numValues]
	const pending: Array<[number, number, number, number]> = [];
	let pos = startPos + numControlBytes; // 值区起点（控制字节之后）
	let controlByteIndex = 0;
	for (const [tag, numValues, mask, end] of tagTable) {
		if (end & 1) {
			controlByteIndex++;
			continue;
		}
		const masked = u8at(r, startPos + controlByteIndex) & mask;
		if (masked === mask && countBitsSet(mask) > 1) {
			const { value, length } = varlenAt(r, pos);
			pending.push([tag, 1, value, numValues]);
			pos += length;
		} else if (masked === mask) {
			pending.push([tag, 0, 1, numValues]);
		} else {
			pending.push([tag, 0, masked >>> countUnsetEnd(mask), numValues]);
		}
	}
	for (const [tag, mode, n, numValues] of pending) {
		const values: number[] = [];
		if (mode === 0) {
			for (let i = 0; i < n * numValues; i++) {
				const { value, length } = varlenAt(r, pos);
				values.push(value);
				pos += length;
				if (length === 0) {
					break;
				}
			}
		} else {
			let used = 0;
			while (used < n) {
				const { value, length } = varlenAt(r, pos);
				values.push(value);
				pos += length;
				used += length;
				if (length === 0) {
					break;
				}
			}
		}
		tags.set(tag, values);
	}
	return tags;
}

/** FDST 流表（KF8）：全文流字节区间 [start, end) 序表（flow 0 = 主 HTML） */
function parseFdst(record: Uint8Array): Array<[number, number]> | null {
	if (record.length < 12 || latin1Of(record.subarray(0, 4)) !== "FDST") {
		return null;
	}
	const count = u32be(record, 8);
	const out: Array<[number, number]> = [];
	for (let i = 0; i < count; i++) {
		const o = 12 + i * 8;
		if (o + 8 > record.length) {
			return null;
		}
		out.push([u32be(record, o), u32be(record, o + 4)]);
	}
	return out.length ? out : null;
}

// ── 构建产物（MOBI6/KF8 共用出口形状）────────────────────────────────────

/** 章节 href：c/0001.xhtml（pad 4，超万章自然增长） */
function chapterHref(i: number): string {
	return `c/${String(i + 1).padStart(4, "0")}.xhtml`;
}

/** filepos 锚点 id：10 位零填充保证字符串序 = 数值序（foliate 同款，无冒号） */
function fileposId(n: number): string {
	return `filepos${String(n).padStart(10, "0")}`;
}

/** 图片字节魔数嗅探 → 扩展名（embed 无 mime 参数 / recindex 场景） */
function sniffImageExt(b: Uint8Array): string {
	if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) {
		return "jpg";
	}
	if (b.length >= 4 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) {
		return "png";
	}
	if (b.length >= 4 && b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x38) {
		return "gif";
	}
	if (b.length >= 2 && b[0] === 0x42 && b[1] === 0x4d) {
		return "bmp";
	}
	if (
		b.length >= 12 &&
		latin1Of(b.subarray(0, 4)) === "RIFF" &&
		latin1Of(b.subarray(8, 12)) === "WEBP"
	) {
		return "webp";
	}
	const head = latin1Of(b.subarray(0, 64)).trimStart().toLowerCase();
	if (head.startsWith("<svg") || head.startsWith("<?xml")) {
		return "svg";
	}
	return "bin";
}

const MIME_EXT: Record<string, string> = {
	"image/jpeg": "jpg",
	"image/png": "png",
	"image/gif": "gif",
	"image/bmp": "bmp",
	"image/webp": "webp",
	"image/svg+xml": "svg",
};

/** 构建中间产物：章文本 + 目录 + 图片/封面资源访问 */
interface BookParts {
	chapters: string[];
	toc: EpubTocNode[];
	/** 1 基资源号 → 图片 href（含扩展名；mime 参数优先，魔数嗅探兜底） */
	imageHref: (id: number, mime?: string) => string;
	/** 1 基资源号 → 记录字节（readEntry 图片出口） */
	imageRecord: (id: number) => Uint8Array | null;
	/** 封面（0 基资源号；调用方组装 href） */
	coverResource: number | null;
}

/**
 * MOBI6 构建：pagebreak 切章 + filepos 字节级锚点插入 + guide 目录 +
 * filepos/recindex 链接图片重写。TOC 取扁平（MOBI6 目录层级靠排版缩进表达，
 * 无结构信息，嵌套放弃）。
 */
function buildMobi6Book(
	header: MobiHeader,
	textBytes: Uint8Array,
	resourceAt: (zeroBased: number) => Uint8Array | null,
): BookParts {
	const latin = latin1Of(textBytes);
	const pagebreakRe = /<\s*(?:mbp:)?pagebreak[^>]*>/gi;
	// 1) pagebreak 切分（字节区间）
	const breaks: number[] = [0];
	for (const m of latin.matchAll(pagebreakRe)) {
		breaks.push(m.index);
	}
	const sections = breaks.map((start, i) => ({
		start,
		end: i + 1 < breaks.length ? breaks[i + 1] : textBytes.length,
	}));
	const sectionOf = (n: number): number => sections.findIndex((s) => s.end > n);
	// 2) filepos 目标收集（所有带 filepos 属性的标签；guide toc 另加）
	const fileposRe = /<[^<>]+filepos=['"]?(\d+)[^<>]*>/gi;
	const targets = new Set<number>();
	for (const m of latin.matchAll(fileposRe)) {
		targets.add(Number(m[1]));
	}
	const tocFilepos = guideTocFileposOf(latin);
	if (tocFilepos !== null) {
		targets.add(tocFilepos);
	}
	const sorted = [...targets].filter((n) => n >= 0 && n < textBytes.length).sort((a, b) => a - b);
	// 3) 图片 href（recindex → 资源记录魔数嗅探）
	const imageHrefs = new Map<number, string>();
	const imageHref = (id: number): string => {
		const hit = imageHrefs.get(id);
		if (hit) {
			return hit;
		}
		const record = resourceAt(id - 1);
		const ext = record && record.length > 0 ? sniffImageExt(record) : "bin";
		const href = `img/${String(id).padStart(4, "0")}.${ext}`;
		imageHrefs.set(id, href);
		return href;
	};
	// 4) 逐章：字节级锚点插入 → 解码 → 清 pagebreak → 链接/图片重写
	const resolveFilepos = (n: number): string => {
		const idx = sectionOf(n);
		if (idx < 0) {
			return "#";
		}
		return idx === currentChapter ? `#${fileposId(n)}` : `${chapterHref(idx)}#${fileposId(n)}`;
	};
	let currentChapter = 0;
	const chapters: string[] = [];
	sections.forEach((s, i) => {
		currentChapter = i;
		const mine = sorted.filter((n) => n >= s.start && n < s.end);
		const arr = insertFileposAnchors(
			textBytes.subarray(s.start, s.end),
			mine.map((n) => ({ n, off: n - s.start })),
		);
		let html = decodeBookBytes(arr, header.encoding).replace(pagebreakRe, "");
		html = html
			.replace(
				/(<a\b[^>]*?)\sfilepos=(["']?)(\d+)\2/gi,
				(_m, pre: string, _q: string, num: string) =>
					`${pre} href="${resolveFilepos(Number(num))}"`,
			)
			.replace(
				/(<img\b[^>]*?)\srecindex=(["']?)(\d+)\2/gi,
				(_m, pre: string, _q: string, num: string) =>
					`${pre} src="${imageHref(Number(num))}"`,
			);
		chapters.push(html);
	});
	// 5) TOC：guide 所指节内扫 a[filepos]（标签内文取字节区间按书籍编码解码——
	// latin1 视图仅做定位，直接取串会把非 ASCII 标签变乱码）
	const toc: EpubTocNode[] = [];
	if (tocFilepos !== null) {
		const sec = sections[sectionOf(tocFilepos)];
		if (sec) {
			const secBytes = textBytes.subarray(sec.start, sec.end);
			const secStr = latin.slice(sec.start, sec.end);
			for (const m of secStr.matchAll(
				/<a\b[^>]*?filepos=['"]?(\d+)[^>]*>([\s\S]*?)<\/a>/gi,
			)) {
				const target = Number(m[1]);
				const idx = sectionOf(target);
				const openEnd = m.index + m[0].indexOf(">") + 1;
				const label = decodeBookBytes(
					secBytes.subarray(openEnd, openEnd + m[2].length),
					header.encoding,
				)
					.replace(/<[^>]+>/g, "")
					.replace(/\s+/g, " ")
					.trim();
				if (label && idx >= 0) {
					toc.push({
						title: unescapeMinimal(label),
						href: "",
						spineIndex: idx,
						fragment: fileposId(target),
						children: [],
					});
				}
			}
		}
	}
	return {
		chapters,
		toc,
		imageHref: (id) => imageHref(id),
		imageRecord: (id) => resourceAt(id - 1),
		coverResource: null, // 由 parseMobi 统一从 EXTH 取
	};
}

/** guide reference[type=toc] 的 filepos（无则 null） */
function guideTocFileposOf(latin: string): number | null {
	for (const m of latin.matchAll(/<reference\b[^>]*>/gi)) {
		const tag = m[0];
		const type = /\btype\s*=\s*["']([^"']*)["']/i.exec(tag)?.[1] ?? "";
		const filepos = /\bfilepos\s*=\s*["']?(\d+)/i.exec(tag)?.[1];
		if (type.split(/\s+/).includes("toc") && filepos) {
			return Number(filepos);
		}
	}
	return null;
}

/** 字节级 filepos 锚点插入（目标按偏移升序，splice 保后续偏移有效） */
function insertFileposAnchors(
	raw: Uint8Array,
	anchors: Array<{ n: number; off: number }>,
): Uint8Array {
	if (anchors.length === 0) {
		return raw;
	}
	const parts: Uint8Array[] = [];
	let pos = 0;
	for (const a of anchors) {
		parts.push(raw.subarray(pos, a.off), strToU8(`<a id="${fileposId(a.n)}"></a>`));
		pos = a.off;
	}
	parts.push(raw.subarray(pos));
	return concatBytes(parts);
}

/**
 * KF8（AZW3）构建：FDST 流表（flow 0 = 主 HTML）+ skel/frag（INDX）字节重组
 * 分章 + NCX（INDX）目录 + kindle:embed/flow 重写 + html 流追加尾章。
 * skel/frag 解析失败返回 null（调用方降级 MOBI6 管线——KF8 无 pagebreak 则
 * 整书单章，仍可打开可摘录）。
 */
function buildKf8Book(
	rec: (i: number) => Uint8Array,
	header: MobiHeader,
	textBytes: Uint8Array,
	resourceAt: (zeroBased: number) => Uint8Array | null,
): BookParts | null {
	const skelData = parseIndx(rec, header.skel);
	const fragData = parseIndx(rec, header.frag);
	if (!skelData || !fragData) {
		return null;
	}
	const skels = skelData.entries.map((e) => ({
		numFrag: e.tags.get(1)?.[0] ?? 0,
		offset: e.tags.get(6)?.[0] ?? 0,
		length: e.tags.get(6)?.[1] ?? 0,
	}));
	const frags = fragData.entries.map((e) => ({
		fid: e.tags.get(4)?.[0] ?? 0,
		insertOffset: parseInt(e.name, 10) || 0,
		offset: e.tags.get(6)?.[0] ?? 0,
		length: e.tags.get(6)?.[1] ?? 0,
	}));
	// 章节重组：skeleton 段在各 frag 的 insertOffset（最终章内坐标）处插入。
	// 升序插入时当前数组索引恒等于最终坐标（先插的 frag 位于坐标下方，天然让
	// 位），无需任何回扣。frag 原始字节存于 skeleton 段之后（offset 相对段尾）。
	// fragRangeInChapter 记录各 frag 内容在成品章内的字节区间（NCX fragment 定
	// 位用，窗口不得越出 frag——对齐 foliate 的 fragRaw.slice(off) 语义）。
	const chapterBytes: Uint8Array[] = [];
	const fidToChapter = new Map<number, number>();
	const fragRangeInChapter = new Map<number, [number, number]>();
	let fragCursor = 0;
	for (const s of skels) {
		if (s.offset >= textBytes.length) {
			continue;
		}
		const sectionFrags = frags.slice(fragCursor, fragCursor + s.numFrag);
		fragCursor += s.numFrag;
		const sectionLen = s.length + sectionFrags.reduce((n, f) => n + f.length, 0);
		const raw = textBytes.subarray(s.offset, Math.min(s.offset + sectionLen, textBytes.length));
		let skeleton = raw.subarray(0, Math.min(s.length, raw.length));
		for (const f of sectionFrags) {
			const insertAt = Math.max(0, Math.min(f.insertOffset, skeleton.length));
			const fragStart = s.length + f.offset;
			const fragRaw = raw.subarray(
				Math.min(fragStart, raw.length),
				Math.min(fragStart + f.length, raw.length),
			);
			skeleton = concatBytes([
				skeleton.subarray(0, insertAt),
				fragRaw,
				skeleton.subarray(insertAt),
			]);
			fidToChapter.set(f.fid, chapterBytes.length);
			fragRangeInChapter.set(f.fid, [insertAt, fragRaw.length]);
		}
		chapterBytes.push(skeleton);
	}
	if (chapterBytes.length === 0) {
		return null;
	}
	// NCX 目录：label = cncx[tag3]；pos = [fid, off]（fid → 章号；off 处开标签的
	// id/name/aid 即章内锚点——id 直用，name/aid 登记字节级改写为 id（净化层只保
	// id；属性名均 ASCII，等长空格填充保后续偏移不漂移），取不到降级 null 停章
	// 顶）。父子（tag21）组树，无父链保底扁平。定位全部在 decode 前的字节层。
	const toc: EpubTocNode[] = [];
	const attrRewrites: Array<{ chapter: number; pos: number; attrLen: number }> = [];
	const ncxData = parseIndx(rec, header.indx);
	if (ncxData) {
		const items = ncxData.entries.map((e, index) => ({
			index,
			label: ncxData.cncx.get(e.tags.get(3)?.[0] ?? -1) ?? "",
			fid: e.tags.get(6)?.[0] ?? -1,
			off: e.tags.get(6)?.[1] ?? 0,
			parent: e.tags.get(21)?.[0],
		}));
		const nodes = new Map<number, EpubTocNode>();
		for (const it of items) {
			const chapter = fidToChapter.get(it.fid) ?? -1;
			let fragment: string | null = null;
			if (chapter >= 0) {
				const chapterB = chapterBytes[chapter];
				const range = fragRangeInChapter.get(it.fid)!;
				const fragEnd = Math.min(range[0] + range[1], chapterB.length);
				const anchorPos = Math.min(range[0] + it.off, fragEnd);
				const window = chapterB.subarray(anchorPos, Math.min(anchorPos + 300, fragEnd));
				// latin1 视图做字节级定位（属性名字节对齐），值再按书籍编码解码
				// （UTF-8 多字节 id 不失真）；带引号值（对齐 foliate 的选择器语义）
				const m = /\s(id|name|aid)\s*=\s*(?:"([^"]*)"|'([^']*)')/i.exec(latin1Of(window));
				if (m) {
					const raw = m[2] ?? m[3] ?? "";
					const valueStart = m.index + m[0].length - 1 - raw.length;
					fragment =
						decodeBookBytes(
							window.subarray(valueStart, valueStart + raw.length),
							header.encoding,
						) || null;
					if (m[1].toLowerCase() !== "id" && fragment) {
						attrRewrites.push({
							chapter,
							pos: anchorPos + m.index + m[0].indexOf(m[1]),
							attrLen: m[1].length,
						});
					}
				}
			}
			nodes.set(it.index, {
				title: it.label.trim() || "(无标题)",
				href: "",
				spineIndex: chapter,
				fragment,
				children: [],
			});
		}
		for (const it of items) {
			const node = nodes.get(it.index)!;
			const parent = it.parent !== undefined ? nodes.get(it.parent) : undefined;
			if (parent && it.parent !== it.index) {
				parent.children.push(node);
			} else {
				toc.push(node);
			}
		}
	}
	// name/aid → id 字节改写（自后向前应用保未处理偏移有效），完成后统一解码
	for (const rw of attrRewrites.sort((a, b) => b.pos - a.pos)) {
		const b = chapterBytes[rw.chapter];
		chapterBytes[rw.chapter] = concatBytes([
			b.subarray(0, rw.pos),
			strToU8(`id${" ".repeat(rw.attrLen - 2)}`),
			b.subarray(rw.pos + rw.attrLen),
		]);
	}
	const chapters = chapterBytes.map((b) =>
		decodeBookBytes(b, header.encoding).replace(/^\s*<\?xml[^>]*\?>/, ""),
	);
	// flow 章追加：被 kindle:flow:NNNN?mime=text/html 引用的流（脚注等）按序
	// 追加为尾部章（页=章语义与摘录回链一致性优先，「第 N 章」编号含脚注流）
	const flowTable = parseFdst(rec(header.fdst));
	const flowRefs = new Map<number, string>();
	for (const s of chapters) {
		for (const m of s.matchAll(/kindle:flow:([0-9a-zA-Z]+)(?:\?mime=([\w/+.-]+))?/gi)) {
			const id = parseInt(m[1], 32);
			if (!flowRefs.has(id)) {
				flowRefs.set(id, m[2] ?? "");
			}
		}
	}
	const flowChapterStart = chapters.length;
	const flowHrefById = new Map<number, string>();
	if (flowTable) {
		let appended = 0;
		for (const [id, mime] of [...flowRefs].sort((a, b) => a[0] - b[0])) {
			if (mime && !/^(text\/html|application\/xhtml\+xml)$/i.test(mime)) {
				continue;
			}
			const range = flowTable[id];
			if (!range) {
				continue;
			}
			const flowBytes = textBytes.subarray(
				Math.min(range[0], textBytes.length),
				Math.min(range[1], textBytes.length),
			);
			if (!latin1Of(flowBytes.subarray(0, 64)).trimStart().startsWith("<")) {
				continue; // 非 HTML 形态（CSS/SVG 包装等）跳过
			}
			chapters.push(
				decodeBookBytes(flowBytes, header.encoding).replace(/^\s*<\?xml[^>]*\?>/, ""),
			);
			flowHrefById.set(id, `${chapterHref(flowChapterStart + appended)}#`);
			appended++;
		}
	}
	// kindle:embed 图片重写（32 进制 id；mime 参数顺手喂扩展名）
	const imageHrefs = new Map<number, string>();
	const imageHref = (id: number, mime?: string): string => {
		const hit = imageHrefs.get(id);
		if (hit) {
			return hit;
		}
		let ext = mime ? MIME_EXT[mime.toLowerCase()] : undefined;
		if (!ext) {
			const record = resourceAt(id - 1);
			ext = record && record.length > 0 ? sniffImageExt(record) : "bin";
		}
		const href = `img/${String(id).padStart(4, "0")}.${ext}`;
		imageHrefs.set(id, href);
		return href;
	};
	for (let i = 0; i < chapters.length; i++) {
		chapters[i] = chapters[i].replace(
			/(src|href|xlink:href)\s*=\s*["']kindle:embed:([0-9a-zA-Z]+)(?:\?mime=([\w/+.-]+))?["']/gi,
			(_m, attr: string, id32: string, mime?: string) =>
				`${attr}="${imageHref(parseInt(id32, 32), mime)}"`,
		);
		// kindle:flow 链接 → 尾部章（fragment 原样保留，锚点 id 由净化层保留）
		chapters[i] = chapters[i].replace(
			/(href|xlink:href)\s*=\s*["']kindle:flow:([0-9a-zA-Z]+)(?:\?mime=[\w/+.-]+)?(?:#([^"']*))?["']/gi,
			(_m, attr: string, id32: string, frag?: string) => {
				const target = flowHrefById.get(parseInt(id32, 32));
				return target ? `${attr}="${target}${frag ?? ""}"` : _m;
			},
		);
	}
	return {
		chapters,
		toc,
		imageHref,
		imageRecord: (id) => resourceAt(id - 1),
		coverResource: null,
	};
}

// ── 出口：readEntry 惰性编码 + 主入口 ─────────────────────────────────────

/** readEntry 章节缓存上限（对齐 epub-document.ts makeEntryReader 的 64MB） */
const MAX_DECODED_BYTES = 64 * 1024 * 1024;

/**
 * 虚拟条目读取器：c/NNNN.xhtml → 章文本惰性转 UTF-8 字节（插入序 LRU，镜像
 * makeEntryReader；doc-search 逐章重复读取受益）；img/NNNN.* → 原始图片记录
 * 字节（subarray 视图零拷贝——下游 blobUrlFor/封面编码均自行 slice 拷贝）。
 */
function makeVirtualEntryReader(
	chapters: string[],
	imageRecord: (id: number) => Uint8Array | null,
): (path: string) => Uint8Array | null {
	const cache = new Map<string, Uint8Array>();
	let total = 0;
	return (path) => {
		const chapter = /^c\/(\d+)\.xhtml$/.exec(path);
		if (chapter) {
			const hit = cache.get(path);
			if (hit) {
				cache.delete(path);
				cache.set(path, hit); // LRU 触碰（重排插入序）
				return hit;
			}
			const text = chapters[Number(chapter[1]) - 1];
			if (text === undefined) {
				return null;
			}
			const bytes = strToU8(text);
			cache.set(path, bytes);
			total += bytes.length;
			while (total > MAX_DECODED_BYTES) {
				const oldest = cache.keys().next().value;
				if (oldest === undefined) {
					break;
				}
				const evicted = cache.get(oldest);
				cache.delete(oldest);
				total -= evicted?.byteLength ?? 0;
			}
			return bytes;
		}
		const img = /^img\/(\d+)\./.exec(path);
		if (img) {
			return imageRecord(Number(img[1]));
		}
		return null;
	};
}

/**
 * 解析 MOBI 家族字节为「虚拟 EPUB」。失败抛中文 Error（reader 统一 showTip）；
 * DRM 一律拒收；combo 文件优先 KF8；KF8 的 skel/frag 损坏降级 MOBI6 管线。
 */
export function parseMobi(bytes: Uint8Array): EpubBook {
	const { rec, header, exth } = parseContainer(bytes);
	const resourceAt = (zeroBased: number): Uint8Array | null => {
		if (zeroBased < 0) {
			return null;
		}
		const record = rec(header.resourceStart + zeroBased);
		return record.length > 0 ? record : null;
	};
	const textBytes = loadTextBytes(rec, header);
	const parts = header.version >= 8 ? buildKf8Book(rec, header, textBytes, resourceAt) : null;
	const book = parts ?? buildMobi6Book(header, textBytes, resourceAt);
	// 标题：EXTH 503 优先，MOBI 头 title 兜底（消费方 basename 再兜底）
	const rawTitle =
		exthText(exth, 503, header.encoding) ??
		(header.titleBytes ? decodeBookBytes(header.titleBytes, header.encoding) : "");
	const title = unescapeMinimal(rawTitle.trim());
	// 封面：EXTH 201 coverOffset 优先 202 thumbnail 兜底（0 基资源号）
	const coverOffset = exthU32(exth, 201) ?? exthU32(exth, 202);
	const coverRecord = coverOffset !== null ? resourceAt(coverOffset) : null;
	const coverHref = (() => {
		if (coverOffset === null || !coverRecord) {
			return null;
		}
		const ext = sniffImageExt(coverRecord);
		return `img/${String(coverOffset + 1).padStart(4, "0")}.${ext}`;
	})();
	const spine: EpubSpineItem[] = book.chapters.map((_, i) => ({
		href: chapterHref(i),
		idref: `c${i + 1}`,
	}));
	return {
		title: title || null,
		coverHref,
		spine,
		toc: book.toc,
		readEntry: makeVirtualEntryReader(book.chapters, book.imageRecord),
	};
}

/**
 * 封面专用提取（㊽ 主页书架批量出封面）：只解 PDB + 头 + EXTH + 封面记录，
 * 不解压正文。任何失败归 null（封面是增强不是依赖，契约永不抛——镜像
 * epubCoverBytes）。
 */
export function mobiCoverBytes(bytes: Uint8Array): { href: string; bytes: Uint8Array } | null {
	try {
		const { rec, header, exth } = parseContainer(bytes);
		const offset = exthU32(exth, 201) ?? exthU32(exth, 202);
		if (offset === null) {
			return null;
		}
		const record = rec(header.resourceStart + offset);
		if (record.length === 0) {
			return null;
		}
		return {
			href: `img/${String(offset + 1).padStart(4, "0")}.${sniffImageExt(record)}`,
			bytes: record,
		};
	} catch {
		return null;
	}
}
