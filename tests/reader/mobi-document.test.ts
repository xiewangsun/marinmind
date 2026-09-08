import { describe, expect, it } from "vitest";
import { strFromU8, strToU8 } from "fflate";
import { mobiCoverBytes, palmDocDecompress, parseMobi } from "../../src/reader/mobi-document";
import type { EpubBook } from "../../src/reader/epub-document";

// ── 字节写入辅助（fixture 专用；PDB/MOBI/INDX 头全大端）────────────────────

class BW {
	private buf: number[] = [];
	u8(v: number): this {
		this.buf.push(v & 0xff);
		return this;
	}
	be16(v: number): this {
		return this.u8(v >>> 8).u8(v);
	}
	be32(v: number): this {
		return this.u8((v >>> 24) & 0xff)
			.u8((v >>> 16) & 0xff)
			.u8((v >>> 8) & 0xff)
			.u8(v);
	}
	str(s: string): this {
		for (let i = 0; i < s.length; i++) {
			this.u8(s.charCodeAt(i));
		}
		return this;
	}
	zeros(n: number): this {
		for (let i = 0; i < n; i++) {
			this.buf.push(0);
		}
		return this;
	}
	raw(b: Uint8Array): this {
		for (const x of b) {
			this.buf.push(x);
		}
		return this;
	}
	len(): number {
		return this.buf.length;
	}
	build(): Uint8Array {
		return Uint8Array.from(this.buf);
	}
}

function concatU8(parts: Uint8Array[]): Uint8Array {
	const total = parts.reduce((n, p) => n + p.length, 0);
	const out = new Uint8Array(total);
	let pos = 0;
	for (const p of parts) {
		out.set(p, pos);
		pos += p.length;
	}
	return out;
}

/** 前向 varlen 编码（INDX 值区 / CNCX 长度前缀）：单字节带高位终结，多字节高组在前、末组带高位 */
function varlenBytes(v: number): number[] {
	if (v < 0x80) {
		return [0x80 | v];
	}
	const groups: number[] = [];
	let x = v;
	while (x > 0) {
		groups.unshift(x & 0x7f);
		x >>>= 7;
	}
	return groups.map((g, i) => (i === groups.length - 1 ? 0x80 | g : g));
}

/** fixture 专用 CP1252 编码（覆盖用到的少量高位字符，其余按 latin1；CJK 不可编码，测试串仅用西文） */
const CP1252_ENC: Record<string, number> = {
	"€": 0x80,
	"’": 0x92,
	"“": 0x93,
	"”": 0x94,
	"—": 0x97,
};
function cp1252Encode(s: string): Uint8Array {
	return Uint8Array.from([...s].map((ch) => CP1252_ENC[ch] ?? ch.charCodeAt(0) & 0xff));
}

const u32b = (v: number): Uint8Array =>
	new Uint8Array([(v >>> 24) & 0xff, (v >>> 16) & 0xff, (v >>> 8) & 0xff, v & 0xff]);

/** 字节级子串查找（TypedArray.indexOf 只接受数值；latin1 视图保字节序） */
function u8IndexOf(hay: Uint8Array, needle: Uint8Array): number {
	const h = Buffer.from(hay).toString("latin1");
	const n = Buffer.from(needle).toString("latin1");
	return h.indexOf(n);
}

// ── 工厂：PDB 容器 / record 0 / INDX / FDST ────────────────────────────────

/** PDB 容器：78B 头（type@60）+ N×8 偏移表 + 记录序列 */
function makePdb(records: Uint8Array[]): Uint8Array {
	const w = new BW();
	w.zeros(60).str("BOOKMOBI").be32(0).be32(0).be16(records.length);
	let pos = 78 + records.length * 8;
	for (const r of records) {
		w.be32(pos).be32(0);
		pos += r.length;
	}
	for (const r of records) {
		w.raw(r);
	}
	return w.build();
}

interface Record0Spec {
	compression?: number; // 默认 1（无压缩；17480 = HUFF/CDIC 用例显式传）
	textRecordCount: number;
	textLength: number;
	encryption?: number;
	encoding?: number; // 默认 65001
	version: number;
	exth?: Array<{ type: number; data: Uint8Array }>;
	title?: string;
	resourceStart?: number;
	huffcdic?: number;
	numHuffcdic?: number;
	fdst?: number;
	numFdst?: number;
	indx?: number;
	frag?: number;
	skel?: number;
	trailingFlags?: number;
}

