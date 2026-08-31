import { describe, expect, it } from "vitest";
import { strToU8, zipSync } from "fflate";
import {
	entryText,
	epubChapterTitleOf,
	epubCoverBytes,
	epubOutline,
	parseEpub,
	resolveZipPath,
} from "../../src/reader/epub-document";

/** 测试工厂：字符串条目自动转 UTF-8 字节（样板 = tests/backup/backup-zip.test.ts） */
function makeEpub(files: Record<string, string | Uint8Array>): Uint8Array {
	const zipped: Record<string, Uint8Array> = {};
	for (const [name, content] of Object.entries(files)) {
		zipped[name] = typeof content === "string" ? strToU8(content) : content;
	}
	return zipSync(zipped);
}

const CONTAINER = `<?xml version="1.0" encoding="UTF-8"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
	<rootfiles>
		<rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/>
	</rootfiles>
</container>`;

/** EPUB3 标准书：nav 目录（嵌套 + 纯分组 + 非 spine 目标）+ properties 封面 */
function sampleEpub3(
	overrides: Record<string, string | Uint8Array> = {},
	omit: string[] = [],
): Uint8Array {
	const files: Record<string, string | Uint8Array> = {
		mimetype: "application/epub+zip",
		"META-INF/container.xml": CONTAINER,
		"OEBPS/content.opf": `<?xml version="1.0" encoding="UTF-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="uid">
	<metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
		<dc:identifier id="uid">urn:uuid:test</dc:identifier>
		<dc:title>测试书</dc:title>
		<meta property="dcterms:modified">2026-01-01T00:00:00Z</meta>
	</metadata>
	<manifest>
		<item id="nav" href="nav.xhtml" properties="nav" media-type="application/xhtml+xml"/>
		<item id="c1" href="text/ch1.xhtml" media-type="application/xhtml+xml"/>
		<item id="c2" href="text/ch2.xhtml" media-type="application/xhtml+xml"/>
		<item id="app" href="text/app.xhtml" media-type="application/xhtml+xml"/>
		<item id="cover" href="images/cover.jpg" properties="cover-image" media-type="image/jpeg"/>
	</manifest>
	<spine>
		<itemref idref="c1"/>
		<itemref idref="c2"/>
	</spine>
</package>`,
		"OEBPS/nav.xhtml": `<?xml version="1.0" encoding="UTF-8"?>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops">
<head><title>目录</title></head>
<body>
<nav epub:type="toc">
	<ol>
		<li><a href="text/ch1.xhtml">第一章</a>
			<ol><li><a href="text/ch1.xhtml#s1">第一节</a></li></ol>
		</li>
		<li><a href="text/ch2.xhtml">第二章</a></li>
		<li><span>附录</span>
			<ol><li><a href="text/app.xhtml">附录 A</a></li></ol>
		</li>
	</ol>
</nav>
<nav epub:type="landmarks" hidden="hidden"><ol><li><a href="text/ch1.xhtml">正文</a></li></ol></nav>
</body>
</html>`,
		"OEBPS/text/ch1.xhtml": "<html><body><h1 id=\"s1\">第一章标题</h1><p>中文正文内容</p></body></html>",
		"OEBPS/text/ch2.xhtml": "<html><body><p>第二章内容</p></body></html>",
		"OEBPS/text/app.xhtml": "<html><body><p>附录内容</p></body></html>",
		"OEBPS/images/cover.jpg": new Uint8Array([1, 2, 3, 4]),
	};
	for (const key of omit) {
		delete files[key];
	}
	return makeEpub({ ...files, ...overrides });
}

/** 替换 OPF（结构变体测试用：空 spine / 悬空引用 / linear=no） */
function opfWithSpine(spineXml: string): string {
	return `<?xml version="1.0" encoding="UTF-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="uid">
	<metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
		<dc:title>变体书</dc:title>
	</metadata>
	<manifest>
		<item id="c1" href="text/ch1.xhtml" media-type="application/xhtml+xml"/>
		<item id="c2" href="text/ch2.xhtml" media-type="application/xhtml+xml"/>
	</manifest>
	<spine>${spineXml}</spine>
</package>`;
}

