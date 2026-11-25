import assert from "node:assert/strict";
import { createRequire } from "node:module";
import * as path from "node:path";
import { test } from "node:test";

/**
 * The librarian's retrieval core. The property that matters most is the one the
 * learner asked for: what comes back is the slides' OWN text, never a summary.
 * That is structural here — an excerpt is cut out of the page — so it is
 * asserted as containment, not as a hope about wording.
 */
const require_ = createRequire(import.meta.url);
const librarian = require_(path.resolve("examples/plugins/study/dist/librarian.cjs")) as {
	DEFAULTS: { maxExcerpts: number; maxOutputChars: number };
	buildDeckIndex(input: unknown): { label: string; pages: { number: number; text: string }[]; imageOnlyPages: number[]; imageOnlyTrailing: number };
	fold(text: string): string;
	stem(token: string): string;
	pagesFromMarkdown(markdown: string): { number: number; text: string }[];
	search(input: unknown): { terms: string[]; hits: { deck: string; page: number; text: string }[]; truncated?: boolean };
	renderSearch(input: unknown): string;
	imageOnlyNote(decks: unknown): string;
};

const LECTURE = [
	"--- Page 1 ---",
	"",
	"Sistemi distribuiti — lezione 3: consenso",
	"",
	"--- Page 2 ---",
	"",
	"Un leader è eletto per un termine. Le elezioni usano timeout randomizzati, così due server",
	"difficilmente partono nello stesso istante e un voto diviso è improbabile.",
	"",
	"--- Page 5 ---",
	"",
	"Log replication: the leader appends each entry before followers apply it.",
	"Snapshotting keeps the log from growing without bound.",
].join("\n");

const index = (markdown = LECTURE, notices: string[] = []) => librarian.buildDeckIndex({
	label: "lecture-03.pdf", path: "/slides/lecture-03.pdf", size: 10, mtimeMs: 1, markdown, notices,
});

/** The excerpt, with the clipping marks the renderer adds taken back off. */
const core = (excerpt: string) => excerpt.replace(/…/g, "").trim();

test("page numbers come from the host's own markers, and only pages with text exist", () => {
	assert.deepEqual(librarian.pagesFromMarkdown(LECTURE).map(page => page.number), [1, 2, 5]);
	// A marker with nothing under it is not a page the librarian can answer for.
	assert.deepEqual(librarian.pagesFromMarkdown("--- Page 1 ---\n\n   \n\n--- Page 2 ---\n\nreal").map(page => page.number), [2]);
	assert.deepEqual(librarian.pagesFromMarkdown("no markers at all"), []);
});

test("image-only pages are named where the numbering betrays them, and counted where it cannot", () => {
	// Pages 3 and 4 are missing from the middle; the notice says 3 were skipped,
	// so exactly one of them sits past the last page with text.
	const deck = index(LECTURE, ["Skipped 3 image-only pages; OCR is not supported."]);
	assert.deepEqual(deck.imageOnlyPages, [3, 4]);
	assert.equal(deck.imageOnlyTrailing, 1);
	const note = librarian.imageOnlyNote([deck]);
	assert.match(note, /lecture-03\.pdf: pages 3, 4 and 1 more image page/);
	assert.match(note, /send ONE native `pdf` job/);
	// No notice means nothing was skipped beyond the gaps themselves.
	assert.equal(index(LECTURE, []).imageOnlyTrailing, 0);
	assert.equal(librarian.imageOnlyNote([index("--- Page 1 ---\n\nall text")]), "");
});