/** record 0：PalmDOC 头(16B) + MOBI 头(v6=232 / v8=264) + EXTH(4 对齐) + title */
function makeRecord0(spec: Record0Spec): Uint8Array {
	const isV8 = spec.version >= 8;
	const mobiLength = isV8 ? 264 : 232;
	const exthList = spec.exth ?? [];
	let exthBytes = new Uint8Array(0);
	if (exthList.length) {
		const body = new BW();
		for (const r of exthList) {
			body.be32(r.type)
				.be32(8 + r.data.length)
				.raw(r.data);
		}
		let total = 12 + body.len();
		const pad = (4 - (total % 4)) % 4;
		total += pad;
		exthBytes = new BW()
			.str("EXTH")
			.be32(total)
			.be32(exthList.length)
			.raw(body.build())
			.zeros(pad)
			.build();
	}
	const titleBytes = spec.title !== undefined ? strToU8(spec.title) : new Uint8Array(0);
	const headerLen = 16 + mobiLength;
	const titleOffset = headerLen + exthBytes.length;
	const out = new Uint8Array(titleOffset + titleBytes.length);
	const dv = new DataView(out.buffer);
	const put = (o: number, s: string) => {
		for (let i = 0; i < s.length; i++) {
			out[o + i] = s.charCodeAt(i) & 0xff;
		}
	};
	put(16, "MOBI");
	dv.setUint16(0, spec.compression ?? 1);
	dv.setUint16(2, 0);
	dv.setUint32(4, spec.textLength);
	dv.setUint16(8, spec.textRecordCount);
	dv.setUint16(10, 4096); // recordSize
	dv.setUint16(12, spec.encryption ?? 0);
	dv.setUint16(14, 0);
	dv.setUint32(20, mobiLength);
	dv.setUint32(24, 2); // type = mobi book
	dv.setUint32(28, spec.encoding ?? 65001);
	dv.setUint32(32, 17); // uid
	dv.setUint32(36, spec.version);
	dv.setUint32(84, titleBytes.length ? titleOffset : 0);
	dv.setUint32(88, titleBytes.length);
	dv.setUint32(108, spec.resourceStart ?? 0xffffffff);
	dv.setUint32(112, spec.huffcdic ?? 0xffffffff);
	dv.setUint32(116, spec.numHuffcdic ?? 0);
	dv.setUint32(128, exthList.length ? 0x40 : 0);
	dv.setUint32(240, spec.trailingFlags ?? 0);
	if (isV8) {
		dv.setUint32(192, spec.fdst ?? 0xffffffff);
		dv.setUint32(196, spec.numFdst ?? 0);
		dv.setUint32(244, spec.indx ?? 0xffffffff);
		dv.setUint32(248, spec.frag ?? 0xffffffff);
		dv.setUint32(252, spec.skel ?? 0xffffffff);
		dv.setUint32(260, 0xffffffff); // guide（未用）
	}
	out.set(exthBytes, headerLen);
	out.set(titleBytes, titleOffset);
	return out;
}

interface IndxEntrySpec {
	name?: string;
	/** 目录标签索引 → 自动以 CNCX 池键填 tag 3 */
	labelIdx?: number;
	tags: Array<[number, number[]]>;
}

/**
 * 构造一组 INDX 记录：头记录（0xC0 头 + TAGX）+ 1 个条目记录（0xC0 头 + 条目 +
 * IDXT）+ 可选 CNCX 记录。tagDefs = [tag, numValues, mask]（单控制字节、end=0，
 * mask 各占独立位）。
 */
