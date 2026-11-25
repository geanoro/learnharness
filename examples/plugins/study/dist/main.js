/**
 * Study — the plugin's three frontend surfaces, in one file because only
 * `manifest.main` and `manifest.styles` are publicly served (a sibling import
 * would 404):
 *
 *  - ONE settings page: the Logseq server, the explain-back switch, and the
 *    shared course list where a course gets its slides folder and its Logseq
 *    `[[COURSE]]` name,
 *  - a "Study" button in each session's top bar, where the learner picks the
 *    course for THAT session, ticks the decks, and turns their notes on,
 *  - the explain-back answer box and its saved record.
 *
 * Every class name here is one the installed app already emits for its own UI.
 * A plugin cannot ship new Tailwind utilities, so borrowing the host's own
 * strings is what makes these surfaces native rather than approximately native.
 */

const ROW = "flex items-center justify-between gap-4 py-1";
const LABEL = "block font-prose text-(length:--lh-prose-size)";
const HINT = "block text-xs text-muted-foreground/70";
const FIELD = "min-w-0 flex-1 rounded-sm border border-border bg-background px-2 py-1 font-ui text-xs";
const BUTTON = "rounded-sm border border-border px-2 text-xs disabled:opacity-40";
const PICK = "min-w-0 flex-1 truncate rounded-sm border border-border bg-background px-2 py-1 text-left font-ui text-xs";
const ENTRY = "flex items-center justify-between gap-4 pl-3 text-xs";
const REMOVE = "rounded-sm px-1.5 text-muted-foreground hover:text-foreground";
const HEADING = "text-sm uppercase tracking-widest text-foreground";
const CHECK = "flex items-center gap-2 text-xs";
const MUTED = "text-xs text-muted-foreground";
const NOTE = "pl-3 text-xs text-muted-foreground";

// ── the explain-back box ────────────────────────────────────────────────────
// The look below is reimplemented, not imported: components/confidence-rail.tsx
// and the "Your answer" composer-twin field in components/question-dock.tsx are
// core-internal, not part of the public plugin SDK. Their classNames are
// ordinary Tailwind utilities already compiled into the app's stylesheet from
// the host's own use of them, so the same strings reproduce the same look.
const CONFIDENCE_STOPS = [0, 30, 50, 70, 90, 100];
const CONFIDENCE_COLORS = ["#ef4444", "#f97316", "#eab308", "#84cc16", "#22c55e", "#10b981"];
const DEFAULT_CONFIDENCE_INDEX = 2;
const TICK_COLOR = "color-mix(in oklab, var(--foreground) 35%, transparent)";
const EXPLANATION_MAX = 2000;

const ANSWER_FIELD_WRAP = "rounded-[10px] border border-border/70 bg-background/60 transition-colors focus-within:border-primary/50";
const ANSWER_FIELD_LABEL = "px-2.5 pt-2 text-xs font-medium uppercase tracking-wide text-muted-foreground";
const ANSWER_FIELD_INPUT = "field-sizing-content lh-input max-h-48 min-h-10 w-full resize-none bg-transparent px-2.5 py-2 outline-none placeholder:text-muted-foreground";
// Same literal strings as the native quiz option row/mark (question-dock.tsx):
// the "I don't know" row is one of the options there; there is no options list
// here to borrow a position from, so DONT_KNOW_WRAP (margin only) is this
// plugin's own choice.
const DONT_KNOW_WRAP = "mt-2";
const QC_OPTION_ROW = "flex items-center gap-3 rounded-lg border px-3 py-2 text-left text-sm outline-none transition-colors";
const QC_OPTION_MARK = "flex size-4 shrink-0 items-center justify-center border";
const CONFIDENCE_ROW_PAD = "pt-1.5 pb-3.5";
const CONFIDENCE_ROW = "flex items-center gap-3";
const CONFIDENCE_LABEL = "shrink-0 text-xs font-medium uppercase tracking-wide";
const CONFIDENCE_TRACK = "relative h-4 min-w-0 flex-1";
const CONFIDENCE_RAIL_OVERLAY = "pointer-events-none absolute top-1/2 left-2 right-2 h-1.5 -translate-y-1/2 rounded-full border border-border";
const CONFIDENCE_SLIDER = "absolute inset-0 h-4 w-full cursor-pointer appearance-none bg-transparent outline-none "
	+ "[&::-webkit-slider-runnable-track]:h-4 [&::-webkit-slider-runnable-track]:bg-transparent "
	+ "[&::-webkit-slider-thumb]:size-4 [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:bg-current "
	+ "[&::-moz-range-track]:h-4 [&::-moz-range-track]:bg-transparent "
	+ "[&::-moz-range-thumb]:size-4 [&::-moz-range-thumb]:appearance-none [&::-moz-range-thumb]:rounded-full [&::-moz-range-thumb]:border-0 [&::-moz-range-thumb]:bg-current";
