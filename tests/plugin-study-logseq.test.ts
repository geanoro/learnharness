/**
 * Off-network coverage for the study plugin's Logseq notes module
 * (examples/plugins/study/dist/logseq.cjs). The module is not a plugin of its
 * own: it has no manifest, settings or view, so these tests drive its entry
 * points directly against a fake local MCP server, exactly as backend.cjs
 * calls them.
 *
 * The flashcard export the earlier version carried is gone (the captain's
 * decision: the slide decks are the better card source, the notes are teacher
 * context), so there is no export to cover here.
 */
import assert from "node:assert/strict";
import * as path from "node:path";
import { after, test } from "node:test";
import { startFakeLogseqServer, type FakeSeed, type FakeServer } from "./helpers/logseq-mcp-fake.ts";

const TOKEN = "fake-local-token";
const servers: FakeServer[] = [];
const fake = await startFakeLogseqServer({ token: TOKEN });
servers.push(fake);

// The module may reach ONLY a fake local server; anything else is a bug.
const realFetch = globalThis.fetch;
const allowed = new Set<string>([fake.url]);
globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
	const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
	if (!allowed.has(url)) throw new Error(`Unexpected network in logseq-notes module test: ${url}`);
	return realFetch(input, init);
}) as typeof fetch;

after(async () => {
	globalThis.fetch = realFetch;
	for (const server of servers) await server.close();
});

const MODULE = path.resolve("examples/plugins/study/dist/logseq.cjs");
const { createLogseqNotesModule, createClient, NOTES_GUIDANCE } = await import(MODULE);

type Config = { serverUrl?: string; token?: string };
type Module = {
	createTools(): { name: string; label: string; description: string; parameters: unknown; execute(id: string, input: unknown, signal: AbortSignal): Promise<{ content: { type: string; text: string }[] }> }[];
	searchNotes(query: string, signal?: AbortSignal): Promise<string>;
	readCourseNotes(course: string, signal?: AbortSignal): Promise<string>;
	checkConnection(signal?: AbortSignal): Promise<{ ok: boolean; message: string }>;
	invalidate(): void;
};

/** The host plugin supplies the config; this stands in for its settings. */
function build(config: Config = { serverUrl: fake.url, token: TOKEN }) {
	const current: Config = { ...config };
	const logseq = createLogseqNotesModule({ readConfig: () => current }) as Module;
	return { logseq, set: (next: Config) => { Object.assign(current, next); logseq.invalidate(); } };
}

/** Indexed access under `noUncheckedIndexedAccess`, failing loudly if absent. */
const at = <T>(items: readonly T[], index: number): T => {
	const value = items[index];
	assert.ok(value !== undefined, `expected an entry at index ${index}`);
	return value;
};

const tokens = (text: string) => Math.ceil(text.length / 4);

const viaTool = async (target: Module, name: string, input: unknown) => {
	const tool = target.createTools().find(candidate => candidate.name === name);
	assert.ok(tool, `${name} missing`);
	const output = await tool.execute("call-1", input, new AbortController().signal);
	return output.content.filter(part => part.type === "text").map(part => part.text).join("\n");
};

test("the module exposes exactly the two read-only note tools, and no plugin surface or prompt text of its own", () => {
	const { logseq } = build();
	const tools = logseq.createTools();
	assert.deepEqual(tools.map(tool => tool.name).sort(), ["logseq_read_course_notes", "logseq_search_notes"]);
	// No manifest, settings or view: the study plugin owns all of that. And no
	// `instructions` member either — registerInstructions can never reach zero
	// for a session that turned the notes off, so the guidance is a string the
	// backend appends to a tool description instead.
	for (const absent of ["activate", "registerSettings", "registerView", "manifest", "instructions"]) {
		assert.equal(absent in logseq, false, `the module must not expose ${absent}`);
	}
	// The guidance and the tool definitions are charged to a turn that has the
	// notes on, so their size is what that turn pays. Measured chars/4, as
	// src/server/chat-handler.ts:367 estimates the system prompt.
	assert.ok(tokens(NOTES_GUIDANCE) <= 200, `the guidance costs ${tokens(NOTES_GUIDANCE)} tokens on a notes turn`);
	let standing = tokens(NOTES_GUIDANCE);
	for (const tool of tools) {
		const cost = tokens(tool.name) + tokens(tool.description) + tokens(JSON.stringify(tool.parameters));
		standing += cost;
		assert.ok(cost <= 110, `${tool.name} definition costs ${cost} tokens`);
	}
	assert.ok(standing <= 400, `the module's per-turn cost with notes on is ${standing} tokens`);
});