function makeIndx(
	tagDefs: Array<[number, number, number]>,
	entries: IndxEntrySpec[],
	cncx: string[] = [],
): { recs: Uint8Array[]; cncxKeys: number[] } {
	// CNCX 池：[varlen 长度][UTF-8 字节]…，键 = varlen 起始字节偏移
	const cncxKeys: number[] = [];
	const cncxBody = new BW();
	let k = 0;
	for (const s of cncx) {
		cncxKeys.push(k);
		const b = strToU8(s);
		const lenBytes = varlenBytes(b.length);
		for (const byte of lenBytes) {
			cncxBody.u8(byte);
		}
		cncxBody.raw(b);
		k += lenBytes.length + b.length;
	}
	// 头记录：INDX 头（idxt@20=0xFFFFFFFF、条目记录数@24=1、编码@28、CNCX 数@52）
	const tagx = new BW();
	tagx.str("TAGX")
		.be32(12 + tagDefs.length * 4)
		.be32(1);
	for (const [tag, nv, mask] of tagDefs) {
		tagx.u8(tag).u8(nv).u8(mask).u8(0);
	}
	const head = new BW()
		.str("INDX")
		.be32(0xc0)
		.be32(0)
		.be32(0)
		.be32(0)
		.be32(0xffffffff)
		.be32(1)
		.be32(65001)
		.be32(0)
		.be32(entries.length)
		.be32(0xffffffff)
		.be32(0)
		.be32(0)
		.be32(cncx.length ? 1 : 0);
	head.zeros(0xc0 - 56).raw(tagx.build());
	// 条目记录：[名长][名][控制字节][值区 varlen…] + IDXT 偏移表（指向各条目）
	const body = new BW();
	const offsets: number[] = [];
	for (const e of entries) {
		offsets.push(0xc0 + body.len());
		const nameB = e.name ? strToU8(e.name) : new Uint8Array(0);
		body.u8(nameB.length).raw(nameB);
		const all = new Map(e.tags);
		if (e.labelIdx !== undefined && cncx.length) {
			all.set(3, [cncxKeys[e.labelIdx]]);
		}
		let cb = 0;
		for (const [tag, , mask] of tagDefs) {
			if (all.has(tag)) {
				cb |= mask;
			}
		}
		body.u8(cb);
		for (const [tag, nv] of tagDefs) {
			const vals = all.get(tag);
			if (!vals) {
				continue;
			}
			if (vals.length !== nv) {
				throw new Error(`fixture: tag ${tag} 值数 ${vals.length} ≠ numValues ${nv}`);
			}
			for (const v of vals) {
				for (const byte of varlenBytes(v)) {
					body.u8(byte);
				}
			}
		}
	}
	const idxtOff = 0xc0 + body.len();
	const entryRec = new BW()
		.str("INDX")
		.be32(0xc0)
		.be32(0)
		.be32(0)
		.be32(0)
		.be32(idxtOff)
		.be32(entries.length)
		.be32(65001)
		.be32(0)
		.be32(entries.length)
		.be32(0xffffffff)
		.be32(0)
		.be32(0)
		.be32(0);
	entryRec
		.zeros(0xc0 - 56)
		.raw(body.build())
		.str("IDXT");
	for (const o of offsets) {
		entryRec.be16(o);
	}
	const recs = [head.build(), entryRec.build()];
	if (cncx.length) {
		recs.push(cncxBody.build());
	}
	return { recs, cncxKeys };
}

/** FDST 流表：magic + 长度@4 + 数量@8 + [start,end] 区间对 */
function makeFdst(ranges: Array<[number, number]>): Uint8Array {
	const w = new BW().str("FDST").be32(0).be32(ranges.length);
	for (const [s, e] of ranges) {
		w.be32(s).be32(e);
	}
	return w.build();
}

// ── 工厂：MOBI6 样本书 ─────────────────────────────────────────────────────

function makeMobi6Records(opts: {
	html: string;
	encode?: (s: string) => Uint8Array;
	encoding?: number;
	exth?: Array<{ type: number; data: Uint8Array }>;
	title?: string;
	images?: Uint8Array[];
	trailingFlags?: number;
	trailing?: Uint8Array;
}): Uint8Array[] {
	const enc = opts.encode ?? strToU8;
	const text = enc(opts.html);
	const rec0 = makeRecord0({
		textRecordCount: 1,
		textLength: text.length,
		encoding: opts.encoding ?? 65001,
		version: 6,
		exth: opts.exth,
		title: opts.title,
		resourceStart: opts.images?.length ? 2 : 0xffffffff,
		trailingFlags: opts.trailingFlags ?? 0,
	});
	return [rec0, concatU8([text, opts.trailing ?? new Uint8Array(0)]), ...(opts.images ?? [])];
}

