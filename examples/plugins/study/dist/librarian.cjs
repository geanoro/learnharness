"use strict";
/**
 * The librarian's index and search — pure functions, no IO, so the whole
 * retrieval behaviour is testable without a PDF, a server or a model.
 *
 * WHY A DETERMINISTIC SEARCH AND NOT A MODEL. The librarian must return the
 * slides' own words with a page reference, never a paraphrase. A ranked lexical
 * search cannot summarise: the excerpt it returns is a substring of the page.
 * That property is structural here, not an instruction a model might drift from,
 * and it costs no model call.
 *
 * WHERE THE PAGE TEXT COMES FROM. The host's own PDF conversion
 * (`ctx.documents.toMarkdown`, frontend-only) emits one `--- Page N ---` marker
 * per page with extractable text and omits image-only pages, reporting how many
 * it skipped in a notice. So page numbers are exact, and the pages this index
 * cannot hold are exactly the ones the native `pdf` job has to read instead.
 */

/** Longest first: the first matching rule wins, then one vowel pass. */
const SUFFIXES = ["amente", "mente", "ingly", "ing", "edly", "ed", "ies", "es", "s"];
const MIN_STEM = 4;

/** Ranking and output bounds. One call must never dump a deck into the lesson. */
const DEFAULTS = Object.freeze({
	maxExcerpts: 6,
	maxExcerptChars: 600,
	maxOutputChars: 3600,
	/** Window the excerpt is cut to before snapping to a line/sentence edge. */
	window: 420,
	/** A page whose raw text contains a query term verbatim outranks one that
	 *  only matches after stemming — the learner's exact phrase is the signal. */
	exactBonus: 1.5,
});

/**
 * Accent- and case-folding. The learner's decks may be Italian or English, and
 * "perché"/"perche" or "Consenso"/"consenso" must reach the same page.
 *
 * Returns the folded text AND a map from each folded character back to its
 * index in the raw string, because an excerpt is cut from the RAW text: NFD
 * decomposition is not length-preserving, so offsets cannot be reused blindly.
 */
function foldWithMap(raw) {
	const text = String(raw ?? "");
	let folded = "";
	const map = [];
	for (let index = 0; index < text.length; index++) {
		// Per character, so one raw index backs every folded character it produced.
		const piece = text[index].normalize("NFD").replace(/\p{M}+/gu, "").toLowerCase();
		for (const character of piece) { folded += character; map.push(index); }
	}
	return { folded, map };
}

const fold = raw => foldWithMap(raw).folded;

/**
 * Deliberately crude, recall-first stemming for Italian and English. It exists
 * so "elezioni" finds "elezione" and "studies" finds "study"; it is not a
 * linguistic analyser and will merge unrelated words. That is acceptable here:
 * a wrong merge adds a weakly scored page, while a miss hides a real slide.
 * `exactBonus` is what keeps precision — a verbatim hit always ranks higher.
 */
function stem(token) {
	let word = String(token ?? "");
	if (word.length <= MIN_STEM) return word;
	// Italian -zione/-zioni collapse to one stem rather than losing the ending.
	if (/zioni?$/.test(word)) return word.replace(/zioni?$/, "zion");
	for (const suffix of SUFFIXES) {
		if (word.endsWith(suffix) && word.length - suffix.length >= MIN_STEM) { word = word.slice(0, -suffix.length); break; }
	}
	// One trailing-vowel pass, for Italian inflection (libro/libri, casa/case)
	// and for English -y (study/studi -> stud).
	if (/[aeioy]$/.test(word) && word.length - 1 >= MIN_STEM) word = word.slice(0, -1);
	return word;
}

/** Folded alphanumeric runs. Digits are kept: slide numbers and years matter. */
function tokenize(text) {
	return fold(text).split(/[^\p{L}\p{N}]+/u).filter(Boolean);
}

const stems = text => tokenize(text).map(stem);

/** `--- Page N ---` sections, in the order and numbering the host emitted. */
function pagesFromMarkdown(markdown) {
	const text = String(markdown ?? "");
	const pages = [];
	const marker = /^--- Page (\d+) ---$/gm;
	let match = marker.exec(text);
	while (match) {
		const number = Number(match[1]);
		const start = match.index + match[0].length;
		const next = marker.exec(text);
		const body = text.slice(start, next ? next.index : text.length).trim();
		if (body) pages.push({ number, text: body });
		match = next;
	}
	return pages;
}

/** How many pages the converter skipped, from its own notice wording. */
function skippedFromNotices(notices) {
	for (const notice of notices ?? []) {
		const match = /Skipped (\d+) image-only/.exec(String(notice ?? ""));
		if (match) return Number(match[1]);
	}
	return 0;
}

/**
 * One deck's cache entry. `size`/`mtimeMs` are the staleness key: the backend
 * re-indexes when the file on disk no longer matches what was converted.
 *
 * Image-only pages carry no text and cannot be searched. Their NUMBERS are only
 * partly knowable: a gap in the emitted page numbers names one exactly, while
 * pages skipped after the last text page are a count without numbers. Both are
 * recorded, because the librarian has to tell the teacher which pages it cannot
 * answer for rather than let them read as absent.
 */
