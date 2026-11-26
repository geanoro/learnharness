import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { renderToString } from "react-dom/server";
import { AppRouterContext } from "next/dist/shared/lib/app-router-context.shared-runtime.js";
import { PathnameContext } from "next/dist/shared/lib/hooks-client-context.shared-runtime.js";
import { Chat } from "../components/chat.tsx";
import { ActivityProvider } from "../components/activity-dock.tsx";
import { InteractionLayersProvider } from "../components/interaction-layers.tsx";
import { PluginsProvider } from "../components/plugins.tsx";
import { ServerEventsProvider } from "../components/server-events.tsx";
import { AppearanceProvider } from "../components/settings/appearance.tsx";
import { SettingsDialogProvider } from "../components/settings/settings-dialog.tsx";
import { SidebarProvider } from "../components/sidebar.tsx";
import { DEFAULT_THEME } from "../src/core/themes.ts";
import type { LhMessage } from "../src/core/native-messages.ts";

/* The window is the switch cost. A long session must reach the DOM as a TAIL
 * plus stand-ins, not as every passage it holds — that build is the ~0.6-0.7 s
 * of blocking main-thread work a switch spends. These assertions pin what
 * reaches the markup, and that the tail is the part that does. */

const router = { bfcacheId: "fixture", back() {}, forward() {}, refresh() {}, hmrRefresh() {}, push() {}, replace() {}, async prefetch() {} };

function passage(index: number): string {
	return `Passage ${index}. ${"A basic feasible solution sits at a vertex of the feasible polytope. ".repeat(12)}`;
}

/** One assistant group of `parts` prose passages. */
function teacherGroup(id: string, parts: number): LhMessage[] {
	return [{
		id, role: "assistant", stopReason: "stop", timestamp: 1, provider: "openrouter", model: "test",
		content: Array.from({ length: parts }, (_, i) => ({ type: "text", text: passage(i) })),
	} as unknown as LhMessage];
}

function learner(id: string, text: string): LhMessage {
	return { id, role: "user", content: text, timestamp: 0 } as unknown as LhMessage;
}

function render(messages: LhMessage[]): string {
	return renderToString(
		<AppRouterContext.Provider value={router}>
		<PathnameContext.Provider value="/chat/chat_window">
		<ServerEventsProvider>
			<PluginsProvider>
				<AppearanceProvider initialAppearance={undefined} initialTheme={DEFAULT_THEME}>
					<SidebarProvider>
						<ActivityProvider>
							<InteractionLayersProvider>
								<SettingsDialogProvider>
									<Chat chatId="chat_window" title="Window" kind="teach" initialMessages={messages} initialConfigured={false} />
								</SettingsDialogProvider>
							</InteractionLayersProvider>
						</ActivityProvider>
					</SidebarProvider>
				</AppearanceProvider>
			</PluginsProvider>
		</ServerEventsProvider>
		</PathnameContext.Provider>
		</AppRouterContext.Provider>,
	);
}

function passages(html: string): string[] {
	return [...html.matchAll(/Passage (\d+)\./g)].map((match) => match[1]!);
}

function spacers(html: string): string[] {
	return [...html.matchAll(/data-testid="transcript-window-spacer" data-edge="([a-z-]+)"/g)].map((match) => match[1]!);
}

describe("the transcript window", () => {
	it("builds the tail of a long session, not all of it", () => {
		// 40 passages at the 745px estimate is ~30,000px of transcript; the
		// window opens on the last ~2,000px of it.
		const html = render([learner("u1", "Explain the simplex method."), ...teacherGroup("t1", 40)]);
		const built = passages(html);
		assert.ok(built.length > 0, "the tail is built");
		assert.ok(built.length < 10, `the window built ${built.length} of 40 passages`);
		// The tail, not the head: what the learner sees when a session opens.
		assert.equal(built.at(-1), "39");
		assert.deepEqual(built.map(Number), built.map(Number).slice().sort((a, b) => a - b), "in order");
	});

	it("reserves the rows it did not build, so the scroller keeps its height", () => {
		const html = render([learner("u1", "Explain the simplex method."), ...teacherGroup("t1", 40)]);
		// Skipped parts of a built group are reserved INSIDE the group, so
		// its <Message> wrapper keeps the height it always had.
		assert.ok(spacers(html).includes("parts-before"), `spacers: ${spacers(html).join(",")}`);
		const reserved = [...html.matchAll(/data-edge="[a-z-]+" style="height:(\d+)px/g)].map((m) => Number(m[1]));
		assert.ok(reserved.length > 0, "a stand-in carries a height");
		// 31+ unbuilt passages at the passage estimate.
		assert.ok(reserved.reduce((a, b) => a + b, 0) > 20_000, `reserved ${reserved.join("+")}`);
	});

	it("builds a short session whole — nothing to window", () => {
		const html = render([learner("u1", "Explain the simplex method."), ...teacherGroup("t1", 2)]);
		assert.deepEqual(passages(html), ["0", "1"]);
		assert.deepEqual(spacers(html), []);
	});

	it("leaves the group wrapper uncontained, because its height is mostly stand-in", () => {
		const html = render([learner("u1", "Explain the simplex method."), ...teacherGroup("t1", 40)]);
		// The group reserves its unbuilt parts INSIDE its wrapper, so a single
		// contain-intrinsic-block-size cannot stand for the wrapper. The parts
		// keep their own containment.
		const wrappers = [...html.matchAll(/<div class="group flex w-full[^"]*"[^>]*>/g)].map((match) => match[0]);
		assert.ok(wrappers.length > 0, "the assistant group renders its wrapper");
		for (const wrapper of wrappers) assert.doesNotMatch(wrapper, /data-older-transcript-row/, wrapper);
		assert.match(html, /data-older-transcript-row="passage"/, "the built passages stay contained");
	});

	it("gives a learner turn its own size class", () => {
		// Two learner turns, so the first is no longer the newest and is
		// containable. "turn" estimates a learner turn, not the 800px default.
		const html = render([
			learner("u1", "Explain the simplex method."), ...teacherGroup("t1", 1),
			learner("u2", "And the dual?"), ...teacherGroup("t2", 1),
		]);
		assert.ok(passages(html).length === 2, `the whole fixture is built: ${passages(html).join(",")}`);
		assert.match(html, /data-older-transcript-row="turn"/);
	});

	it("gives every built row an identity to measure", () => {
		const rows = (html: string) => [...html.matchAll(/data-lh-row="([^"]+)"/g)].map((match) => match[1]!);
		const long = rows(render([learner("u1", "Explain the simplex method."), ...teacherGroup("t1", 40)]));
		assert.ok(long.every((row) => /^t1:\d+$/.test(row)), `the tail is parts of the last group: ${long.join(",")}`);
		assert.equal(new Set(long).size, long.length, "row identities are unique");
		// A learner turn is one row of its own, wherever the window reaches it.
		const short = rows(render([learner("u1", "Explain the simplex method."), ...teacherGroup("t1", 2)]));
		assert.ok(short.includes("u1"), `learner turn is a row: ${short.join(",")}`);
	});
});
