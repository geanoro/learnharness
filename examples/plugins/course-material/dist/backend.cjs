const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

/** Author-owned feature code: the host adds no special handling for any of this. */
const FORMAT_VERSION = 1;
const MAX_NAME = 80;
const MAX_FILES = 200;
const MAX_DEPTH = 4;
/** Context thrift: one call must never dump a whole archive into the lesson.
 *  Rows win over bytes for a short folder, bytes win for pathological paths. */
const MAX_ROWS = 60;
const MAX_OUTPUT_CHARS = 8000;
const AGENTS = ["prober", "teacher", "practice"];

/** Absolute, or ~/… — the same shape the app's own File access list accepts. */
const isFolderEntry = value => typeof value === "string" && (value.startsWith("/") || /^~[/\\]/.test(value)) && !value.includes("\0");
const expandHome = folder => (folder.startsWith("~/") || folder.startsWith("~\\") ? path.join(os.homedir(), folder.slice(2)) : folder);
const quoted = list => (list.length ? list.map(course => `"${course.name}"`).join(", ") : "none");
const printable = value => ![...value].some(character => { const code = character.codePointAt(0); return code < 0x20 || code === 0x7f; });
const object = value => {
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Expected an operation input object");
	return value;
};

/** PDFs only, hidden folders skipped, depth and count hard-capped: this is a
 *  one-call inventory for the model, not a file browser or a search index. */
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
	const coursesFile = path.join(ctx.dataDirectory, "courses.json");
	const sessionsFile = path.join(ctx.dataDirectory, "sessions.json");

	const readRecord = (file, key) => {
		let raw;
		try { raw = fs.readFileSync(file, "utf8"); }
		catch (error) { if (error.code === "ENOENT") return undefined; throw error; }
		const record = JSON.parse(raw);
		if (!record || typeof record !== "object") throw new Error(`Invalid course-material ${key} record`);
		// A newer format is never rewritten or reinterpreted — the plugin owns these files.
		if (record.version !== FORMAT_VERSION) throw new Error(`Unsupported course-material ${key} format version ${record.version}`);
		return record;
	};

	const loadCourses = () => {
		const record = readRecord(coursesFile, "courses");
		if (!record) return [];
		if (!Array.isArray(record.courses)) throw new Error("Invalid course-material courses record");
		return record.courses.map(course => {
			if (!course || typeof course.name !== "string" || typeof course.folder !== "string") throw new Error("Invalid course entry");
			return { name: course.name, folder: course.folder };
		});
	};

	/** chatId → what the learner ticked for that one session. An empty deck list
	 *  means the whole course; no entry at all means nothing is selected yet. */
	const loadSessions = () => {
		const record = readRecord(sessionsFile, "sessions");
		if (!record) return {};
		if (!record.sessions || typeof record.sessions !== "object" || Array.isArray(record.sessions)) throw new Error("Invalid course-material sessions record");
		const sessions = {};
		for (const [chatId, entry] of Object.entries(record.sessions)) {
			if (!entry || typeof entry.course !== "string" || !Array.isArray(entry.decks)) continue;
			sessions[chatId] = { course: entry.course, decks: entry.decks.filter(deck => typeof deck === "string") };
		}
		return sessions;
	};

	let courses = loadCourses();
	let sessions = loadSessions();
	let registrations = [];

	const writeAtomic = (file, data) => {
		fs.mkdirSync(ctx.dataDirectory, { recursive: true });
		const temporary = `${file}.tmp`;
		fs.writeFileSync(temporary, `${JSON.stringify(data, null, "\t")}\n`);
		fs.renameSync(temporary, file);
	};
	const persistCourses = next => { writeAtomic(coursesFile, { version: FORMAT_VERSION, courses: next }); courses = next; };
	const persistSessions = next => { writeAtomic(sessionsFile, { version: FORMAT_VERSION, sessions: next }); sessions = next; };

	/** Name resolution stays here rather than in the model: an exact
	 *  case-insensitive hit first, then a single unambiguous containment match. */
	const courseNames = () => quoted(courses);

	const resolve = requested => {
		const wanted = String(requested ?? "").trim().toLowerCase();
		if (!wanted) return undefined;
		const exact = courses.find(course => course.name.trim().toLowerCase() === wanted);
		if (exact) return exact;
		const partial = courses.filter(course => course.name.toLowerCase().includes(wanted) || wanted.includes(course.name.toLowerCase()));
		return partial.length === 1 ? partial[0] : undefined;
	};

	const PICKER = "the \"Course material\" button in this session's top bar";

	const render = (course, selected) => {
		let listing;
		try { listing = listDecks(course.folder); }
		catch (error) {
			return `"${course.name}" is configured as ${expandHome(course.folder)}, but that folder cannot be read right now `
				+ `(${error instanceof Error ? error.message : String(error)}). Tell the learner the folder is missing or unreadable, `
				+ "and teach without the slides; do not look for the decks elsewhere.";
		}
		const chosen = selected && selected.length
			? listing.decks.filter(deck => selected.includes(deck.label))
			: listing.decks;
		if (chosen.length === 0) {
			return selected && selected.length
				? `"${course.name}" — the decks the learner ticked are no longer in ${listing.root}. Say so and ask them to pick again with ${PICKER}.`
				: `"${course.name}" — ${listing.root} holds no PDF files. PowerPoint cannot be read: if the slides are .pptx, the learner `
					+ "has to export them to PDF first. Say so, and teach without the slides until then.";
		}
		const rows = [];
		let budget = MAX_OUTPUT_CHARS;
		for (const deck of chosen) {
			const row = deck.path;
			if (rows.length >= MAX_ROWS || budget - row.length < 0) break;
			budget -= row.length + 1;
			rows.push(row);
		}
		const hidden = chosen.length - rows.length;
		const scope = selected && selected.length
			? `${chosen.length} deck${chosen.length === 1 ? "" : "s"} ticked for this session`
			: `whole course, ${chosen.length} PDF${chosen.length === 1 ? "" : "s"}${listing.truncated ? `+ (walk capped at ${MAX_FILES})` : ""}`;
		return `"${course.name}" (${scope}):\n${rows.join("\n")}`
			+ (hidden > 0 ? `\n… and ${hidden} more — too many to teach from; ask the learner to tick today's decks with ${PICKER}.` : "")
			+ `\nOne \`pdf\` job per deck above. Nothing else is in scope; for another deck ask the learner to add it with ${PICKER}.`;
	};

	const describe = (chatId, input, signal) => {
		if (ctx.signal.aborted || signal?.aborted) throw new Error("Course material is disabled or the turn was cancelled");
		const selection = sessions[chatId];
		if (selection) {
			const course = resolve(selection.course);
			if (!course) {
				return `This session was pointed at the course "${selection.course}", which is no longer configured. `
					+ `Say so and ask the learner to pick again with ${PICKER}. The configured courses are: ${quoted(courses)}.`;
			}
			return render(course, selection.decks);
		}
		const requested = object(input).course;
		if (requested === undefined || requested === null || String(requested).trim() === "") {
			return courses.length === 0
				? "No course is configured. Teach normally and do not mention this setup."
				: `The learner has not picked a course for this session yet. The configured courses are: ${quoted(courses)}. `
					+ `Ask which one this session is about and to tick the decks with ${PICKER}, or teach without the slides — never guess a folder.`;
		}
		const course = resolve(requested);
		if (!course) {
			return `No configured course matches "${requested}". The configured courses are: ${quoted(courses)}. `
				+ `Ask the learner to pick with ${PICKER}, or teach without the slides — never substitute another folder.`;
		}
		return `${render(course, undefined)}\n\nThe learner has not ticked specific decks for this session; `
			+ `they can narrow it to today's lecture with ${PICKER}.`;
	};

	/** Nothing is contributed through `registerInstructions`, deliberately. That
	 *  API takes one static text used on EVERY matching turn, so a rule about a
	 *  course would be paid for in every session, including the ones that have
	 *  nothing to do with a course. `registerTools` is the only per-turn surface
	 *  the API offers — its factory receives this turn's frozen {chatId, agent} —
	 *  so the rules live in the tool's description, sized to what this session
	 *  actually selected: nothing at all without a configured course, one short
	 *  line when nothing is picked, the full block only where it applies. */
	const RULES = "Teach from those decks first.\n"
		+ "- One `pdf` job per deck listed above, each asking the one question you need of that deck. Never a job per fact.\n"
		+ "- When a later plan step is not covered by the briefs you already hold, you may send ONE more targeted job for that "
		+ "step. One per step at most.\n"
		+ `- Need a deck that is not listed? Ask the learner to add it with ${PICKER}; nothing outside it is in scope.\n`
		+ "- Cite the deck and page a brief gives you (\"lecture-04.pdf, p. 12\"), and never a page you have not read.\n"
		+ "- Say it in the same breath when you go past the slides: background they assume, a step they skip, your own example, "
		+ "a correction. Going beyond them is fine; leaving it unmarked is not.";

	const compose = () => {
		for (const unregister of registrations) unregister();
		registrations = [];
		if (courses.length === 0) return; // No course: not one token on any turn.
		registrations.push(ctx.registerTools({
			agents: AGENTS,
			create(context) {
				const chatId = context.chatId;
				const selection = sessions[chatId];
				return [{
					name: "course_material",
					label: "course material",
					description: selection
						? `The learner picked the course "${selection.course}" for this session and ticked which slide decks to use. `
							+ "Call this ONCE to list them — now, if you have not called it since they picked (an earlier call that found "
							+ "nothing does not count). It lists paths and never reads them.\n" + RULES
						: `The learner keeps courses of slide PDFs (${courseNames()}) and picks one per session, with ${PICKER}. `
							+ "Call this ONCE at the start to see whether they have. Nothing picked: say so in one line and ask them to "
							+ "pick, or to name the course — never guess, and do not call again until they pick.",
					parameters: {
						type: "object",
						properties: {
							course: { type: "string", description: "Only if the learner named a course without picking it." },
						},
						additionalProperties: false,
					},
					execute: async (_toolCallId, input, signal) => ({ content: [{ type: "text", text: describe(chatId, input ?? {}, signal) }], details: null }),
				}];
			},
		}));
	};

	const courseState = () => courses.map(course => {
		const entry = { name: course.name, folder: course.folder, resolved: expandHome(course.folder) };
		try { entry.decks = listDecks(course.folder).decks.length; }
		catch (error) { entry.error = error instanceof Error ? error.message : String(error); }
		return entry;
	});

	ctx.handle("courses", () => courseState());
	ctx.handle("add", input => {
		const value = object(input);
		const name = typeof value.name === "string" ? value.name.trim() : "";
		const folder = typeof value.folder === "string" ? value.folder.trim().replace(/[/\\]+$/, "") : "";
		if (!name) throw new Error("Give the course a name");
		if (name.length > MAX_NAME) throw new Error(`Keep the course name under ${MAX_NAME} characters`);
		if (!printable(name)) throw new Error("The course name cannot contain control characters");
		if (courses.some(course => course.name.trim().toLowerCase() === name.toLowerCase())) throw new Error(`"${name}" is already configured`);
		if (!isFolderEntry(folder)) throw new Error("Enter an absolute path or ~/folder");
		let stat;
		try { stat = fs.statSync(expandHome(folder)); }
		catch { throw new Error(`No such folder: ${expandHome(folder)}`); }
		if (!stat.isDirectory()) throw new Error(`Not a folder: ${expandHome(folder)}`);
		persistCourses([...courses, { name, folder }]);
		compose();
		return courseState();
	});
	ctx.handle("remove", input => {
		const value = object(input);
		const next = courses.filter(course => course.name !== value.name);
		if (next.length !== courses.length) { persistCourses(next); compose(); }
		return courseState();
	});

	/** The session picker's own operations. */
	ctx.handle("decks", input => {
		const course = resolve(object(input).course);
		if (!course) throw new Error("That course is not configured");
		const listing = listDecks(course.folder);
		return { course: course.name, root: listing.root, truncated: listing.truncated, decks: listing.decks.map(deck => ({ label: deck.label })) };
	});
	ctx.handle("selection", input => {
		const chatId = object(input).chatId;
		if (typeof chatId !== "string" || !chatId) throw new Error("A session id is required");
		return sessions[chatId] ?? null;
	});
	ctx.handle("select", input => {
		const value = object(input);
		if (typeof value.chatId !== "string" || !value.chatId) throw new Error("A session id is required");
		const course = resolve(value.course);
		if (!course) throw new Error("That course is not configured");
		const available = new Set(listDecks(course.folder).decks.map(deck => deck.label));
		const decks = Array.isArray(value.decks) ? value.decks.filter(deck => available.has(deck)) : [];
		const selection = { course: course.name, decks };
		persistSessions({ ...sessions, [value.chatId]: selection });
		return selection;
	});
	ctx.handle("clear", input => {
		const value = object(input);
		if (typeof value.chatId !== "string" || !value.chatId) throw new Error("A session id is required");
		if (!(value.chatId in sessions)) return null;
		const next = { ...sessions };
		delete next[value.chatId];
		persistSessions(next);
		return null;
	});

	compose();
	ctx.cleanup(() => { for (const unregister of registrations) unregister(); registrations = []; });
};
