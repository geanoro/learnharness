import assert from "node:assert/strict";
import * as path from "node:path";
import { test } from "node:test";
import { parseHTML } from "linkedom";

/**
 * The settings page and the per-session picker, driven as DOM against a stub
 * host. The gesture under test is the one the whole librarian depends on: a
 * native directory input (the control the host's own Extract files… → Folder
 * uses) hands the plugin real `File` objects, which is the only input
 * `ctx.documents.toMarkdown` accepts, and `window.lh.getPathForFile` turns one
 * of them into the folder's absolute path for the course record.
 */

const flush = () => new Promise(resolve => setImmediate(resolve));

/** These handlers never read their event argument; only `pick` needs a real one. */
const EVENT = undefined as never;
const fire = (node: unknown, handler: "onclick" | "oninput" | "onchange") => {
	const target = node as Record<string, ((event: never) => void) | undefined>;
	assert.ok(typeof target[handler] === "function", `no ${handler} handler`);
	target[handler]!(EVENT);
};

interface FakeFile { name: string; size: number; webkitRelativePath: string }
const deck = (relative: string, size = 1024): FakeFile =>
	({ name: relative.split("/").pop()!, size, webkitRelativePath: `distsys/${relative}` });

const SLIDES = "/Users/learner/slides/distsys";

interface Dialog { title: string; content: (container: HTMLElement, signal: AbortSignal) => unknown }

interface Harness {
	container: HTMLElement;
	document: Document;
	calls: { operation: string; input: unknown }[];
	converted: string[];
	pick(files: FakeFile[]): Promise<void>;
	settings: (container: HTMLElement, signal: AbortSignal) => unknown;
	action: { name: string; run(context: unknown): void };
	placements: unknown[];
	dialog: Dialog | undefined;
	controller: AbortController;
}

async function mountFrontend(t: import("node:test").TestContext, options: { desktop: boolean; state?: unknown }): Promise<Harness> {
	const { document, window } = parseHTML("<html><body></body></html>");
	const previousWindow = (globalThis as { window?: unknown }).window;
	(globalThis as { window?: unknown }).window = options.desktop
		? { lh: { getPathForFile: (file: FakeFile) => `${SLIDES}/${file.webkitRelativePath.split("/").slice(1).join("/")}` } }
		: {};
	t.after(() => { (globalThis as { window?: unknown }).window = previousWindow; });

	const { activate } = await import(`${path.resolve("examples/plugins/study/dist/main.js")}?${options.desktop ? "desktop" : "browser"}`);
	const calls: Harness["calls"] = [];
	const converted: string[] = [];
	let state: Record<string, unknown> = (options.state as Record<string, unknown>) ?? {
		courses: [], logseq: { serverUrl: "", hasToken: false, defaultUrl: "http://127.0.0.1:12315/mcp" }, explainBack: true,
	};
	const registered: {
		settings?: Harness["settings"]; action?: Harness["action"]; placements: unknown[]; dialog?: Harness["dialog"];
	} = { placements: [] };
	const controller = new AbortController();
	const ctx = {
		signal: controller.signal,
		registerSettings: (mount: never) => { registered.settings = mount; },
		registerAction: (action: never) => { registered.action = action; },
		placeAction: (placement: never) => { registered.placements.push(placement); },
		registerQuestionRenderer: () => {},
		ui: { openDialog: (dialog: Dialog) => { registered.dialog = dialog; return { update() {}, dispose() {} }; } },
		documents: {
			toMarkdown: async (file: FakeFile) => {
				converted.push(file.webkitRelativePath);
				return { name: file.name, markdown: `--- Page 1 ---\n\n${file.name} page one`, notices: [] };
			},
		},
		call: async (operation: string, input?: unknown) => {
			calls.push({ operation, input });
			if (operation === "state") return state;
			if (operation === "addCourse") {
				const value = input as { name: string; folder: string; logseq?: string };
				state = {
					...state,
					courses: [{ name: value.name, folder: value.folder, logseq: value.logseq ?? "", resolved: value.folder, decks: 2, indexed: 0 }],
				};
				return state;
			}
			if (operation === "decks") {
				return { course: "DISTSYS", root: SLIDES, truncated: false, decks: [
					{ label: "lecture-03.pdf", pages: 0, imageOnly: 0, indexed: false },
					{ label: "extra/lecture-04.pdf", pages: 0, imageOnly: 0, indexed: false },
				] };
			}
			if (operation === "putIndex") return { label: (input as { label: string }).label, pages: 1, imageOnly: 0 };
			if (operation === "selection") return null;
			if (operation === "clear") return null;
			if (operation === "select") {
				// The real backend answers with what it STORED, not with the request.
				const value = input as { course: string; decks: string[]; notes: boolean };
				return { course: value.course, decks: value.decks, notes: value.notes };
			}
			if (operation === "setLogseq") { state = { ...state, logseq: { ...(state.logseq as object), hasToken: true } }; return state; }
			throw new Error(`Unexpected operation: ${operation}`);
		},
	};
	activate(ctx);
	const container = document.createElement("div");
	registered.settings!(container as unknown as HTMLElement, controller.signal);
	await flush();

	/** Answer the native directory input this mount just opened. */
	const pick = async (files: FakeFile[]) => {
		const input = document.querySelector('[data-testid="study-folder-input"]');
		assert.ok(input, "no directory input was opened");
		(input as unknown as { files: FakeFile[] }).files = files;
		input!.dispatchEvent(new (window as unknown as { Event: typeof Event }).Event("change", { bubbles: true }));
		await flush();
	};

	// The harness returns the LIVE registration object: `dialog` is only filled
	// when the action later runs, so a spread copy would always read undefined.
	return Object.assign(registered as unknown as Harness, {
		container: container as unknown as HTMLElement,
		document: document as unknown as Document,
		calls, converted, pick, controller,
	});
}

