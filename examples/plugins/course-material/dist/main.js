/**
 * The settings page is deliberately the app's own File-access folder list,
 * shape for shape: a labelled row, an add line indented under it, then one
 * line per entry with a Remove on the right. Every class here is a class the
 * installed app already emits for its own settings — a plugin cannot ship new
 * Tailwind utilities, so borrowing existing ones is what keeps it native.
 */
const ROW = "flex items-center justify-between gap-4 py-1";
const LABEL = "block font-prose text-(length:--lh-prose-size)";
const HINT = "block text-xs text-muted-foreground/70";
const FIELD = "min-w-0 flex-1 rounded-sm border border-border bg-background px-2 py-1 font-ui text-xs";
const ADD = "rounded-sm border border-border px-2 text-xs disabled:opacity-40";
const ENTRY = "flex items-center justify-between gap-4 pl-3 text-xs";
const REMOVE = "rounded-sm px-1.5 text-muted-foreground hover:text-foreground";

export function activate(ctx) {
	ctx.registerSettings((container, signal) => {
		const document = container.ownerDocument;
		let alive = !signal.aborted;
		const onAbort = () => { alive = false; };
		signal.addEventListener("abort", onAbort, { once: true });

		const element = (tag, className, parent, text) => {
			const node = document.createElement(tag);
			if (className) node.className = className;
			if (text !== undefined) node.textContent = text;
			parent.append(node);
			return node;
		};

		const root = element("div", "flex flex-col gap-3", container);
		element("p", "text-xs text-muted-foreground", root,
			"A course remembers the folder its slides live in, so you never retype the path. In a session about that course, the teacher "
			+ "reads those decks first through the usual background PDF reader, cites their pages, and says when it goes beyond them.");
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
		const folder = element("input", FIELD, form);
		folder.setAttribute("aria-label", "Slides folder");
		folder.placeholder = "Absolute path or ~/folder";
		const add = element("button", ADD, form, "Add course");
		add.type = "button";
		add.disabled = true;

		const message = element("p", "pl-3 text-xs text-error", block, "");
		message.setAttribute("role", "alert");
		const list = element("div", "flex flex-col gap-2", block);

		const syncAdd = () => { add.disabled = !alive || !name.value.trim() || !folder.value.trim(); };
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
					const courses = await ctx.call("add", { name: name.value, folder: folder.value });
					if (!alive) return;
					name.value = "";
					folder.value = "";
					render(courses);
				} catch (error) { fail(error); }
				finally { syncAdd(); }
			})();
		};
		for (const field of [name, folder]) {
			field.oninput = () => { message.textContent = ""; syncAdd(); };
			field.onkeydown = event => { if (event.key === "Enter") { event.preventDefault(); if (!add.disabled) add.onclick(); } };
		}

		element("p", "text-xs text-muted-foreground", root,
			"Reading the slides still goes through the app's own file access: if Settings → Agent restricts it to listed folders, add the "
			+ "course folder there too.");

		void (async () => {
			try { render(await ctx.call("courses")); }
			catch (error) { fail(error); }
		})();

		return () => {
			alive = false;
			signal.removeEventListener("abort", onAbort);
			container.replaceChildren();
		};
	});
}
