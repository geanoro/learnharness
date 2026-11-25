/**
 * Two surfaces, both built only from classes the installed app already emits for
 * its own settings — a plugin cannot ship new Tailwind utilities, so borrowing
 * existing ones is what keeps them native:
 *
 *  - a settings page shaped like the app's File-access folder list, where courses
 *    are added once; the folder comes from the desktop app's own native dialog,
 *  - a "Course material" button in each session's top bar, where the learner picks
 *    the course for THAT session and ticks the decks to teach from.
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

/** The desktop app exposes its own folder dialog on the page as
 *  window.lh.chooseAttachmentFolder — the very one the composer's paperclip
 *  opens. It is fixed for the window's life, so read it once per mount. */
const folderDialog = () => (typeof window === "undefined" ? undefined : window.lh?.chooseAttachmentFolder);

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

export function activate(ctx) {
	ctx.registerSettings((container, signal) => {
		const element = maker(container);
		let alive = !signal.aborted;
		const onAbort = () => { alive = false; };
		signal.addEventListener("abort", onAbort, { once: true });

		const root = element("div", "flex flex-col gap-3", container);
		element("p", "text-xs text-muted-foreground", root,
			"A course remembers the folder its slides live in, so you never retype the path. In a session, the Course material "
			+ "button in the top bar is where you pick the course and tick the decks to teach from.");
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
		const chooseFolder = folderDialog();
		let picked = "";
		let folder;
		let pick;
		if (chooseFolder) {
			pick = element("button", PICK, form, "Choose folder…");
			pick.type = "button";
			pick.setAttribute("aria-label", "Slides folder");
			pick.onclick = () => {
				message.textContent = "";
				void (async () => {
					try {
						const chosen = await chooseFolder();
						if (!alive || chosen === null || chosen === undefined) return; // Native cancellation changes nothing.
						picked = chosen;
						pick.textContent = chosen;
						pick.title = chosen;
						syncAdd();
					} catch { fail(new Error("Could not choose a folder. Try again.")); }
				})();
			};
		} else {
			folder = element("input", FIELD, form);
			folder.setAttribute("aria-label", "Slides folder");
			folder.placeholder = "Absolute path or ~/folder";
		}
		const add = element("button", BUTTON, form, "Add course");
		add.type = "button";
		add.disabled = true;

		const message = element("p", "pl-3 text-xs text-error", block, "");
		message.setAttribute("role", "alert");
		const list = element("div", "flex flex-col gap-2", block);

		const folderValue = () => (folder ? folder.value.trim() : picked);
		const syncAdd = () => { add.disabled = !alive || !name.value.trim() || !folderValue(); };
		const fail = error => { if (alive) message.textContent = error instanceof Error ? error.message : String(error); };

		const render = courses => {
			if (!alive) return;
			list.replaceChildren();
			if (courses.length === 0) {
				element("p", "pl-3 text-xs text-muted-foreground", list, "No course yet. Add one above and the teacher will use it.");
				return;
			}
			for (const course of courses) {
				const entry = element("div", ENTRY, list);
				const text = element("span", "min-w-0", entry);
				element("span", "block truncate font-ui", text, course.name);
				const where = element("span", "block truncate font-ui text-muted-foreground", text, course.resolved ?? course.folder);
				where.title = course.resolved ?? course.folder;
				const right = element("span", "flex shrink-0 items-center gap-2", entry);
				if (course.error) element("span", "text-error", right, "folder unreadable");
				else element("span", "tabular-nums text-muted-foreground", right, `${course.decks ?? 0} PDF${course.decks === 1 ? "" : "s"}`);
				const remove = element("button", REMOVE, right, "Remove");
				remove.type = "button";
				remove.setAttribute("aria-label", `Remove ${course.name}`);
				remove.onclick = () => {
					message.textContent = "";
					remove.disabled = true;
					void (async () => {
						try { render(await ctx.call("remove", { name: course.name })); }
						catch (error) { fail(error); if (alive) remove.disabled = false; }
					})();
				};
			}
		};

		add.onclick = () => {
			message.textContent = "";
			add.disabled = true;
			void (async () => {
				try {
					const courses = await ctx.call("add", { name: name.value, folder: folderValue() });
					if (!alive) return;
					name.value = "";
					picked = "";
					if (folder) folder.value = "";
					if (pick) { pick.textContent = "Choose folder…"; pick.removeAttribute("title"); }
					render(courses);
				} catch (error) { fail(error); }
				finally { syncAdd(); }
			})();
		};
		for (const field of folder ? [name, folder] : [name]) {
			field.oninput = () => { message.textContent = ""; syncAdd(); };
			field.onkeydown = event => { if (event.key === "Enter") { event.preventDefault(); if (!add.disabled) add.onclick(); } };
		}

		if (!chooseFolder) {
			element("p", "pl-3 text-xs text-muted-foreground", block,
				"Folders can only be chosen from the desktop app, which opens the same picker as the composer's paperclip. "
				+ "Type the full path here instead.");
		}
		element("p", "text-xs text-muted-foreground", root,
			"Name a course exactly as its [[COURSE]] block is named in your notes, so the two line up. "
			+ "Reading the slides still goes through the app's own file access: if Settings → Agent restricts it to listed folders, "
			+ "add the course folder there too.");

		void (async () => {
			try { render(await ctx.call("courses")); }
			catch (error) { fail(error); }
		})();

		return () => {
			alive = false;
			signal.removeEventListener("abort", onAbort);
			// Remove only this mount's own subtree. The host may mount twice (React's
			// development double-invoke) and deliver the first cleanup after the second
			// mount has already drawn: clearing the whole container would erase it.
			root.remove();
		};
	});

	/** The per-session picker. Its context carries this session's id, which is the
	 *  same chat id the backend's per-turn tool factory sees, so what is ticked here
	 *  is exactly what `course_material` reports for this session. */
	const mountPicker = (chatId) => (container, signal) => {
		const element = maker(container);
		let alive = !signal.aborted;
		const onAbort = () => { alive = false; };
		signal.addEventListener("abort", onAbort, { once: true });

		const root = element("div", "flex flex-col gap-3", container);
		element("h2", HEADING, root, "Course material");
		element("p", "text-xs text-muted-foreground", root,
			"Pick the course this session is about, then tick the decks to teach from — today's lecture, say. "
			+ "The teacher reads only those, cites their pages, and says when it goes beyond them.");
		const message = element("p", "text-xs text-error", root, "");
		message.setAttribute("role", "alert");
		const courseList = element("div", "flex flex-col gap-2", root);
		const deckList = element("div", "flex flex-col gap-2", root);
		const actions = element("div", "flex gap-2", root);
		const save = element("button", BUTTON, actions, "Use these decks");
		save.type = "button";
		save.disabled = true;
		const clear = element("button", BUTTON, actions, "Clear selection");
		clear.type = "button";

		let courses = [];
		let chosen = null;
		let decks = [];
		let ticked = new Set();

		const fail = error => { if (alive) message.textContent = error instanceof Error ? error.message : String(error); };

		const renderDecks = () => {
			if (!alive) return;
			deckList.replaceChildren();
			save.disabled = !chosen;
			if (!chosen) return;
			if (decks.length === 0) {
				element("p", "pl-3 text-xs text-muted-foreground", deckList,
					"That folder holds no PDF files. PowerPoint is not supported — export .pptx to PDF first.");
				save.disabled = true;
				return;
			}
			element("p", "pl-3 text-xs text-muted-foreground", deckList,
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
			if (courses.length === 0) {
				element("p", "text-xs text-muted-foreground", courseList,
					"No course configured yet. Add one in Settings → Community plugins → Course material.");
				return;
			}
			for (const course of courses) {
				const label = element("label", CHECK, courseList);
				const radio = element("input", "accent-primary", label);
				radio.type = "radio";
				radio.name = "course-material-course";
				radio.checked = chosen === course.name;
				radio.onchange = () => {
					chosen = course.name;
					ticked = new Set();
					decks = [];
					renderCourses();
					renderDecks();
					void loadDecks(course.name);
				};
				element("span", "min-w-0 truncate font-ui", label, course.name);
				if (course.error) element("span", "text-error", label, "folder unreadable");
				else element("span", "tabular-nums text-muted-foreground", label, `${course.decks ?? 0} PDF${course.decks === 1 ? "" : "s"}`);
			}
		};

		save.onclick = () => {
			message.textContent = "";
			save.disabled = true;
			void (async () => {
				try {
					await ctx.call("select", { chatId, course: chosen, decks: [...ticked] });
					if (alive) message.textContent = "";
				} catch (error) { fail(error); }
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
					renderCourses();
					renderDecks();
				} catch (error) { fail(error); }
			})();
		};

		void (async () => {
			try {
				const [list, selection] = await Promise.all([ctx.call("courses"), ctx.call("selection", { chatId })]);
				if (!alive) return;
				courses = list;
				if (selection) {
					chosen = selection.course;
					ticked = new Set(selection.decks);
				}
				renderCourses();
				renderDecks();
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
		name: "Course material",
		run(context) {
			if (context.surface !== "session") return;
			ctx.ui.openDialog({ title: "Course material", content: mountPicker(context.sessionId) }, { signal: ctx.signal });
		},
	});
	ctx.placeAction({ id: "session-pick", actionId: "pick", location: "top-bar", sessions: ["teaching", "practice"] });
}
