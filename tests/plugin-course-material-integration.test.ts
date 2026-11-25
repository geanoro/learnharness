import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, test } from "node:test";
import { createFauxCore } from "@earendil-works/pi-ai";
import type { PluginAgentKind, PluginLearningData } from "../src/core/plugins.ts";
import type { PluginAgentService } from "../src/core/plugin-agents.ts";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "lh-course-material-plugin-"));
const data = path.join(root, "data");
process.env.LH_DATA_DIR = data;
process.env.LH_AUTH_FILE = path.join(root, "auth.json");
const originalFetch = globalThis.fetch;
globalThis.fetch = async () => { throw new Error("Unexpected network in course-material-plugin integration"); };
after(() => { globalThis.fetch = originalFetch; fs.rmSync(root, { recursive: true, force: true }); });

// Configure storage BEFORE loading any module which reads app paths.
const { createPluginHost } = await import("../src/server/plugin-host.ts");
const { createTeacherAgent } = await import("../src/agent/teacher-agent.ts");
const { chatStore } = await import("../src/store/chats.ts");

interface CourseState { name: string; folder: string; resolved: string; decks?: number; error?: string }

test("course-material example grounds every teaching agent in a configured course folder", { timeout: 10000 }, async t => {
	const directory = path.join(data, "plugins");
	fs.mkdirSync(directory, { recursive: true });
	fs.cpSync(path.resolve("examples/plugins/course-material"), path.join(directory, "course-material"), { recursive: true });
	// A real folder of decks: one nested, one non-PDF sibling that must stay unlisted.
	const slides = path.join(root, "slides", "db2");
	fs.mkdirSync(path.join(slides, "extra"), { recursive: true });
	fs.writeFileSync(path.join(slides, "lecture-01.pdf"), "%PDF-1.7 fixture");
	fs.writeFileSync(path.join(slides, "extra", "lecture-02.pdf"), "%PDF-1.7 fixture");
	fs.writeFileSync(path.join(slides, "notes.txt"), "not a deck");

	const foreground = createFauxCore({});
	const host = createPluginHost({
		directory, appVersion: "0.7.0",
		createServices() {
			return {
				learning: { directory: data } as PluginLearningData,
				inference: { catalog: async () => { throw new Error("Unused in this fixture"); }, engineFor: () => { throw new Error("Unused in this fixture"); }, onUsage: () => {} } as never,
				agents: { dispose: async () => {} } as PluginAgentService,
				workers: { dispose: async () => {} } as never,
				createBackgroundTool: () => { throw new Error("course-material registers no background tool"); },
			};
		},
	});
	t.after(() => host.dispose());
	await host.initialize();
	await host.setEnabled("course-material", true);
	assert.equal(host.list()[0]?.status, "active", JSON.stringify(host.list()));
	assert.equal(host.list()[0]?.error, undefined, JSON.stringify(host.list()));

	const chat = chatStore.createChat("Basi di dati — normalizzazione");
	const kinds: PluginAgentKind[] = ["prober", "teacher", "practice"];

	// Installed but unconfigured contributes NOTHING: no prompt changes until a course exists.
	for (const agent of kinds) assert.deepEqual(host.agentContributions({ chatId: chat.id, agent }, []), { instructions: [], tools: [] });

	await assert.rejects(host.call("course-material", "add", { name: "Basi di dati", folder: "relative/slides" }), /absolute path/);
	await assert.rejects(host.call("course-material", "add", { name: "Basi di dati", folder: path.join(root, "missing") }), /No such folder/);
	await assert.rejects(host.call("course-material", "add", { name: "  ", folder: slides }), /name/);
	await assert.rejects(host.call("course-material", "add", { name: "Basi di dati", folder: path.join(slides, "notes.txt") }), /Not a folder/);

	const added = await host.call("course-material", "add", { name: "Basi di dati", folder: slides }) as CourseState[];
	assert.deepEqual(added.map(course => [course.name, course.decks, course.error]), [["Basi di dati", 2, undefined]]);
	await assert.rejects(host.call("course-material", "add", { name: "basi di dati", folder: slides }), /already configured/);
	// The plugin's own record, in its own data directory, carrying its own version.
	assert.deepEqual(JSON.parse(fs.readFileSync(path.join(directory, "course-material", "data", "courses.json"), "utf8")),
		{ version: 1, courses: [{ name: "Basi di dati", folder: slides }] });

	for (const agent of kinds) {
		const contributions = host.agentContributions({ chatId: chat.id, agent }, []);
		// Nothing goes into the system prompt: registerInstructions is one static text
		// used on EVERY turn, so a session with no course would pay for one it never uses.
		assert.deepEqual(contributions.instructions, [], agent);
		assert.deepEqual(contributions.tools.map(tool => tool.name), ["course_material"], agent);
		const described = contributions.tools[0]!.description;
		// Unpicked session: one short line, no grounding block, no folder path.
		assert.ok(described.includes('"Basi di dati"'), agent);
		assert.equal(described.includes(slides), false, agent);
		assert.match(described, /Call this ONCE at the start/);
		assert.match(described, /never guess/);
		assert.doesNotMatch(described, /One per step at most/, "the full block is not paid for before a course is picked");
		assert.ok(described.length < 600, `unpicked description is ${described.length} chars`);
	}

	// The real native teacher composes the directive into its prompt and keeps its own tools.
	const agent = createTeacherAgent(undefined, {
		chatId: chat.id,
		engine: { model: foreground.getModel(), streamFn: foreground.streamSimple },
		pluginContributions: host.agentContributions,
	});
	assert.doesNotMatch(agent.state.systemPrompt, /course_material/, "the system prompt is left exactly as it was");
	assert.ok(agent.state.tools.some(tool => tool.name === "course_material"), "the plugin tool joins the loadout");
	assert.ok(agent.state.tools.some(tool => tool.name === "quiz"), "core tools remain available");

	const tool = host.agentContributions({ chatId: chat.id, agent: "teacher" }, []).tools[0]!;
	const run = async (input: unknown) => {
		const result = await tool.execute!("call-1", input as never, undefined, undefined);
		const [part] = (result as { content: { type: string; text: string }[] }).content;
		assert.equal(part?.type, "text");
		return part!.text;
	};
	// Lists the decks, nested ones included, and nothing that is not a PDF.
	const listed = await run({ course: "basi" });
	assert.match(listed, /whole course, 2 PDFs/);
	assert.ok(listed.includes(path.join(slides, "lecture-01.pdf")));
	assert.ok(listed.includes(path.join(slides, "extra", "lecture-02.pdf")));
	assert.doesNotMatch(listed, /notes\.txt/);
	assert.match(listed, /One `pdf` job per deck above/);
	assert.match(listed, /Nothing else is in scope/);
	// An unmatched course names the real ones instead of failing or substituting a folder.
	const missed = await run({ course: "Fisica" });
	assert.match(missed, /No configured course matches "Fisica"/);
	assert.match(missed, /"Basi di dati"/);
	assert.match(missed, /never substitute another folder/);

	// The session picker: what the learner ticks is what the tool reports for THAT chat.
	const listing = await host.call("course-material", "decks", { course: "Basi di dati" }) as { course: string; decks: { label: string }[] };
	assert.deepEqual(listing.decks.map(deck => deck.label).sort(), ["lecture-01.pdf", path.join("extra", "lecture-02.pdf")].sort());
	assert.equal(await host.call("course-material", "selection", { chatId: chat.id }), null);
	const unpicked = await run({});
	assert.match(unpicked, /has not picked a course for this session yet/);
	assert.match(unpicked, /never guess a folder/);

	await host.call("course-material", "select", { chatId: chat.id, course: "Basi di dati", decks: ["lecture-01.pdf"] });
	assert.deepEqual(await host.call("course-material", "selection", { chatId: chat.id }), { course: "Basi di dati", decks: ["lecture-01.pdf"] });
	const scoped = host.agentContributions({ chatId: chat.id, agent: "teacher" }, []).tools[0]!;
	const scopedResult = await scoped.execute!("call-3", {} as never, undefined, undefined);
	const picked = (scopedResult as { content: { text: string }[] }).content[0]!.text;
	assert.match(picked, /1 deck ticked for this session/);
	assert.ok(picked.includes(path.join(slides, "lecture-01.pdf")));
	assert.doesNotMatch(picked, /lecture-02\.pdf/, "an unticked deck stays out of scope");
	assert.match(picked, /for another deck ask the learner to add it/);
	// A deck that is not in the course folder cannot be smuggled into a selection.
	assert.deepEqual(await host.call("course-material", "select", { chatId: chat.id, course: "Basi di dati", decks: ["../secret.pdf"] }), { course: "Basi di dati", decks: [] });

	// Another chat is unaffected: the selection is per session, not global.
	const other = chatStore.createChat("Fisica 1");
	assert.equal(await host.call("course-material", "selection", { chatId: other.id }), null);

	await host.call("course-material", "clear", { chatId: chat.id });
	assert.equal(await host.call("course-material", "selection", { chatId: chat.id }), null);

	// Removing the last course returns the prompts to untouched.
	assert.deepEqual(await host.call("course-material", "remove", { name: "Basi di dati" }), []);
	for (const agent of kinds) assert.deepEqual(host.agentContributions({ chatId: chat.id, agent }, []), { instructions: [], tools: [] });

	await host.setEnabled("course-material", false);
	assert.deepEqual(host.agentContributions({ chatId: chat.id, agent: "teacher" }, []), { instructions: [], tools: [] });
});

