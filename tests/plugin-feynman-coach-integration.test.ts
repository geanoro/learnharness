import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, test } from "node:test";
import { createFauxCore } from "@earendil-works/pi-ai";
import { Compile } from "typebox/compile";
import type { PluginAgentService } from "../src/core/plugin-agents.ts";
import type { PluginLearningData } from "../src/core/plugins.ts";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "lh-feynman-coach-plugin-"));
const data = path.join(root, "data");
process.env.LH_DATA_DIR = data;
process.env.LH_AUTH_FILE = path.join(root, "auth.json");
const originalFetch = globalThis.fetch;
globalThis.fetch = async () => { throw new Error("Unexpected network in feynman-coach-plugin integration"); };
after(() => { globalThis.fetch = originalFetch; fs.rmSync(root, { recursive: true, force: true }); });

// Configure storage BEFORE loading any module which reads app paths.
const { createPluginHost } = await import("../src/server/plugin-host.ts");
const { createTeacherAgent } = await import("../src/agent/teacher-agent.ts");
const { chatStore } = await import("../src/store/chats.ts");
const { questionDefinition } = await import(path.resolve("examples/plugins/feynman-coach/dist/backend.cjs"));

test("the feynman-explain question/answer schemas accept the confidence scale and reject whitespace-only explanations", () => {
	const question = Compile(questionDefinition.questionSchema);
	const answer = Compile(questionDefinition.answerSchema);
	assert.equal(question.Check({ mode: "full" }), true);
	assert.equal(question.Check({ mode: "short" }), true);
	for (const value of [{}, { mode: "medium" }, { mode: "full", extra: 1 }]) assert.equal(question.Check(value), false);
	for (const confidence of [0, 30, 50, 70, 90, 100]) assert.equal(answer.Check({ explanation: "A causes B because of the mechanism.", confidence }), true);
	for (const value of [
		{ explanation: "", confidence: 50 },
		{ explanation: "ok", confidence: 40 },
		{ explanation: "ok" },
		{ confidence: 50 },
		{ explanation: "ok", confidence: 50, extra: true },
	]) assert.equal(answer.Check(value), false);
	for (const explanation of ["   ", "\n\t "]) {
		assert.equal(answer.Check({ explanation, confidence: 50 }), true, "schema alone allows whitespace-only text");
		assert.deepEqual(questionDefinition.validateAnswer({ answer: { explanation, confidence: 50 } }), ["explanation must contain nonwhitespace text"]);
	}
	assert.equal(questionDefinition.validateAnswer({ answer: { explanation: "A real explanation.", confidence: 50 } }), undefined);
	assert.equal(questionDefinition.showThinking, false);
	assert.equal("probe" in questionDefinition, false);
	assert.equal(questionDefinition.teach.toolName, "feynman_explain");
});

test("feynman-coach example composes its explain-back instructions and a native feynman_explain question tool into the teacher's prompt when enabled", { timeout: 10000 }, async t => {
	const directory = path.join(data, "plugins");
	fs.mkdirSync(directory, { recursive: true });
	fs.cpSync(path.resolve("examples/plugins/feynman-coach"), path.join(directory, "feynman-coach"), { recursive: true });
	const foreground = createFauxCore({});
	const host = createPluginHost({
		directory, appVersion: "0.6.1",
		createServices(info) {
			return {
				learning: { directory: data } as PluginLearningData,
				inference: { catalog: async () => { throw new Error("Unused in this fixture"); }, engineFor: () => { throw new Error("Unused in this fixture"); }, onUsage: () => {} } as never,
				agents: { dispose: async () => {} } as PluginAgentService,
				workers: { dispose: async () => {} } as never,
				createBackgroundTool: () => { throw new Error("feynman-coach registers no background worker tools"); },
			};
		},
	});
	t.after(() => host.dispose());
	await host.initialize();
	await host.setEnabled("feynman-coach", true);
	assert.equal(host.list()[0]?.status, "active", JSON.stringify(host.list()));
	assert.equal(host.list()[0]?.error, undefined, JSON.stringify(host.list()));

	const chat = chatStore.createChat("Feynman coach plugin proof");
	const contributions = host.agentContributions({ chatId: chat.id, agent: "teacher" }, []);
	assert.equal(contributions.questionTypes?.length, 1);
	assert.equal(contributions.questionTypes?.[0]?.pluginId, "feynman-coach");
	assert.equal(contributions.questionTypes?.[0]?.definition.id, "feynman-explain");
	assert.equal(contributions.questionTypes?.[0]?.variant, "teach");
	assert.equal(host.resolveQuestionType("feynman-coach", "feynman-explain", 1).status, "available");
	assert.equal(host.resolveQuestionType("feynman-coach", "feynman-explain", 2).status, "unavailable");

	const agent = createTeacherAgent(undefined, {
		chatId: chat.id,
		engine: { model: foreground.getModel(), streamFn: foreground.streamSimple },
		pluginContributions: host.agentContributions,
	});
	assert.match(agent.state.systemPrompt, /explain the whole node back in his own words/);
	assert.match(agent.state.systemPrompt, /at most/);
	assert(agent.state.tools.some(tool => tool.name === "quiz"), "core tools remain available");
	const explainTool = agent.state.tools.find(tool => tool.name === "feynman_explain");
	assert(explainTool, "feynman_explain is exposed as a native teach tool");
	assert.match(explainTool!.description, /Feynman-style explain-back/);

	await host.setEnabled("feynman-coach", false);
	assert.deepEqual(host.agentContributions({ chatId: chat.id, agent: "teacher" }, []), { instructions: [], tools: [] });
});