/** EPUB2 老书：NCX 目录 + meta[name=cover] 间接封面（无 nav 文档） */
function sampleEpub2(overrides: Record<string, string | Uint8Array> = {}): Uint8Array {
	const files: Record<string, string | Uint8Array> = {
		"META-INF/container.xml": CONTAINER,
		"OEBPS/content.opf": `<?xml version="1.0" encoding="UTF-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="2.0" unique-identifier="uid">
	<metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
		<dc:title>EPUB2 老书</dc:title>
		<dc:identifier id="uid">x</dc:identifier>
		<meta name="cover" content="cover-img"/>
	</metadata>
	<manifest>
		<item id="ncx" href="toc.ncx" media-type="application/x-dtbncx+xml"/>
		<item id="c1" href="text/ch1.xhtml" media-type="application/xhtml+xml"/>
		<item id="c2" href="text/ch2.xhtml" media-type="application/xhtml+xml"/>
		<item id="cover-img" href="images/cover.png" media-type="image/png"/>
	</manifest>
	<spine toc="ncx">
		<itemref idref="c1"/>
		<itemref idref="c2"/>
	</spine>
</package>`,
		"OEBPS/toc.ncx": `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE ncx PUBLIC "-//NISO//DTD ncx 2005-1//EN" "http://www.daisy.org/z3986/2005/ncx-2005-1.dtd">
<ncx xmlns="http://www.daisy.org/z3986/2005/ncx/" version="2005-1">
	<head/>
	<docTitle><text>旧书</text></docTitle>
	<navMap>
		<navPoint id="n1" playOrder="1">
			<navLabel><text>卷一</text></navLabel>
			<content src="text/ch1.xhtml"/>
			<navPoint id="n1-1" playOrder="2">
				<navLabel><text>第 1 章</text></navLabel>
				<content src="text/ch1.xhtml#top"/>
			</navPoint>
		</navPoint>
		<navPoint id="n2" playOrder="3">
			<navLabel><text>第 2 章</text></navLabel>
			<content src="text/ch2.xhtml"/>
		</navPoint>
	</navMap>
</ncx>`,
		"OEBPS/text/ch1.xhtml": "<html><body><p>老书一章</p></body></html>",
		"OEBPS/text/ch2.xhtml": "<html><body><p>老书二章</p></body></html>",
		"OEBPS/images/cover.png": new Uint8Array([9, 9]),
	};
	return makeEpub({ ...files, ...overrides });
}

describe("resolveZipPath 路径归一（㊼ EPUB）", () => {
	it("../ 与 . 段归一；%20 URL 解码；fragment 与 query 剥离", () => {
		expect(resolveZipPath("OEBPS/nav.xhtml", "text/../images/a%20b.png")).toEqual({
			path: "OEBPS/images/a b.png",
			fragment: null,
		});
		expect(resolveZipPath("OEBPS/nav.xhtml", "../META-INF/container.xml?raw#frag")).toEqual({
			path: "META-INF/container.xml",
			fragment: "frag",
		});
		expect(resolveZipPath("OEBPS/nav.xhtml", "./text/ch1.xhtml")).toEqual({
			path: "OEBPS/text/ch1.xhtml",
			fragment: null,
		});
	});

	it("越根钳制（../../.. 超出根忽略）；绝对路径自 zip 根", () => {
		expect(resolveZipPath("container.xml", "../../../../x.png").path).toBe("x.png");
		expect(resolveZipPath("OEBPS/nav.xhtml", "/images/a.png").path).toBe("images/a.png");
	});

	it("纯 fragment 指向基准文件自身；空 fragment 归一 null", () => {
		expect(resolveZipPath("OEBPS/nav.xhtml", "#sec1")).toEqual({
			path: "OEBPS/nav.xhtml",
			fragment: "sec1",
		});
		expect(resolveZipPath("OEBPS/nav.xhtml", "ch1.xhtml#").fragment).toBeNull();
	});

	it("畸形 % 序列原样保留（不抛，条目查不中由调用方降级）", () => {
		expect(resolveZipPath("a.xhtml", "x%2.png").path).toBe("x%2.png");
	});
});

