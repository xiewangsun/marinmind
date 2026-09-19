import { describe, expect, it } from "vitest";
import type { BookDocument, Card, CardLink, DocumentBookmark, ReviewState } from "../../src/types";
import {
	defaultReviewState,
	linkId,
	parseBookMd,
	sanitizeFileName,
	serializeBookMd,
	type SerializeBookInput,
} from "../../src/store/book-format";

/** 构造文档 */
function doc(partial: Partial<BookDocument> = {}): BookDocument {
	return {
		id: "11111111-1111-4111-8111-111111111111",
		filePath: "阅读/书籍A.pdf",
		title: "书籍A",
		author: null, // 163：可选字段显式 null（与解析产物 toEqual 对齐；序列化省略行）
		category: null,
		collectMapId: null,
		autoFlashcard: false,
		lastPage: null,
		createdAt: 1700000000000,
		updatedAt: 1700000100000,
		...partial,
	};
}

/** 构造卡片（默认 text/第 3 页/无内容） */
function card(partial: Partial<Card> & Pick<Card, "id" | "excerptType">): Card {
	return {
		documentId: doc().id,
		page: 3,
		rects: [],
		polygon: null,
		excerptText: null,
		excerptRef: null,
		note: null,
		color: null,
		lineStyle: null,
		title: null,
		deck: null,
		occlusions: [],
		tags: [],
		createdAt: 1700000001000,
		updatedAt: 1700000001000,
		...partial,
	};
}

/** 构造复习状态 */
function review(cardId: string, partial: Partial<ReviewState> = {}): ReviewState {
	return { ...defaultReviewState(cardId, 1700000001000), ...partial };
}

/** 组一次序列化输入 */
function bookInput(overrides: Partial<SerializeBookInput> = {}): SerializeBookInput {
	return {
		doc: doc(),
		cards: [],
		reviews: new Map(),
		bookmarks: [],
		links: [],
		...overrides,
	};
}