function buildDeckIndex({ label, path: file, size, mtimeMs, markdown, notices }) {
	const pages = pagesFromMarkdown(markdown);
	const numbers = pages.map(page => page.number);
	const highest = numbers.length ? Math.max(...numbers) : 0;
	const present = new Set(numbers);
	const gaps = [];
	for (let number = 1; number <= highest; number++) if (!present.has(number)) gaps.push(number);
	const skipped = skippedFromNotices(notices);
	return {
		label, path: file, size, mtimeMs,
		pages,
		imageOnlyPages: gaps,
		/** Skipped pages past the last text page: counted, never numbered. */
		imageOnlyTrailing: Math.max(0, skipped - gaps.length),
	};
}

/** Inverted index over the decks in scope. Rebuilt per call: it is cheap
 *  relative to reading the cache files, and keeps the search stateless. */
function postings(decks) {
	const index = new Map();
	const pages = [];
	for (const deck of decks) {
		for (const page of deck.pages ?? []) {
			const slot = pages.length;
			pages.push({ deck: deck.label, number: page.number, text: page.text });
			const counts = new Map();
			for (const token of stems(page.text)) counts.set(token, (counts.get(token) ?? 0) + 1);
			for (const [token, count] of counts) {
				if (!index.has(token)) index.set(token, new Map());
				index.get(token).set(slot, count);
			}
		}
	}
	return { index, pages };
}

/** Distinct, nonempty query terms, each kept with the stem it searches by. */
function queryTerms(terms) {
	const list = Array.isArray(terms) ? terms : [terms];
	const seen = new Set();
	const out = [];
	for (const value of list) {
		const raw = String(value ?? "").trim();
		if (!raw) continue;
		for (const token of tokenize(raw)) {
			const key = stem(token);
			if (!key || seen.has(key)) continue;
			seen.add(key);
			out.push({ raw: token, stem: key });
		}
	}
	return out;
}

/**
 * The excerpt: the densest window of the page's own text, cut from the RAW
 * string so accents and capitals survive, then snapped outward to a line or
 * sentence edge so it does not start mid-word.
 */
function excerpt(raw, terms, limits) {
	const bounds = { ...DEFAULTS, ...(limits ?? {}) };
	const { folded, map } = foldWithMap(raw);
	const hits = [];
	for (const term of terms) {
		let at = folded.indexOf(term.raw);
		while (at !== -1) { hits.push(at); at = folded.indexOf(term.raw, at + 1); }
	}
	if (!hits.length) {
		// Stem-only match: no verbatim position to centre on, so lead with the
		// page's opening, which on a slide is its title.
		return clip(raw.trim(), bounds.maxExcerptChars);
	}
	hits.sort((a, b) => a - b);
	let best = hits[0], bestCount = 0;
	for (const start of hits) {
		const count = hits.filter(hit => hit >= start && hit < start + bounds.window).length;
		if (count > bestCount) { bestCount = count; best = start; }
	}
	const from = Math.max(0, best - Math.floor(bounds.window / 4));
	const to = Math.min(folded.length, from + bounds.window);
	let start = map[from] ?? 0;
	let end = to >= map.length ? raw.length : map[to];
	// Snap outward to a line or sentence boundary, within a quarter-window.
	const slack = Math.floor(bounds.window / 4);
	const back = raw.lastIndexOf("\n", start);
	if (back !== -1 && start - back <= slack) start = back + 1;
	const forward = raw.indexOf("\n", end);
	if (forward !== -1 && forward - end <= slack) end = forward;
	const text = raw.slice(start, end).trim();
	return `${start > 0 ? "…" : ""}${clip(text, bounds.maxExcerptChars)}${end < raw.length ? "…" : ""}`;
}

function clip(text, limit) {
	const value = String(text ?? "");
	return value.length > limit ? `${value.slice(0, limit - 1).trimEnd()}…` : value;
}

/**
 * Rank the pages of `decks` against `terms` and return the top excerpts.
 * Scoring is tf-idf over stems plus a verbatim-match bonus; ties break by deck
 * label then page number so the same query always answers the same way.
 */