const CONFIDENCE_VALUE = "w-[4ch] shrink-0 text-center font-mono text-sm tabular-nums";
const STATIC_RAIL = "h-1.5 w-full rounded-full border border-border min-w-0 flex-1";
const ANSWERED_ROW = "mt-3 flex items-center gap-3";
const ANSWERED_TEXT = "lh-prose mt-2 whitespace-pre-wrap";
const ANSWERED_DONT_KNOW = "mt-2 text-sm text-muted-foreground";

function nearestStopIndex(value) {
	let best = 0;
	for (let i = 1; i < CONFIDENCE_STOPS.length; i++) if (Math.abs(CONFIDENCE_STOPS[i] - value) < Math.abs(CONFIDENCE_STOPS[best] - value)) best = i;
	return best;
}

/** Same paint as components/confidence-rail.tsx's confidenceRailStyle. */
function paintRail(element, value) {
	const color = CONFIDENCE_COLORS[CONFIDENCE_STOPS.indexOf(value)] ?? CONFIDENCE_COLORS[DEFAULT_CONFIDENCE_INDEX];
	element.style.backgroundColor = "var(--background)";
	element.style.backgroundImage = [
		`linear-gradient(90deg, ${color} 0%, ${color} ${value}%, transparent ${value}%, transparent 100%)`,
		...[30, 50, 70, 90].map(() => `linear-gradient(90deg, ${TICK_COLOR}, ${TICK_COLOR})`),
	].join(", ");
	element.style.backgroundSize = ["100% 100%", "1px 100%", "1px 100%", "1px 100%", "1px 100%"].join(", ");
	element.style.backgroundPosition = ["0 0", ...[30, 50, 70, 90].map(p => `${p}% 0`)].join(", ");
	element.style.backgroundRepeat = "no-repeat";
}

function readValue(answer) {
	if (answer && answer.status !== "empty" && answer.value && typeof answer.value === "object") return answer.value;
	return null;
}

// ── shared helpers ──────────────────────────────────────────────────────────

function maker(container) {
	const document = container.ownerDocument;
	return (tag, className, parent, text) => {
		const node = document.createElement(tag);
		if (className) node.className = className;
		if (text !== undefined) node.textContent = text;
		parent.append(node);
		return node;
	};
}

/** The desktop app resolves a renderer-supplied File to its real path — the
 *  same bridge the composer's attachments use (components/attach-files-button.tsx).
 *  Absent in the browser and the dev preview, where paths stay unknown. */
const pathResolver = () => (typeof window === "undefined" ? undefined : window.lh?.getPathForFile);

const relativeLabel = file => (file.webkitRelativePath || file.name).split("/").slice(1).join("/") || file.name;

/**
 * Open the OS folder chooser and return the folder's absolute path plus its
 * files. This is a native directory input — the same control the host's own
 * Extract files… → Folder uses (components/notes-import.tsx) — so the plugin
 * gets real `File` objects, which is the only input `ctx.documents.toMarkdown`
 * accepts. The absolute path is then derived from one file, because the browser
 * never exposes a directory path by itself.
 */
function chooseFolder(document) {
	return new Promise(resolve => {
		const input = document.createElement("input");
		input.type = "file";
		input.setAttribute("webkitdirectory", "");
		input.setAttribute("data-testid", "study-folder-input");
		input.style.display = "none";
		document.body.append(input);
		const finish = value => { input.remove(); resolve(value); };
		input.addEventListener("cancel", () => finish(null), { once: true });
		input.addEventListener("change", () => {
			const files = Array.from(input.files ?? []);
			if (!files.length) return finish(null);
			finish({ root: rootOf(files), files });
		}, { once: true });
		input.click();
	});
}

/** The chosen folder's absolute path, or "" where the bridge is absent. */
function rootOf(files) {
	const resolve = pathResolver();
	if (!resolve) return "";
	for (const file of files) {
		const relative = (file.webkitRelativePath || "").split("/").slice(1).join("/");
		let absolute = "";
		try { absolute = resolve(file); } catch { continue; }
		if (!absolute) continue;
		if (!relative) return absolute.replace(/[/\\][^/\\]*$/, "");
		for (const separator of ["/", "\\"]) {
			const suffix = `${separator}${relative.split("/").join(separator)}`;
			if (absolute.endsWith(suffix)) return absolute.slice(0, -suffix.length);
		}
	}
	return "";
}

/**
 * Convert and store one deck at a time. The host allows exactly ONE document
 * conversion process-wide and fails fast as busy with no queue
 * (docs/plugin-authoring.md), so this is sequential by necessity, not by
 * preference, and retries a busy slot once before giving up on that deck.
 * A deck that cannot be converted — a scan, an over-size file — is reported and
 * skipped; the rest of the course still gets indexed.
 */