const byTestId = (root: ParentNode, id: string) => root.querySelector(`[data-testid="${id}"]`);
const buttonNamed = (root: ParentNode, label: string) =>
	[...root.querySelectorAll("button")].find(node => (node.textContent ?? "").trim() === label);
const fieldLabelled = (root: ParentNode, label: string) => root.querySelector(`[aria-label="${label}"]`);

test("the desktop settings page turns ONE folder gesture into a course and its index", async t => {
	const harness = await mountFrontend(t, { desktop: true });

	assert.ok(harness.container.textContent?.includes("One plugin for the whole study loop"));
	assert.ok(fieldLabelled(harness.container, "Course name"), "the course name field");
	assert.ok(fieldLabelled(harness.container, "Logseq course name"), "the Logseq name field");
	assert.ok(fieldLabelled(harness.container, "Logseq MCP token"), "the token field");
	assert.equal((fieldLabelled(harness.container, "Logseq MCP token") as HTMLInputElement).type, "password");

	const add = buttonNamed(harness.container, "Add course")!;
	assert.equal((add as HTMLButtonElement).disabled, true, "nothing to add yet");

	const name = fieldLabelled(harness.container, "Course name") as HTMLInputElement;
	name.value = "DISTSYS";
	fire(name, "oninput");

	// The folder picker is a native directory input, not a path prompt.
	const choose = fieldLabelled(harness.container, "Slides folder")!;
	assert.equal(choose.tagName, "BUTTON", "the desktop build chooses, never types");
	fire(choose, "onclick");
	await harness.pick([deck("lecture-03.pdf"), deck("extra/lecture-04.pdf"), deck("notes.txt")]);

	// The absolute path came from one of the chosen files, via the host's bridge.
	assert.equal(choose.textContent, SLIDES);
	assert.equal((add as HTMLButtonElement).disabled, false);

	fire(add, "onclick");
	await flush();
	await flush();
	await flush();

	const added = harness.calls.find(call => call.operation === "addCourse");
	assert.deepEqual(added?.input, { name: "DISTSYS", folder: SLIDES, logseq: "" });

	// Indexing ran from that SAME gesture: no second folder dialog.
	assert.deepEqual(harness.converted, ["distsys/lecture-03.pdf", "distsys/extra/lecture-04.pdf"],
		"only the decks the backend listed are converted, and nothing else in the folder");
	const stored = harness.calls.filter(call => call.operation === "putIndex").map(call => (call.input as { label: string }).label);
	assert.deepEqual(stored, ["lecture-03.pdf", "extra/lecture-04.pdf"]);
	const first = harness.calls.find(call => call.operation === "putIndex")!.input as { markdown: string; size: number };
	assert.match(first.markdown, /^--- Page 1 ---/, "the host's own conversion output is what gets stored");
	assert.equal(first.size, 1024, "the size is sent so the backend can refuse a mismatched file");
	assert.match(byTestId(harness.container, "study-progress")!.textContent!, /Indexed 2 of 2 deck\(s\)\./);
});