describe("book-format 序列化与解析", () => {
	it("空书往返：无卡无书签只出 frontmatter", () => {
		const text = serializeBookMd(bookInput());
		expect(text).toBe(
			[
				"---",
				"marinmind: book",
				`id: ${doc().id}`,
				"title: 书籍A",
				"file_path: 阅读/书籍A.pdf",
				"created_at: 1700000000000",
				"updated_at: 1700000100000",
				"---",
				"",
			].join("\n"),
		);
		const parsed = parseBookMd(text, { fileName: "书籍A.md" });
		expect(parsed.cards).toEqual([]);
		expect(parsed.bookmarks).toEqual([]);
		expect(parsed.doc).toEqual(doc());
		expect(parsed.warnings).toEqual([]);
	});

	it("作者 author 行（163）：有值落行往返；null 省略行（零写入契约）", () => {
		const withAuthor = serializeBookMd(bookInput({ doc: doc({ author: "张三" }) }));
		expect(withAuthor).toContain("author: 张三");
		const parsed = parseBookMd(withAuthor, { fileName: "书籍A.md" });
		expect(parsed.doc.author).toBe("张三");
		// null（含缺行）：不落行，解析回 null
		const withoutAuthor = serializeBookMd(bookInput());
		expect(withoutAuthor).not.toContain("author:");
		expect(parseBookMd(withoutAuthor, { fileName: "书籍A.md" }).doc.author).toBeNull();
	});

	it("分节标题量词（165）：epub 书写「第 N 章」，pdf 仍「第 N 页」；旧「页」文件两者皆收", () => {
		const epubCard = card({
			id: "33333333-3333-4333-8333-333333333333",
			excerptType: "area",
			page: 3,
		});
		const epubText = serializeBookMd(
			bookInput({ doc: doc({ filePath: "阅读/书.epub" }), cards: [epubCard] }),
		);
		expect(epubText).toContain("## 第 3 章");
		expect(epubText).not.toContain("## 第 3 页");

		const pdfText = serializeBookMd(
			bookInput({ doc: doc({ filePath: "阅读/书.pdf" }), cards: [epubCard] }),
		);
		expect(pdfText).toContain("## 第 3 页");

		// 旧式「页」标题的手编 epub 书文件：解析照收（存量字节不动语义不变）
		const legacy = parseBookMd(epubText.replace("## 第 3 章", "## 第 3 页"), {
			fileName: "书.md",
		});
		expect(legacy.cards).toHaveLength(1);
		expect(legacy.cards[0]!.page).toBe(3);
	});

	it("语音时长 dur 键（84-B）：audio 卡往返还原；缺省不落键（零写入契约）", () => {
		// audio 卡带时长：序列化含 "dur":37 且解析还原
		const audioCard = card({
			id: "22222222-2222-4222-8222-222222222222",
			excerptType: "audio",
			excerptRef: "assets/abc.webm",
			durationSec: 37,
		});
		const text1 = serializeBookMd(bookInput({ cards: [audioCard] }));
		expect(text1).toContain(`"ref":"assets/abc.webm","dur":37`);
		const parsed1 = parseBookMd(text1, { fileName: "书籍A.md" });
		expect(parsed1.cards[0].durationSec).toBe(37);
		// 二次序列化字节稳定（dur 键序固定在 ref 后；解析返回数组需转 Map）
		const text2 = serializeBookMd({
			...bookInput(),
			cards: parsed1.cards,
			reviews: new Map(parsed1.reviews.map((r) => [r.cardId, r])),
			links: parsed1.links,
		});
		expect(text2).toBe(text1);

		// 零写入契约：无 durationSec 的存量卡不落 dur 键（字节不含）
		const plainCard = card({
			id: "22222222-2222-4222-8222-222222222222",
			excerptType: "text",
			excerptText: "普通摘录",
		});
		const text3 = serializeBookMd(bookInput({ cards: [plainCard] }));
		expect(text3).not.toContain(`"dur"`);
		const parsed3 = parseBookMd(text3, { fileName: "书籍A.md" });
		expect(parsed3.cards[0].durationSec).toBeUndefined();

		// 容错：dur 损坏（负数/字符串）不落字段，不拖垮整卡
		const broken = text1.replace(`"dur":37`, `"dur":-5`);
		const parsed4 = parseBookMd(broken, { fileName: "书籍A.md" });
		expect(parsed4.cards[0].durationSec).toBeUndefined();
		expect(parsed4.cards[0].excerptRef).toBe("assets/abc.webm");
	});

	it("photo 展示框 rects 往返（84-D）：定位后往返还原；空 rects 零写入（存量字节不变）", () => {
		const frame = { x: 0.3, y: 0.4, w: 0.2, h: 0.1 };
		const photoCard = card({
			id: "33333333-3333-4333-8333-333333333333",
			excerptType: "photo",
			excerptRef: "assets/pic.jpg",
			page: 3,
			rects: [frame],
		});
		const text1 = serializeBookMd(bookInput({ cards: [photoCard] }));
		expect(text1).toContain(`"rects":[{`);
		const parsed1 = parseBookMd(text1, { fileName: "书籍A.md" });
		expect(parsed1.cards[0].rects).toEqual([frame]);
		// 二次序列化字节稳定（解析返回数组需转 Map）
		const text2 = serializeBookMd({
			...bookInput(),
			cards: parsed1.cards,
			reviews: new Map(parsed1.reviews.map((r) => [r.cardId, r])),
			links: parsed1.links,
		});
		expect(text2).toBe(text1);

		// 零写入契约：未定位的 photo 卡（rects 空）不落 rects 键——84 之前存量字节不变
		const unlocated = card({
			id: "33333333-3333-4333-8333-333333333333",
			excerptType: "photo",
			excerptRef: "assets/pic.jpg",
			page: 3,
		});
		const text3 = serializeBookMd(bookInput({ cards: [unlocated] }));
		expect(text3).not.toContain(`"rects"`);
		expect(parseBookMd(text3, { fileName: "书籍A.md" }).cards[0].rects).toEqual([]);
	});

	it("库外绝对路径 filePath 往返（㉞ 关键回归——yamlQuote 冒号转义）", () => {
		for (const abs of [
			"D:\\Books 库外\\书籍A.pdf", // Windows：冒号 + 反斜杠，必走 JSON.stringify
			"/home/u/books/书籍A.pdf", // POSIX：合法 plain scalar
			"\\\\srv\\share\\书籍A.pdf", // UNC
		]) {
			const input = bookInput({ doc: doc({ filePath: abs }) });
			const text = serializeBookMd(input);
			const parsed = parseBookMd(text, { fileName: "书籍A.md" });
			expect(parsed.doc.filePath).toBe(abs);
			// 二次序列化字节相同（确定性契约不因路径形态破坏）
			expect(
				serializeBookMd({
					...input,
					doc: parsed.doc,
					cards: parsed.cards,
					reviews: parsed.reviews,
					bookmarks: parsed.bookmarks,
					links: parsed.links,
				}),
			).toBe(text);
		}
	});
	it("分类 category 往返（㉟）：有值序列化在 title 后，危险字符经 yamlQuote 无损，二次序列化字节相同", () => {
		for (const category of [
			"学习", // 普通：裸写
			"工作: 重点", // 冒号 → JSON.stringify
			"带\"引号'的", // 引号
			"  首尾空白  ", // yamlQuote 会因首尾空白加引号，trim 后解析取值
		]) {
			const input = bookInput({ doc: doc({ category }) });
			const text = serializeBookMd(input);
			// 行位置：title 之后、file_path 之前
			const lines = text.split("\n");
			expect(lines.indexOf("title: 书籍A") + 1).toBe(
				lines.findIndex((l) => l.startsWith("category: ")),
			);
			const parsed = parseBookMd(text, { fileName: "书籍A.md" });
			expect(parsed.doc.category).toBe(category.trim());
			expect(parsed.extraFrontmatter).toEqual([]); // 已知字段认领，不入 extra
			// 首回合可能归一（trim），归一后二次起字节稳定
			const text2 = serializeBookMd({
				...input,
				doc: parsed.doc,
				cards: parsed.cards,
				reviews: parsed.reviews,
				bookmarks: parsed.bookmarks,
				links: parsed.links,
			});
			const parsed2 = parseBookMd(text2, { fileName: "书籍A.md" });
			expect(
				serializeBookMd({
					...input,
					doc: parsed2.doc,
					cards: parsed2.cards,
					reviews: parsed2.reviews,
					bookmarks: parsed2.bookmarks,
					links: parsed2.links,
				}),
			).toBe(text2);
		}
	});
	it("分类为 null 不输出行（㉟ 零写契约：存量库序列化字节不变）", () => {
		const text = serializeBookMd(bookInput({ doc: doc({ category: null }) }));
		expect(text).not.toContain("category:");
		// 手编文件里的空值分类（category: 后空白）解析归未分类
		const handEdited = text.replace("title: 书籍A", "title: 书籍A\ncategory: ");
		const parsed = parseBookMd(handEdited, { fileName: "书籍A.md" });
		expect(parsed.doc.category).toBeNull();
	});
	it("用户手加 category 行被解析认领（㉟：KNOWN key 而非 extraFrontmatter）", () => {
		const base = serializeBookMd(bookInput());
		const hand = base.replace("title: 书籍A", "title: 书籍A\ncategory: 手编分类");
		const parsed = parseBookMd(hand, { fileName: "书籍A.md" });
		expect(parsed.doc.category).toBe("手编分类");
		expect(parsed.extraFrontmatter).toEqual([]);
	});
	it("摘录目标覆盖 collect_map_id 往返（㊴）：有值序列化在 category 后，null 省略整行", () => {
		// null：不输出行——存量库（字段引入前）序列化字节不变，零写入契约
		const textNull = serializeBookMd(bookInput({ doc: doc({ collectMapId: null }) }));
		expect(textNull).not.toContain("collect_map_id");

		// 有值：category 之后、file_path 之前；往返还原
		const mapId = "mm222222-3333-4333-8333-333333333333";
		const text = serializeBookMd(bookInput({ doc: doc({ collectMapId: mapId }) }));
		const lines = text.split("\n");
		const catIdx = lines.findIndex((l) => l.startsWith("category: "));
		const cmIdx = lines.findIndex((l) => l.startsWith("collect_map_id: "));
		if (catIdx >= 0) {
			expect(catIdx + 1).toBe(cmIdx); // category 紧前
		} else {
			expect(lines.indexOf("title: 书籍A") + 1).toBe(cmIdx); // 无 category 时贴 title
		}
		const parsed = parseBookMd(text, { fileName: "书籍A.md" });
		expect(parsed.doc.collectMapId).toBe(mapId);
		expect(parsed.extraFrontmatter).toEqual([]); // 已知字段认领

		// 手编空值（collect_map_id: 后空白）解析归 null = 回默认同名图
		const handEmpty = textNull.replace("title: 书籍A", "title: 书籍A\ncollect_map_id: ");
		expect(parseBookMd(handEmpty, { fileName: "书籍A.md" }).doc.collectMapId).toBeNull();
	});
	it("七种形态卡片 + 书签往返：解析还原数据，二次序列化字节相同", () => {
		// 构造顺序 = 序列化顺序（页升序 → 页内按 createdAt），保证 toEqual 直比成立
		const cards: Card[] = [
			card({
				id: "aaaaaaaa-0000-4000-8000-000000000001",
				excerptType: "text",
				excerptText: "第一行文字\n第二行文字",
				rects: [
					{ x: 0.1, y: 0.2, w: 0.5, h: 0.03 },
					{ x: 0.1, y: 0.25, w: 0.4, h: 0.03 },
				],
				color: "purple",
				createdAt: 1700000001000,
			}),
			card({
				id: "aaaaaaaa-0000-4000-8000-000000000004",
				excerptType: "blank",
				note: "这里是批注\n第二行批注",
				tags: ["概念", "重点"],
				rects: [{ x: 0.5, y: 0.5, w: 0.006, h: 0.006 }],
				createdAt: 1700000001500,
			}),
			card({
				id: "aaaaaaaa-0000-4000-8000-000000000005",
				excerptType: "handwriting",
				excerptRef: "assets/hw1.png",
				note: "手写批注",
				createdAt: 1700000002000,
			}),
			card({
				id: "aaaaaaaa-0000-4000-8000-000000000003",
				excerptType: "lasso",
				page: 12,
				polygon: [
					{ x: 0.2, y: 0.3 },
					{ x: 0.5, y: 0.31 },
					{ x: 0.45, y: 0.6 },
				],
				rects: [{ x: 0.2, y: 0.3, w: 0.3, h: 0.3 }],
				createdAt: 1700000002500,
			}),
			card({
				id: "aaaaaaaa-0000-4000-8000-000000000002",
				excerptType: "area",
				page: 12,
				excerptRef: "assets/area1.png",
				rects: [{ x: 0.2, y: 0.3, w: 0.4, h: 0.2 }],
				createdAt: 1700000003000,
			}),
			card({
				id: "aaaaaaaa-0000-4000-8000-000000000006",
				excerptType: "audio",
				page: null,
				excerptRef: "assets/audio1.webm",
				createdAt: 1700000003500,
			}),
			card({
				id: "aaaaaaaa-0000-4000-8000-000000000007",
				excerptType: "photo",
				page: null,
				excerptRef: "assets/photo1.png",
				createdAt: 1700000004000,
			}),
		];
		const reviews = new Map<string, ReviewState>([
			[
				"aaaaaaaa-0000-4000-8000-000000000001",
				review("aaaaaaaa-0000-4000-8000-000000000001", {
					isFlashcard: true,
					phase: "review",
					ease: 2.3,
					intervalDays: 6,
					repetitions: 2,
					dueAt: 1700099999999,
					lastReviewedAt: 1700000099999,
					lapses: 1,
				}),
			],
		]);
		const bookmarks: DocumentBookmark[] = [
			{
				id: "bbbbbbbb-0000-4000-8000-000000000001",
				documentId: doc().id,
				page: 3,
				label: "引言",
				createdAt: 1700000005000,
			},
			{
				id: "bbbbbbbb-0000-4000-8000-000000000002",
				documentId: doc().id,
				page: 12,
				label: "第 12 页",
				createdAt: 1700000006000,
			},
		];
		const text = serializeBookMd(bookInput({ cards, reviews, bookmarks }));

		// 结构快照：分节顺序（3 → 12 → 未分组）与书签节
		expect(text.indexOf("## 第 3 页")).toBeLessThan(text.indexOf("## 第 12 页"));
		expect(text.indexOf("## 第 12 页")).toBeLessThan(text.indexOf("## 未分组"));
		expect(text.indexOf("## 未分组")).toBeLessThan(text.indexOf("## 📑 书签"));
		// callout 与块锚点、机器注释的骨架
		expect(text).toContain("> [!excerpt]\n> 第一行文字\n> 第二行文字");
		expect(text).toContain(`^card-aaaaaaaa-0000-4000-8000-000000000001`);
		expect(text).toContain("> ![](assets/area1.png)");
		expect(text).toContain("> **批注**：这里是批注\n> 第二行批注");
		expect(text).toContain("> #概念 #重点");
		expect(text).toContain("- 引言（第 3 页）");
		expect(text).toContain("- 第 12 页"); // 默认名书签不重复追加页码后缀

		const parsed = parseBookMd(text, { fileName: "书籍A.md" });
		expect(parsed.warnings).toEqual([]);
		expect(parsed.doc).toEqual(doc());
		expect(parsed.cards).toEqual(cards);
		const parsedReviews = new Map(parsed.reviews.map((r) => [r.cardId, r]));
		for (const [id, expected] of reviews) {
			expect(parsedReviews.get(id)).toEqual(expected);
		}
		for (const c of cards) {
			if (!reviews.has(c.id)) {
				expect(parsedReviews.get(c.id)).toEqual(defaultReviewState(c.id, c.createdAt));
			}
		}
		expect(parsed.bookmarks).toEqual(bookmarks);

		// 二次序列化字节相同（确定性）
		const again = serializeBookMd({
			doc: parsed.doc,
			cards: parsed.cards,
			reviews: new Map(parsed.reviews.map((r) => [r.cardId, r])),
			bookmarks: parsed.bookmarks,
			links: parsed.links,
			extraFrontmatter: parsed.extraFrontmatter,
		});
		expect(again).toBe(text);
	});

	it("138 blue 原样透传（㊹ 误归一 blue→yellow 已移除：蓝卡重开不再变黄，往返字节不变）", () => {
		const c = card({
			id: "aaaaaaaa-0000-4000-8000-000000000001",
			excerptType: "text",
			excerptText: "蓝文字卡",
			color: "blue",
			rects: [{ x: 0.1, y: 0.2, w: 0.5, h: 0.03 }],
		});
		const text = serializeBookMd(bookInput({ cards: [c] }));
		expect(text).toContain(`"color":"blue"`);
		const parsed = parseBookMd(text, { fileName: "书籍A.md" });
		// 读取不归一：存量蓝卡（文字摘录历史值）与新建蓝卡一视同仁保持 blue
		expect(parsed.cards[0].color).toBe("blue");
		// 再序列化仍落 blue（打开不落盘契约——未变更不重写，字节稳定）
		const again = serializeBookMd(bookInput({ cards: parsed.cards }));
		expect(again).toContain(`"color":"blue"`);
		// 其他颜色值透传不受影响
		const keep = card({
			id: "aaaaaaaa-0000-4000-8000-000000000002",
			excerptType: "text",
			excerptText: "旧紫卡",
			color: "purple",
			rects: [{ x: 0.1, y: 0.25, w: 0.5, h: 0.03 }],
		});
		const parsed2 = parseBookMd(serializeBookMd(bookInput({ cards: [keep] })), {
			fileName: "书籍A.md",
		});
		expect(parsed2.cards[0].color).toBe("purple");
	});

	it("链接只存于持有方（较小 id 一侧），解析重建规范化链接", () => {
		const a = card({
			id: "aaaaaaaa-0000-4000-8000-000000000001",
			excerptType: "text",
			excerptText: "A",
		});
		const b = card({
			id: "bbbbbbbb-0000-4000-8000-000000000002",
			excerptType: "text",
			excerptText: "B",
		});
		const foreign = "ffffffff-0000-4000-8000-000000000009"; // 另一本书里的卡
		const links: CardLink[] = [
			{ id: linkId(a.id, b.id), sourceId: b.id, targetId: a.id, createdAt: 1700000009000 },
			{
				id: linkId(a.id, foreign),
				sourceId: a.id,
				targetId: foreign,
				createdAt: 1700000010000,
			},
		];
		const text = serializeBookMd(bookInput({ cards: [a, b], links }));
		// 链接只出现在 a（较小 id）的机器注释里（按注释首 token 定位行，避免 to 字段误中）
		const commentOf = (id: string) =>
			text.split("\n").find((l) => l.startsWith("<!--mm ") && l.includes(`"id":"${id}"`))!;
		expect(commentOf(a.id)).toContain(
			`"links":[{"to":"${b.id}","at":1700000009000},{"to":"${foreign}","at":1700000010000}]`,
		);
		expect(commentOf(b.id)).not.toContain("links");

		const parsed = parseBookMd(text, { fileName: "书籍A.md" });
		expect(parsed.links).toHaveLength(2);
		expect(parsed.links[0]).toEqual({
			id: linkId(a.id, b.id),
			sourceId: a.id,
			targetId: b.id,
			createdAt: 1700000009000,
		});
		expect(parsed.links[1]).toEqual({
			id: linkId(a.id, foreign),
			sourceId: a.id,
			targetId: foreign,
			createdAt: 1700000010000,
		});
	});

	it("按书自动转闪卡 auto_flashcard 往返（㊷）：true 序列化在 collect_map_id 后，false 省略整行", () => {
		// false（默认）：不输出行——存量库（字段引入前）序列化字节不变，零写入契约
		const textOff = serializeBookMd(bookInput({ doc: doc({ autoFlashcard: false }) }));
		expect(textOff).not.toContain("auto_flashcard");

		// true：collect_map_id 之后；往返还原
		const textOn = serializeBookMd(bookInput({ doc: doc({ autoFlashcard: true }) }));
		const lines = textOn.split("\n");
		const cmIdx = lines.findIndex((l) => l.startsWith("collect_map_id: "));
		const afIdx = lines.findIndex((l) => l.startsWith("auto_flashcard: "));
		expect(afIdx).toBeGreaterThan(0);
		if (cmIdx >= 0) {
			expect(cmIdx + 1).toBe(afIdx); // collect_map_id 紧前
		} else {
			// 无 collect_map_id 时贴 category（或 title）
			const catIdx = lines.findIndex((l) => l.startsWith("category: "));
			const anchor = catIdx >= 0 ? catIdx : lines.indexOf("title: 书籍A");
			expect(anchor + 1).toBe(afIdx);
		}
		expect(lines[afIdx]).toBe("auto_flashcard: true");
		const parsed = parseBookMd(textOn, { fileName: "书籍A.md" });
		expect(parsed.doc.autoFlashcard).toBe(true);
		expect(parsed.extraFrontmatter).toEqual([]); // 已知字段认领
	});

	it("上次阅读页码 last_page 往返（80）：非 null 序列化在 auto_flashcard 后，null 省略整行", () => {
		// null（默认/页 1 归一）：不输出行——未翻页的存量书序列化字节不变，零写入契约
		const textNull = serializeBookMd(bookInput({ doc: doc({ lastPage: null }) }));
		expect(textNull).not.toContain("last_page");

		// 非 null：file_path 之前；往返还原
		const textOn = serializeBookMd(bookInput({ doc: doc({ lastPage: 7 }) }));
		const lines = textOn.split("\n");
		const lpIdx = lines.findIndex((l) => l.startsWith("last_page: "));
		expect(lpIdx).toBeGreaterThan(0);
		expect(lines[lpIdx]).toBe("last_page: 7");
		// 键序紧邻：auto_flashcard（缺省省行时跳过）之后、file_path 之前
		const fpIdx = lines.findIndex((l) => l.startsWith("file_path: "));
		expect(lpIdx).toBeLessThan(fpIdx);
		const afIdx = lines.findIndex((l) => l.startsWith("auto_flashcard: "));
		expect(afIdx).toBeLessThan(0); // 本输入 autoFlashcard=false 省行
		const parsed = parseBookMd(textOn, { fileName: "书籍A.md" });
		expect(parsed.doc.lastPage).toBe(7);
		expect(parsed.extraFrontmatter).toEqual([]); // last_page 已知字段认领，不进未知区
	});

	it("手编非法 last_page 解析归一 null（80）：非数字/0/负数/1（页 1 语义即未翻页）", () => {
		for (const bad of ["abc", "0", "-3", "1", "2.5"]) {
			const text = [
				"---",
				"marinmind: book",
				`id: ${doc().id}`,
				"title: 书籍A",
				`last_page: ${bad}`,
				"file_path: 阅读/书籍A.pdf",
				"created_at: 1700000000000",
				"updated_at: 1700000100000",
				"---",
				"",
			].join("\n");
			const parsed = parseBookMd(text, { fileName: "书籍A.md" });
			// 2.5 向下取整为 2 其余归 null（页 1 不落行，读侧同样归一）
			expect(parsed.doc.lastPage, `last_page: ${bad}`).toBe(bad === "2.5" ? 2 : null);
		}
	});

	it("遮挡 occlusions 机器层往返（㊷）：occ 键还原，无遮挡卡不输出该键（零写入）", () => {
		const plain = card({
			id: "aaaaaaaa-0000-4000-8000-000000000001",
			excerptType: "text",
			excerptText: "无遮挡",
		});
		const occluded = card({
			id: "aaaaaaaa-0000-4000-8000-000000000002",
			excerptType: "area",
			excerptRef: "assets/area1.png",
			rects: [{ x: 0.2, y: 0.3, w: 0.4, h: 0.2 }],
			occlusions: [
				{ x: 0.22, y: 0.32, w: 0.1, h: 0.06 },
				{ x: 0.35, y: 0.4, w: 0.15, h: 0.05 },
			],
		});
		const text = serializeBookMd(bookInput({ cards: [plain, occluded] }));
		// 零写入：无遮挡卡的机器注释不含 occ 键
		const commentOf = (id: string) =>
			text.split("\n").find((l) => l.startsWith("<!--mm ") && l.includes(`"id":"${id}"`))!;
		expect(commentOf(plain.id)).not.toContain("occ");
		expect(commentOf(occluded.id)).toContain(
			`"occ":[{"x":0.22,"y":0.32,"w":0.1,"h":0.06},{"x":0.35,"y":0.4,"w":0.15,"h":0.05}]`,
		);

		const parsed = parseBookMd(text, { fileName: "书籍A.md" });
		expect(parsed.warnings).toEqual([]);
		expect(parsed.cards.find((c) => c.id === occluded.id)!.occlusions).toEqual(
			occluded.occlusions,
		);
		expect(parsed.cards.find((c) => c.id === plain.id)!.occlusions).toEqual([]); // 缺键回填默认

		// 二次序列化字节相同（确定性）
		const again = serializeBookMd({
			doc: parsed.doc,
			cards: parsed.cards,
			reviews: new Map(parsed.reviews.map((r) => [r.cardId, r])),
			bookmarks: parsed.bookmarks,
			links: parsed.links,
			extraFrontmatter: parsed.extraFrontmatter,
		});
		expect(again).toBe(text);
	});

	it("标题 title 机器层往返（㊺）：title 键还原，无标题卡不输出该键（零写入）", () => {
		const plain = card({
			id: "aaaaaaaa-0000-4000-8000-000000000003",
			excerptType: "text",
			excerptText: "无标题",
		});
		const titled = card({
			id: "aaaaaaaa-0000-4000-8000-000000000004",
			excerptType: "text",
			excerptText: "摘录原文",
			title: "我的标题",
		});
		const text = serializeBookMd(bookInput({ cards: [plain, titled] }));
		// 零写入：无标题卡的机器注释不含 title 键（存量卡字节不变）
		const commentOf = (id: string) =>
			text.split("\n").find((l) => l.startsWith("<!--mm ") && l.includes(`"id":"${id}"`))!;
		expect(commentOf(plain.id)).not.toContain('"title"');
		expect(commentOf(titled.id)).toContain('"title":"我的标题"');

		const parsed = parseBookMd(text, { fileName: "书籍A.md" });
		expect(parsed.warnings).toEqual([]);
		expect(parsed.cards.find((c) => c.id === titled.id)!.title).toBe("我的标题");
		expect(parsed.cards.find((c) => c.id === plain.id)!.title).toBeNull(); // 缺键回填 null
		// 损坏值（非字符串）按无标题处理不拖垮整卡
		const broken = text.replace('"title":"我的标题"', '"title":123');
		expect(
			parseBookMd(broken, { fileName: "书籍A.md" }).cards.find((c) => c.id === titled.id)!
				.title,
		).toBeNull();

		// 二次序列化字节相同（确定性）
		const again = serializeBookMd({
			doc: parsed.doc,
			cards: parsed.cards,
			reviews: new Map(parsed.reviews.map((r) => [r.cardId, r])),
			bookmarks: parsed.bookmarks,
			links: parsed.links,
			extraFrontmatter: parsed.extraFrontmatter,
		});
		expect(again).toBe(text);
	});

	it("卡组 deck 机器层往返：deck 键还原（title 之后），未分组卡不输出该键（零写入）", () => {
		const plain = card({
			id: "aaaaaaaa-0000-4000-8000-000000000005",
			excerptType: "text",
			excerptText: "未分组",
		});
		const decked = card({
			id: "aaaaaaaa-0000-4000-8000-000000000006",
			excerptType: "text",
			excerptText: "摘录原文",
			title: "我的标题",
			deck: "考研单词",
		});
		const text = serializeBookMd(bookInput({ cards: [plain, decked] }));
		// 零写入：未分组卡的机器注释不含 deck 键（存量卡字节不变）
		const commentOf = (id: string) =>
			text.split("\n").find((l) => l.startsWith("<!--mm ") && l.includes(`"id":"${id}"`))!;
		expect(commentOf(plain.id)).not.toContain('"deck"');
		// 键序：deck 在 title 之后（确定性）
		expect(commentOf(decked.id)).toContain('"title":"我的标题","deck":"考研单词"');

		const parsed = parseBookMd(text, { fileName: "书籍A.md" });
		expect(parsed.warnings).toEqual([]);
		expect(parsed.cards.find((c) => c.id === decked.id)!.deck).toBe("考研单词");
		expect(parsed.cards.find((c) => c.id === plain.id)!.deck).toBeNull(); // 缺键回填 null
		// 损坏值（非字符串）按未分组处理不拖垮整卡
		const broken = text.replace('"deck":"考研单词"', '"deck":123');
		expect(
			parseBookMd(broken, { fileName: "书籍A.md" }).cards.find((c) => c.id === decked.id)!
				.deck,
		).toBeNull();

		// 二次序列化字节相同（确定性）
		const again = serializeBookMd({
			doc: parsed.doc,
			cards: parsed.cards,
			reviews: new Map(parsed.reviews.map((r) => [r.cardId, r])),
			bookmarks: parsed.bookmarks,
			links: parsed.links,
			extraFrontmatter: parsed.extraFrontmatter,
		});
		expect(again).toBe(text);
	});

	it("文字摘录线型 line 机器层往返（77）：squiggle/strikethrough 才落键（deck 之后），缺省/underline 省键（零写入）", () => {
		const plain = card({
			id: "aaaaaaaa-0000-4000-8000-000000000015",
			excerptType: "text",
			excerptText: "默认下划线",
		});
		const squiggled = card({
			id: "aaaaaaaa-0000-4000-8000-000000000016",
			excerptType: "text",
			excerptText: "波浪线摘录",
			title: "我的标题",
			deck: "考研单词",
			lineStyle: "squiggle",
		});
		const text = serializeBookMd(bookInput({ cards: [plain, squiggled] }));
		const commentOf = (id: string) =>
			text.split("\n").find((l) => l.startsWith("<!--mm ") && l.includes(`"id":"${id}"`))!;
		// 零写入：默认（null=下划线）卡的机器注释不含 line 键（存量卡字节不变）
		expect(commentOf(plain.id)).not.toContain('"line"');
		// 键序：line 在 deck 之后（确定性）
		expect(commentOf(squiggled.id)).toContain('"deck":"考研单词","line":"squiggle"');

		const parsed = parseBookMd(text, { fileName: "书籍A.md" });
		expect(parsed.warnings).toEqual([]);
		expect(parsed.cards.find((c) => c.id === squiggled.id)!.lineStyle).toBe("squiggle");
		expect(parsed.cards.find((c) => c.id === plain.id)!.lineStyle).toBeNull(); // 缺键回填 null
		// 损坏值（非字符串）与非法值（不在名单）均按 null 处理不拖垮整卡
		const broken = text.replace('"line":"squiggle"', '"line":123');
		expect(
			parseBookMd(broken, { fileName: "书籍A.md" }).cards.find((c) => c.id === squiggled.id)!
				.lineStyle,
		).toBeNull();
		const bogus = text.replace('"line":"squiggle"', '"line":"wavy"');
		expect(
			parseBookMd(bogus, { fileName: "书籍A.md" }).cards.find((c) => c.id === squiggled.id)!
				.lineStyle,
		).toBeNull();
		// 手编 underline 归一 null（与序列化省键首尾一致——内存规范形无 underline 值）
		const handWritten = text.replace('"line":"squiggle"', '"line":"underline"');
		const normalized = parseBookMd(handWritten, { fileName: "书籍A.md" });
		expect(normalized.cards.find((c) => c.id === squiggled.id)!.lineStyle).toBeNull();
		// 归一后再序列化 line 键消失（字节收敛）
		const renormalized = serializeBookMd({
			doc: normalized.doc,
			cards: normalized.cards,
			reviews: new Map(normalized.reviews.map((r) => [r.cardId, r])),
			bookmarks: normalized.bookmarks,
			links: normalized.links,
			extraFrontmatter: normalized.extraFrontmatter,
		});
		expect(renormalized).not.toContain('"line"');

		// 二次序列化字节相同（确定性）
		const again = serializeBookMd({
			doc: parsed.doc,
			cards: parsed.cards,
			reviews: new Map(parsed.reviews.map((r) => [r.cardId, r])),
			bookmarks: parsed.bookmarks,
			links: parsed.links,
			extraFrontmatter: parsed.extraFrontmatter,
		});
		expect(again).toBe(text);
	});

	it("目录章节骨架 outline 机器层往返（55）：occ 后 outline:true 键还原，普通卡不输出该键（零写入）", () => {
		const plain = card({
			id: "aaaaaaaa-0000-4000-8000-000000000007",
			excerptType: "text",
			excerptText: "普通摘录",
		});
		const chapter = card({
			id: "aaaaaaaa-0000-4000-8000-000000000008",
			excerptType: "text",
			excerptText: "第一章",
			title: "第一章",
			page: 1,
			outline: true,
		});
		const text = serializeBookMd(bookInput({ cards: [plain, chapter] }));
		// 零写入：普通卡（含 outline: false）的机器注释不含 outline 键
		const commentOf = (id: string) =>
			text.split("\n").find((l) => l.startsWith("<!--mm ") && l.includes(`"id":"${id}"`))!;
		expect(commentOf(plain.id)).not.toContain('"outline"');
		expect(commentOf(chapter.id)).toContain('"outline":true');

		const parsed = parseBookMd(text, { fileName: "书籍A.md" });
		expect(parsed.warnings).toEqual([]);
		expect(parsed.cards.find((c) => c.id === chapter.id)!.outline).toBe(true);
		expect(parsed.cards.find((c) => c.id === plain.id)!.outline).toBeFalsy(); // 缺键 = 普通卡
		// 损坏值（非 true）按普通卡处理不拖垮整卡
		const broken = text.replace('"outline":true', '"outline":"yes"');
		expect(
			parseBookMd(broken, { fileName: "书籍A.md" }).cards.find((c) => c.id === chapter.id)!
				.outline,
		).toBeFalsy();

		// 二次序列化字节相同（确定性）
		const again = serializeBookMd({
			doc: parsed.doc,
			cards: parsed.cards,
			reviews: new Map(parsed.reviews.map((r) => [r.cardId, r])),
			bookmarks: parsed.bookmarks,
			links: parsed.links,
			extraFrontmatter: parsed.extraFrontmatter,
		});
		expect(again).toBe(text);
	});

	it("书名分组卡 group 机器层往返与存量推导（81）：outline 后 group:true 键，普通卡不输出（零写入）", () => {
		const plain = card({
			id: "aaaaaaaa-0000-4000-8000-000000000017",
			excerptType: "text",
			excerptText: "普通摘录",
		});
		const group = card({
			id: "aaaaaaaa-0000-4000-8000-000000000018",
			excerptType: "text",
			page: null,
			excerptText: "《书籍A》",
			group: true,
		});
		const text = serializeBookMd(bookInput({ cards: [plain, group] }));
		// 零写入：普通卡的机器注释不含 group 键（存量卡字节不变）
		const commentOf = (id: string) =>
			text.split("\n").find((l) => l.startsWith("<!--mm ") && l.includes(`"id":"${id}"`))!;
		expect(commentOf(plain.id)).not.toContain('"group"');
		expect(commentOf(group.id)).toContain('"group":true');

		const parsed = parseBookMd(text, { fileName: "书籍A.md" });
		expect(parsed.warnings).toEqual([]);
		expect(parsed.cards.find((c) => c.id === group.id)!.group).toBe(true);
		expect(parsed.cards.find((c) => c.id === plain.id)!.group).toBeFalsy(); // 缺键 = 普通卡

		// 存量推导：旧库组卡文件无 group 键，解析层按「page null + 文本恰为《书名》」
		// 识别（读取只在内存，不标脏；下次自然写入补齐 group 键）
		const legacy = text.replace('"group":true,', "");
		const parsedLegacy = parseBookMd(legacy, { fileName: "书籍A.md" });
		expect(parsedLegacy.cards.find((c) => c.id === group.id)!.group).toBe(true);
		const rewritten = serializeBookMd({
			doc: parsedLegacy.doc,
			cards: parsedLegacy.cards,
			reviews: new Map(parsedLegacy.reviews.map((r) => [r.cardId, r])),
			bookmarks: parsedLegacy.bookmarks,
			links: parsedLegacy.links,
			extraFrontmatter: parsedLegacy.extraFrontmatter,
		});
		expect(rewritten).toContain('"group":true'); // 推导标记随下次写入持久化

		// EPUB 型 page null 文本摘录（文本非《书名》）不误标
		const epub = card({
			id: "aaaaaaaa-0000-4000-8000-000000000019",
			excerptType: "text",
			page: null,
			excerptText: "跨章文字摘录",
		});
		const parsedEpub = parseBookMd(serializeBookMd(bookInput({ cards: [epub] })), {
			fileName: "书籍A.md",
		});
		expect(parsedEpub.cards[0]!.group).toBeFalsy();

		// 损坏值（非 true）不拖垮整卡——组卡形态（page null + 《书名》）由推导兜底仍识别
		const broken = text.replace('"group":true', '"group":"yes"');
		expect(
			parseBookMd(broken, { fileName: "书籍A.md" }).cards.find((c) => c.id === group.id)!
				.group,
		).toBe(true);
	});
});