/**
 * 标准 MOBI6 样本书：3 节（guide 节 / 正文二节 / 目录节），filepos 目标用 5 位
 * 定宽数字两轮编码消解「值即偏移」的循环依赖。
 */
function mobi6Sample(encoding?: 1252): { book: EpubBook; ch2: number } {
	const enc = encoding === 1252 ? cp1252Encode : strToU8;
	const PB = "<mbp:pagebreak/>";
	const build = (t: { ch1: string; ch2: string; toc: string }): Uint8Array => {
		const s0 = `<html><head><guide><reference type="toc" filepos="${t.toc}"></guide></head><body><img recindex="00001"/><p>章一内容 100€起</p></body></html>`;
		const s1 = `<p>章二内容</p><a filepos="${t.ch1}">回章一</a><a filepos="${t.ch2}">本页头</a>`;
		const s2 = `<a filepos="${t.ch1}">第一章</a><br/><a filepos="${t.ch2}">第二章</a>`;
		return enc(`${s0}${PB}${s1}${PB}${s2}`);
	};
	const zero = build({ ch1: "00000", ch2: "00000", toc: "00000" });
	const at = (probe: string): number => {
		const i = u8IndexOf(zero, enc(probe));
		expect(i).toBeGreaterThanOrEqual(0);
		return i;
	};
	const t = {
		ch1: String(at("<html>")).padStart(5, "0"),
		ch2: String(at("<p>章二内容")).padStart(5, "0"),
		toc: String(at('<a filepos="00000">第一章')).padStart(5, "0"),
	};
	const text = build(t);
	const records = [
		makeRecord0({
			textRecordCount: 1,
			textLength: text.length,
			encoding: encoding ?? 65001,
			version: 6,
			resourceStart: 2,
		}),
		text,
		new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2]),
	];
	return { book: parseMobi(makePdb(records)), ch2: Number(t.ch2) };
}

// ── 工厂：KF8 样本书（2 主章 + 1 脚注流章；NCX 覆盖 id 直用 / name 改写 / 无属性）──

function makeKf8Records(opts?: { skelAt?: number }): Uint8Array[] {
	const B = (s: string) => strToU8(s);
	const S0 = `<html><body><h1 id="V1"></h1><p>尾段<a href="kindle:flow:00001?mime=text/html#note1">脚注</a></p></body></html>`;
	const fragA = `<span id="K1">章一标题</span>`;
	const S1 = `<html><body><p>二固定</p><span name="K2"></span><img src="kindle:embed:00001?mime=image/png"/><link rel="stylesheet" href="kindle:flow:00002?mime=text/css"/></body></html>`;
	const fragB = `<em name="K2">插二</em>`;
	const fragC = `<div>无锚</div>`;
	const flow1 = `<html><body><p id="note1">脚注内容</p></body></html>`;
	const flow2 = "body{margin:0}";
	const [B0, BA, B1, BB, BC, BF1, BF2] = [S0, fragA, S1, fragB, fragC, flow1, flow2].map(B);
	const s0Off = 0;
	const aOff = B0.length;
	const s1Off = aOff + BA.length;
	const bOff = s1Off + B1.length;
	const cOff = bOff + BB.length;
	const f1Off = cOff + BC.length;
	const f2Off = f1Off + BF1.length;
	const stream = concatU8([B0, BA, B1, BB, BC, BF1, BF2]);
	const insertA = B(`<html><body><h1 id="V1">`).length; // 最终章内坐标（frag 插入点）
	const insertB = B(`<html><body><p>二固定</p>`).length;
	const insertC = insertB + BB.length; // 含已插入 fragB 的最终坐标
	const skelIndx = makeIndx(
		[
			[1, 1, 0x01],
			[6, 2, 0x02],
		],
		[
			{
				tags: [
					[1, [1]],
					[6, [s0Off, B0.length]],
				],
			},
			{
				tags: [
					[1, [2]],
					[6, [s1Off, B1.length]],
				],
			},
		],
	);
	const fragIndx = makeIndx(
		[
			[4, 1, 0x01],
			[6, 2, 0x02],
		],
		[
			{
				name: String(insertA),
				tags: [
					[4, [1]],
					[6, [0, BA.length]],
				],
			}, // 段内相对偏移（骨架后）
			{
				name: String(insertB),
				tags: [
					[4, [2]],
					[6, [0, BB.length]],
				],
			},
			{
				name: String(insertC),
				tags: [
					[4, [3]],
					[6, [BB.length, BC.length]],
				],
			},
		],
	);
	const ncxIndx = makeIndx(
		[
			[1, 1, 0x01],
			[2, 1, 0x02],
			[3, 1, 0x04],
			[6, 2, 0x08],
			[21, 1, 0x10],
		],
		[
			{ labelIdx: 0, tags: [[6, [1, 0]]] },
			{
				labelIdx: 1,
				tags: [
					[6, [2, 0]],
					[21, [0]],
				],
			}, // 第二节挂第一章下
			{ labelIdx: 2, tags: [[6, [3, 0]]] },
		],
		["第一章", "第一节", "第二章"],
	);
	const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 3, 4]);
	const rec0 = makeRecord0({
		textRecordCount: 1,
		textLength: stream.length,
		version: 8,
		skel: opts?.skelAt ?? 2,
		frag: 4,
		indx: 6,
		fdst: 9,
		numFdst: 3,
		resourceStart: 10,
	});
	return [
		rec0,
		stream, // 1
		...skelIndx.recs, // 2-3
		...fragIndx.recs, // 4-5
		...ncxIndx.recs, // 6-8（头/条目/CNCX）
		makeFdst([
			[0, f1Off],
			[f1Off, f2Off],
			[f2Off, stream.length],
		]), // 9
		png, // 10
	];
}