function search({ decks, terms, limits }) {
	const bounds = { ...DEFAULTS, ...(limits ?? {}) };
	const query = queryTerms(terms);
	if (!query.length) return { terms: [], hits: [], scanned: 0 };
	const { index, pages } = postings(decks ?? []);
	if (!pages.length) return { terms: query.map(term => term.raw), hits: [], scanned: 0 };
	const scores = new Map();
	for (const term of query) {
		const slots = index.get(term.stem);
		if (!slots) continue;
		const idf = Math.log(1 + pages.length / slots.size);
		for (const [slot, count] of slots) {
			scores.set(slot, (scores.get(slot) ?? 0) + (1 + Math.log(count)) * idf);
		}
	}
	// The verbatim bonus is scored against the page text, so it also rewards a
	// page that spells the term out without the stem ever matching.
	for (const [slot, page] of pages.entries()) {
		const folded = fold(page.text);
		let exact = 0;
		for (const term of query) if (folded.includes(term.raw)) exact += 1;
		if (exact) scores.set(slot, (scores.get(slot) ?? 0) + exact * bounds.exactBonus);
	}
	const ranked = [...scores.entries()]
		.filter(([, score]) => score > 0)
		.sort((a, b) => b[1] - a[1]
			|| pages[a[0]].deck.localeCompare(pages[b[0]].deck)
			|| pages[a[0]].number - pages[b[0]].number)
		.slice(0, bounds.maxExcerpts);
	const hits = [];
	let budget = bounds.maxOutputChars;
	for (const [slot, score] of ranked) {
		const page = pages[slot];
		const text = excerpt(page.text, query, bounds);
		if (budget - text.length < 0) break;
		budget -= text.length;
		hits.push({ deck: page.deck, page: page.number, score, text });
	}
	return { terms: query.map(term => term.raw), hits, scanned: pages.length, truncated: hits.length < ranked.length };
}

/** One sentence per deck about the pages this index cannot answer for. */
function imageOnlyNote(decks) {
	const parts = [];
	for (const deck of decks ?? []) {
		const numbered = (deck.imageOnlyPages ?? []).length
			? `page${deck.imageOnlyPages.length === 1 ? "" : "s"} ${deck.imageOnlyPages.join(", ")}`
			: "";
		const trailing = deck.imageOnlyTrailing ? `${deck.imageOnlyTrailing} more image page${deck.imageOnlyTrailing === 1 ? "" : "s"}` : "";
		const detail = [numbered, trailing].filter(Boolean).join(" and ");
		if (detail) parts.push(`${deck.label}: ${detail}`);
	}
	const cut = [];
	for (const deck of decks ?? []) {
		const pieces = [];
		if (deck.droppedPages) pieces.push(`${deck.droppedPages} page${deck.droppedPages === 1 ? "" : "s"} after the first ${(deck.pages ?? []).length} not indexed`);
		if (deck.clippedPages) pieces.push(`${deck.clippedPages} long page${deck.clippedPages === 1 ? "" : "s"} cut short`);
		if (pieces.length) cut.push(`${deck.label}: ${pieces.join(", ")}`);
	}
	const sentences = [];
	if (parts.length) {
		sentences.push(`Image-only slides carry no text and are NOT in this index — ${parts.join("; ")}. `
			+ "For those, send ONE native `pdf` job for that deck; do not report them as missing from the course.");
	}
	if (cut.length) {
		sentences.push(`Index limits left slide text out — ${cut.join("; ")}. `
			+ "For those, send ONE native `pdf` job for that deck; do not report them as missing from the course.");
	}
	return sentences.join(" ");
}

/** `course_library`'s answer: the slides' own words, with deck and page. */
function renderSearch({ course, decks, terms, limits, unindexed }) {
	const result = search({ decks, terms, limits });
	if (!result.terms.length) return "Give at least one search term.";
	const asked = result.terms.join(", ");
	const missing = (unindexed ?? []).length
		? `\n\nNot indexed yet, so not searched: ${unindexed.join(", ")}. `
			+ "Tell the learner to open the Study picker and press Index to include them."
		: "";
	if (!result.hits.length) {
		// Joined from the parts that exist: an absent image-only note must not
		// leave a blank line behind it.
		return [
			`Nothing in the indexed slides of "${course}" matches: ${asked}.${missing}`,
			imageOnlyNote(decks),
			"Unless a note above says slide text is missing from the index, say the slides do not cover it, then teach it yourself and mark it as going beyond them.",
		].filter(Boolean).join("\n\n");
	}
	const lines = [
		`"${course}" — ${result.hits.length} slide excerpt${result.hits.length === 1 ? "" : "s"} for: ${asked}`,
		"",
	];
	for (const hit of result.hits) lines.push(`${hit.deck}, p. ${hit.page}:`, hit.text, "");
	lines.push("Verbatim slide text: your SOURCE, not your script. Explain it in your own teaching words at the learner's level — "
		+ "never paste or recite a slide, quote a short phrase only where the exact wording carries the meaning, such as a "
		+ "definition — and cite the deck and page exactly as printed above, never a page that is not.");
	const note = imageOnlyNote(decks);
	if (note) lines.push(note);
	if (result.truncated) lines.push("More pages matched than fit; narrow the terms if this was not enough.");
	return lines.join("\n") + missing;
}

module.exports = {
	DEFAULTS, MIN_STEM, SUFFIXES,
	buildDeckIndex, excerpt, fold, foldWithMap, imageOnlyNote, pagesFromMarkdown,
	postings, queryTerms, renderSearch, search, skippedFromNotices, stem, stems, tokenize,
};