describe("book-format 手编回灌（可读层提取规则）", () => {
	function baseText(): string {
		const c1 = card({
			id: "aaaaaaaa-0000-4000-8000-000000000001",
			excerptType: "text",
			excerptText: "原文内容",
		});
		const c2 = card({
			id: "aaaaaaaa-0000-4000-8000-000000000002",
			excerptType: "photo",
			page: 5,
			excerptRef: "assets/photo1.png",
		});
		return serializeBookMd(bookInput({ cards: [c1, c2] }));
	}

	it("直接改正文与批注，解析采纳新值", () => {
		const text = baseText()
			.replace("> 原文内容", "> 用户改过的内容")
			.replace("> ![](assets/photo1.png)", "> ![](assets/photo1.png)\n> 附加说明文字");
		const parsed = parseBookMd(text, { fileName: "书籍A.md" });
		expect(parsed.cards[0].excerptText).toBe("用户改过的内容");
		// photo 卡正文追加了文字：嵌入行照常跳过，附加行进 excerptText
		expect(parsed.cards[1].excerptText).toBe("附加说明文字");
	});

	it("删除嵌入行不丢 ref（机器层权威）", () => {
		const text = baseText().replace("> ![](assets/photo1.png)\n", "");
		const parsed = parseBookMd(text, { fileName: "书籍A.md" });
		expect(parsed.cards[1].excerptRef).toBe("assets/photo1.png");
		expect(parsed.cards[1].excerptText).toBeNull();
	});

	it("把卡片移到另一页节，页码跟随节标题", () => {
		const parsed = parseBookMd(moveCardBlock(baseText(), 5, 3), { fileName: "书籍A.md" });
		expect(parsed.cards.find((c) => c.excerptType === "photo")?.page).toBe(3);
		expect(parsed.cards.find((c) => c.excerptType === "text")?.page).toBe(3);
	});
});

