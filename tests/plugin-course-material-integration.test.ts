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
		assert.equal(contributions.instructions.length, 1, agent);
		const text = contributions.instructions[0]!;
		assert.ok(text.includes(`"Basi di dati" — ${slides}`), agent);
		assert.match(text, /Call `course_material` ONCE for that course/);
		assert.match(text, /Read a deck with the native `pdf` job/);
		assert.match(text, /never cite a page you have not read/);
		assert.match(text, /whenever you go beyond the slides/);
		assert.deepEqual(contributions.tools.map(tool => tool.name), ["course_material"], agent);
	}

	// The real native teacher composes the directive into its prompt and keeps its own tools.
	const agent = createTeacherAgent(undefined, {
		chatId: chat.id,
		engine: { model: foreground.getModel(), streamFn: foreground.streamSimple },
		pluginContributions: host.agentContributions,
	});
	assert.match(agent.state.systemPrompt, /## Course material/);
	assert.match(agent.state.systemPrompt, /never guess a folder/);
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
	assert.match(listed, /2 PDFs/);
	assert.ok(listed.includes(path.join(slides, "lecture-01.pdf")));
	assert.ok(listed.includes(path.join("extra", "lecture-02.pdf")));
	assert.doesNotMatch(listed, /notes\.txt/);
	assert.match(listed, /Read a deck with the `pdf` job/);
	// An unmatched course names the real ones instead of failing or substituting a folder.
	const missed = await run({ course: "Fisica" });
	assert.match(missed, /No configured course matches "Fisica"/);
	assert.match(missed, /"Basi di dati"/);
	assert.match(missed, /never substitute another folder/);

	// Removing the last course returns the prompts to untouched.
	assert.deepEqual(await host.call("course-material", "remove", { name: "Basi di dati" }), []);
	for (const agent of kinds) assert.deepEqual(host.agentContributions({ chatId: chat.id, agent }, []), { instructions: [], tools: [] });

	await host.setEnabled("course-material", false);
	assert.deepEqual(host.agentContributions({ chatId: chat.id, agent: "teacher" }, []), { instructions: [], tools: [] });
});