/** The settings page and the per-session picker, driven as DOM against a stub host. */
async function mountFrontend(t: import("node:test").TestContext, lh?: { chooseAttachmentFolder: () => Promise<string | null> }) {
	const { parseHTML } = await import("linkedom");
	const { document } = parseHTML("<html><body></body></html>");
	const previousWindow = (globalThis as { window?: unknown }).window;
	(globalThis as { window?: unknown }).window = lh ? { lh } : {};
	t.after(() => { (globalThis as { window?: unknown }).window = previousWindow; });
	const { activate } = await import(`${path.resolve("examples/plugins/course-material/dist/main.js")}?${lh ? "desktop" : "browser"}`);
	const calls: { operation: string; input: unknown }[] = [];
	let courses: unknown[] = [];
	const registered: { settings?: (container: HTMLElement, signal: AbortSignal) => unknown; action?: { name: string; run(context: unknown): void }; placements: unknown[] } = { placements: [] };
	const controller = new AbortController();
	const ctx = {
		signal: controller.signal,
		registerSettings: (mount: never) => { registered.settings = mount; },
		registerAction: (action: never) => { registered.action = action; },
		placeAction: (placement: never) => { registered.placements.push(placement); },
		ui: { openDialog: () => ({ update() {}, dispose() {} }) },
		call: async (operation: string, input?: unknown) => {
			calls.push({ operation, input });
			if (operation === "courses") return courses;
			if (operation === "add") { courses = [{ name: (input as { name: string }).name, folder: (input as { folder: string }).folder, resolved: (input as { folder: string }).folder, decks: 2 }]; return courses; }
			throw new Error(`Unexpected operation: ${operation}`);
		},
	};
	activate(ctx);
	const container = document.createElement("div");
	registered.settings!(container as unknown as HTMLElement, controller.signal);
	await new Promise(resolve => setImmediate(resolve));
	return { container, calls, registered, controller, document };
}

