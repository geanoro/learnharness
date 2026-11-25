"use strict";
/**
 * Logseq notes - the study plugin's notes module.
 *
 * This file is not a plugin of its own: it has no manifest, no settings page
 * and no view. `backend.cjs` owns the single settings page and the shared
 * course list, and passes this module a `readConfig()` returning the Logseq
 * server URL and token. That keeps one plugin to maintain while this file stays
 * the only place that knows how to talk to Logseq.
 *
 * Entry points for the plugin backend:
 *   const logseq = createLogseqNotesModule({ readConfig, isEnabled });
 *   ctx.registerTools({ agents, create: context => logseq.createTools(context) });
 *   await logseq.checkConnection(signal);      // -> { ok, message }
 *
 * `course` is the learner's Logseq `[[COURSE]]` name, which the course list
 * stores next to that course's slides folder.
 *
 * NOTES ARE TEACHER CONTEXT ONLY. The earlier `exportCourse` entry point, which
 * rendered a course's notes as markdown for the Flashcards plugin, is gone: the
 * slide decks turned out to be the better card source, and the notes' value is
 * what the teacher does with them. Nothing here writes a file.
 *
 * This module registers no system-prompt text. `registerInstructions` takes
 * one static text for every turn of its agents, so it can never reach zero for
 * a session that turned the notes off; `NOTES_GUIDANCE` rides a tool
 * description instead and disappears with it. See `backend.cjs`.
 *
 * READ-ONLY: logseq-mcp.cjs refuses every tool outside
 * searchBlocks/getPage/listPages, so nothing here can write to the graph.
 */

const { createClient, LogseqError, scrub, READ_ONLY_TOOLS } = require("./logseq-mcp.cjs");
const notes = require("./logseq-notes.cjs");

const DEFAULT_URL = "http://127.0.0.1:12315/mcp";
/** Bounds so one tool call cannot turn into a long chain of requests. */
const MAX_ENTITY_LOOKUPS = 12;
const PAGE_INDEX_TTL_MS = 60000;

/**
 * How to USE the notes, as opposed to what the two tools are. `backend.cjs`
 * appends this to a tool description in the phases where it earns its place,
 * so it is charged to a session that turned the notes on and to no other.
 * It stays at the minimum that still steers behaviour: when to call, what the
 * notes are for, what to cite, and what to do when Logseq is shut. No
 * examples, and no restating of doctrine the host prompt already carries.
 */
const NOTES_GUIDANCE = [
	"Call logseq_read_course_notes ONCE when you take up the course, and logseq_search_notes only when the learner mentions something they wrote down — not every turn.",
	"Their notes record what they highlighted, put in their own words, and said they were unsure about; lead with a doubt they wrote when it is relevant. They do not replace the slides: keep teaching from what the librarian returns.",
	"Cite the journal day, and a slide page only when the tool gave you one. If a tool reports Logseq closed or the token wrong, say so once and carry on without the notes.",
].join("\n");

/**
 * @param {{
 *   readConfig: () => {serverUrl?: string, token?: string} | Promise<{serverUrl?: string, token?: string}>,
 *   isEnabled?: (context: {chatId?: string, agent?: string}) => boolean,
 *   fetchImpl?: typeof fetch,
 *   timeoutMs?: number,
 *   now?: () => number,
 * }} options
 */