// ── 工厂：HUFF/CDIC（2/4 码长混合 + 一个需递归展开的字典条目）──────────────

/**
 * 码表：首字节 ≥0x80（首位 1）→ 表1 直达，1 位码 `1`→字典[0]（"A"）；首字节
 * <0x80（首位 0）→ 提示码长 2 走表2：`00`→字典[2]（压缩子流，递归展开
 * "AAAAAAAA"）、`01`→字典[1]（空，吸收填充位）。表2 槽 2 mincode=0、
 * maxcode=2，code = 2 - bits2。
 */
function makeHuffRecords(): Uint8Array[] {
	const huff = new BW();
	huff.str("HUFF").be32(0).be32(16).be32(1040);
	for (let i = 0; i < 256; i++) {
		huff.be32(i >= 0x80 ? 0x00000181 : 0x00000002);
	}
	huff.be32(0).be32(0); // 槽 1（未用）
	huff.be32(0).be32(2); // 槽 2：mincode=0、maxcode=2
	for (let i = 3; i <= 32; i++) {
		huff.be32(0xffffffff).be32(0);
	}
	// CDIC：指针表@16 起（偏移按 buffer 内坐标），3 条目（numEntries=3、
	// codeLength=2 → n=min(4,3)=3）；条目间按指针偏移垫整
	const cdic = new BW().str("CDIC").be32(16).be32(3).be32(2);
	cdic.be16(6).be16(10).be16(14); // 条目偏移（buffer 内）
	cdic.be16(0x8001).u8(0x41); // [6]："A"（已解压，占 3B）
	cdic.zeros(1); // 垫整到 10
	cdic.be16(0x8000); // [10]：空（已解压，占 2B）
	cdic.zeros(2); // 垫整到 14
	cdic.be16(0x0001).u8(0xff); // [14]：压缩子流 0xFF → 递归展开 8×"A"
	const rec0 = makeRecord0({
		compression: 17480,
		textRecordCount: 1,
		textLength: 10,
		version: 6,
		huffcdic: 2,
		numHuffcdic: 2,
	});
	// 码流 0b10010101 = `1`(A) `00`(字典2→8×A) `1`(A) `01`(空) `01`(空)
	return [rec0, new Uint8Array([0x95]), huff.build(), cdic.build()];
}

// ── 用例 ───────────────────────────────────────────────────────────────────

