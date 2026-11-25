"use strict";
/**
 * Pure shaping of Logseq MCP responses into compact text for an agent. No IO
 * here, so the whole output format is testable without a server.
 *
 * The learner's notes are TEACHER CONTEXT ONLY. An earlier version of this
 * module also rendered them as markdown for the Flashcards plugin's "Generate
 * from file"; that export was dropped (see this plugin's README), because the
 * slide decks proved the better card source while the notes' value — what the
 * learner highlighted, rephrased and doubted — is realised by the teacher.
 *
 * Why this shape: the Logseq MCP server's `getPage` returns only a page's
 * DIRECT children, so a learner's highlights and the notes nested under them
 * (3-5 levels deep in a journal) are reachable only through `searchBlocks`.
 * These helpers therefore rebuild what structure the search hits allow -
 * grouping by journal day and re-attaching a hit to its parent hit - rather
 * than walking the real tree, which the server does not expose.
 */

const ANNOTATION_TAG = "Pdf-annotation";
const ASSET_TAG = "Asset";
const LINK_ONLY = /^\[\[(.+)\]\]$/s;
/**
 * Conservative marker for the learner's own uncertainty, so a teacher can lead
 * with it. Deliberately small: it only flags phrasings the learner actually
 * writes, and a miss costs nothing (the note is still shown).
 */