test("the settings page uses the desktop folder dialog when the app exposes one", { timeout: 10000 }, async t => {
	let opened = 0;
	const { container, calls } = await mountFrontend(t, { chooseAttachmentFolder: async () => { opened++; return "/Users/learner/db2/slides"; } });
	const buttons = () => [...container.querySelectorAll("button")];
	const choose = buttons().find(button => button.getAttribute("aria-label") === "Slides folder")!;
	assert.ok(choose, "the folder is chosen with a button, not typed");
	assert.equal(choose.textContent, "Choose folder…");
	assert.equal(container.querySelector('input[aria-label="Slides folder"]'), null, "no typed-path field on the desktop");

	const name = container.querySelector('input[aria-label="Course name"]') as unknown as HTMLInputElement;
	const add = buttons().find(button => button.textContent === "Add course")!;
	name.value = "Basi di dati";
	name.oninput?.(new Event("input") as never);
	assert.equal(add.disabled, true, "a name alone is not enough");

	await choose.onclick?.(new Event("click") as never);
	await new Promise(resolve => setImmediate(resolve));
	assert.equal(opened, 1, "the native dialog is what supplies the path");
	assert.equal(choose.textContent, "/Users/learner/db2/slides");
	assert.equal(add.disabled, false);

	await add.onclick?.(new Event("click") as never);
	await new Promise(resolve => setImmediate(resolve));
	assert.deepEqual(calls.find(call => call.operation === "add")?.input, { name: "Basi di dati", folder: "/Users/learner/db2/slides" });
	assert.equal(choose.textContent, "Choose folder…", "the picker resets for the next course");
});