async function indexDecks(ctx, { course, files, labels, onProgress, alive }) {
	const wanted = files.filter(file => labels.has(relativeLabel(file)));
	const failures = [];
	let done = 0;
	for (const file of wanted) {
		if (!alive()) return { done, total: wanted.length, failures };
		const label = relativeLabel(file);
		onProgress(`Reading ${label} — ${done + 1} of ${wanted.length}…`);
		try {
			let converted;
			try { converted = await ctx.documents.toMarkdown(file); }
			catch (error) {
				if (!/busy/i.test(error instanceof Error ? error.message : String(error))) throw error;
				await new Promise(wake => setTimeout(wake, 400));
				converted = await ctx.documents.toMarkdown(file);
			}
			if (!alive()) return { done, total: wanted.length, failures };
			await ctx.call("putIndex", { course, label, markdown: converted.markdown, notices: converted.notices, size: file.size });
			done += 1;
		} catch (error) {
			failures.push(`${label}: ${error instanceof Error ? error.message : String(error)}`);
		}
	}
	return { done, total: wanted.length, failures };
}

export function activate(ctx) {
	// ── the one settings page ───────────────────────────────────────────────
	ctx.registerSettings((container, signal) => {
		const element = maker(container);
		const document = container.ownerDocument;
		let alive = !signal.aborted;
		const onAbort = () => { alive = false; };
		signal.addEventListener("abort", onAbort, { once: true });

		const root = element("div", "flex flex-col gap-3", container);
		element("p", MUTED, root,
			"One plugin for the whole study loop. A course remembers the folder its slides live in and the name its notes use in "
			+ "Logseq, so you never retype either. In a session, the Study button in the top bar is where you pick the course, "
			+ "tick today's decks and turn your notes on.");

		const message = element("p", "text-xs text-error", root, "");
		message.setAttribute("role", "alert");
		const fail = error => { if (alive) message.textContent = error instanceof Error ? error.message : String(error); };
		const clearMessage = () => { message.textContent = ""; };

		// ── courses ───────────────────────────────────────────────────────────
		const block = element("div", "flex flex-col gap-2", root);
		const heading = element("div", ROW, block);
		const labels = element("span", "min-w-0", heading);
		element("span", LABEL, labels, "Courses");
		element("span", HINT, labels,
			"Each course points at a folder of slide PDFs. PowerPoint is not supported — export .pptx to PDF first.");

		const form = element("div", "flex gap-2 pl-3", block);
		const name = element("input", FIELD, form);
		name.setAttribute("aria-label", "Course name");
		name.placeholder = "Course name";
		const logseqName = element("input", FIELD, form);
		logseqName.setAttribute("aria-label", "Logseq course name");
		logseqName.placeholder = "Logseq [[COURSE]]";

		const resolver = pathResolver();
		let picked = "";
		let pickedFiles = [];
		let typedFolder;
		let pick;
		if (resolver) {
			pick = element("button", PICK, form, "Choose folder…");
			pick.type = "button";
			pick.setAttribute("aria-label", "Slides folder");
			pick.onclick = () => {
				clearMessage();
				void (async () => {
					const chosen = await chooseFolder(document);
					if (!alive || !chosen) return; // Cancelling changes nothing.
					if (!chosen.root) { fail(new Error("Could not read that folder's path. Try again.")); return; }
					picked = chosen.root;
					pickedFiles = chosen.files;
					pick.textContent = chosen.root;
					pick.title = chosen.root;
					syncAdd();
				})();
			};
		} else {
			typedFolder = element("input", FIELD, form);
			typedFolder.setAttribute("aria-label", "Slides folder");
			typedFolder.placeholder = "Absolute path or ~/folder";
		}
		const add = element("button", BUTTON, form, "Add course");
		add.type = "button";
		add.disabled = true;

		const progress = element("p", NOTE, block, "");
		progress.setAttribute("data-testid", "study-progress");
		const list = element("div", "flex flex-col gap-2", block);

		const folderValue = () => (typedFolder ? typedFolder.value.trim() : picked);
		const syncAdd = () => { add.disabled = !alive || !name.value.trim() || !folderValue(); };

		// ── Logseq ────────────────────────────────────────────────────────────
		const logseqBlock = element("div", "flex flex-col gap-2", root);
		const logseqHeading = element("div", ROW, logseqBlock);
		const logseqLabels = element("span", "min-w-0", logseqHeading);
		element("span", LABEL, logseqLabels, "Logseq notes");
		element("span", HINT, logseqLabels,
			"Read-only, over the Logseq app's own local MCP server — it answers only while Logseq is open.");
		const logseqForm = element("div", "flex gap-2 pl-3", logseqBlock);
		const serverUrl = element("input", FIELD, logseqForm);
		serverUrl.setAttribute("aria-label", "Logseq MCP server URL");
		const token = element("input", FIELD, logseqForm);
		token.type = "password";
		token.setAttribute("aria-label", "Logseq MCP token");
		token.placeholder = "Token";
		const saveLogseq = element("button", BUTTON, logseqForm, "Save");
		saveLogseq.type = "button";
		const testLogseq = element("button", BUTTON, logseqForm, "Test");
		testLogseq.type = "button";
		const logseqStatus = element("p", NOTE, logseqBlock, "");
		logseqStatus.setAttribute("data-testid", "study-logseq-status");

		// ── explain-back ──────────────────────────────────────────────────────
		const explainRow = element("label", `${ROW} pl-3`, root);
		const explainLabels = element("span", "min-w-0", explainRow);
		element("span", LABEL, explainLabels, "Explain-back checkpoint");
		element("span", HINT, explainLabels,
			"Offers the explain-back box when a plan node closes. Off removes it, and its rules, from every turn.");
		const explainBack = element("input", "accent-primary", explainRow);
		explainBack.type = "checkbox";

		const render = state => {
			if (!alive) return;
			serverUrl.placeholder = state.logseq.defaultUrl;
			if (document.activeElement !== serverUrl) serverUrl.value = state.logseq.serverUrl;
			token.placeholder = state.logseq.hasToken ? "Token saved — type to replace" : "Token";
			explainBack.checked = state.explainBack !== false;
			list.replaceChildren();
			if (!state.courses.length) {
				element("p", NOTE, list, "No course yet. Add one above and the teacher will use it.");
				return;
			}
			for (const course of state.courses) {
				const entry = element("div", ENTRY, list);
				const texts = element("span", "min-w-0", entry);
				element("span", "block truncate font-ui", texts, course.name);
				const where = element("span", "block truncate font-ui text-muted-foreground", texts, course.resolved ?? course.folder);
				where.title = course.resolved ?? course.folder;
				const right = element("span", "flex shrink-0 items-center gap-2", entry);
				if (course.error) element("span", "text-error", right, "folder unreadable");
				else element("span", "tabular-nums text-muted-foreground", right,
					`${course.indexed ?? 0}/${course.decks ?? 0} indexed`);

				const logseqField = element("input", `${FIELD} max-w-[12rem]`, right);
				logseqField.value = course.logseq ?? "";
				logseqField.placeholder = "Logseq [[COURSE]]";
				logseqField.setAttribute("aria-label", `Logseq name for ${course.name}`);
				logseqField.onchange = () => {
					clearMessage();
					void (async () => {
						try { render(await ctx.call("updateCourse", { name: course.name, logseq: logseqField.value })); }
						catch (error) { fail(error); }
					})();
				};

				const reindex = element("button", BUTTON, right, "Index");
				reindex.type = "button";
				reindex.setAttribute("aria-label", `Index ${course.name}`);
				reindex.onclick = () => {
					clearMessage();
					void (async () => {
						try {
							const chosen = await chooseFolder(document);
							if (!alive || !chosen) return;
							await runIndex(course.name, chosen.files);
						} catch (error) { fail(error); }
					})();
				};

				const remove = element("button", REMOVE, right, "Remove");
				remove.type = "button";
				remove.setAttribute("aria-label", `Remove ${course.name}`);
				remove.onclick = () => {
					clearMessage();
					remove.disabled = true;
					void (async () => {
						try { render(await ctx.call("removeCourse", { name: course.name })); }
						catch (error) { fail(error); if (alive) remove.disabled = false; }
					})();
				};
			}
		};

		/** Index what the learner just chose, reporting deck by deck. */
		const runIndex = async (course, files) => {
			const listing = await ctx.call("decks", { course });
			if (!alive) return;
			const labels = new Set(listing.decks.map(deck => deck.label));
			if (!files.some(file => labels.has(relativeLabel(file)))) {
				progress.textContent = "";
				fail(new Error(`That folder holds none of "${course}"'s decks. Choose the course's own slides folder.`));
				return;
			}
			const result = await indexDecks(ctx, {
				course, files, labels, alive: () => alive,
				onProgress: line => { if (alive) progress.textContent = line; },
			});
			if (!alive) return;
			progress.textContent = `Indexed ${result.done} of ${result.total} deck(s).`;
			if (result.failures.length) fail(new Error(`Not indexed — ${result.failures.join("; ")}`));
			render(await ctx.call("state"));
		};

		add.onclick = () => {
			clearMessage();
			add.disabled = true;
			void (async () => {
				const course = name.value.trim();
				try {
					const state = await ctx.call("addCourse", { name: course, folder: folderValue(), logseq: logseqName.value });
					if (!alive) return;
					render(state);
					// The folder pick already handed us its files, so the index is built
					// from that same gesture rather than asking for the folder twice.
					if (pickedFiles.length) await runIndex(course, pickedFiles);
					if (!alive) return;
					name.value = "";
					logseqName.value = "";
					picked = "";
					pickedFiles = [];
					if (typedFolder) typedFolder.value = "";
					if (pick) { pick.textContent = "Choose folder…"; pick.removeAttribute("title"); }
				} catch (error) { fail(error); }
				finally { syncAdd(); }
			})();
		};
		for (const field of [name, logseqName, ...(typedFolder ? [typedFolder] : [])]) {
			field.oninput = () => { clearMessage(); syncAdd(); };
			field.onkeydown = event => { if (event.key === "Enter") { event.preventDefault(); if (!add.disabled) add.onclick(); } };
		}

		saveLogseq.onclick = () => {
			clearMessage();
			logseqStatus.textContent = "";
			void (async () => {
				try {
					// An empty token field keeps the saved one: the field never shows it,
					// so saving a URL must not wipe it.
					const input = { serverUrl: serverUrl.value };
					if (token.value.trim()) input.token = token.value;
					const state = await ctx.call("setLogseq", input);
					if (!alive) return;
					token.value = "";
					render(state);
					logseqStatus.textContent = "Saved.";
				} catch (error) { fail(error); }
			})();
		};
		testLogseq.onclick = () => {
			clearMessage();
			logseqStatus.textContent = "Testing…";
			void (async () => {
				try {
					const result = await ctx.call("testLogseq");
					if (alive) logseqStatus.textContent = result.message;
				} catch (error) { fail(error); if (alive) logseqStatus.textContent = ""; }
			})();
		};
		explainBack.onchange = () => {
			clearMessage();
			void (async () => {
				try { render(await ctx.call("setExplainBack", { enabled: explainBack.checked })); }
				catch (error) { fail(error); }
			})();
		};

		if (!resolver) {
			element("p", NOTE, block,
				"Folders can only be chosen from the desktop app, which opens the same picker as the composer's paperclip. "
				+ "Type the full path here instead; Index still works from the button on each course.");
		}
		element("p", MUTED, root,
			"Indexing reads each deck's text once through the app's own PDF conversion, so the teacher can be given the slides' "
			+ "own words with a page number instead of a summary. Image-only slides carry no text and stay outside the index: "
			+ "the teacher reads those with a pdf job. Reading the slides still goes through the app's own file access — if "
			+ "Settings → Agent restricts it to listed folders, add the course folder there too.");

		void (async () => {
			try { render(await ctx.call("state")); }
			catch (error) { fail(error); }
		})();

		return () => {
			alive = false;
			signal.removeEventListener("abort", onAbort);
			// Remove only this mount's own subtree. The host may mount twice (React's
			// development double-invoke) and deliver the first cleanup after the second
			// mount has already drawn: clearing the container would erase it.
			root.remove();
		};
	});

	// ── the per-session picker ──────────────────────────────────────────────
	/** Its context carries this session's id, which is the same chat id the
	 *  backend's per-turn tool factory sees, so what is ticked here is exactly
	 *  what the librarian answers for in this session — and only this one. */
	const mountPicker = (chatId) => (container, signal) => {
		const element = maker(container);
		const document = container.ownerDocument;
		let alive = !signal.aborted;
		const onAbort = () => { alive = false; };
		signal.addEventListener("abort", onAbort, { once: true });

		const root = element("div", "flex flex-col gap-3", container);
		element("h2", HEADING, root, "Study");
		element("p", MUTED, root,
			"Pick the course this session is about, then tick the decks to teach from — today's lecture, say. The teacher reads "
			+ "only those, through the librarian, and cites the deck and page. Nothing is sent to the teacher until you pick.");
		const message = element("p", "text-xs text-error", root, "");
		message.setAttribute("role", "alert");
		const courseList = element("div", "flex flex-col gap-2", root);
		const deckList = element("div", "flex flex-col gap-2", root);
		const notesRow = element("div", "flex flex-col gap-2", root);
		const progress = element("p", NOTE, root, "");
		progress.setAttribute("data-testid", "study-picker-progress");
		const actions = element("div", "flex gap-2", root);
		const save = element("button", BUTTON, actions, "Use these decks");
		save.type = "button";
		save.disabled = true;
		const clear = element("button", BUTTON, actions, "Clear selection");
		clear.type = "button";

		let state = { courses: [], logseq: { hasToken: false } };
		let chosen = null;
		let decks = [];
		let ticked = new Set();
		let notes = false;

		const fail = error => { if (alive) message.textContent = error instanceof Error ? error.message : String(error); };

		const renderNotes = () => {
			if (!alive) return;
			notesRow.replaceChildren();
			if (!chosen) return;
			if (!state.logseq.hasToken) {
				element("p", NOTE, notesRow, "Logseq notes: add the server token in Settings → Community plugins → Study to use them.");
				return;
			}
			const label = element("label", `${CHECK} pl-3`, notesRow);
			const box = element("input", "accent-primary", label);
			box.type = "checkbox";
			box.checked = notes;
			box.setAttribute("data-testid", "study-notes-toggle");
			box.onchange = () => { notes = box.checked; };
			const course = state.courses.find(entry => entry.name === chosen);
			element("span", "min-w-0 truncate font-ui", label,
				`Use my Logseq notes${course?.logseq ? ` for [[${course.logseq}]]` : ""}`);
		};

		const renderDecks = () => {
			if (!alive) return;
			deckList.replaceChildren();
			save.disabled = !chosen;
			if (!chosen) return;
			if (!decks.length) {
				element("p", NOTE, deckList, "That folder holds no PDF files. PowerPoint is not supported — export .pptx to PDF first.");
				save.disabled = true;
				return;
			}
			const unindexed = decks.filter(deck => !deck.indexed);
			element("p", NOTE, deckList,
				ticked.size === 0 ? "Nothing ticked: the whole course is in scope." : `${ticked.size} of ${decks.length} ticked.`);
			for (const deck of decks) {
				const label = element("label", `${CHECK} pl-3`, deckList);
				const box = element("input", "accent-primary", label);
				box.type = "checkbox";
				box.checked = ticked.has(deck.label);
				box.onchange = () => {
					if (box.checked) ticked.add(deck.label); else ticked.delete(deck.label);
					renderDecks();
				};
				element("span", "min-w-0 truncate font-ui", label, deck.label);
				element("span", "tabular-nums text-muted-foreground", label,
					deck.indexed ? `${deck.pages} page${deck.pages === 1 ? "" : "s"}` : "not indexed");
			}
			if (unindexed.length) {
				const row = element("div", "flex items-center gap-2 pl-3", deckList);
				element("span", MUTED, row,
					`${unindexed.length} deck${unindexed.length === 1 ? "" : "s"} not indexed yet — the librarian cannot search ${unindexed.length === 1 ? "it" : "them"}.`);
				const index = element("button", BUTTON, row, "Index");
				index.type = "button";
				index.onclick = () => {
					message.textContent = "";
					void (async () => {
						try {
							const chosenFolder = await chooseFolder(document);
							if (!alive || !chosenFolder) return;
							const labels = new Set(decks.map(deck => deck.label));
							if (!chosenFolder.files.some(file => labels.has(relativeLabel(file)))) {
								fail(new Error(`That folder holds none of "${chosen}"'s decks. Choose the course's own slides folder.`));
								return;
							}
							const result = await indexDecks(ctx, {
								course: chosen, files: chosenFolder.files, labels, alive: () => alive,
								onProgress: line => { if (alive) progress.textContent = line; },
							});
							if (!alive) return;
							progress.textContent = `Indexed ${result.done} of ${result.total} deck(s).`;
							if (result.failures.length) fail(new Error(`Not indexed — ${result.failures.join("; ")}`));
							await loadDecks(chosen);
						} catch (error) { fail(error); }
					})();
				};
			}
		};

		const loadDecks = async (course) => {
			try {
				const listing = await ctx.call("decks", { course });
				if (!alive || chosen !== course) return;
				decks = listing.decks;
				renderDecks();
			} catch (error) { fail(error); decks = []; renderDecks(); }
		};

		const renderCourses = () => {
			if (!alive) return;
			courseList.replaceChildren();
			if (!state.courses.length) {
				element("p", MUTED, courseList, "No course configured yet. Add one in Settings → Community plugins → Study.");
				return;
			}
			for (const course of state.courses) {
				const label = element("label", CHECK, courseList);
				const radio = element("input", "accent-primary", label);
				radio.type = "radio";
				radio.name = "study-course";
				radio.checked = chosen === course.name;
				radio.onchange = () => {
					chosen = course.name;
					ticked = new Set();
					decks = [];
					renderCourses();
					renderDecks();
					renderNotes();
					void loadDecks(course.name);
				};
				element("span", "min-w-0 truncate font-ui", label, course.name);
				if (course.error) element("span", "text-error", label, "folder unreadable");
				else element("span", "tabular-nums text-muted-foreground", label, `${course.indexed ?? 0}/${course.decks ?? 0} indexed`);
			}
		};

		save.onclick = () => {
			message.textContent = "";
			save.disabled = true;
			void (async () => {
				try { await ctx.call("select", { chatId, course: chosen, decks: [...ticked], notes }); }
				catch (error) { fail(error); }
				finally { if (alive) renderDecks(); }
			})();
		};
		clear.onclick = () => {
			message.textContent = "";
			void (async () => {
				try {
					await ctx.call("clear", { chatId });
					if (!alive) return;
					chosen = null;
					ticked = new Set();
					decks = [];
					notes = false;
					renderCourses();
					renderDecks();
					renderNotes();
				} catch (error) { fail(error); }
			})();
		};

		void (async () => {
			try {
				const [loaded, selection] = await Promise.all([ctx.call("state"), ctx.call("selection", { chatId })]);
				if (!alive) return;
				state = loaded;
				if (selection) {
					chosen = selection.course;
					ticked = new Set(selection.decks);
					notes = selection.notes === true;
				}
				renderCourses();
				renderDecks();
				renderNotes();
				if (chosen) await loadDecks(chosen);
			} catch (error) { fail(error); }
		})();

		return () => {
			alive = false;
			signal.removeEventListener("abort", onAbort);
			root.remove(); // This mount's own subtree only; see the settings mount.
		};
	};

	ctx.registerAction({
		id: "pick",
		name: "Study",
		run(context) {
			if (context.surface !== "session") return;
			ctx.ui.openDialog({ title: "Study", content: mountPicker(context.sessionId) }, { signal: ctx.signal });
		},
	});
	ctx.placeAction({ id: "session-pick", actionId: "pick", location: "top-bar", sessions: ["teaching", "practice"] });

	// ── the explain-back box ────────────────────────────────────────────────
	ctx.registerQuestionRenderer({
		id: "study-explain",
		supportedContractVersions: [1],
		mountAnswerEditor(container, props) {
			const doc = container.ownerDocument;
			const initial = readValue(props.answer);
			let index = typeof initial?.confidence === "number" && CONFIDENCE_STOPS.includes(initial.confidence)
				? CONFIDENCE_STOPS.indexOf(initial.confidence) : DEFAULT_CONFIDENCE_INDEX;
			let dontKnow = initial?.dontKnow === true;
			let active = props.active;

			const field = doc.createElement("div");
			field.setAttribute("data-testid", "answer-field");
			field.className = ANSWER_FIELD_WRAP;
			const label = doc.createElement("div");
			label.className = ANSWER_FIELD_LABEL;
			label.textContent = "Your answer";
			const textarea = doc.createElement("textarea");
			textarea.setAttribute("data-testid", "study-explanation-input");
			textarea.rows = 4;
			textarea.className = ANSWER_FIELD_INPUT;
			textarea.maxLength = EXPLANATION_MAX;
			textarea.value = typeof initial?.explanation === "string" ? initial.explanation : "";
			textarea.placeholder = props.input.payload && props.input.payload.mode === "short"
				? "One sentence, in your own words, no terms the teacher used."
				: "3-5 lines, in your own words, as if to a friend — no terms the teacher used.";
			field.append(label, textarea);
			container.append(field);

			// Same literal row/mark classes as the native quiz "I don't know" option
			// (components/question-dock.tsx), so it reads as the identical control —
			// just outside the options list this box does not have.
			const dontKnowRow = doc.createElement("div");
			dontKnowRow.className = DONT_KNOW_WRAP;
			const dontKnowButton = doc.createElement("button");
			dontKnowButton.type = "button";
			dontKnowButton.setAttribute("data-testid", "study-dont-know");
			const dontKnowMark = doc.createElement("span");
			const dontKnowDot = doc.createElement("span");
			dontKnowDot.className = "size-1.5 rounded-full bg-current";
			dontKnowMark.append(dontKnowDot);
			const dontKnowLabel = doc.createElement("span");
			dontKnowLabel.textContent = "I don't know";
			dontKnowButton.append(dontKnowMark, dontKnowLabel);
			dontKnowRow.append(dontKnowButton);
			container.append(dontKnowRow);

			const confidenceRow = doc.createElement("div");
			confidenceRow.setAttribute("data-question-confidence", "");
			confidenceRow.className = CONFIDENCE_ROW_PAD;
			const inner = doc.createElement("div");
			inner.className = CONFIDENCE_ROW;
			const confidenceLabel = doc.createElement("span");
			confidenceLabel.textContent = "Confidence";
			const track = doc.createElement("div");
			track.setAttribute("data-testid", "confidence-track");
			const rail = doc.createElement("div");
			rail.setAttribute("aria-hidden", "true");
			rail.setAttribute("data-testid", "confidence-rail");
			rail.className = CONFIDENCE_RAIL_OVERLAY;
			const slider = doc.createElement("input");
			slider.type = "range";
			slider.min = "0"; slider.max = "100"; slider.step = "1";
			slider.setAttribute("aria-label", "Confidence — the probability your explanation holds up");
			slider.title = "How sure you are this explanation holds up — 50% is a coin flip.";
			slider.setAttribute("data-testid", "confidence-slider");
			slider.className = CONFIDENCE_SLIDER;
			const valueLabel = doc.createElement("span");
			valueLabel.setAttribute("data-testid", "confidence-value");
			const paint = () => {
				paintRail(rail, CONFIDENCE_STOPS[index]);
				slider.value = String(CONFIDENCE_STOPS[index]);
				slider.style.color = CONFIDENCE_COLORS[index];
				confidenceLabel.className = `${CONFIDENCE_LABEL} ${dontKnow ? "text-muted-foreground/50" : "text-muted-foreground"}`;
				track.className = dontKnow ? `${CONFIDENCE_TRACK} opacity-40` : CONFIDENCE_TRACK;
				slider.disabled = !active || dontKnow;
				valueLabel.className = dontKnow ? `${CONFIDENCE_VALUE} text-muted-foreground/50` : CONFIDENCE_VALUE;
				valueLabel.textContent = dontKnow ? "—" : `${CONFIDENCE_STOPS[index]}%`;
			};
			track.append(rail, slider);
			inner.append(confidenceLabel, track, valueLabel);
			confidenceRow.append(inner);
			container.append(confidenceRow);

			const renderDontKnow = () => {
				textarea.disabled = !active || dontKnow;
				dontKnowButton.disabled = !active;
				dontKnowButton.setAttribute("aria-pressed", String(dontKnow));
				dontKnowButton.className = `${QC_OPTION_ROW} border-dashed ${dontKnow ? "border-primary text-foreground" : "text-muted-foreground"}`;
				dontKnowMark.className = `${QC_OPTION_MARK} rounded-full ${dontKnow ? "border-primary bg-primary text-primary-foreground" : "border-muted-foreground/40"}`;
				dontKnowDot.style.display = dontKnow ? "" : "none";
				paint();
			};
			renderDontKnow();

			let disposed = false;
			const publish = () => {
				if (disposed) return;
				if (dontKnow) { props.onChange({ status: "ready", value: { dontKnow: true } }); return; }
				const explanation = textarea.value.trim();
				if (!explanation) { props.onChange({ status: "empty" }); return; }
				props.onChange({ status: "ready", value: { explanation: textarea.value, confidence: CONFIDENCE_STOPS[index] } });
			};
			const onSlide = () => { index = nearestStopIndex(Number(slider.value)); paint(); publish(); };
			const onToggleDontKnow = () => {
				if (!active) return;
				dontKnow = !dontKnow;
				renderDontKnow();
				publish();
			};
			textarea.addEventListener("input", publish);
			slider.addEventListener("input", onSlide);
			dontKnowButton.addEventListener("click", onToggleDontKnow);
			publish();

			return {
				update(next) {
					active = next.active;
					const value = readValue(next.answer);
					if (value) {
						if (typeof value.explanation === "string" && value.explanation !== textarea.value) textarea.value = value.explanation;
						if (typeof value.confidence === "number" && CONFIDENCE_STOPS.includes(value.confidence) && CONFIDENCE_STOPS.indexOf(value.confidence) !== index) {
							index = CONFIDENCE_STOPS.indexOf(value.confidence);
						}
						if (typeof value.dontKnow === "boolean" && value.dontKnow !== dontKnow) dontKnow = value.dontKnow;
					}
					renderDontKnow();
				},
				focus() { textarea.focus(); },
				appendTranscript(text) {
					if (dontKnow) return;
					textarea.value = (textarea.value + text).slice(0, EXPLANATION_MAX);
					publish();
				},
				dispose() {
					disposed = true;
					textarea.removeEventListener("input", publish);
					slider.removeEventListener("input", onSlide);
					dontKnowButton.removeEventListener("click", onToggleDontKnow);
				},
			};
		},
		mountAnswered(container, props) {
			const doc = container.ownerDocument;
			const answer = props.answer;
			if (answer && answer.dontKnow === true) {
				const note = doc.createElement("div");
				note.setAttribute("data-testid", "study-dont-know-answered");
				note.className = ANSWERED_DONT_KNOW;
				note.textContent = "Answered “I don't know”.";
				container.append(note);
				return;
			}
			const paragraph = doc.createElement("div");
			paragraph.setAttribute("data-testid", "study-explanation-answered");
			paragraph.className = ANSWERED_TEXT;
			const explanation = answer && typeof answer.explanation === "string" ? answer.explanation : "";
			paragraph.textContent = `“${explanation}”`;
			container.append(paragraph);

			const confidence = answer && typeof answer.confidence === "number" && CONFIDENCE_STOPS.includes(answer.confidence)
				? answer.confidence : CONFIDENCE_STOPS[DEFAULT_CONFIDENCE_INDEX];
			const row = doc.createElement("div");
			row.className = ANSWERED_ROW;
			row.setAttribute("data-testid", "answered-confidence");
			const rail = doc.createElement("div");
			rail.className = STATIC_RAIL;
			paintRail(rail, confidence);
			const valueLabel = doc.createElement("span");
			valueLabel.className = `${CONFIDENCE_VALUE} text-muted-foreground`;
			valueLabel.textContent = `${confidence}%`;
			row.append(rail, valueLabel);
			container.append(row);
		},
	});
}