/** 把第 from 页节里的卡区块文本搬到第 to 页节（模拟用户剪切粘贴 callout 块） */
function moveCardBlock(text: string, from: number, to: number): string {
	const lines = text.split("\n");
	const fromIdx = lines.indexOf(`## 第 ${from} 页`);
	const toIdx = lines.indexOf(`## 第 ${to} 页`);
	if (fromIdx < 0 || toIdx < 0) throw new Error("节不存在");
	// 找该节内的第一个卡片块（callout 起始行到机器注释行）
	const calloutIdx = lines.findIndex((l, i) => i > fromIdx && l === "> [!excerpt]");
	const commentIdx = lines.findIndex((l, i) => i > calloutIdx && l.startsWith("<!--mm "));
	const block = lines.splice(calloutIdx, commentIdx - calloutIdx + 1);
	// 插到目标节标题后（重算 toIdx 因 splice 已变）
	const insertAt = lines.indexOf(`## 第 ${to} 页`) + 1;
	lines.splice(insertAt, 0, "", ...block);
	return lines.join("\n");
}

describe("book-format 容错", () => {
	function twoCardText(): string {
		const cards = [
			card({
				id: "aaaaaaaa-0000-4000-8000-000000000001",
				excerptType: "text",
				excerptText: "好卡",
			}),
			card({
				id: "aaaaaaaa-0000-4000-8000-000000000002",
				excerptType: "text",
				excerptText: "坏卡",
			}),
		];
		return serializeBookMd(bookInput({ cards }));
	}

	it("单条机器注释损坏：跳过该卡记 warning，其余照常", () => {
		const text = twoCardText().replace(
			/<!--mm \{"id":"aaaaaaaa-0000-4000-8000-000000000002[^>]*-->/,
			"<!--mm {oops -->",
		);
		const parsed = parseBookMd(text, { fileName: "书籍A.md" });
		expect(parsed.cards).toHaveLength(1);
		expect(parsed.cards[0].excerptText).toBe("好卡");
		expect(parsed.warnings.some((w) => w.includes("JSON 损坏"))).toBe(true);
	});

	it("缺块锚点行：卡片仍恢复（warning 提示）", () => {
		const text = twoCardText().replace(`^card-aaaaaaaa-0000-4000-8000-000000000002\n`, "");
		const parsed = parseBookMd(text, { fileName: "书籍A.md" });
		expect(parsed.cards).toHaveLength(2);
		expect(parsed.warnings.some((w) => w.includes("块锚点"))).toBe(true);
	});

	it("书签注释损坏：跳过记 warning", () => {
		const bm: DocumentBookmark = {
			id: "bbbbbbbb-0000-4000-8000-000000000001",
			documentId: doc().id,
			page: 2,
			label: "坏书签",
			createdAt: 1700000005000,
		};
		const text = serializeBookMd(bookInput({ bookmarks: [bm] })).replace(
			/<!--mm-bm \{[^>]*-->/,
			"<!--mm-bm broken -->",
		);
		const parsed = parseBookMd(text, { fileName: "书籍A.md" });
		expect(parsed.bookmarks).toHaveLength(0);
		expect(parsed.warnings.some((w) => w.includes("书签"))).toBe(true);
	});

	it("未知 frontmatter 字段往返保留（Obsidian aliases 不丢）", () => {
		const text = twoCardText().replace(
			"---\nmarinmind: book",
			"---\naliases: [书籍A, Book A]\nmarinmind: book",
		);
		const parsed = parseBookMd(text, { fileName: "书籍A.md" });
		expect(parsed.extraFrontmatter).toContain("aliases: [书籍A, Book A]");
		const again = serializeBookMd({
			doc: parsed.doc,
			cards: parsed.cards,
			reviews: new Map(parsed.reviews.map((r) => [r.cardId, r])),
			bookmarks: parsed.bookmarks,
			links: parsed.links,
			extraFrontmatter: parsed.extraFrontmatter,
		});
		expect(again).toContain("aliases: [书籍A, Book A]");
	});

	it("正文里的 # 开头行不被误吞为 tag（整行 tag 才算）", () => {
		const c = card({
			id: "aaaaaaaa-0000-4000-8000-000000000001",
			excerptType: "text",
			excerptText: "#1 排名第一\n普通行",
		});
		const parsed = parseBookMd(serializeBookMd(bookInput({ cards: [c] })), {
			fileName: "书籍A.md",
		});
		expect(parsed.cards[0].excerptText).toBe("#1 排名第一\n普通行");
		expect(parsed.cards[0].tags).toEqual([]);
	});

	it("非 book 文件（marinmind frontmatter 不符）按空书解析并警告", () => {
		const text = "---\nmarinmind: mindmap\n---\n\n## 第 1 页\n";
		const parsed = parseBookMd(text, { fileName: "x.md" });
		expect(parsed.cards).toEqual([]);
		expect(parsed.warnings.join()).toContain("book");
	});
});

describe("sanitizeFileName", () => {
	it("替换 Obsidian 非法与 wikilink 保留字符", () => {
		expect(sanitizeFileName('a/b\\c:d*e?f"g<h>i|j#k^l[m]n')).toBe(
			"a b c d e f g h i j k l m n",
		);
	});

	it("折叠空白、去首尾、限长 100", () => {
		expect(sanitizeFileName("  多   空格  ")).toBe("多 空格");
		expect(sanitizeFileName("x".repeat(150))).toHaveLength(100);
	});

	it("全非法时兜底未命名", () => {
		expect(sanitizeFileName("///")).toBe("未命名");
		expect(sanitizeFileName("   ")).toBe("未命名");
	});
});