const DOUBT = /(\?\?|\bi\s*don'?t\s*get\b|\bidont\s*get\b|\bnot\s+so\s+confident\b|\bno\s+idea\b|\bbho\b|\bnon\s+so\b|\bnon\s+ho\s+capito\b|\bcosa\s+centra\b)/i;

/**
 * Hard caps on what one tool call can put into the lesson context. A whole
 * three-day course reads in ~1700 characters, so these bound the worst case
 * (a course with months of notes) rather than the normal one: ~1000 tokens for
 * a course read and ~700 for a search, at the repo's chars/4 estimate.
 */
const DEFAULTS = Object.freeze({ maxBlocks: 40, maxBlockChars: 260, maxTotalChars: 4000 });
const SEARCH_LIMITS = Object.freeze({ maxBlocks: 20, maxBlockChars: 220, maxTotalChars: 2800 });

function hasTag(hit, ident) {
	return (hit?.tags ?? []).some(tag => typeof tag?.ident === "string" && tag.ident.endsWith(`/${ident}`));
}

const isHighlight = hit => hasTag(hit, ANNOTATION_TAG);
const isAsset = hit => hasTag(hit, ASSET_TAG);

/** Collapse whitespace; Logseq titles carry hard wraps from the PDF layer. */
function flatten(text) {
	return String(text ?? "").replace(/\s+/g, " ").trim();
}

/**
 * Drop Logseq's `[[ ]]` link syntax from prose. The brackets are graph markup;
 * an agent reading "Did the quiz for [[DISTSYS]]" should see the words, and
 * must not start echoing wiki syntax back at the learner.
 */
function stripLinks(text) {
	return flatten(text).replace(/\[\[([^[\]]+)\]\]/g, "$1");
}

function clamp(text, limit) {
	const value = flatten(text);
	return value.length > limit ? `${value.slice(0, limit - 1).trimEnd()}…` : value;
}

/** A block whose whole title is one [[link]] is an outline pointer, not prose. */
function linkTarget(title) {
	const match = LINK_ONLY.exec(flatten(title));
	return match ? flatten(match[1]) : undefined;
}

/** uuid -> page title, from `listPages`. */
function pageIndex(pages) {
	const index = new Map();
	for (const page of pages ?? []) {
		if (page?.uuid && page?.title) index.set(String(page.uuid), String(page.title));
	}
	return index;
}

/** Lowercased page titles, to tell a topic link from a highlight reference. */
function pageTitleSet(pages) {
	const titles = new Set();
	for (const page of pages ?? []) {
		if (page?.title) titles.add(flatten(page.title).toLowerCase());
	}
	return titles;
}

/** numeric block id -> asset (slide deck / PDF) title, from search hits. */
function assetIndex(hits) {
	const index = new Map();
	for (const hit of hits ?? []) {
		if (isAsset(hit) && typeof hit.id === "number") index.set(hit.id, flatten(hit.title));
	}
	return index;
}

/**
 * Where a highlight came from, as far as the server will say.
 * `entity` is `getPage(<highlight uuid>)`'s entity: it carries `hl-page` (the
 * slide/PDF page) and `asset: {id}`. The asset's NAME is only ever available
 * when the same search also returned that asset block, hence best-effort.
 */
function describeSource(hit, entity, assets) {
	const page = typeof entity?.["hl-page"] === "number" ? entity["hl-page"] : undefined;
	const assetId = entity?.asset?.id ?? (isHighlight(hit) ? hit.parent : undefined);
	const name = typeof assetId === "number" ? assets.get(assetId) : undefined;
	if (name && page !== undefined) return `${name}, p.${page}`;
	if (name) return name;
	if (page !== undefined) return `slide p.${page}`;
	return undefined;
}

/**
 * Group the search hits into journal days, re-attaching each hit to its parent
 * hit when the parent is also in the result set (that is how a learner's note
 * nested under a highlight gets shown with the highlight it belongs to).
 *
 * @param {{hits: object[], pages: object[], entities?: Map<string, object>}} input
 */
function groupByDay({ hits, pages, entities }) {
	const titles = pageIndex(pages);
	const knownPages = pageTitleSet(pages);
	const assets = assetIndex(hits);
	const resolved = entities ?? new Map();
	const content = (hits ?? []).filter(hit => hit && !isAsset(hit));
	const byId = new Map(content.filter(hit => typeof hit.id === "number").map(hit => [hit.id, hit]));
	const children = new Map();
	for (const hit of content) {
		if (typeof hit.parent === "number" && byId.has(hit.parent)) {
			if (!children.has(hit.parent)) children.set(hit.parent, []);
			children.get(hit.parent).push(hit);
		}
	}
	const days = new Map();
	for (const hit of content) {
		// A hit shown under its parent must not also appear at the top level.
		if (typeof hit.parent === "number" && byId.has(hit.parent)) continue;
		const key = String(hit.page ?? "");
		if (!days.has(key)) days.set(key, { pageUuid: key, title: titles.get(key) ?? "(unknown page)", entries: [] });
		days.get(key).entries.push(hit);
	}
	const describe = hit => {
		const entity = resolved.get(String(hit.uuid));
		const target = linkTarget(hit.title);
		// A block that is only [[Some Page]] is how the learner heads a course
		// or topic section; one that is only [[a whole slide sentence]] points
		// back at a highlight. They read very differently, so label them so.
		const kind = isHighlight(hit) ? "highlight"
			: target ? (knownPages.has(target.toLowerCase()) ? "topic" : "reference")
				: "note";
		return {
			uuid: String(hit.uuid ?? ""),
			kind,
			text: target ? stripLinks(target) : stripLinks(hit.title ?? hit.content ?? ""),
			source: isHighlight(hit) ? describeSource(hit, entity, assets) : undefined,
			doubt: kind === "note" && DOUBT.test(flatten(hit.title ?? "")),
			children: (children.get(hit.id) ?? []).map(child => describe(child)),
		};
	};
	return [...days.values()]
		.map(day => ({ ...day, entries: day.entries.map(entry => describe(entry)).filter(entry => entry.text) }))
		.filter(day => day.entries.length);
}

/**
 * Counts the learner would recognise: highlights they made and notes they
 * wrote. Topic headers and pointers back to a highlight are navigation, not
 * notes, so counting them would overstate how much the learner actually wrote.
 */
function countEntries(days) {
	let highlights = 0, notes = 0, doubts = 0;
	const walk = entries => {
		for (const entry of entries) {
			if (entry.kind === "highlight") highlights += 1;
			else if (entry.kind === "note") { notes += 1; if (entry.doubt) doubts += 1; }
			walk(entry.children);
		}
	};
	walk(days.flatMap(day => day.entries));
	return { highlights, notes, doubts, days: days.length };
}

/** Render one grouped tree as compact agent-facing text, within hard bounds. */
function renderText({ heading, days, limits }) {
	const bounds = { ...DEFAULTS, ...(limits ?? {}) };
	const stats = countEntries(days);
	const lines = [heading];
	let blocks = 0, truncated = false;
	const emit = (entry, depth) => {
		if (blocks >= bounds.maxBlocks) { truncated = true; return; }
		blocks += 1;
		const indent = "  ".repeat(depth);
		// A topic header needs no prefix: the bare course/topic name says it.
		// A pointer back to a highlight is clamped short, because the full
		// highlight text is already shown where the learner made it.
		const label = entry.kind === "highlight"
			? `slide highlight${entry.source ? ` — ${entry.source}` : ""}: `
			: entry.kind === "reference" ? "refers to: " : entry.kind === "topic" ? "" : entry.doubt ? "learner doubt: " : "learner: ";
		const limit = entry.kind === "reference" ? Math.min(120, bounds.maxBlockChars) : bounds.maxBlockChars;
		lines.push(`${indent}- ${label}${clamp(entry.text, limit)}`);
		for (const child of entry.children) emit(child, depth + 1);
	};
	for (const day of days) {
		if (blocks >= bounds.maxBlocks) { truncated = true; break; }
		lines.push("", `## ${day.title}`);
		for (const entry of day.entries) emit(entry, 0);
	}
	if (truncated) lines.push("", `(Truncated at ${bounds.maxBlocks} blocks. Narrow the query to see more.)`);
	let text = lines.join("\n");
	// The block cap is the usual limiter; this is the backstop that keeps one
	// call from ever growing the lesson context past a known size.
	if (text.length > bounds.maxTotalChars) {
		const suffix = "…\n(Output truncated.)";
		text = text.slice(0, Math.max(0, bounds.maxTotalChars - suffix.length)).trimEnd() + suffix;
		truncated = true;
	}
	return { text, stats, truncated };
}

/** `logseq_search_notes` output. */
function renderSearch({ query, days, limits }) {
	if (!days.length) return { text: `No blocks in the learner's Logseq graph matched "${query}".`, stats: { days: 0, highlights: 0, notes: 0 }, truncated: false };
	const counted = countEntries(days);
	const heading = `The learner's own Logseq notes matching "${query}" — ${counted.highlights} slide highlight(s), ${counted.notes} note(s) across ${counted.days} journal day(s). Cite the journal day and, for a highlight, its slide page.`;
	return renderText({ heading, days, limits: { ...SEARCH_LIMITS, ...(limits ?? {}) } });
}

/** `logseq_read_course_notes` output. */
function renderCourse({ course, days, limits }) {
	if (!days.length) return { text: `The learner's Logseq graph has no notes matching the course "${course}".`, stats: { days: 0, highlights: 0, notes: 0 }, truncated: false };
	const counted = countEntries(days);
	const heading = [
		`The learner's own Logseq notes for "${course}" — ${counted.highlights} slide highlight(s), ${counted.notes} note(s) of which ${counted.doubts} sound unsure, across ${counted.days} journal day(s).`,
		"These are the learner's notes, not the course material: keep teaching from the slides the librarian returns, and use these to see what they highlighted, wrote and doubted. Cite the journal day and the slide page when you refer to one.",
	].join("\n");
	return renderText({ heading, days, limits });
}

module.exports = {
	ANNOTATION_TAG, ASSET_TAG, DEFAULTS, SEARCH_LIMITS,
	assetIndex, clamp, countEntries, describeSource, flatten,
	groupByDay, isAsset, isHighlight, linkTarget, pageIndex, pageTitleSet,
	renderCourse, renderSearch, renderText, stripLinks,
};