describe("palmDocDecompress 四分支（㊽）", () => {
	it("字面量：0x00 透传、0x09–0x7F 原样", () => {
		expect([...palmDocDecompress(Uint8Array.from([0x00, 0x09, 0x41, 0x7f]))]).toEqual([
			0x00, 0x09, 0x41, 0x7f,
		]);
	});
	it("1–8：拷贝后随 N 字节", () => {
		expect([...palmDocDecompress(Uint8Array.from([0x41, 0x03, 0x42, 0x43, 0x44]))]).toEqual([
			0x41, 0x42, 0x43, 0x44,
		]);
	});
	it("0x80–0xBF 距离-长度对：14 位距离 + 3 位长度+3", () => {
		// "abc" + pair(0x8018)：distance=3、length=3 → "abcabc"
		expect([...palmDocDecompress(Uint8Array.from([0x61, 0x62, 0x63, 0x80, 0x18]))]).toEqual([
			0x61, 0x62, 0x63, 0x61, 0x62, 0x63,
		]);
	});
	it("0xC0–0xFF：空格 + 异或", () => {
		expect([...palmDocDecompress(Uint8Array.from([0xc1]))]).toEqual([0x20, 0x41]);
	});
	it("畸形距离越过已解压区 → 截断不抛", () => {
		expect(palmDocDecompress(Uint8Array.from([0x80, 0x18])).length).toBe(0);
	});
});

describe("MOBI6 管线（㊽）", () => {
	it("pagebreak 切章 / 字节级锚点 / 同章+跨章链接重写 / recindex 图片 / 扁平 TOC", () => {
		const { book, ch2 } = mobi6Sample();
		expect(book.spine.map((s) => s.href)).toEqual([
			"c/0001.xhtml",
			"c/0002.xhtml",
			"c/0003.xhtml",
		]);
		const ch = (i: number) => strFromU8(book.readEntry(`c/000${i}.xhtml`)!);
		// 节 1：filepos=0 锚点插在节首；recindex → img/0001.jpg；pagebreak 已清
		expect(ch(1).startsWith(`<a id="filepos0000000000"></a><html>`)).toBe(true);
		expect(ch(1)).toContain(`src="img/0001.jpg"`);
		expect(ch(1)).not.toContain("recindex");
		expect(ch(1)).not.toContain("pagebreak");
		expect(ch(1)).toContain("100€起");
		// 节 2：跨章链接带章前缀、同章链接裸 #；自身节首锚点
		expect(ch(2)).toContain(`href="c/0001.xhtml#filepos0000000000"`);
		expect(ch(2)).toContain(`href="#filepos${String(ch2).padStart(10, "0")}"`);
		// 节 3（目录节）：链接同样重写
		expect(ch(3)).toContain(`href="c/0001.xhtml#filepos0000000000"`);
		expect(ch(3)).toContain(`href="c/0002.xhtml#filepos${String(ch2).padStart(10, "0")}"`);
		// 图片出口：零拷贝原始记录字节；缺号 null
		expect([...book.readEntry("img/0001.jpg")!]).toEqual([0xff, 0xd8, 0xff, 0xe0, 1, 2]);
		expect(book.readEntry("img/0009.jpg")).toBeNull();
		// 扁平 TOC：guide → a[filepos]
		expect(book.toc.map((n) => n.title)).toEqual(["第一章", "第二章"]);
		expect(book.toc[0]).toMatchObject({ spineIndex: 0, fragment: "filepos0000000000" });
		expect(book.toc[1]).toMatchObject({
			spineIndex: 1,
			fragment: `filepos${String(ch2).padStart(10, "0")}`,
		});
	});

	it("CP1252 高位字符按书籍编码往返（encoding=1252）", () => {
		const html = "<p>Prix 100€ — debut</p>";
		const bytes = makePdb(
			makeMobi6Records({ html, encode: cp1252Encode, encoding: 1252, title: "CP1252 Book" }),
		);
		const book = parseMobi(bytes);
		expect(book.title).toBe("CP1252 Book");
		expect(strFromU8(book.readEntry("c/0001.xhtml")!)).toContain("100€");
		expect(strFromU8(book.readEntry("c/0001.xhtml")!)).toContain("—");
	});

	it("文本记录尾部剥除：varlen 条目 + multibyte 尾（真实布局：mb 在前、条目在后）", () => {
		const html = "<p>干净正文</p>";
		// 布局 [mb 计数字节][条目 2B][varlen 长度]；varlen 值 = 条目数据 + varlen
		// 字节本身（3 → 0x83）；trailingFlags=0b11
		const trailing = new Uint8Array([0x58, 0x01, 0xab, 0xcd, 0x83]);
		const bytes = makePdb(makeMobi6Records({ html, trailingFlags: 0b11, trailing }));
		expect(strFromU8(parseMobi(bytes).readEntry("c/0001.xhtml")!)).toBe(html);
	});

	it("无 pagebreak 的 MOBI6 → 整书单章", () => {
		const book = parseMobi(makePdb(makeMobi6Records({ html: "<p>唯一</p>" })));
		expect(book.spine).toHaveLength(1);
		expect(strFromU8(book.readEntry("c/0001.xhtml")!)).toBe("<p>唯一</p>");
	});
});