test("the browser build says folders cannot be chosen, and offers a typed path instead", async t => {
	const harness = await mountFrontend(t, { desktop: false });
	const folder = fieldLabelled(harness.container, "Slides folder")!;
	assert.equal(folder.tagName, "INPUT", "no native dialog without the desktop bridge");
	assert.match(harness.container.textContent!, /Folders can only be chosen from the desktop app/);
	assert.match(harness.container.textContent!, /Index still works from the button on each course/);
});

test("saving the Logseq URL alone never clears the stored token", async t => {
	const harness = await mountFrontend(t, {
		desktop: true,
		state: { courses: [], logseq: { serverUrl: "http://127.0.0.1:12315/mcp", hasToken: true, defaultUrl: "http://127.0.0.1:12315/mcp" }, explainBack: true },
	});
	// A saved token is never rendered back into the field, only acknowledged.
	const token = fieldLabelled(harness.container, "Logseq MCP token") as HTMLInputElement;
	assert.equal(token.value, "");
	assert.match(token.placeholder, /Token saved/);

	fire(buttonNamed(harness.container, "Save"), "onclick");
	await flush();
	const saved = harness.calls.find(call => call.operation === "setLogseq")!.input as Record<string, unknown>;
	assert.deepEqual(Object.keys(saved), ["serverUrl"], "an untouched token field sends no token at all");
});