test("when Logseq notes are off for a session the module contributes no tools, so the turn pays nothing for them", async () => {
	const turns: unknown[] = [];
	const logseq = createLogseqNotesModule({
		readConfig: () => ({ serverUrl: fake.url, token: TOKEN }),
		isEnabled: (context: { chatId?: string }) => { turns.push(context); return context.chatId === "notes-on"; },
	}) as Module & { createTools(context?: unknown): ReturnType<Module["createTools"]> };

	// `create` runs fresh every turn, so the gate is consulted per turn.
	assert.deepEqual(logseq.createTools({ chatId: "notes-off", agent: "teacher" }), []);
	assert.deepEqual(logseq.createTools({ chatId: "notes-on", agent: "teacher" }).map(tool => tool.name).sort(),
		["logseq_read_course_notes", "logseq_search_notes"]);
	assert.deepEqual(turns, [{ chatId: "notes-off", agent: "teacher" }, { chatId: "notes-on", agent: "teacher" }]);

	// Off means zero tool tokens, not a cheaper tool.
	const off = logseq.createTools({ chatId: "notes-off", agent: "teacher" });
	assert.equal(off.reduce((sum, tool) => sum + tokens(tool.name) + tokens(tool.description) + tokens(JSON.stringify(tool.parameters)), 0), 0);

	// The feature still works for an enabled session.
	assert.match(await logseq.readCourseNotes("DISTSYS"), /## Nov 20th, 2026/);

	// Default is enabled, so a host that does not gate keeps today's behaviour.
	const ungated = createLogseqNotesModule({ readConfig: () => ({ serverUrl: fake.url, token: TOKEN }) }) as Module;
	assert.equal(ungated.createTools().length, 2);
});

test("createLogseqNotesModule refuses to start without a config supplier", () => {
	assert.throws(() => createLogseqNotesModule({}), /needs a readConfig/);
	assert.throws(() => createLogseqNotesModule(), /needs a readConfig/);
});

test("searchNotes returns the learner's own notes and doubts with the slide deck and page they came from", async () => {
	const { logseq } = build();
	const text = await logseq.searchNotes("randomized timeouts");
	assert.match(text, /## Nov 20th, 2026/, "hits are grouped by journal day");
	assert.match(text, /learner doubt: IDONT GET why randomized timeouts fix split vote/);
	assert.doesNotMatch(text, /groceries/, "an unrelated journal day must not be pulled in");
	await assert.rejects(() => logseq.searchNotes("a"), /at least two characters/);
});

test("readCourseNotes groups a course by journal day and keeps each note under the highlight it belongs to", async () => {
	const { logseq } = build();
	const text = await logseq.readCourseNotes("DISTSYS");
	for (const day of ["## Nov 20th, 2026", "## Nov 21st, 2026", "## Nov 23rd, 2026"]) assert.match(text, new RegExp(day));
	assert.match(text, /slide highlight — DISTSYS lecture 3 - consensus and Raft, p\.12: A leader is elected for a term/);
	assert.match(text, /slide highlight — DISTSYS lecture 4 - log compaction, p\.7: Snapshotting discards log entries/);
	// The learner's note sits under its highlight, indented, not at the top level.
	assert.match(text, /p\.12: A leader is elected[^\n]*\n {2}- learner doubt: so term is like a logical clock\?\? not so confident/);
	assert.match(text, /- learner doubt: why not just keep the log\?\? disk is cheap/);
	assert.match(text, /- learner: ok this is the part i get/);
	// A block that is only a [[link]] to a highlight is a pointer, not prose.
	assert.match(text, /- refers to: A leader is elected for a term/);
	// A block that is only [[Some Page]] is the learner's own section header:
	// it reads as the topic, never as a pointer back to a highlight.
	assert.match(text, /\n- DISTSYS\n {2}- learner: Raft - leader election/);
	// Logseq's link syntax is graph markup and must not reach the agent.
	assert.match(text, /- learner: Did the quiz for DISTSYS on Consensus/);
	assert.doesNotMatch(text, /\[\[/, "no wiki-link syntax may survive into the agent's context");
	// Headers count what the learner actually wrote, not navigation blocks.
	assert.match(text, /10 note\(s\) of which 4 sound unsure, across 3 journal day\(s\)/);
	// Empty bullets carry nothing and must not become empty lines of context.
	assert.doesNotMatch(text, /- learner: *\n/);
	assert.match(text, /These are the learner's notes, not the course material/);
	assert.doesNotMatch(text, /groceries/);
});

test("a highlight whose slide deck the search did not return still reports its slide page", async () => {
	// "Snapshotting" matches the highlight but not the asset block's own title,
	// so the asset name is genuinely unknown and must not be invented.
	const { logseq } = build();
	const text = await logseq.searchNotes("Snapshotting");
	assert.match(text, /slide highlight — slide p\.7: Snapshotting discards log entries/);
	assert.doesNotMatch(text, /log compaction, p\.7/);
});

test("reads stay read-only and bounded: only the three read tools are ever called, and entity lookups are capped", async () => {
	const { logseq } = build();
	await logseq.checkConnection();
	const before = fake.calls.length;
	await logseq.readCourseNotes("DISTSYS");
	const made = fake.calls.slice(before);
	assert.deepEqual([...new Set(fake.calls.map(call => call.name))].sort(), ["getPage", "listPages", "searchBlocks"]);
	assert.equal(fake.calls.some(call => call.name === "upsertNodes"), false, "the module must never write to the graph");
	assert.equal(made.filter(call => call.name === "searchBlocks").length, 1, "one search per call");
	assert.ok(made.filter(call => call.name === "getPage").length <= 12, `entity lookups must stay bounded, saw ${made.filter(call => call.name === "getPage").length}`);
	assert.equal(made.filter(call => call.name === "listPages").length, 0, "the page index is cached between calls");

	// invalidate() is how the host drops the cache after its settings change.
	logseq.invalidate();
	const afterInvalidate = fake.calls.length;
	await logseq.readCourseNotes("DISTSYS");
	assert.equal(fake.calls.slice(afterInvalidate).filter(call => call.name === "listPages").length, 1);
});

test("the read-only MCP client refuses a write tool outright, before any request", async () => {
	const client = createClient({ url: fake.url, token: TOKEN });
	const before = fake.calls.length;
	await assert.rejects(() => client.callTool("upsertNodes", { nodes: [] }), /read-only and never calls upsertNodes/);
	assert.equal(fake.calls.length, before, "a refused write must not reach the server at all");
});

test("a huge graph cannot blow up the lesson context: both tool outputs stay under their hard caps", async () => {
	// 60 journal days of long notes under a matching topic: far more than any
	// real course, so the caps - not the data - decide the output size.
	const pages: FakeSeed["pages"] = [];
	const blocks: FakeSeed["blocks"] = [];
	for (let day = 0; day < 60; day += 1) {
		const uuid = `big-page-${day}`;
		const containerId = 90000 + day * 100;
		pages.push({ uuid, title: `Day ${day}`, containerId });
		blocks.push({ id: containerId + 1, uuid: `big-${day}-head`, title: "[[BIGCOURSE]]", parent: containerId, page: uuid, level: 1 });
		for (let note = 0; note < 10; note += 1) {
			blocks.push({
				id: containerId + 2 + note, uuid: `big-${day}-${note}`, parent: containerId + 1, page: uuid, level: 2,
				title: `note ${day}.${note} ${"long winded study prose that keeps going ".repeat(12)}`,
			});
		}
	}
	pages.push({ uuid: "big-course-page", title: "BIGCOURSE", containerId: 99999 });
	const big = await startFakeLogseqServer({ token: TOKEN, seed: { pages, blocks } });
	servers.push(big);
	allowed.add(big.url);
	const { logseq } = build({ serverUrl: big.url, token: TOKEN });

	const course = await logseq.readCourseNotes("BIGCOURSE");
	assert.ok(course.length <= 4000, `course read must stay within its cap, saw ${course.length} chars`);
	assert.match(course, /truncated/i, "a truncated answer must say so rather than look complete");

	const search = await logseq.searchNotes("long winded");
	assert.ok(search.length <= 2800, `search must stay within its cap, saw ${search.length} chars`);
	assert.match(search, /truncated/i);

	// One search per call and a capped number of entity reads, whatever the size.
	const before = big.calls.length;
	await logseq.readCourseNotes("BIGCOURSE");
	const made = big.calls.slice(before);
	assert.equal(made.filter(call => call.name === "searchBlocks").length, 1);
	assert.ok(made.filter(call => call.name === "getPage").length <= 12);
});

test("a wrong token, a closed Logseq app and a missing token each produce a message the learner can act on", async () => {
	const { logseq, set } = build();

	set({ token: "not-the-token" });
	const rejected = await logseq.checkConnection();
	assert.equal(rejected.ok, false);
	assert.match(rejected.message, /rejected the token/);
	assert.doesNotMatch(rejected.message, /not-the-token/, "a failure must not echo the token");

	// A tool answers the agent in words instead of throwing the turn away.
	const text = await viaTool(logseq, "logseq_search_notes", { query: "Raft" });
	assert.match(text, /Could not read the learner's Logseq notes\./);
	assert.match(text, /rejected the token/);

	const closed = await startFakeLogseqServer({ token: TOKEN });
	allowed.add(closed.url);
	await closed.close();
	set({ serverUrl: closed.url, token: TOKEN });
	const unreachable = await logseq.checkConnection();
	assert.equal(unreachable.ok, false);
	assert.match(unreachable.message, /Could not reach the Logseq MCP server/);
	assert.match(unreachable.message, /Open the Logseq app/);
	assert.match(await viaTool(logseq, "logseq_read_course_notes", { course: "DISTSYS" }), /Open the Logseq app/);

	// The host has a settings page but the learner has not pasted a token yet.
	set({ serverUrl: fake.url, token: "" });
	const unconfigured = await logseq.checkConnection();
	assert.equal(unconfigured.ok, false);
	assert.match(unconfigured.message, /Set the Logseq MCP server token/);
	assert.match(await viaTool(logseq, "logseq_search_notes", { query: "Raft" }), /Set the Logseq MCP server token/);

	set({ token: TOKEN });
	assert.equal((await logseq.checkConnection()).ok, true);
});

test("the token never appears in any message the module produces, whatever fails", async () => {
	const secret = "SUPERSECRET-should-never-surface";
	const { logseq } = build({ serverUrl: fake.url, token: secret });
	const surfaces = [
		(await logseq.checkConnection()).message,
		await viaTool(logseq, "logseq_search_notes", { query: "Raft" }),
		await viaTool(logseq, "logseq_read_course_notes", { course: "DISTSYS" }),
	];
	for (const surface of surfaces) assert.doesNotMatch(surface, new RegExp(secret), "a token must never reach a message");
	assert.match(at(surfaces, 0), /rejected the token/);
});