describe("KF8（AZW3）管线（㊽）", () => {
	it("skel-frag 字节精确重组 / NCX id 直用 / name→id 字节改写 / 无属性降级 / embed+flow 重写 / 脚注流追章", () => {
		const book = parseMobi(makePdb(makeKf8Records()));
		// 2 主章 + 1 脚注流章（CSS 流不追加）
		expect(book.spine.map((s) => s.href)).toEqual([
			"c/0001.xhtml",
			"c/0002.xhtml",
			"c/0003.xhtml",
		]);
		expect(strFromU8(book.readEntry("c/0001.xhtml")!)).toBe(
			`<html><body><h1 id="V1"><span id="K1">章一标题</span></h1><p>尾段<a href="c/0003.xhtml#note1">脚注</a></p></body></html>`,
		);
		expect(strFromU8(book.readEntry("c/0002.xhtml")!)).toBe(
			`<html><body><p>二固定</p><em id  ="K2">插二</em><div>无锚</div><span name="K2"></span>` +
				`<img src="img/0001.png"/><link rel="stylesheet" href="kindle:flow:00002?mime=text/css"/></body></html>`,
		);
		expect(strFromU8(book.readEntry("c/0003.xhtml")!)).toBe(
			`<html><body><p id="note1">脚注内容</p></body></html>`,
		);
		// embed（32 进制 id）→ 图片出口；CSS 流链接保持原样（kindle: 协议由净化层剥）
		expect([...book.readEntry("img/0001.png")!]).toEqual([
			0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 3, 4,
		]);
		// NCX：id 直用（K1）、name 字节改写（id + 空格填充）、无属性 null 停章顶；tag21 组树
		expect(book.toc).toEqual([
			{
				title: "第一章",
				href: "",
				spineIndex: 0,
				fragment: "K1",
				children: [
					{ title: "第一节", href: "", spineIndex: 1, fragment: "K2", children: [] },
				],
			},
			{ title: "第二章", href: "", spineIndex: 1, fragment: null, children: [] },
		]);
	});

	it("skel 损坏 → 降级 MOBI6 管线（整书单章、toc 空）不抛", () => {
		const book = parseMobi(makePdb(makeKf8Records({ skelAt: 9 }))); // skel 指向 FDST 记录
		expect(book.spine).toHaveLength(1);
		expect(book.toc).toEqual([]);
		expect(strFromU8(book.readEntry("c/0001.xhtml")!)).toContain("章一标题");
	});

	it("combo（EXTH 121 boundary）优先走 KF8 半边", () => {
		const records = [
			makeRecord0({
				textRecordCount: 1,
				textLength: 8,
				version: 6,
				exth: [{ type: 121, data: u32b(2) }],
			}),
			strToU8("<p>旧</p>"),
			...makeKf8Records(),
		];
		const book = parseMobi(makePdb(records));
		expect(book.spine).toHaveLength(3);
		expect(book.toc[0]!.fragment).toBe("K1");
	});
});

describe("HUFF/CDIC 解压（㊽）", () => {
	it("表1 直达 + 表2 码长推进 + 字典递归展开与缓存（全链 E2E）", () => {
		const book = parseMobi(makePdb(makeHuffRecords()));
		expect(strFromU8(book.readEntry("c/0001.xhtml")!)).toBe("AAAAAAAAAA");
	});
});

