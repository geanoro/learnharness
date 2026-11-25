import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, test } from "node:test";
import { createFauxCore } from "@earendil-works/pi-ai";
import type { PluginAgentKind, PluginLearningData } from "../src/core/plugins.ts";
import type { PluginAgentService } from "../src/core/plugin-agents.ts";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "lh-study-plugin-"));
const data = path.join(root, "data");
process.env.LH_DATA_DIR = data;
process.env.LH_AUTH_FILE = path.join(root, "auth.json");
const originalFetch = globalThis.fetch;
globalThis.fetch = async () => { throw new Error("Unexpected network in study-plugin integration"); };
after(() => { globalThis.fetch = originalFetch; fs.rmSync(root, { recursive: true, force: true }); });

// Configure storage BEFORE loading any module which reads app paths.
const { createPluginHost } = await import("../src/server/plugin-host.ts");
const { createTeacherAgent } = await import("../src/agent/teacher-agent.ts");
const { chatStore } = await import("../src/store/chats.ts");

/** The app's own system-prompt estimate, as src/server/chat-handler.ts:367
 *  computes it.  in src/core/compaction.ts takes MESSAGES, not
 *  prompt text, so it is the wrong instrument for a tool description. */
const tokensOf = (text: string) => Math.ceil(text.length / 4);

const KINDS: PluginAgentKind[] = ["prober", "teacher", "practice"];
const EMPTY = { instructions: [], tools: [] };

/** One lecture's worth of extracted text, in the shape the host's own PDF
 *  conversion emits: a marker per page with text, image-only pages absent. */
const LECTURE_03 = [
	"--- Page 1 ---",
	"",
	"Sistemi distribuiti — lezione 3",
	"",
	"--- Page 3 ---",
	"",
	"Un leader è eletto per un termine. Le elezioni usano timeout randomizzati,",
	"così due server difficilmente partono insieme.",
	"",
	"--- Page 4 ---",
	"",
	"Log replication: the leader appends every entry before followers apply it.",
].join("\n");

function makeHost(directory: string) {
	return createPluginHost({
		directory, appVersion: "0.7.0",
		createServices() {
			return {
				// The plugin reads ONE session to fold its phase; give it the real store.
				learning: { directory: data, getSession: (id: string) => chatStore.getChat(id) } as unknown as PluginLearningData,
				inference: { catalog: async () => { throw new Error("Unused"); }, engineFor: () => { throw new Error("Unused"); }, onUsage: () => {} } as never,
				agents: { dispose: async () => {} } as PluginAgentService,
				workers: { dispose: async () => {} } as never,
				createBackgroundTool: () => { throw new Error("study registers no background tool"); },
			};
		},
	});
}

const textOf = async (tool: { execute?: unknown }, input: unknown) => {
	const result = await (tool as { execute: (id: string, input: unknown, signal?: AbortSignal, update?: unknown) => Promise<unknown> })
		.execute("call-1", input, undefined, undefined);
	return ((result as { content: { type: string; text: string }[] }).content[0]!).text;
};

/** The transcript events the host's own phase fold keys on, natively shaped. */
const PROBE_DONE = [
	{ id: "m1", role: "assistant", content: [{ type: "toolCall", name: "probe_done", id: "c1", arguments: {} }] },
	{ id: "m2", role: "toolResult", toolName: "probe_done", toolCallId: "c1", details: { ok: true }, content: [] },
];
const TAGGED_QUIZ = { id: "m3", role: "assistant", content: [{ type: "toolCall", name: "quiz", id: "c2", arguments: { nodeId: "n1" } }] };