test("the settings page falls back to a typed path where no native dialog exists", { timeout: 10000 }, async t => {
	const { container } = await mountFrontend(t);
	assert.ok(container.querySelector('input[aria-label="Slides folder"]'), "the browser keeps the typed-path field");
	assert.equal([...container.querySelectorAll("button")].some(button => button.textContent === "Choose folder…"), false);
	assert.match(container.textContent ?? "", /only be chosen from the desktop app/);
});

test("the plugin places a session-scoped picker in the top bar", { timeout: 10000 }, async t => {
	const { registered } = await mountFrontend(t);
	assert.equal(registered.action?.name, "Course material");
	assert.deepEqual(registered.placements, [{ id: "session-pick", actionId: "pick", location: "top-bar", sessions: ["teaching", "practice"] }]);
});

test("one course_material call stays bounded however many decks the folder holds", { timeout: 20000 }, async t => {
	const directory = path.join(data, "cap-plugins");
	fs.mkdirSync(directory, { recursive: true });
	fs.cpSync(path.resolve("examples/plugins/course-material"), path.join(directory, "course-material"), { recursive: true });
	// An archive, not a lecture folder: 300 decks under deliberately long paths.
	const archive = path.join(root, "Università", "Archivio storico del corso di Basi di dati", "slides");
	fs.mkdirSync(archive, { recursive: true });
	for (let i = 1; i <= 300; i++) fs.writeFileSync(path.join(archive, `lezione-${String(i).padStart(3, "0")}-argomento-piuttosto-lungo.pdf`), "%PDF-1.7");
	const host = createPluginHost({
		directory, appVersion: "0.7.0",
		createServices() {
			return {
				learning: { directory: data } as PluginLearningData,
				inference: {} as never,
				agents: { dispose: async () => {} } as PluginAgentService,
				workers: { dispose: async () => {} } as never,
				createBackgroundTool: () => { throw new Error("course-material registers no background tool"); },
			};
		},
	});
	t.after(() => host.dispose());
	await host.initialize();
	await host.setEnabled("course-material", true);
	await host.call("course-material", "add", { name: "Archivio", folder: archive });
	const chat = chatStore.createChat("Archivio");
	const tool = host.agentContributions({ chatId: chat.id, agent: "teacher" }, []).tools[0]!;
	const result = await tool.execute!("call-cap", { course: "Archivio" } as never, undefined, undefined);
	const text = (result as { content: { text: string }[] }).content[0]!.text;
	// The walk itself stops at 200 files, and the reply the model reads stops well before that.
	assert.ok(text.length < 9000, `one call returned ${text.length} chars`);
	assert.match(text, /walk capped at 200/);
	assert.match(text, /and \d+ more — too many to teach from/);
	assert.match(text, /ask the learner to tick today's decks/);
});

test("the session picker lists courses, loads their decks and saves the ticked ones for that chat", { timeout: 10000 }, async t => {
	const { parseHTML } = await import("linkedom");
	const { document } = parseHTML("<html><body></body></html>");
	const previousWindow = (globalThis as { window?: unknown }).window;
	(globalThis as { window?: unknown }).window = {};
	t.after(() => { (globalThis as { window?: unknown }).window = previousWindow; });
	const { activate } = await import(`${path.resolve("examples/plugins/course-material/dist/main.js")}?picker`);

	const calls: { operation: string; input: unknown }[] = [];
	let action: { run(context: unknown): void } | undefined;
	let dialog: { content: (container: HTMLElement, signal: AbortSignal) => unknown } | undefined;
	const controller = new AbortController();
	activate({
		signal: controller.signal,
		registerSettings: () => {},
		registerAction: (registered: never) => { action = registered; },
		placeAction: () => {},
		ui: { openDialog: (props: never) => { dialog = props; return { update() {}, dispose() {} }; } },
		call: async (operation: string, input?: unknown) => {
			calls.push({ operation, input });
			if (operation === "courses") return [{ name: "Basi di dati", folder: "/s", resolved: "/s", decks: 2 }];
			if (operation === "selection") return null;
			if (operation === "decks") return { course: "Basi di dati", root: "/s", truncated: false, decks: [{ label: "lezione-01.pdf" }, { label: "lezione-02.pdf" }] };
			if (operation === "select") return input;
			throw new Error(`Unexpected operation: ${operation}`);
		},
	});

	action!.run({ surface: "session", placement: "top-bar", sessionId: "chat_picker", kind: "teaching" });
	const container = document.createElement("div");
	dialog!.content(container as unknown as HTMLElement, new AbortController().signal);
	const settle = async () => { for (let i = 0; i < 4; i++) await new Promise(resolve => setImmediate(resolve)); };
	await settle();

	// The selection is read for THIS chat, not globally.
	assert.deepEqual(calls.find(call => call.operation === "selection")?.input, { chatId: "chat_picker" });
	const radio = container.querySelector('input[type="radio"]') as unknown as HTMLInputElement;
	assert.ok(radio, "one radio per configured course");
	assert.equal(container.querySelectorAll('input[type="checkbox"]').length, 0, "decks appear only once a course is chosen");
	const save = [...container.querySelectorAll("button")].find(button => button.textContent === "Use these decks")!;
	assert.equal(save.disabled, true, "nothing can be saved before a course is chosen");

	radio.checked = true;
	await radio.onchange?.(new Event("change") as never);
	await settle();
	const boxes = [...container.querySelectorAll('input[type="checkbox"]')] as unknown as HTMLInputElement[];
	assert.equal(boxes.length, 2, "the chosen course's decks are listed");
	assert.match(container.textContent ?? "", /Nothing ticked: the whole course is in scope/);
	assert.equal(save.disabled, false);

	boxes[0]!.checked = true;
	await boxes[0]!.onchange?.(new Event("change") as never);
	await settle();
	assert.match(container.textContent ?? "", /1 of 2 ticked/);

	await [...container.querySelectorAll("button")].find(button => button.textContent === "Use these decks")!.onclick?.(new Event("click") as never);
	await settle();
	assert.deepEqual(calls.find(call => call.operation === "select")?.input, { chatId: "chat_picker", course: "Basi di dati", decks: ["lezione-01.pdf"] });
});

test("a remounted picker survives the first mount's late cleanup", { timeout: 10000 }, async t => {
	// The host mounts content, cleans up and mounts again (React's development
	// double-invoke), and the first cleanup can land after the second mount has
	// drawn. A cleanup that cleared the whole container would blank the dialog.
	const { parseHTML } = await import("linkedom");
	const { document } = parseHTML("<html><body></body></html>");
	const previousWindow = (globalThis as { window?: unknown }).window;
	(globalThis as { window?: unknown }).window = {};
	t.after(() => { (globalThis as { window?: unknown }).window = previousWindow; });
	const { activate } = await import(`${path.resolve("examples/plugins/course-material/dist/main.js")}?remount`);

	let action: { run(context: unknown): void } | undefined;
	let dialog: { content: (container: HTMLElement, signal: AbortSignal) => unknown } | undefined;
	activate({
		signal: new AbortController().signal,
		registerSettings: () => {},
		registerAction: (registered: never) => { action = registered; },
		placeAction: () => {},
		ui: { openDialog: (props: never) => { dialog = props; return { update() {}, dispose() {} }; } },
		call: async (operation: string) => {
			if (operation === "courses") return [{ name: "Basi di dati", folder: "/s", resolved: "/s", decks: 2 }];
			if (operation === "selection") return null;
			throw new Error(`Unexpected operation: ${operation}`);
		},
	});
	action!.run({ surface: "session", placement: "top-bar", sessionId: "chat_remount", kind: "teaching" });

	const container = document.createElement("div") as unknown as HTMLElement;
	const first = new AbortController();
	const cleanupFirst = dialog!.content(container, first.signal) as () => void;
	const second = new AbortController();
	dialog!.content(container, second.signal);
	for (let i = 0; i < 4; i++) await new Promise(resolve => setImmediate(resolve));
	// The first mount's cleanup arrives late, exactly as the host delivers it.
	first.abort();
	cleanupFirst();
	assert.match(container.textContent ?? "", /Pick the course this session is about/, "the live mount still shows its content");
	assert.equal(container.querySelectorAll('input[type="radio"]').length, 1, "and exactly one copy of it");
});

test("a session with no course selected pays nothing for one that has", { timeout: 20000 }, async t => {
	const directory = path.join(data, "cost-plugins");
	fs.mkdirSync(directory, { recursive: true });
	fs.cpSync(path.resolve("examples/plugins/course-material"), path.join(directory, "course-material"), { recursive: true });
	const decks = path.join(root, "cost-slides");
	fs.mkdirSync(decks, { recursive: true });
	for (let i = 1; i <= 4; i++) fs.writeFileSync(path.join(decks, `lezione-0${i}.pdf`), "%PDF-1.7");
	const host = createPluginHost({
		directory, appVersion: "0.7.0",
		createServices() {
			return {
				learning: { directory: data } as PluginLearningData,
				inference: {} as never,
				agents: { dispose: async () => {} } as PluginAgentService,
				workers: { dispose: async () => {} } as never,
				createBackgroundTool: () => { throw new Error("course-material registers no background tool"); },
			};
		},
	});
	t.after(() => host.dispose());
	await host.initialize();
	await host.setEnabled("course-material", true);

	// The app's own system-prompt estimator convention (src/server/chat-handler.ts).
	const cost = (chatId: string) => {
		const { instructions, tools } = host.agentContributions({ chatId, agent: "teacher" }, []);
		const text = [...instructions, ...tools.map(tool => `${tool.name}${tool.description}${JSON.stringify(tool.parameters)}`)].join("");
		return Math.ceil(text.length / 4);
	};

	// No course configured at all: the plugin is installed and enabled, and costs nothing.
	const untouched = chatStore.createChat("Nessun corso");
	assert.equal(cost(untouched.id), 0);
	assert.deepEqual(host.agentContributions({ chatId: untouched.id, agent: "teacher" }, []), { instructions: [], tools: [] });

	await host.call("course-material", "add", { name: "Basi di dati", folder: decks });
	const unpicked = chatStore.createChat("Una sessione qualunque");
	const picked = chatStore.createChat("Lezione di oggi");
	await host.call("course-material", "select", { chatId: picked.id, course: "Basi di dati", decks: ["lezione-01.pdf"] });

	const unpickedCost = cost(unpicked.id);
	const pickedCost = cost(picked.id);
	// A session that never picked a course carries a one-line pointer, not the rules.
	assert.ok(unpickedCost > 0 && unpickedCost < 180, `unpicked session costs ${unpickedCost} tokens`);
	// The session that did carries the rules — and it is the only one that does.
	assert.ok(pickedCost > unpickedCost, `picked ${pickedCost} should exceed unpicked ${unpickedCost}`);
	assert.ok(pickedCost < 400, `picked session costs ${pickedCost} tokens`);
	assert.equal(cost(untouched.id) === 0 || cost(untouched.id) === unpickedCost, true);
});