describe("parseEpub EPUB3（㊼）", () => {
	it("全解析：dc:title / cover-image 封面 / spine 归一路径 / nav 嵌套目录", () => {
		const book = parseEpub(sampleEpub3());
		expect(book.title).toBe("测试书");
		expect(book.coverHref).toBe("OEBPS/images/cover.jpg");
		expect(book.spine.map((s) => s.href)).toEqual([
			"OEBPS/text/ch1.xhtml",
			"OEBPS/text/ch2.xhtml",
		]);
		// epub:type=toc 的 nav 优先（landmarks nav 不误选）
		expect(book.toc.map((n) => n.title)).toEqual(["第一章", "第二章", "附录"]);
		expect(book.toc[0].spineIndex).toBe(0);
		expect(book.toc[0].children).toHaveLength(1);
		expect(book.toc[0].children[0]).toMatchObject({ title: "第一节", fragment: "s1", spineIndex: 0 });
		// 纯分组节点（li>span）无链接；其子级指向非 spine 资源 → spineIndex -1
		expect(book.toc[2]).toMatchObject({ href: "", spineIndex: -1, fragment: null });
		expect(book.toc[2].children[0]).toMatchObject({ title: "附录 A", spineIndex: -1 });
		// E2 懒解压：readEntry 按需取条目（结构文件/章节/封面皆可读；缺失路径 null）
		expect(book.readEntry("mimetype")).not.toBeNull();
		expect(book.readEntry("OEBPS/text/ch1.xhtml")).not.toBeNull();
		expect(book.readEntry("OEBPS/images/cover.jpg")).not.toBeNull();
		expect(book.readEntry("OEBPS/missing.xhtml")).toBeNull();
	});

	it("entryText 中文往返；路径不存在 null", () => {
		const book = parseEpub(sampleEpub3());
		const text = entryText(book, "OEBPS/text/ch1.xhtml");
		expect(text).toContain("中文正文内容");
		expect(entryText(book, "OEBPS/missing.xhtml")).toBeNull();
	});

	it("dc:title 缺失 → null（调用方 basename 兜底）", () => {
		const book = parseEpub(
			sampleEpub3({
				"OEBPS/content.opf": `<?xml version="1.0"?>
<package version="3.0"><metadata/><manifest>
<item id="c1" href="text/ch1.xhtml" media-type="application/xhtml+xml"/>
</manifest><spine><itemref idref="c1"/></spine></package>`,
			}),
		);
		expect(book.title).toBeNull();
		expect(book.spine).toHaveLength(1);
	});

	it("linear=no 保留在 spine；悬空 itemref 跳过不破页码连续性", () => {
		const book = parseEpub(
			sampleEpub3({
				"OEBPS/content.opf": opfWithSpine(
					'<itemref idref="c2" linear="no"/><itemref idref="ghost"/><itemref idref="c1"/>',
				),
			}),
		);
		expect(book.spine.map((s) => s.href)).toEqual([
			"OEBPS/text/ch2.xhtml",
			"OEBPS/text/ch1.xhtml",
		]);
	});
});

describe("parseEpub EPUB2 与目录回退（㊼）", () => {
	it("NCX 三层 navPoint 嵌套 + spine@toc + meta[name=cover] 间接封面", () => {
		const book = parseEpub(sampleEpub2());
		expect(book.title).toBe("EPUB2 老书");
		expect(book.coverHref).toBe("OEBPS/images/cover.png");
		expect(book.toc.map((n) => n.title)).toEqual(["卷一", "第 2 章"]);
		expect(book.toc[0].children[0]).toMatchObject({ title: "第 1 章", fragment: "top", spineIndex: 0 });
		expect(book.toc[1].spineIndex).toBe(1);
	});

	it("nav 与 NCX 并存 → 用 nav；仅 NCX（无 nav）回退 NCX", () => {
		const book = parseEpub(sampleEpub3({
			"OEBPS/content.opf": `<?xml version="1.0" encoding="UTF-8"?>
<package version="3.0" unique-identifier="uid">
<metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:title>双目录书</dc:title></metadata>
<manifest>
<item id="nav" href="nav.xhtml" properties="nav" media-type="application/xhtml+xml"/>
<item id="ncx" href="toc.ncx" media-type="application/x-dtbncx+xml"/>
<item id="c1" href="text/ch1.xhtml" media-type="application/xhtml+xml"/>
<item id="c2" href="text/ch2.xhtml" media-type="application/xhtml+xml"/>
</manifest>
<spine toc="ncx"><itemref idref="c1"/><itemref idref="c2"/></spine>
</package>`,
			"OEBPS/nav.xhtml": `<?xml version="1.0"?>
<html><body><nav epub:type="toc"><ol><li><a href="text/ch1.xhtml">导航优先</a></li></ol></nav></body></html>`,
			"OEBPS/toc.ncx": sampleEpub2()["OEBPS/toc.ncx"] as string,
		}));
		expect(book.toc.map((n) => n.title)).toEqual(["导航优先"]);

		const ncxOnly = parseEpub(sampleEpub2());
		expect(ncxOnly.toc[0].title).toBe("卷一");
	});

	it("nav 与 NCX 皆无 → toc=[]（reader 兜底「第 N 章」平铺）", () => {
		const book = parseEpub(sampleEpub3({
			"OEBPS/content.opf": `<?xml version="1.0" encoding="UTF-8"?>
<package version="3.0" unique-identifier="uid">
<metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:title>无目录书</dc:title></metadata>
<manifest>
<item id="c1" href="text/ch1.xhtml" media-type="application/xhtml+xml"/>
<item id="c2" href="text/ch2.xhtml" media-type="application/xhtml+xml"/>
</manifest>
<spine><itemref idref="c1"/><itemref idref="c2"/></spine>
</package>`,
		}));
		expect(book.toc).toEqual([]);
		expect(book.spine).toHaveLength(2);
	});
});

