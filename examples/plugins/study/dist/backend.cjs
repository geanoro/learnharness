"use strict";
/**
 * Study — one plugin for the whole loop: the explain-back checkpoint, the
 * course slides behind a librarian, and the learner's own Logseq notes.
 *
 * WHY ONE PLUGIN. Three plugins meant three settings pages, three course lists
 * and three standing prompt costs. Here there is one settings page, one course
 * list (each course has a slides folder and its Logseq `[[COURSE]]` name), and
 * one per-session picker.
 *
 * WHY NOTHING GOES THROUGH `registerInstructions`. That API takes ONE static
 * text used on EVERY turn of the agents it names, with no per-turn or per-chat
 * hook. A rule about a course would then be charged to every session, including
 * the ones with no course. `registerTools`' factory is the only per-turn surface
 * the API offers — it receives that turn's frozen `{chatId, agent}` — so every
 * word the agents are told rides a tool description, sized to what this session
 * actually selected and to the phase it is in. The budget this buys is in the
 * README. `registerInstructions` is not called anywhere in this file.
 *
 * WHAT IS AUTHOR-OWNED. All of it: the host adds no special handling for any of
 * this. No core edits, no persisted format or schema version change, no
 * learning-data writes, nothing in the knowledge graph, no code execution.
 */

const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const librarian = require("./librarian.cjs");
const { phaseOf } = require("./phase.cjs");
const { createLogseqNotesModule, NOTES_GUIDANCE, DEFAULT_URL } = require("./logseq.cjs");

const FORMAT_VERSION = 1;
const MAX_NAME = 80;
/** Folder walk, as in the app's own File-access list: PDFs only, no hidden
 *  folders, depth and count hard-capped. An inventory, not a file browser. */
const MAX_FILES = 200;
const MAX_DEPTH = 4;
/** Index bounds, so one pathological deck cannot grow the cache without end. */
const MAX_INDEX_PAGES = 400;
const MAX_PAGE_CHARS = 4000;
const MAX_TERMS = 8;
const AGENTS = ["prober", "teacher", "practice"];
/** This plugin's own teaching-question tool, so the phase fold recognises it. */
const EXPLAIN_TOOL = "study_explain";
const QUESTION_TYPE_ID = "study-explain";
const CONFIDENCE_STOPS = [0, 30, 50, 70, 90, 100];
const EXPLANATION_MAX = 2000;
const PICKER = "the \"Study\" button in this session's top bar";

const isFolderEntry = value => typeof value === "string" && (value.startsWith("/") || /^~[/\\]/.test(value)) && !value.includes("\0");
const expandHome = folder => (folder.startsWith("~/") || folder.startsWith("~\\") ? path.join(os.homedir(), folder.slice(2)) : folder);
const quoted = list => (list.length ? list.map(course => `"${course.name}"`).join(", ") : "none");
const printable = value => ![...value].some(character => { const code = character.codePointAt(0); return code < 0x20 || code === 0x7f; });
const object = value => {
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Expected an operation input object");
	return value;
};
const text = (value, label) => {
	const out = typeof value === "string" ? value.trim() : "";
	if (!out) throw new Error(`${label} is required`);
	return out;
};

function listDecks(folder) {
	const root = expandHome(folder);
	const stat = fs.statSync(root); // Throws for a missing/unreadable folder; every caller reports that.
	if (!stat.isDirectory()) throw new Error(`Not a folder: ${root}`);
	const decks = [];
	let truncated = false;
	const walk = (directory, depth) => {
		if (truncated) return;
		for (const entry of fs.readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
			if (entry.name.startsWith(".")) continue;
			const full = path.join(directory, entry.name);
			if (entry.isDirectory()) { if (depth < MAX_DEPTH) walk(full, depth + 1); continue; }
			if (!entry.isFile() || !/\.pdf$/i.test(entry.name)) continue;
			if (decks.length >= MAX_FILES) { truncated = true; return; }
			decks.push({ label: path.relative(root, full), path: full });
		}
	};
	walk(root, 1);
	return { root, decks, truncated };
}