test("study plugin: one course list, a librarian door, notes, and the explain-back box", { timeout: 20000 }, async t => {
	const directory = path.join(data, "plugins");
	fs.mkdirSync(directory, { recursive: true });
	fs.cpSync(path.resolve("examples/plugins/study"), path.join(directory, "study"), { recursive: true });

	const slides = path.join(root, "slides", "distsys");
	fs.mkdirSync(path.join(slides, "extra"), { recursive: true });
	fs.writeFileSync(path.join(slides, "lecture-03.pdf"), "%PDF-1.7 fixture");
	fs.writeFileSync(path.join(slides, "extra", "lecture-04.pdf"), "%PDF-1.7 fixture");
	fs.writeFileSync(path.join(slides, "notes.txt"), "not a deck");

	const host = makeHost(directory);
	t.after(() => host.dispose());
	await host.initialize();
	await host.setEnabled("study", true);
	assert.equal(host.list()[0]?.status, "active", JSON.stringify(host.list()));
	assert.equal(host.list()[0]?.error, undefined, JSON.stringify(host.list()));

	const chat = chatStore.createChat("Sistemi distribuiti — consenso");

	await t.test("unconfigured, the only thing registered is the explain-back box", () => {
		for (const agent of KINDS) {
			const contributions = host.agentContributions({ chatId: chat.id, agent }, []);
			// No system-prompt text ever: registerInstructions is never called.
			assert.deepEqual(contributions.instructions, [], agent);
			assert.deepEqual(contributions.tools, [], agent);
			const questions = (contributions.questionTypes ?? []).map(entry => entry.definition.id);
			// The box is a teaching mechanic: only a teacher turn sees it.
			assert.deepEqual(questions, agent === "teacher" ? ["study-explain"] : [], agent);
		}
	});

	await t.test("a course is refused unless its folder really is one", async () => {
		await assert.rejects(host.call("study", "addCourse", { name: "DISTSYS", folder: "relative/slides" }), /absolute path/);
		await assert.rejects(host.call("study", "addCourse", { name: "DISTSYS", folder: path.join(root, "missing") }), /No such folder/);
		await assert.rejects(host.call("study", "addCourse", { name: "  ", folder: slides }), /name/);
		await assert.rejects(host.call("study", "addCourse", { name: "DISTSYS", folder: path.join(slides, "notes.txt") }), /Not a folder/);
	});

	await t.test("the shared course list keeps the folder and the Logseq name together", async () => {
		const state = await host.call("study", "addCourse", { name: "DISTSYS", folder: slides, logseq: "DISTSYS" }) as
			{ courses: { name: string; logseq: string; decks: number; indexed: number }[] };
		assert.deepEqual(state.courses.map(course => [course.name, course.logseq, course.decks, course.indexed]), [["DISTSYS", "DISTSYS", 2, 0]]);
		await assert.rejects(host.call("study", "addCourse", { name: "distsys", folder: slides }), /already configured/);
		assert.deepEqual(JSON.parse(fs.readFileSync(path.join(directory, "study", "data", "courses.json"), "utf8")),
			{ version: 1, courses: [{ name: "DISTSYS", folder: slides, logseq: "DISTSYS" }] });
	});

	await t.test("a configured course that THIS session has not picked still costs nothing", () => {
		for (const agent of KINDS) {
			assert.deepEqual(host.agentContributions({ chatId: chat.id, agent }, []).tools, [], agent);
		}
	});

	await t.test("picking a course opens exactly one door, with the full rules while planning", async () => {
		await host.call("study", "select", { chatId: chat.id, course: "DISTSYS", decks: [], notes: false });
		for (const agent of KINDS) {
			const tools = host.agentContributions({ chatId: chat.id, agent }, []).tools;
			assert.deepEqual(tools.map(tool => tool.name), ["course_library"], agent);
		}
		const planning = host.agentContributions({ chatId: chat.id, agent: "teacher" }, []).tools[0]!;
		assert.match(planning.description, /Teach from these slides first, and reach them ONLY through this tool/);
		assert.match(planning.description, /Several terms in one call/);
		assert.match(planning.description, /going past them/);
		assert.match(planning.description, /ONE native `pdf` job/);
		// A practice session is never in the planning phase: it gets the pointer.
		const practice = host.agentContributions({ chatId: chat.id, agent: "practice" }, []).tools[0]!;
		assert.doesNotMatch(practice.description, /ONLY through this tool/);
		assert.ok(practice.description.length < 200, `pointer is ${practice.description.length} chars`);
	});

	await t.test("the librarian's inventory names what it cannot search, with the path a pdf job needs", async () => {
		const tool = host.agentContributions({ chatId: chat.id, agent: "teacher" }, []).tools[0]!;
		const listed = await textOf(tool, {});
		assert.match(listed, /"DISTSYS" — 2 decks in scope/);
		assert.match(listed, /lecture-03\.pdf — NOT indexed; only a `pdf` job can read it/);
		assert.ok(listed.includes(path.join(slides, "lecture-03.pdf")));
		assert.doesNotMatch(listed, /notes\.txt/, "a non-PDF sibling is never a deck");
		// Nothing is searchable yet, so a query says so rather than inventing an answer.
		const empty = await textOf(tool, { terms: ["elezioni"] });
		assert.match(empty, /Not indexed yet, so not searched/);
	});

	await t.test("indexing a deck makes the librarian answer in the slides' own words", async () => {
		const stored = await host.call("study", "putIndex", {
			course: "DISTSYS", label: "lecture-03.pdf", markdown: LECTURE_03,
			notices: ["PDF text extraction may contain errors; check the result against the original.",
				"Skipped 2 image-only pages; OCR is not supported."],
			size: fs.statSync(path.join(slides, "lecture-03.pdf")).size,
		}) as { pages: number; imageOnly: number };
		assert.deepEqual([stored.pages, stored.imageOnly], [3, 2]);

		const tool = host.agentContributions({ chatId: chat.id, agent: "teacher" }, []).tools[0]!;
		const answer = await textOf(tool, { terms: ["elezione", "timeout"] });
		// Verbatim slide text, with the page it came from — not a summary.
		assert.match(answer, /lecture-03\.pdf, p\. 3:/);
		assert.match(answer, /timeout randomizzati/);
		assert.match(answer, /Verbatim slide text, not a summary/);
		// Recall across Italian inflection and accents: "elezione" finds "elezioni",
		// and the query carried no accent while the slide does.
		assert.match(answer, /Un leader è eletto per un termine/);
		// Image-only pages are named, and sent to the one tool that can read them.
		assert.match(answer, /page 2 and 1 more image page/);
		assert.match(answer, /send ONE native `pdf` job/);
		// English terms reach the English page of the same deck.
		assert.match(await textOf(tool, { terms: ["replication"] }), /lecture-03\.pdf, p\. 4:/);
		// A term in no deck is reported as absent, with the boundary to declare.
		const missing = await textOf(tool, { terms: ["kubernetes"] });
		assert.match(missing, /Nothing in the indexed slides of "DISTSYS" matches/);
		assert.match(missing, /going beyond them/);
	});

	await t.test("one reply stays bounded however much of the course matches", async () => {
		// 80 long pages that ALL match: the caps decide the size, not the course.
		const flood = Array.from({ length: 80 }, (_, i) =>
			`--- Page ${i + 1} ---\n\nconsenso ${"prosa lunga che continua ".repeat(40)}`).join("\n\n");
		await host.call("study", "putIndex", { course: "DISTSYS", label: "extra/lecture-04.pdf", markdown: flood, notices: [] });
		const tool = host.agentContributions({ chatId: chat.id, agent: "teacher" }, []).tools[0]!;
		const flooded = await textOf(tool, { terms: ["consenso"] });
		assert.ok(tokensOf(flooded) < 800, `a pathological course returned ${tokensOf(flooded)} tokens`);
		assert.equal((flooded.match(/lecture-04\.pdf, p\. /g) ?? []).length, 6, "capped at six excerpts");
	});

	await t.test("a deck whose file changed stops answering from stale text", async () => {
		fs.writeFileSync(path.join(slides, "lecture-03.pdf"), "%PDF-1.7 fixture, rewritten and longer");
		const tool = host.agentContributions({ chatId: chat.id, agent: "teacher" }, []).tools[0]!;
		assert.match(await textOf(tool, {}), /lecture-03\.pdf — NOT indexed/);
		// Re-indexing the new bytes brings it back.
		await host.call("study", "putIndex", {
			course: "DISTSYS", label: "lecture-03.pdf", markdown: LECTURE_03, notices: [],
			size: fs.statSync(path.join(slides, "lecture-03.pdf")).size,
		});
		assert.match(await textOf(tool, { terms: ["elezioni"] }), /lecture-03\.pdf, p\. 3:/);
	});

	await t.test("an oversize deck never lets truncated slides be reported as absent", async () => {
		const big = Array.from({ length: 405 }, (_, index) => `--- Page ${index + 1} ---\n\nfiller ${index + 1}${index === 0 ? ` ${"x".repeat(4500)}` : ""} ${index === 404 ? "zebrafish" : ""}`).join("\n\n");
		const size = fs.statSync(path.join(slides, "lecture-03.pdf")).size;
		const reply = await host.call("study", "putIndex", { course: "DISTSYS", label: "lecture-03.pdf", markdown: big, notices: [], size }) as { pages: number };
		assert.equal(reply.pages, 400);
		const tool = host.agentContributions({ chatId: chat.id, agent: "teacher" }, []).tools[0]!;
		const missing = await textOf(tool, { terms: ["zebrafish"] });
		assert.match(missing, /5 pages after the first 400 not indexed/);
		assert.match(missing, /1 long page cut short/);
		assert.match(await textOf(tool, {}), /beyond the index limits/);
		await host.call("study", "putIndex", { course: "DISTSYS", label: "lecture-03.pdf", markdown: LECTURE_03, notices: [], size });
		assert.doesNotMatch(await textOf(tool, { terms: ["zebrafish"] }), /Index limits/);
	});

	await t.test("the index refuses text that did not come from the course's own folder", async () => {
		await assert.rejects(host.call("study", "putIndex", { course: "DISTSYS", label: "../secret.pdf", markdown: LECTURE_03 }),
			/is not a deck in/);
		await assert.rejects(host.call("study", "putIndex", { course: "DISTSYS", label: "lecture-03.pdf", markdown: LECTURE_03, size: 999999 }),
			/does not match the file that was read/);
		await assert.rejects(host.call("study", "putIndex", { course: "DISTSYS", label: "lecture-03.pdf", markdown: LECTURE_03 }),
			/does not match the file that was read/);
		await assert.rejects(host.call("study", "putIndex", { course: "DISTSYS", label: "lecture-03.pdf", markdown: "   " }),
			/converted to no text at all/);
	});

	await t.test("an unticked deck stays out of scope", async () => {
		await host.call("study", "select", { chatId: chat.id, course: "DISTSYS", decks: ["lecture-03.pdf"], notes: false });
		const listed = await textOf(host.agentContributions({ chatId: chat.id, agent: "teacher" }, []).tools[0]!, {});
		assert.match(listed, /1 deck in scope/);
		assert.doesNotMatch(listed, /lecture-04\.pdf/);
		// A deck outside the course folder cannot be smuggled into a selection.
		assert.deepEqual(await host.call("study", "select", { chatId: chat.id, course: "DISTSYS", decks: ["../secret.pdf"], notes: false }),
			{ course: "DISTSYS", decks: [], notes: false });
	});

	await t.test("the phase decides how much the librarian says", async () => {
		const teaching = chatStore.createChat("DISTSYS — teaching");
		await host.call("study", "select", { chatId: teaching.id, course: "DISTSYS", decks: [], notes: false });
		const describe = () => host.agentContributions({ chatId: teaching.id, agent: "teacher" }, []).tools[0]!.description;
		assert.match(describe(), /ONLY through this tool/, "probe");
		chatStore.saveMessages(teaching.id, PROBE_DONE as never);
		assert.match(describe(), /ONLY through this tool/, "plan");
		chatStore.saveMessages(teaching.id, [...PROBE_DONE, TAGGED_QUIZ] as never);
		const pointer = describe();
		assert.doesNotMatch(pointer, /ONLY through this tool/, "teach");
		assert.match(pointer, /cite only the pages it gives you/);
	});

	await t.test("notes are off until the session asks for them, and need a token", async () => {
		// No token saved yet: asking for notes cannot turn them on.
		assert.deepEqual(await host.call("study", "select", { chatId: chat.id, course: "DISTSYS", decks: [], notes: true }),
			{ course: "DISTSYS", decks: [], notes: false });
		assert.deepEqual(host.agentContributions({ chatId: chat.id, agent: "teacher" }, []).tools.map(tool => tool.name), ["course_library"]);

		await assert.rejects(host.call("study", "setLogseq", { serverUrl: "ftp://nope", token: "t" }), /http:\/\/ or https:\/\//);
		await host.call("study", "setLogseq", { serverUrl: "http://127.0.0.1:12315/mcp", token: "secret-token" });
		await host.call("study", "select", { chatId: chat.id, course: "DISTSYS", decks: [], notes: true });
		const tools = host.agentContributions({ chatId: chat.id, agent: "teacher" }, []).tools;
		assert.deepEqual(tools.map(tool => tool.name), ["course_library", "logseq_search_notes", "logseq_read_course_notes"]);
		const read = tools.find(tool => tool.name === "logseq_read_course_notes")!;
		// The model is told the Logseq name instead of being left to guess a block
		// it has never seen, and may omit the argument entirely.
		assert.match(read.description, /Omit `course` to read "DISTSYS"/);
		assert.deepEqual((read.parameters as { required?: unknown }).required, []);
		assert.match(read.description, /Call logseq_read_course_notes ONCE/);
		assert.match(read.description, /not every turn/);
		// The composed tool description carries the firm rule: a page the tool gave is always cited with its deck.
		assert.match(read.description, /Always cite the journal day, and whenever the tool gave a slide page, cite that deck and page too/);
		assert.doesNotMatch(read.description, /upsertNodes/, "no write tool is named to an agent");

		// The token is plugin-owned: no read-back operation returns it.
		const state = await host.call("study", "state") as { logseq: { hasToken: boolean } };
		assert.deepEqual(state.logseq, { serverUrl: "http://127.0.0.1:12315/mcp", hasToken: true, defaultUrl: "http://127.0.0.1:12315/mcp" });
		assert.doesNotMatch(JSON.stringify(state), /secret-token/);
		// Saving only the URL keeps the token rather than silently clearing it.
		await host.call("study", "setLogseq", { serverUrl: "http://127.0.0.1:9999/mcp" });
		assert.equal((await host.call("study", "state") as { logseq: { hasToken: boolean } }).logseq.hasToken, true);
	});

	await t.test("a failed Logseq call answers the agent in words and never echoes the token", async () => {
		const read = host.agentContributions({ chatId: chat.id, agent: "teacher" }, []).tools
			.find(tool => tool.name === "logseq_read_course_notes")!;
		const answer = await textOf(read, {});
		assert.match(answer, /Could not read the learner's Logseq notes/);
		assert.doesNotMatch(answer, /secret-token/);
	});

	await t.test("clearing the session returns every turn to zero", async () => {
		await host.call("study", "clear", { chatId: chat.id });
		assert.equal(await host.call("study", "selection", { chatId: chat.id }), null);
		for (const agent of KINDS) assert.deepEqual(host.agentContributions({ chatId: chat.id, agent }, []).tools, [], agent);
	});

	await t.test("the explain-back box can be switched off entirely", async () => {
		await host.call("study", "setExplainBack", { enabled: false });
		assert.deepEqual(host.agentContributions({ chatId: chat.id, agent: "teacher" }, []).questionTypes ?? [], []);
		await host.call("study", "setExplainBack", { enabled: true });
		assert.deepEqual((host.agentContributions({ chatId: chat.id, agent: "teacher" }, []).questionTypes ?? [])
			.map(entry => entry.definition.id), ["study-explain"]);
	});

	await t.test("the real native teacher takes the tool and keeps its own", async () => {
		await host.call("study", "select", { chatId: chat.id, course: "DISTSYS", decks: [], notes: false });
		const foreground = createFauxCore({});
		const agent = createTeacherAgent(undefined, {
			chatId: chat.id,
			engine: { model: foreground.getModel(), streamFn: foreground.streamSimple },
			pluginContributions: host.agentContributions,
		});
		assert.doesNotMatch(agent.state.systemPrompt, /course_library/, "the system prompt is left exactly as it was");
		assert.ok(agent.state.tools.some(tool => tool.name === "course_library"), "the librarian joins the loadout");
		assert.ok(agent.state.tools.some(tool => tool.name === "study_explain"), "the explain-back box joins it too");
		assert.ok(agent.state.tools.some(tool => tool.name === "quiz"), "core tools remain available");
	});

	await t.test("removing the course takes its cached page text with it", async () => {
		const cached = () => fs.readdirSync(path.join(directory, "study", "data", "index"));
		assert.ok(cached().length > 0, "a deck was indexed");
		await host.call("study", "removeCourse", { name: "DISTSYS" });
		assert.deepEqual(cached(), []);
		for (const agent of KINDS) assert.deepEqual(host.agentContributions({ chatId: chat.id, agent }, []).tools, [], agent);
	});

	await t.test("disabling the plugin returns the prompts untouched", async () => {
		await host.setEnabled("study", false);
		assert.deepEqual(host.agentContributions({ chatId: chat.id, agent: "teacher" }, []), EMPTY);
	});
});

/** The budget the learner asked for, in the app's own estimator. */
test("study plugin: what a turn costs in each state", { timeout: 20000 }, async t => {
	const directory = path.join(data, "budget-plugins");
	fs.mkdirSync(directory, { recursive: true });
	fs.cpSync(path.resolve("examples/plugins/study"), path.join(directory, "study"), { recursive: true });
	const slides = path.join(root, "budget-slides");
	fs.mkdirSync(slides, { recursive: true });
	fs.writeFileSync(path.join(slides, "lecture-03.pdf"), "%PDF-1.7 fixture");

	const host = makeHost(directory);
	t.after(() => host.dispose());
	await host.initialize();
	await host.setEnabled("study", true);
	const chat = chatStore.createChat("budget");

	/** Everything a turn pays this plugin: prompt text, tools, question tools. */
	const cost = (agent: PluginAgentKind) => {
		const contributions = host.agentContributions({ chatId: chat.id, agent }, []);
		const parts = [
			...contributions.instructions,
			...contributions.tools.map(tool => `${tool.name}${tool.description}${JSON.stringify(tool.parameters)}`),
			...(contributions.questionTypes ?? []).map(entry => {
				const tool = entry.definition[entry.variant]!;
				return `${tool.toolName}${tool.description}${JSON.stringify(entry.definition.questionSchema)}`;
			}),
		];
		return tokensOf(parts.join(""));
	};

	const measured: Record<string, number> = {};
	measured["nothing configured — prober/practice"] = cost("prober");
	measured["nothing configured — teacher (explain-back only)"] = cost("teacher");
	await host.call("study", "addCourse", { name: "DISTSYS", folder: slides, logseq: "DISTSYS" });
	measured["course configured, this session picked none — teacher"] = cost("teacher");
	await host.call("study", "select", { chatId: chat.id, course: "DISTSYS", decks: [], notes: false });
	measured["course active, planning — teacher"] = cost("teacher");
	measured["course active, practice — practice"] = cost("practice");
	chatStore.saveMessages(chat.id, [...PROBE_DONE, TAGGED_QUIZ] as never);
	measured["course active, teaching — teacher"] = cost("teacher");
	await host.call("study", "setLogseq", { serverUrl: "http://127.0.0.1:12315/mcp", token: "t" });
	await host.call("study", "select", { chatId: chat.id, course: "DISTSYS", decks: [], notes: true });
	measured["course + notes active, teaching — teacher"] = cost("teacher");
	chatStore.saveMessages(chat.id, [] as never);
	measured["course + notes active, planning — teacher"] = cost("teacher");
	await host.call("study", "setExplainBack", { enabled: false });
	measured["course + notes active, planning, explain-back off — teacher"] = cost("teacher");
	await host.call("study", "clear", { chatId: chat.id });
	measured["configured but nothing active, explain-back off — teacher"] = cost("teacher");

	// Printed so the README's table can be regenerated from a run, not retyped.
	for (const [state, tokens] of Object.entries(measured)) console.log(`  ${String(tokens).padStart(5)} tokens — ${state}`);

	// The three guarantees the learner asked for, as assertions.
	assert.equal(measured["nothing configured — prober/practice"], 0, "an unconfigured plugin changes no prober turn");
	assert.equal(measured["course configured, this session picked none — teacher"],
		measured["nothing configured — teacher (explain-back only)"],
		"a session that picked nothing pays nothing for the course");
	assert.equal(measured["configured but nothing active, explain-back off — teacher"], 0, "everything off is a true zero");
	assert.ok(measured["course active, teaching — teacher"] < measured["course active, planning — teacher"],
		"teaching pays a pointer, planning pays the rules");
	assert.ok(measured["course active, planning — teacher"] < 900,
		`the planning turn is ${measured["course active, planning — teacher"]} tokens`);
});