describe("epubOutline / epubChapterTitleOf（㊼ 阅读器接线）", () => {
	it("toc 树转换：spineIndex+1 为页码；非 spine 目标 page=null（is-dead 置灰语义）", () => {
		const book = parseEpub(sampleEpub3());
		const outline = epubOutline(book);
		expect(outline.map((e) => e.title)).toEqual(["第一章", "第二章", "附录"]);
		expect(outline[0].page).toBe(1);
		expect(outline[0].children[0]).toMatchObject({ title: "第一节", page: 1, fragment: "s1" });
		expect(outline[2].page).toBeNull();
		expect(outline[2].children[0].page).toBeNull();
	});

	it("toc 为空时兜底「第 N 章」平铺（spine 顺序）", () => {
		const book = parseEpub(sampleEpub3({
			"OEBPS/content.opf": `<?xml version="1.0" encoding="UTF-8"?>
<package version="3.0"><metadata/><manifest>
<item id="c1" href="text/ch1.xhtml" media-type="application/xhtml+xml"/>
<item id="c2" href="text/ch2.xhtml" media-type="application/xhtml+xml"/>
</manifest><spine><itemref idref="c1"/><itemref idref="c2"/></spine></package>`,
		}));
		const outline = epubOutline(book);
		expect(outline.map((e) => e.title)).toEqual(["第 1 章", "第 2 章"]);
		expect(outline.map((e) => e.page)).toEqual([1, 2]);
	});

	it("章节标题：同章更深节点胜出；取 ≤ 当前章最近标题；全越界 null", () => {
		const book = parseEpub(sampleEpub3());
		// 章 1 内：第一节（文档序靠后、同 idx）比 第一章 更具体
		expect(epubChapterTitleOf(book, 0)).toBe("第一节");
		expect(epubChapterTitleOf(book, 1)).toBe("第二章");
	});
});

describe("parseEpub 错误路径（中文文案，宁拒不赌）", () => {
	it("非 zip 字节", () => {
		expect(() => parseEpub(new Uint8Array([1, 2, 3]))).toThrow(/无法解压/);
	});

	it("encryption.xml 存在即拒（DRM / 字体混淆不区分）", () => {
		expect(() =>
			parseEpub(sampleEpub3({ "META-INF/encryption.xml": "<encryption/>" })),
		).toThrow(/加密内容/);
	});

	it("缺 container.xml / container 无 rootfile / OPF 文件缺失 / 空 spine", () => {
		expect(() => parseEpub(sampleEpub3({}, ["META-INF/container.xml"]))).toThrow(/container\.xml/);
		expect(() =>
			parseEpub(sampleEpub3({
				"META-INF/container.xml": '<container version="1.0"><rootfiles/></container>',
			})),
		).toThrow(/rootfile/);
		expect(() =>
			parseEpub(sampleEpub3({
				"META-INF/container.xml": CONTAINER.replace("OEBPS/content.opf", "OEBPS/missing.opf"),
			})),
		).toThrow(/missing\.opf/);
		expect(() =>
			parseEpub(sampleEpub3({ "OEBPS/content.opf": opfWithSpine("") })),
		).toThrow(/可读章节/);
	});
});

describe("epubCoverBytes filter 限次提取（㊼ 主页封面）", () => {
	it("正常提取：EPUB3 properties 封面字节直取", () => {
		const cover = epubCoverBytes(sampleEpub3());
		expect(cover).not.toBeNull();
		expect(cover!.href).toBe("OEBPS/images/cover.jpg");
		expect([...cover!.bytes]).toEqual([1, 2, 3, 4]);
	});

	it("EPUB2 meta[name=cover] 间接封面同样可取", () => {
		const cover = epubCoverBytes(sampleEpub2());
		expect(cover).not.toBeNull();
		expect(cover!.href).toBe("OEBPS/images/cover.png");
	});

	it("无封面 → null；非 zip → null 不抛（封面是增强不是依赖）", () => {
		const noCover = epubCoverBytes(sampleEpub3({
			"OEBPS/content.opf": opfWithSpine('<itemref idref="c1"/>'),
		}));
		expect(noCover).toBeNull();
		expect(epubCoverBytes(new Uint8Array([1, 2, 3]))).toBeNull();
	});
});