describe("标题解析（㊽）", () => {
	it("EXTH 503 优先 + 实体反转义", () => {
		const bytes = makePdb(
			makeMobi6Records({
				html: "<p>x</p>",
				exth: [{ type: 503, data: strToU8("EXTH 标题&amp;") }],
				title: "头字段标题",
			}),
		);
		expect(parseMobi(bytes).title).toBe("EXTH 标题&");
	});
	it("无 EXTH 503 回退 MOBI 头 title", () => {
		expect(
			parseMobi(makePdb(makeMobi6Records({ html: "<p>x</p>", title: "头字段标题" }))).title,
		).toBe("头字段标题");
	});
	it("两者皆缺 → null（调用方 basename 兜底）", () => {
		expect(parseMobi(makePdb(makeMobi6Records({ html: "<p>x</p>" }))).title).toBeNull();
	});
});

describe("DRM 拒收（㊽）", () => {
	it("encryption=1（老 MOBI 加密）与 =2（新 DRM）均中文报错", () => {
		const drm = (enc: number) =>
			makePdb([
				makeRecord0({ textRecordCount: 1, textLength: 1, version: 6, encryption: enc }),
				strToU8("x"),
			]);
		expect(() => parseMobi(drm(1))).toThrow(/加密内容（DRM）/);
		expect(() => parseMobi(drm(2))).toThrow(/加密内容（DRM）/);
	});
});

describe("mobiCoverBytes（㊽ 主页封面，永不抛）", () => {
	const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 7, 8]);
	it("EXTH 201 coverOffset 命中：href 带嗅探扩展名 + 原始字节", () => {
		const cover = mobiCoverBytes(
			makePdb(
				makeMobi6Records({
					html: "<p>x</p>",
					exth: [{ type: 201, data: u32b(0) }],
					images: [jpeg],
				}),
			),
		);
		expect(cover).not.toBeNull();
		expect(cover!.href).toBe("img/0001.jpg");
		expect([...cover!.bytes]).toEqual([...jpeg]);
	});
	it("EXTH 202 thumbnail 兜底；parseMobi 同书 coverHref 一致", () => {
		const records = makeMobi6Records({
			html: "<p>x</p>",
			exth: [{ type: 202, data: u32b(0) }],
			images: [jpeg],
		});
		expect(mobiCoverBytes(makePdb(records))!.href).toBe("img/0001.jpg");
		expect(parseMobi(makePdb(records)).coverHref).toBe("img/0001.jpg");
	});
	it("无 EXTH → null；DRM → null；非 MOBI 字节 → null 不抛", () => {
		expect(mobiCoverBytes(makePdb(makeMobi6Records({ html: "<p>x</p>" })))).toBeNull();
		const drm = makePdb([
			makeRecord0({ textRecordCount: 1, textLength: 1, version: 6, encryption: 2 }),
			strToU8("x"),
		]);
		expect(mobiCoverBytes(drm)).toBeNull();
		expect(mobiCoverBytes(new Uint8Array(20))).toBeNull();
	});
});

describe("畸形输入（宁拒不赌，中文文案）", () => {
	/** 在字节数组指定偏移写入 ASCII 串 */
	const putAscii = (arr: Uint8Array, off: number, s: string) => {
		for (let i = 0; i < s.length; i++) {
			arr[off + i] = s.charCodeAt(i);
		}
	};
	it("过短字节 / 非 BOOKMOBI / Topaz 各自文案", () => {
		expect(() => parseMobi(new Uint8Array(50))).toThrow(/不是有效的 MOBI/);
		const notMobi = new Uint8Array(120);
		putAscii(notMobi, 60, "JUNKJUNK");
		expect(() => parseMobi(notMobi)).toThrow(/BOOKMOBI/);
		const tpz = new Uint8Array(120);
		putAscii(tpz, 60, "TPZ");
		putAscii(tpz, 64, "TPZ1");
		expect(() => parseMobi(tpz)).toThrow(/Topaz/);
	});
	it("numRecords=0 / 记录表越界", () => {
		const b = new Uint8Array(100);
		putAscii(b, 60, "BOOKMOBI");
		expect(() => parseMobi(b)).toThrow(/记录表越界/);
	});
	it("record 0 缺 MOBI 魔数", () => {
		expect(() => parseMobi(makePdb([new Uint8Array(64)]))).toThrow(/MOBI 头魔数/);
	});
	it("正文为空（textRecordCount=0）", () => {
		expect(() =>
			parseMobi(makePdb([makeRecord0({ textRecordCount: 0, textLength: 0, version: 6 })])),
		).toThrow(/无正文/);
	});
});
