const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

/** Author-owned feature code: the host adds no special handling for any of this. */
const FORMAT_VERSION = 1;
const MAX_NAME = 80;
const MAX_FILES = 200;
const MAX_DEPTH = 4;
const AGENTS = ["prober", "teacher", "practice"];

/** Absolute, or ~/… — the same shape the app's own File access list accepts. */
const isFolderEntry = value => typeof value === "string" && (value.startsWith("/") || /^~[/\\]/.test(value)) && !value.includes("\0");
const expandHome = folder => (folder.startsWith("~/") || folder.startsWith("~\\") ? path.join(os.homedir(), folder.slice(2)) : folder);
const formatSize = bytes => (bytes >= 1024 * 1024 ? `${(bytes / (1024 * 1024)).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`);
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
			let size = 0;
			try { size = fs.statSync(full).size; } catch { size = 0; }
			decks.push({ label: path.relative(root, full), path: full, size });
		}
	};
	walk(root, 1);
	return { root, decks, truncated };
}

exports.activate = ctx => {
	const file = path.join(ctx.dataDirectory, "courses.json");

	const load = () => {
		let raw;
		try { raw = fs.readFileSync(file, "utf8"); }
		catch (error) { if (error.code === "ENOENT") return []; throw error; }
		const record = JSON.parse(raw);
		if (!record || typeof record !== "object" || !Array.isArray(record.courses)) throw new Error("Invalid course-material record");
		// A newer format is never rewritten or reinterpreted — the plugin owns this file.
		if (record.version !== FORMAT_VERSION) throw new Error(`Unsupported course-material format version ${record.version}`);
		return record.courses.map(course => {
			if (!course || typeof course.name !== "string" || typeof course.folder !== "string") throw new Error("Invalid course entry");
			return { name: course.name, folder: course.folder };
		});
	};

	let courses = load();
	let registrations = [];

	const persist = next => {
		fs.mkdirSync(ctx.dataDirectory, { recursive: true });
		const temporary = `${file}.tmp`;
		fs.writeFileSync(temporary, `${JSON.stringify({ version: FORMAT_VERSION, courses: next }, null, "\t")}\n`);
		fs.renameSync(temporary, file);
		courses = next;
	};

	/** Name resolution stays here rather than in the model: an exact
	 *  case-insensitive hit first, then a single unambiguous containment match. */
	const resolve = requested => {
		const wanted = requested.trim().toLowerCase();
		if (!wanted) return undefined;
		const exact = courses.find(course => course.name.trim().toLowerCase() === wanted);
		if (exact) return exact;
		const partial = courses.filter(course => course.name.toLowerCase().includes(wanted) || wanted.includes(course.name.toLowerCase()));
		return partial.length === 1 ? partial[0] : undefined;
	};

	const describe = (input, signal) => {
		if (ctx.signal.aborted || signal?.aborted) throw new Error("Course material is disabled or the turn was cancelled");
		const requested = object(input).course;
		if (typeof requested !== "string") throw new Error("course must be a string");
		const course = resolve(requested);
		if (!course) {
			return `No configured course matches "${requested}". The configured courses are: ${quoted(courses)}. `
				+ "Ask the learner which one this session is about, or teach without the slides — never substitute another folder.";
		}
		let listing;
		try { listing = listDecks(course.folder); }
		catch (error) {
			return `"${course.name}" is configured as ${expandHome(course.folder)}, but that folder cannot be read right now `
				+ `(${error instanceof Error ? error.message : String(error)}). Tell the learner the folder is missing or unreadable, `
				+ "and teach without the slides; do not look for the decks elsewhere.";
		}
		if (listing.decks.length === 0) {
			return `"${course.name}" — ${listing.root} holds no PDF files. PowerPoint cannot be read: if the slides are .pptx, the learner `
				+ "has to export them to PDF first. Say so, and teach without the slides until then.";
		}
		const rows = listing.decks.map(deck => `${deck.label} — ${deck.path} (${formatSize(deck.size)})`);
		return `"${course.name}" — ${listing.root}\n${listing.decks.length} PDF${listing.decks.length === 1 ? "" : "s"}`
			+ `${listing.truncated ? ` (listing capped at ${MAX_FILES})` : ""}:\n\n${rows.join("\n")}\n\n`
			+ "Read a deck with the `pdf` job, passing the path above plus the specific question you need answered. "
			+ "Non-PDF files are not listed; PowerPoint is not supported.";
	};

	/** One instruction block plus one tool, rebuilt whenever the course list
	 *  changes. With no course configured nothing is contributed at all, so an
	 *  installed-but-unconfigured plugin leaves every prompt exactly as it was. */
	const compose = () => {
		for (const unregister of registrations) unregister();
		registrations = [];
		if (courses.length === 0) return;
		const listing = courses.map(course => `- "${course.name}" — ${expandHome(course.folder)}`).join("\n");
		const courseNames = quoted(courses);
		registrations.push(ctx.registerInstructions({
			agents: AGENTS,
			text: "## Course material\n\n"
				+ "The learner has pointed these courses at folders of slide PDFs on this machine:\n\n"
				+ `${listing}\n\n`
				+ "When this session is about one of those courses — its title or the learner's own words name the course, or the learner "
				+ "says which course it is — that course's slides are the primary source, and everything else is secondary to them.\n\n"
				+ "1. Settle the course ONCE, at the start, and name it in one short clause so the learner can correct you. If nothing listed "
				+ "matches clearly, ask which course it is or teach normally — never guess a folder, never invent a course that is not listed.\n"
				+ "2. Call `course_material` ONCE for that course to get its deck list. Not again per plan node, per question or per fact: the "
				+ "list does not change mid-session, and the inventory is not the content.\n"
				+ "3. Read a deck with the native `pdf` job — one job per deck you actually need, each with the specific question you need "
				+ "answered, fire-and-forget exactly as usual. Never a job per fact, and never `read` on a PDF.\n"
				+ "4. Cite what the briefs give you, in the form they give it: the deck plus the page (\"lecture-04.pdf, p. 12\"). A claim you "
				+ "attribute to the slides must come from a brief you actually received — never cite a page you have not read.\n"
				+ "5. Say so in the same breath whenever you go beyond the slides: background they assume, a step they skip, your own example, "
				+ "a correction of something they get wrong or out of date. Going beyond them is allowed and often necessary; leaving it "
				+ "unmarked is not, because the learner is studying these decks and needs to know which part was on them.\n\n"
				+ "When no listed course fits this session, ignore all of the above and teach normally; do not mention this setup.",
		}));
		registrations.push(ctx.registerTools({
			agents: AGENTS,
			create() {
				return [{
					name: "course_material",
					label: "course material",
					description: `List the slide decks of one of the learner's configured courses (${courseNames}). `
						+ "Call it ONCE per session, before teaching from the slides, to learn which decks exist and where they are. "
						+ "It lists PDF files and does not read them: read a deck with the `pdf` job, giving it a path this tool returned.",
					parameters: {
						type: "object",
						properties: {
							course: { type: "string", description: `The configured course to list, named as the course-material instructions name it (${courseNames}).` },
						},
						required: ["course"],
						additionalProperties: false,
					},
					execute: async (_toolCallId, input, signal) => ({ content: [{ type: "text", text: describe(input, signal) }], details: null }),
				}];
			},
		}));
	};

	const state = () => courses.map(course => {
		const entry = { name: course.name, folder: course.folder, resolved: expandHome(course.folder) };
		try { entry.decks = listDecks(course.folder).decks.length; }
		catch (error) { entry.error = error instanceof Error ? error.message : String(error); }
		return entry;
	});

	ctx.handle("courses", () => state());
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
		persist([...courses, { name, folder }]);
		compose();
		return state();
	});
	ctx.handle("remove", input => {
		const value = object(input);
		const next = courses.filter(course => course.name !== value.name);
		if (next.length !== courses.length) { persist(next); compose(); }
		return state();
	});

	compose();
	ctx.cleanup(() => { for (const unregister of registrations) unregister(); registrations = []; });
};