function createLogseqNotesModule(options) {
	if (!options || typeof options.readConfig !== "function") {
		throw new Error("createLogseqNotesModule needs a readConfig() supplying the Logseq server URL and token.");
	}
	const now = options.now ?? (() => Date.now());
	const isEnabled = options.isEnabled ?? (() => true);
	let pageCache;

	async function client(signal) {
		const config = (await options.readConfig()) ?? {};
		return createClient({
			url: config.serverUrl || DEFAULT_URL,
			token: config.token || "",
			...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
			...(options.timeoutMs ? { timeoutMs: options.timeoutMs } : {}),
			...(signal ? { signal } : {}),
		});
	}

	async function listPagesCached(mcp) {
		if (pageCache && now() - pageCache.at < PAGE_INDEX_TTL_MS) return pageCache.pages;
		const pages = await mcp.callTool("listPages", { expand: false });
		const list = Array.isArray(pages) ? pages : [];
		pageCache = { at: now(), pages: list };
		return list;
	}

	/** Drop the cached page index, e.g. after the host's settings change. */
	function invalidate() { pageCache = undefined; }

	/**
	 * One search, one page index (cached), and at most MAX_ENTITY_LOOKUPS
	 * follow-up entity reads for the highlights - that is the only way to learn
	 * a highlight's slide page and PDF asset.
	 */
	async function days(term, signal) {
		const mcp = await client(signal);
		const [pages, found] = await Promise.all([
			listPagesCached(mcp),
			mcp.callTool("searchBlocks", { searchTerm: term }),
		]);
		const hits = Array.isArray(found?.blocks) ? found.blocks : [];
		const entities = new Map();
		for (const hit of hits.filter(candidate => notes.isHighlight(candidate) && candidate?.uuid).slice(0, MAX_ENTITY_LOOKUPS)) {
			// Sequential on purpose: a burst of parallel reads against the
			// learner's own editor is not worth the few saved milliseconds.
			try {
				const resolved = await mcp.callTool("getPage", { pageName: String(hit.uuid) });
				if (resolved?.entity) entities.set(String(hit.uuid), resolved.entity);
			} catch (error) {
				if (error instanceof LogseqError && ["unauthorized", "unreachable", "timeout", "not-configured"].includes(error.kind)) throw error;
				// A single unreadable highlight costs its slide reference, not the answer.
			}
		}
		return notes.groupByDay({ hits, pages, entities });
	}

	/** Turn any failure into something the learner or the agent can act on. */
	async function explain(error) {
		if (error instanceof LogseqError) return error.message;
		let token = "";
		try { token = (await options.readConfig())?.token ?? ""; } catch { /* the original failure is what matters */ }
		return scrub(error instanceof Error ? error.message : String(error), token);
	}

	async function searchNotes(query, signal) {
		const term = String(query ?? "").trim();
		if (term.length < 2) throw new Error("Enter at least two characters to search the notes.");
		return notes.renderSearch({ query: term, days: await days(term, signal) }).text;
	}

	async function readCourseNotes(course, signal) {
		const name = String(course ?? "").trim();
		if (name.length < 2) throw new Error("Enter the course or topic to read.");
		return notes.renderCourse({ course: name, days: await days(name, signal) }).text;
	}

	async function checkConnection(signal) {
		try {
			invalidate();
			const pages = await listPagesCached(await client(signal));
			return { ok: true, message: `Connected. The graph has ${pages.length} page(s).` };
		} catch (error) {
			return { ok: false, message: await explain(error) };
		}
	}

	/**
	 * Native tool definitions for the host's `registerTools`. A tool answers the
	 * agent in words on failure rather than throwing the turn away.
	 *
	 * `create` runs fresh every turn, so passing the host's per-turn context
	 * here is what makes the cost conditional: when Logseq notes are off for
	 * this session, this returns NO tools and the turn pays nothing for them.
	 *
	 * The guidance that used to ride `registerInstructions` lives in these
	 * descriptions instead. `registerInstructions` takes one static text used on
	 * every turn of its agents, with no per-turn or per-chat hook, so it cannot
	 * reach zero for a session that turned the notes off — and this plugin's
	 * budget requires exactly that. `backend.cjs` wraps these descriptions.
	 */
	function createTools(context) {
		if (!isEnabled(context ?? {})) return [];
		const answer = async (work) => {
			try { return { content: [{ type: "text", text: await work() }] }; }
			catch (error) { return { content: [{ type: "text", text: `Could not read the learner's Logseq notes. ${await explain(error)}` }] }; }
		};
		return [
			{
				name: "logseq_search_notes",
				label: "Search the learner's Logseq notes",
				description: "Search the learner's own Logseq notes for a word or phrase. Returns their notes and slide highlights by journal day, highlights cited with slide deck and page. Read-only.",
				parameters: {
					type: "object",
					properties: { query: { type: "string", minLength: 2, maxLength: 200, description: "Word or short phrase to find." } },
					required: ["query"],
					additionalProperties: false,
				},
				execute: (_toolCallId, input, signal) => answer(() => searchNotes(input.query, signal)),
			},
			{
				name: "logseq_read_course_notes",
				label: "Read the learner's Logseq notes for a course",
				description: "Read what the learner wrote in Logseq about one course, by journal day: their slide highlights with deck and page, and their own notes and doubts under them. Read-only.",
				parameters: {
					type: "object",
					properties: { course: { type: "string", minLength: 2, maxLength: 200, description: "Course or topic name as written in Logseq." } },
					required: ["course"],
					additionalProperties: false,
				},
				execute: (_toolCallId, input, signal) => answer(() => readCourseNotes(input.course, signal)),
			},
		];
	}

	return { createTools, searchNotes, readCourseNotes, checkConnection, invalidate };
}

module.exports = {
	createLogseqNotesModule,
	// Re-exported so the host plugin needs only this one entry point.
	createClient, LogseqError, notes, scrub, READ_ONLY_TOOLS,
	DEFAULT_URL, NOTES_GUIDANCE, MAX_ENTITY_LOOKUPS, PAGE_INDEX_TTL_MS,
};