exports.activate = ctx => {
	const file = name => path.join(ctx.dataDirectory, name);
	const indexDirectory = file("index");

	const readRecord = (target, key) => {
		let raw;
		try { raw = fs.readFileSync(target, "utf8"); }
		catch (error) { if (error.code === "ENOENT") return undefined; throw error; }
		const record = JSON.parse(raw);
		if (!record || typeof record !== "object") throw new Error(`Invalid study ${key} record`);
		// A newer format is never rewritten or reinterpreted — the plugin owns these files.
		if (record.version !== FORMAT_VERSION) throw new Error(`Unsupported study ${key} format version ${record.version}`);
		return record;
	};
	const writeAtomic = (target, data) => {
		fs.mkdirSync(path.dirname(target), { recursive: true });
		const temporary = `${target}.tmp`;
		fs.writeFileSync(temporary, `${JSON.stringify(data, null, "\t")}\n`);
		fs.renameSync(temporary, target);
	};

	/** The one shared course list: a name, its slides folder, its Logseq name. */
	const loadCourses = () => {
		const record = readRecord(file("courses.json"), "courses");
		if (!record) return [];
		if (!Array.isArray(record.courses)) throw new Error("Invalid study courses record");
		return record.courses.map(course => {
			if (!course || typeof course.name !== "string" || typeof course.folder !== "string") throw new Error("Invalid course entry");
			return { name: course.name, folder: course.folder, logseq: typeof course.logseq === "string" ? course.logseq : "" };
		});
	};

	/** chatId → what the learner picked for that ONE session. No entry means
	 *  nothing is active, which is also what makes the turn cost zero. */
	const loadSessions = () => {
		const record = readRecord(file("sessions.json"), "sessions");
		if (!record || !record.sessions || typeof record.sessions !== "object" || Array.isArray(record.sessions)) return {};
		const sessions = {};
		for (const [chatId, entry] of Object.entries(record.sessions)) {
			if (!entry || typeof entry.course !== "string" || !Array.isArray(entry.decks)) continue;
			sessions[chatId] = { course: entry.course, decks: entry.decks.filter(deck => typeof deck === "string"), notes: entry.notes === true };
		}
		return sessions;
	};

	/** Plugin-owned settings. The token lives here and is never returned to the
	 *  frontend, never logged, and never allowed into an error message. */
	const loadSettings = () => {
		const record = readRecord(file("settings.json"), "settings");
		const logseq = record && record.logseq && typeof record.logseq === "object" ? record.logseq : {};
		return {
			logseq: {
				serverUrl: typeof logseq.serverUrl === "string" ? logseq.serverUrl : "",
				token: typeof logseq.token === "string" ? logseq.token : "",
			},
			explainBack: !record || record.explainBack !== false,
		};
	};

	let courses = loadCourses();
	let sessions = loadSessions();
	let settings = loadSettings();

	const persistCourses = next => { writeAtomic(file("courses.json"), { version: FORMAT_VERSION, courses: next }); courses = next; };
	const persistSessions = next => { writeAtomic(file("sessions.json"), { version: FORMAT_VERSION, sessions: next }); sessions = next; };
	const persistSettings = next => {
		writeAtomic(file("settings.json"), { version: FORMAT_VERSION, logseq: next.logseq, explainBack: next.explainBack });
		settings = next;
	};

	// ── the librarian's cache ────────────────────────────────────────────────
	// One file per deck, keyed by the deck's absolute path, carrying the size and
	// mtime it was built from. A deck whose file has changed reads as not indexed
	// rather than answering from stale text.

	const indexFile = deckPath => path.join(indexDirectory, `${crypto.createHash("sha256").update(deckPath).digest("hex").slice(0, 16)}.json`);

	const readIndex = deck => {
		let entry;
		try { entry = readRecord(indexFile(deck.path), "index"); }
		catch { return undefined; } // A corrupt or future cache entry re-indexes; it never breaks a lesson.
		if (!entry || entry.path !== deck.path) return undefined;
		let stat;
		try { stat = fs.statSync(deck.path); } catch { return undefined; }
		if (stat.size !== entry.size || Math.floor(stat.mtimeMs) !== entry.mtimeMs) return undefined;
		return { ...entry, label: deck.label };
	};

	const writeIndex = entry => writeAtomic(indexFile(entry.path), { version: FORMAT_VERSION, ...entry });

	const dropIndex = deckPath => { try { fs.rmSync(indexFile(deckPath)); } catch { /* nothing cached for this deck */ } };

	// ── the Logseq notes module ─────────────────────────────────────────────
	const logseq = createLogseqNotesModule({
		readConfig: () => settings.logseq,
		// Per turn, per session: notes off here means NO tools on this turn.
		isEnabled: context => sessions[context?.chatId]?.notes === true,
	});

	// ── course and selection resolution ─────────────────────────────────────
	const findExact = name => {
		const wanted = String(name ?? "").trim().toLowerCase();
		return wanted ? courses.find(course => course.name.trim().toLowerCase() === wanted) : undefined;
	};

	/** The decks this session is scoped to, with each one's cached index. */
	const scopeOf = selection => {
		const course = findExact(selection.course);
		if (!course) return { course: undefined };
		let listing;
		try { listing = listDecks(course.folder); }
		catch (error) { return { course, error: error instanceof Error ? error.message : String(error) }; }
		const chosen = selection.decks.length ? listing.decks.filter(deck => selection.decks.includes(deck.label)) : listing.decks;
		const indexed = [];
		const unindexed = [];
		for (const deck of chosen) {
			const entry = readIndex(deck);
			if (entry) indexed.push(entry); else unindexed.push(deck.label);
		}
		return { course, root: listing.root, decks: chosen, indexed, unindexed, truncated: listing.truncated };
	};

	/** The librarian's own answer: excerpts, or the inventory when asked for no
	 *  terms. Both name absolute paths only where a `pdf` job would need one. */
	const consult = (chatId, input, signal) => {
		if (ctx.signal.aborted || signal?.aborted) throw new Error("Study is disabled or the turn was cancelled");
		const selection = sessions[chatId];
		if (!selection) {
			// Normally unreachable: with nothing picked the factory registers no tool
			// at all. This covers a selection cleared between the factory and the call.
			return "No course is active for this session. The learner picks one with "
				+ `${PICKER}; until they do there is nothing in scope. Teach without the slides and do not guess a folder.`;
		}
		const scope = scopeOf(selection);
		if (!scope.course) {
			return `This session was pointed at the course "${selection.course}", which is no longer configured. `
				+ `Say so and ask the learner to pick again with ${PICKER}. The configured courses are: ${quoted(courses)}.`;
		}
		if (scope.error) {
			return `"${scope.course.name}" is configured as ${expandHome(scope.course.folder)}, but that folder cannot be read right now `
				+ `(${scope.error}). Tell the learner the folder is missing or unreadable, and teach without the slides.`;
		}
		if (!scope.decks.length) {
			return selection.decks.length
				? `"${scope.course.name}" — the decks the learner ticked are no longer in ${scope.root}. Say so and ask them to pick again with ${PICKER}.`
				: `"${scope.course.name}" — ${scope.root} holds no PDF files. PowerPoint cannot be read: if the slides are .pptx, the learner `
					+ "has to export them to PDF first. Say so, and teach without the slides until then.";
		}
		const terms = Array.isArray(object(input).terms) ? input.terms.slice(0, MAX_TERMS) : [];
		if (!terms.length) return inventory(scope);
		return librarian.renderSearch({ course: scope.course.name, decks: scope.indexed, terms, unindexed: scope.unindexed });
	};

	/** What is in scope, which decks the librarian can answer for, and the
	 *  absolute paths a native `pdf` job needs for the rest. */
	const inventory = scope => {
		const lines = [`"${scope.course.name}" — ${scope.decks.length} deck${scope.decks.length === 1 ? "" : "s"} in scope`
			+ `${scope.truncated ? ` (folder walk capped at ${MAX_FILES} files)` : ""}:`];
		for (const deck of scope.decks) {
			const entry = scope.indexed.find(candidate => candidate.label === deck.label);
			lines.push(entry
				? `- ${deck.label} — ${entry.pages.length} searchable page${entry.pages.length === 1 ? "" : "s"}`
					+ `${entry.imageOnlyPages.length || entry.imageOnlyTrailing ? ", plus image-only pages" : ""}`
				: `- ${deck.label} — NOT indexed; only a \`pdf\` job can read it: ${deck.path}`);
		}
		if (scope.unindexed.length) {
			lines.push("", `Tell the learner to press Index in ${PICKER} to make the unindexed decks searchable.`);
		}
		const note = librarian.imageOnlyNote(scope.indexed);
		if (note) lines.push("", note);
		lines.push("", "Now call this again with `terms` to get the slides' own words. Nothing outside these decks is in scope; "
			+ `for another deck ask the learner to add it with ${PICKER}.`);
		return lines.join("\n");
	};

	// ── the per-turn loadout ────────────────────────────────────────────────

	/** The phase of this session, for gating how much is said. Reads ONE record
	 *  (`getSession`), never the session list — see phase.cjs for why. */
	const phaseFor = chatId => {
		try {
			const record = ctx.learning.getSession(chatId);
			return record ? phaseOf(record.messages, [EXPLAIN_TOOL]) : "probe";
		} catch { return "probe"; } // An unreadable record gets the fuller text, never a wrong one.
	};

	const LIBRARY_RULES = "Teach from these slides first, and reach them ONLY through this tool.\n"
		+ "- Call it once with no `terms` to see what is in scope, then with the words you need. Several terms in one call; "
		+ "Italian and English both match, accents and endings included.\n"
		+ "- What comes back is the slides' own text with a deck and a page. Cite them exactly as printed, and never a page "
		+ "you were not given.\n"
		+ "- Nothing matched? Say the slides do not cover it. Then teach it yourself and say in the same breath that you are "
		+ "going past them — background they assume, a step they skip, your own example, a correction. Going beyond them is "
		+ "fine; leaving it unmarked is not.\n"
		+ "- Image-only slides carry no text. For those, and only those, send ONE native `pdf` job for that deck.";

	const LIBRARY_POINTER = "The slides for this session's course, as their own text with deck and page. "
		+ "Call it with the words you need; cite only the pages it gives you.";

	const NOTES_POINTER = "The learner's own Logseq notes for this course. Read them once, lead with a doubt they wrote.";

	let registrations = [];
	const unregisterAll = () => { for (const unregister of registrations) unregister(); registrations = []; };

	const compose = () => {
		unregisterAll();
		if (settings.explainBack) registrations.push(ctx.registerQuestionType(exports.questionDefinition));
		// No course configured and no Logseq server set: not one token on any turn.
		if (!courses.length && !settings.logseq.token) return;
		registrations.push(ctx.registerTools({
			agents: AGENTS,
			create(context) {
				const chatId = context.chatId;
				const selection = sessions[chatId];
				// Nothing picked for this session: nothing registered, nothing paid.
				// The picker is how a course becomes active; the prompt never asks.
				if (!selection) return [];
				const full = context.agent !== "practice" && phaseFor(chatId) !== "teach";
				const tools = [];
				if (courses.length) {
					tools.push({
						name: "course_library",
						label: "course library",
						description: full
							? `The learner picked the course "${selection.course}" for this session`
								+ `${selection.decks.length ? ` and ticked ${selection.decks.length} deck(s)` : ""}. ${LIBRARY_RULES}`
							: LIBRARY_POINTER,
						parameters: {
							type: "object",
							properties: {
								terms: {
									type: "array",
									items: { type: "string", minLength: 1, maxLength: 120 },
									maxItems: MAX_TERMS,
									description: "Words or short phrases to find. Omit to list what is in scope.",
								},
							},
							additionalProperties: false,
						},
						execute: async (_toolCallId, input, signal) => ({
							content: [{ type: "text", text: consult(chatId, input ?? {}, signal) }],
							details: null,
						}),
					});
				}
				for (const tool of logseq.createTools(context)) {
					if (tool.name !== "logseq_read_course_notes") { tools.push(tool); continue; }
					// The model cannot know the course's Logseq name — the learner typed it
					// in settings next to the slides folder. So the name is defaulted here
					// and the model is told it may omit it, instead of being made to guess
					// a `[[COURSE]]` block it has never seen.
					const logseqName = findExact(selection.course)?.logseq || selection.course;
					tools.push({
						...tool,
						description: full
							? `${tool.description} Omit \`course\` to read "${logseqName}", this session's course.\n${NOTES_GUIDANCE}`
							: `${NOTES_POINTER} Omit \`course\` for "${logseqName}".`,
						parameters: { ...tool.parameters, required: [] },
						execute: (toolCallId, input, signal) => tool.execute(
							toolCallId,
							{ ...(input ?? {}), course: typeof input?.course === "string" && input.course.trim() ? input.course : logseqName },
							signal,
						),
					});
				}
				return tools;
			},
		}));
	};

	// ── the frontend bridge ─────────────────────────────────────────────────

	const courseState = () => courses.map(course => {
		const entry = { name: course.name, folder: course.folder, logseq: course.logseq, resolved: expandHome(course.folder) };
		try {
			const listing = listDecks(course.folder);
			entry.decks = listing.decks.length;
			entry.indexed = listing.decks.filter(deck => readIndex(deck)).length;
		} catch (error) { entry.error = error instanceof Error ? error.message : String(error); }
		return entry;
	});

	/** The token is never part of this; only whether one is set. */
	const state = () => ({
		courses: courseState(),
		logseq: { serverUrl: settings.logseq.serverUrl, hasToken: Boolean(settings.logseq.token), defaultUrl: DEFAULT_URL },
		explainBack: settings.explainBack,
	});

	ctx.handle("state", () => state());

	ctx.handle("addCourse", input => {
		const value = object(input);
		const name = text(value.name, "A course name");
		const folder = typeof value.folder === "string" ? value.folder.trim().replace(/[/\\]+$/, "") : "";
		if (name.length > MAX_NAME) throw new Error(`Keep the course name under ${MAX_NAME} characters`);
		if (!printable(name)) throw new Error("The course name cannot contain control characters");
		if (findExact(name)) throw new Error(`"${name}" is already configured`);
		if (!isFolderEntry(folder)) throw new Error("Enter an absolute path or ~/folder");
		let stat;
		try { stat = fs.statSync(expandHome(folder)); }
		catch { throw new Error(`No such folder: ${expandHome(folder)}`); }
		if (!stat.isDirectory()) throw new Error(`Not a folder: ${expandHome(folder)}`);
		const logseq = typeof value.logseq === "string" ? value.logseq.trim() : "";
		if (logseq.length > MAX_NAME) throw new Error(`Keep the Logseq name under ${MAX_NAME} characters`);
		if (logseq && !printable(logseq)) throw new Error("The Logseq name cannot contain control characters");
		persistCourses([...courses, { name, folder, logseq }]);
		compose();
		return state();
	});

	ctx.handle("updateCourse", input => {
		const value = object(input);
		const course = findExact(value.name);
		if (!course) throw new Error("That course is not configured");
		const logseq = typeof value.logseq === "string" ? value.logseq.trim() : "";
		if (logseq.length > MAX_NAME) throw new Error(`Keep the Logseq name under ${MAX_NAME} characters`);
		if (logseq && !printable(logseq)) throw new Error("The Logseq name cannot contain control characters");
		persistCourses(courses.map(entry => (entry === course ? { ...entry, logseq } : entry)));
		return state();
	});

	ctx.handle("removeCourse", input => {
		const course = findExact(object(input).name);
		if (course) {
			// The course's cached index goes with it: nothing keeps page text for a
			// course the learner removed.
			try { for (const deck of listDecks(course.folder).decks) dropIndex(deck.path); } catch { /* folder already gone */ }
			persistCourses(courses.filter(entry => entry !== course));
			compose();
		}
		return state();
	});

	ctx.handle("setLogseq", input => {
		const value = object(input);
		const serverUrl = typeof value.serverUrl === "string" ? value.serverUrl.trim() : "";
		if (serverUrl && !/^https?:\/\//i.test(serverUrl)) throw new Error("The server URL must start with http:// or https://");
		// An absent token field leaves the stored one alone, so saving the URL
		// does not silently clear a token the learner cannot see.
		const token = typeof value.token === "string" ? value.token.trim() : settings.logseq.token;
		persistSettings({ ...settings, logseq: { serverUrl, token } });
		logseq.invalidate();
		compose();
		return state();
	});

	ctx.handle("setExplainBack", input => {
		persistSettings({ ...settings, explainBack: object(input).enabled === true });
		compose();
		return state();
	});

	ctx.handle("testLogseq", async () => logseq.checkConnection(ctx.signal));

	ctx.handle("decks", input => {
		const course = findExact(object(input).course);
		if (!course) throw new Error("That course is not configured");
		const listing = listDecks(course.folder);
		return {
			course: course.name, root: listing.root, truncated: listing.truncated,
			decks: listing.decks.map(deck => {
				const entry = readIndex(deck);
				return {
					label: deck.label,
					pages: entry ? entry.pages.length : 0,
					imageOnly: entry ? entry.imageOnlyPages.length + entry.imageOnlyTrailing : 0,
					indexed: Boolean(entry),
				};
			}),
		};
	});

	/**
	 * Store one deck's converted text. The frontend does the conversion because
	 * `ctx.documents.toMarkdown` exists only there (`docs/plugin-authoring.md`:
	 * "There is no backend documents member... path/URL/token input, or
	 * file-picker API"), so this is where its result lands.
	 *
	 * The deck is matched by label inside the course folder, never by a path the
	 * frontend supplies, and the size/mtime recorded are this process's own stat.
	 */
	ctx.handle("putIndex", input => {
		const value = object(input);
		const course = findExact(value.course);
		if (!course) throw new Error("That course is not configured");
		const label = text(value.label, "A deck label");
		const deck = listDecks(course.folder).decks.find(candidate => candidate.label === label);
		if (!deck) throw new Error(`"${label}" is not a deck in ${expandHome(course.folder)}`);
		const markdown = typeof value.markdown === "string" ? value.markdown : "";
		if (!markdown.trim()) throw new Error(`"${label}" converted to no text at all; it may be a scan. Teach it through a pdf job instead.`);
		const stat = fs.statSync(deck.path);
		if (typeof value.size === "number" && value.size !== stat.size) {
			throw new Error(`"${label}" on disk does not match the file that was read. Choose the course's own folder and index again.`);
		}
		const built = librarian.buildDeckIndex({
			label: deck.label, path: deck.path, size: stat.size, mtimeMs: Math.floor(stat.mtimeMs),
			markdown, notices: Array.isArray(value.notices) ? value.notices : [],
		});
		writeIndex({
			...built,
			// Bounded on the way in, so the cache cannot grow without end and one
			// librarian call never reads more than a known amount.
			pages: built.pages.slice(0, MAX_INDEX_PAGES).map(page => ({ number: page.number, text: page.text.slice(0, MAX_PAGE_CHARS) })),
		});
		return { label: deck.label, pages: Math.min(built.pages.length, MAX_INDEX_PAGES), imageOnly: built.imageOnlyPages.length + built.imageOnlyTrailing };
	});

	ctx.handle("dropIndex", input => {
		const course = findExact(object(input).course);
		if (!course) throw new Error("That course is not configured");
		for (const deck of listDecks(course.folder).decks) dropIndex(deck.path);
		return state();
	});

	/** The per-session picker's own operations. */
	ctx.handle("selection", input => sessions[text(object(input).chatId, "A session id")] ?? null);

	ctx.handle("select", input => {
		const value = object(input);
		const chatId = text(value.chatId, "A session id");
		const course = findExact(value.course);
		if (!course) throw new Error("That course is not configured");
		const available = new Set(listDecks(course.folder).decks.map(deck => deck.label));
		const decks = Array.isArray(value.decks) ? value.decks.filter(deck => available.has(deck)) : [];
		const notes = value.notes === true && Boolean(settings.logseq.token);
		const selection = { course: course.name, decks, notes };
		persistSessions({ ...sessions, [chatId]: selection });
		return selection;
	});

	ctx.handle("clear", input => {
		const chatId = text(object(input).chatId, "A session id");
		if (!(chatId in sessions)) return null;
		const next = { ...sessions };
		delete next[chatId];
		persistSessions(next);
		return null;
	});

	compose();
	ctx.cleanup(() => unregisterAll());
};

/**
 * The explain-back box. Its grading rules ride this description rather than
 * `registerInstructions`, so only a TEACHER turn pays for them: a prober or
 * practice turn never sees the box, and so never sees its rules either.
 */
exports.questionDefinition = {
	id: QUESTION_TYPE_ID,
	label: "Explain it back",
	contractVersion: 1,
	showThinking: false,
	questionSchema: {
		type: "object",
		properties: { mode: { type: "string", enum: ["short", "full"] } },
		required: ["mode"],
		additionalProperties: false,
	},
	answerSchema: {
		anyOf: [
			{
				type: "object",
				properties: {
					explanation: { type: "string", minLength: 1, maxLength: EXPLANATION_MAX },
					confidence: { type: "number", enum: CONFIDENCE_STOPS },
				},
				required: ["explanation", "confidence"],
				additionalProperties: false,
			},
			{
				// The "I don't know" path: a genuine decline, not an explanation that
				// happens to be short. Its own branch, not a loosened minLength on the
				// one above, so a decline can never silently carry a stale explanation
				// or confidence through re-validation.
				type: "object",
				properties: { dontKnow: { type: "boolean", enum: [true] } },
				required: ["dontKnow"],
				additionalProperties: false,
			},
		],
	},
	teach: {
		toolName: EXPLAIN_TOOL,
		description: "Pose the explain-back checkpoint for the plan node that just closed. A node closes when you move on to a "
			+ "different node, or the session is ending — at EVERY close, ask in ordinary prose whether he wants to explain the whole "
			+ "node back in his own words, or skip it; only if he wants to, call this. A close is tentative: nodes are never marked "
			+ "finished, so if you come back to a node you had closed, treat the next move-on as a fresh close and offer again. "
			+ "`payload.mode` is \"full\" for the normal 3-5 line explain-back, or \"short\" when the node was small or every check on "
			+ "it landed on the first try. Your `question` asks him to explain it as if to a friend, without the terms you introduced, "
			+ "and to pick how sure he is — or say he doesn't know.\n"
			+ "`dontKnow: true` is a genuine gap, never a wrong answer and never a retry occasion: give him the correct explanation "
			+ "yourself in prose and move on, without spending a retry.\n"
			+ "Otherwise grade the saved `explanation` strictly against the node, not against your wording — never right to be kind, "
			+ "a near-miss is partial understanding. Read `confidence` alongside the verdict: a CONFIDENT explanation with a gap is "
			+ "exactly the case that must not be waved through as a small tightening — high confidence raises your scrutiny, never "
			+ "lowers it. Only an explanation that holds up lets you move on. If it has a hole, name exactly ONE in prose — a term "
			+ "used as a stand-in, or a skipped step in the causal chain — point him at the fact or step in this node to look at "
			+ "again, never at the answer, then re-pose this for the same node and mode. Two retries at most; if the second still "
			+ "has a hole, give him the correct explanation yourself and move on.\n"
			+ "This is ordinary teaching, not a labeled ritual: never announce it, name it, or narrate why you are asking.",
	},
	validateAnswer(context) {
		const answer = context.answer;
		if (answer && answer.dontKnow === true) return undefined;
		const explanation = answer && answer.explanation;
		if (typeof explanation !== "string" || !explanation.trim()) return ["explanation must contain nonwhitespace text"];
		return undefined;
	},
};

exports.CONFIDENCE_STOPS = CONFIDENCE_STOPS;
exports.EXPLAIN_TOOL = EXPLAIN_TOOL;
exports.QUESTION_TYPE_ID = QUESTION_TYPE_ID;
