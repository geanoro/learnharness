import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, test } from "node:test";
import { createFauxCore } from "@earendil-works/pi-ai";
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

test("feynman-coach example composes its explain-back instructions into the teacher's prompt when enabled", { timeout: 10000 }, async t => {
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
				createBackgroundTool: () => { throw new Error("feynman-coach registers no tools"); },
			};
		},
	});
	t.after(() => host.dispose());
	await host.initialize();
	await host.setEnabled("feynman-coach", true);
	assert.equal(host.list()[0]?.status, "active", JSON.stringify(host.list()));
	assert.equal(host.list()[0]?.error, undefined, JSON.stringify(host.list()));

	const chat = chatStore.createChat("Feynman coach plugin proof");
	const agent = createTeacherAgent(undefined, {
		chatId: chat.id,
		engine: { model: foreground.getModel(), streamFn: foreground.streamSimple },
		pluginContributions: host.agentContributions,
	});
	assert.match(agent.state.systemPrompt, /explain the whole node back in his own words/);
	assert.match(agent.state.systemPrompt, /at most/);
	assert(agent.state.tools.some(tool => tool.name === "quiz"), "core tools remain available");
	assert.equal(agent.state.tools.length, agent.state.tools.filter(tool => tool.name !== "feynman_coach").length, "no new tool is registered");

	await host.setEnabled("feynman-coach", false);
	assert.deepEqual(host.agentContributions({ chatId: chat.id, agent: "teacher" }, []), { instructions: [], tools: [] });
});