test("the session picker is placed in the top bar and binds the choice to that one session", async t => {
	const harness = await mountFrontend(t, {
		desktop: true,
		state: {
			courses: [{ name: "DISTSYS", folder: SLIDES, logseq: "DISTSYS", resolved: SLIDES, decks: 2, indexed: 1 }],
			logseq: { serverUrl: "http://127.0.0.1:12315/mcp", hasToken: true, defaultUrl: "http://127.0.0.1:12315/mcp" },
			explainBack: true,
		},
	});
	assert.equal(harness.action.name, "Study");
	assert.deepEqual(harness.placements, [{ id: "session-pick", actionId: "pick", location: "top-bar", sessions: ["teaching", "practice"] }]);

	// Read the dialog through a call, not a property reference: every assert
	// helper under assert/strict narrows its argument for the rest of the scope,
	// so asserting it is absent once would type every later read as `never`.
	const dialog = () => harness.dialog;

	// A non-session surface opens nothing.
	harness.action.run({ surface: "home" });
	assert.equal(dialog(), undefined);

	harness.action.run({ surface: "session", sessionId: "chat_abc" });
	assert.equal(dialog()?.title, "Study");
	const panel = harness.document.createElement("div");
	dialog()!.content(panel as unknown as HTMLElement, harness.controller.signal);
	await flush();
	await flush();

	assert.match(panel.textContent!, /Nothing is sent to the teacher until you pick/);
	const radio = panel.querySelector('input[type="radio"]') as HTMLInputElement;
	radio.checked = true;
	fire(radio, "onchange");
	await flush();
	await flush();

	// Decks arrive with their index state, and the unindexed ones say so.
	assert.match(panel.textContent!, /lecture-03\.pdf/);
	assert.match(panel.textContent!, /not indexed/);
	assert.match(panel.textContent!, /2 decks not indexed yet/);
	assert.ok(buttonNamed(panel, "Index"), "the picker can index without leaving the session");

	// The notes toggle names the course's Logseq block, and defaults to off.
	const notes = byTestId(panel, "study-notes-toggle") as HTMLInputElement;
	assert.equal(notes.checked, false);
	assert.match(panel.textContent!, /Use my Logseq notes for \[\[DISTSYS\]\]/);
	notes.checked = true;
	fire(notes, "onchange");

	const tick = panel.querySelector('input[type="checkbox"]:not([data-testid])') as HTMLInputElement;
	tick.checked = true;
	fire(tick, "onchange");
	await flush();

	fire(buttonNamed(panel, "Use these decks"), "onclick");
	await flush();
	assert.deepEqual(harness.calls.find(call => call.operation === "select")?.input,
		{ chatId: "chat_abc", course: "DISTSYS", decks: ["lecture-03.pdf"], notes: true });

	// Pressing the button has to SHOW that it did something: what the teacher now
	// uses is named, the deck it uses carries a badge, and there is nothing left
	// to save until the learner changes something.
	const status = () => byTestId(panel, "study-picker-status")!.textContent!;
	assert.match(status(), /In use/);
	assert.match(status(), /DISTSYS — 1 deck: lecture-03\.pdf/);
	assert.match(status(), /with your Logseq notes/);
	assert.equal(panel.querySelectorAll('[data-testid="study-in-use"]').length, 2, "the status line and the deck row both say so");
	assert.equal((buttonNamed(panel, "Use these decks") as HTMLButtonElement).disabled, true, "nothing left to save");

	// Changing the draft re-opens the action and says the change is not live yet.
	const second = [...panel.querySelectorAll('input[type="checkbox"]:not([data-testid])')][1] as HTMLInputElement;
	second.checked = true;
	fire(second, "onchange");
	await flush();
	const update = buttonNamed(panel, "Update these decks") as HTMLButtonElement;
	assert.ok(update, "the button says it would update an existing selection");
	assert.equal(update.disabled, false);
	assert.match(status(), /not in use yet/);

	// Clearing takes the session back to contributing nothing.
	fire(buttonNamed(panel, "Clear selection"), "onclick");
	await flush();
	assert.equal(panel.querySelector('[role="alert"]')!.textContent, "", "clearing reported no error");
	assert.equal(panel.querySelectorAll('[data-testid="study-in-use"]').length, 0);
	assert.match(status(), /the teacher is told nothing about a course/);
});

test("the picker tells the learner when the chosen folder is not the course's", async t => {
	const harness = await mountFrontend(t, {
		desktop: true,
		state: {
			courses: [{ name: "DISTSYS", folder: SLIDES, logseq: "", resolved: SLIDES, decks: 2, indexed: 0 }],
			logseq: { serverUrl: "", hasToken: false, defaultUrl: "http://127.0.0.1:12315/mcp" }, explainBack: true,
		},
	});
	const reindex = harness.container.querySelector('[aria-label="Index DISTSYS"]') as HTMLButtonElement;
	fire(reindex, "onclick");
	await harness.pick([{ name: "other.pdf", size: 10, webkitRelativePath: "somewhere-else/other.pdf" }]);
	await flush();
	assert.match(harness.container.querySelector('[role="alert"]')!.textContent!,
		/That folder holds none of "DISTSYS"'s decks/);
	assert.equal(harness.converted.length, 0, "nothing outside the course is ever converted");
});