test("recall survives accents and Italian and English inflection", () => {
	assert.equal(librarian.fold("Perché È Così"), "perche e cosi");
	const pairs: [string, string][] = [["elezioni", "elezione"], ["libri", "libro"], ["studies", "study"], ["timeouts", "timeout"]];
	for (const [a, b] of pairs) {
		assert.equal(librarian.stem(librarian.fold(a)), librarian.stem(librarian.fold(b)), `${a} / ${b}`);
	}
	const decks = [index()];
	// The query is unaccented and singular; the slide is accented and plural.
	assert.deepEqual(librarian.search({ decks, terms: ["elezione"] }).hits.map(hit => hit.page), [2]);
	// English reaches the English page of the same deck.
	assert.deepEqual(librarian.search({ decks, terms: ["replication"] }).hits.map(hit => hit.page), [5]);
	// Several terms in one call, as the teacher is told it may pass.
	const both = librarian.search({ decks, terms: ["snapshotting", "voto diviso"] });
	assert.deepEqual(both.hits.map(hit => hit.page).sort(), [2, 5]);
});

test("every excerpt is a verbatim slice of the page it cites — the no-summary guarantee", () => {
	const deck = index();
	const byNumber = new Map(deck.pages.map(page => [page.number, page.text]));
	for (const terms of [["elezioni"], ["leader"], ["snapshotting"], ["consenso", "replication"]]) {
		const hits = librarian.search({ decks: [deck], terms }).hits;
		assert.ok(hits.length, `no hit for ${terms.join("+")}`);
		for (const hit of hits) {
			const page = byNumber.get(hit.page)!;
			assert.ok(page.includes(core(hit.text)), `"${hit.text}" is not a slice of page ${hit.page}`);
		}
	}
});

test("a verbatim match outranks one that only survives stemming", () => {
	const decks = [librarian.buildDeckIndex({
		label: "a.pdf", path: "/a.pdf", size: 1, mtimeMs: 1, notices: [],
		// p.1 carries the inflected form only; p.2 spells the query out verbatim.
		markdown: "--- Page 1 ---\n\nLe elezioni dei leader sono frequenti.\n\n--- Page 2 ---\n\nLa elezione del leader avviene per termine.",
	})];
	assert.equal(librarian.search({ decks, terms: ["elezione"] }).hits[0]!.page, 2);
});

test("one call is bounded in excerpts and in characters, however big the course", () => {
	const pages = Array.from({ length: 60 }, (_, i) =>
		`--- Page ${i + 1} ---\n\nconsenso ${"x".repeat(900)}`).join("\n\n");
	const decks = [librarian.buildDeckIndex({ label: "big.pdf", path: "/big.pdf", size: 1, mtimeMs: 1, markdown: pages, notices: [] })];
	const result = librarian.search({ decks, terms: ["consenso"] });
	assert.ok(result.hits.length <= librarian.DEFAULTS.maxExcerpts, `${result.hits.length} excerpts`);
	const total = result.hits.reduce((sum, hit) => sum + hit.text.length, 0);
	assert.ok(total <= librarian.DEFAULTS.maxOutputChars, `${total} characters`);
	const rendered = librarian.renderSearch({ course: "DISTSYS", decks, terms: ["consenso"] });
	assert.ok(rendered.length < 6000, `the whole reply is ${rendered.length} characters`);
});

test("nothing to search, nothing matched, and nothing asked are three different answers", () => {
	const decks = [index()];
	assert.match(librarian.renderSearch({ course: "DISTSYS", decks, terms: [] }), /Give at least one search term/);
	assert.match(librarian.renderSearch({ course: "DISTSYS", decks, terms: ["kubernetes"] }), /Nothing in the indexed slides/);
	assert.match(librarian.renderSearch({ course: "DISTSYS", decks: [], terms: ["consenso"], unindexed: ["lecture-03.pdf"] }),
		/Not indexed yet, so not searched: lecture-03\.pdf/);
	// A term that matched is never reported as a miss, and the reply says where it came from.
	const found = librarian.renderSearch({ course: "DISTSYS", decks, terms: ["elezioni"] });
	assert.match(found, /lecture-03\.pdf, p\. 2:/);
	// The excerpts are the teacher's source, not a script to read out.
	assert.match(found, /your SOURCE, not your script/);
	assert.match(found, /quote a short phrase only where the exact wording carries the meaning/);
});
