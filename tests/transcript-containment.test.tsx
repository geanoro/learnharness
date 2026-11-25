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
import { olderPartsFrom } from "../components/transcript-rows.ts";
import type { LhMessage } from "../src/core/native-messages.ts";

/* Containment reaches the rows a teaching transcript is actually made of.
 *
 * The marker used to sit on the message group only, and assistant grouping
 * merges consecutive native messages into one row — so on a 237-message
 * session it landed on 5 elements covering 18% of the transcript's height,
 * and the two biggest rows (18,360 px and 25,895 px of 63,217 px) carried
 * nothing because they follow the newest learner turn. These assertions pin
 * WHERE the marker lands, not that it is fast. */

const router = { bfcacheId: "fixture", back() {}, forward() {}, refresh() {}, hmrRefresh() {}, push() {}, replace() {}, async prefetch() {} };

const QUIZ_INPUT = {
	question: "What stays zero at the simplex optimum?",
	options: [{ label: "The reduced costs" }, { label: "The slack" }],
	correctAnswer: "The reduced costs",
	explanation: "Optimality is exactly non-negative reduced costs.",
};

const QUIZ_ANSWER = {
	kind: "quiz" as const,
	questionText: QUIZ_INPUT.question,
	answers: [{ index: 1, label: "The reduced costs" }],
	options: [{ index: 1, label: "The reduced costs" }, { index: 2, label: "The slack" }],
	correctIndices: [1],
	correct: true,
	explanation: QUIZ_INPUT.explanation,
};

/** One assistant group: prose, a step boundary, more prose, a quiz call. */
function teacherGroup(id: string, callId: string): LhMessage[] {
	return [
		{
			id: `${id}_a`, role: "assistant", stopReason: "stop", timestamp: 1, provider: "openrouter", model: "test",
			content: [{ type: "text", text: "A basic feasible solution sits at a vertex." }],
		} as unknown as LhMessage,
		{
			id: `${id}_b`, role: "assistant", stopReason: "tool_use", timestamp: 2, provider: "openrouter", model: "test",
			content: [
				{ type: "text", text: "Pivoting walks from vertex to vertex." },
				{ type: "toolCall", id: callId, name: "quiz", arguments: QUIZ_INPUT },
			],
		} as unknown as LhMessage,
		{
			id: `${id}_r`, role: "toolResult", toolCallId: callId, toolName: "quiz", isError: false, timestamp: 3,
			content: [{ type: "text", text: "answered" }], details: QUIZ_ANSWER,
		} as unknown as LhMessage,
	];
}

function learner(id: string, text: string): LhMessage {
	return { id, role: "user", content: text, timestamp: 0 } as unknown as LhMessage;
}

function render(messages: LhMessage[], initiallyInFlight = false): string {
	return renderToString(
		<AppRouterContext.Provider value={router}>
		<PathnameContext.Provider value="/chat/chat_containment">
		<ServerEventsProvider>
			<PluginsProvider>
				<AppearanceProvider initialAppearance={undefined} initialTheme={DEFAULT_THEME}>
					<SidebarProvider>
						<ActivityProvider>
							<InteractionLayersProvider>
								<SettingsDialogProvider>
									<Chat chatId="chat_containment" title="Containment" kind="teach" initialMessages={messages} initialConfigured={false} initiallyInFlight={initiallyInFlight} />
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

/** Every element carrying the marker, with the marker's value. */
function markedTags(html: string): string[] {
	return [...html.matchAll(/<[a-z]+[^>]*?data-older-transcript-row="([^"]*)"[^>]*>/g)].map((m) => m[1]!);
}

describe("transcript containment markers", () => {
	it("marks source passages and answered cards inside an assistant group", () => {
		const html = render([learner("u1", "Explain the simplex method."), ...teacherGroup("t1", "call_1")]);

		// The group projects to ONE assistant row, so the group-level marker
		// could never contain its parts separately.
		const passages = [...html.matchAll(/<div[^>]*lh-source-passage[^>]*>/g)].map((m) => m[0]);
		assert.equal(passages.length, 2, "two prose parts in the group");
		for (const passage of passages) {
			assert.match(passage, /data-older-transcript-row="passage"/, passage);
		}

		const card = html.match(/<div[^>]*data-testid="answered-card"[^>]*>/)?.[0];
		assert.ok(card, "the answered quiz renders its card");
		assert.match(card, /data-older-transcript-row="card"/);

		// Separators and the collapsed reasoning wrapper get nothing: a
		// separator is 1px and a collapsed reasoning block holds no content,
		// so containing them buys no layout and only corrupts the estimated
		// scroll height.
		const separators = [...html.matchAll(/<[a-z]+[^>]*data-slot="separator"[^>]*>/g)].map((m) => m[0]);
		assert.ok(separators.length > 0, "the step boundary renders a separator");
		for (const separator of separators) assert.doesNotMatch(separator, /data-older-transcript-row/);
		for (const value of markedTags(html)) {
			assert.ok(["", "passage", "card"].includes(value), `unexpected marker value ${JSON.stringify(value)}`);
		}
	});

	it("leaves the live tail fully laid out while a turn runs", () => {
		const messages = [learner("u1", "Explain the simplex method."), ...teacherGroup("t1", "call_1")];
		const atRest = render(messages);
		const inFlight = render(messages, true);

		const marks = (html: string) => markedTags(html).filter((v) => v === "passage" || v === "card").length;
		assert.ok(marks(atRest) > 0, "at rest the group's parts are contained");
		assert.equal(marks(inFlight), 0, "the only row IS the live tail while a turn runs");
	});
});

describe("olderPartsFrom", () => {
	it("contains every row at rest and every row but the live tail while busy", () => {
		assert.equal(olderPartsFrom(17, false), 17, "at rest nothing is being written");
		assert.equal(olderPartsFrom(17, true), 16, "the last row is the live tail");
		assert.equal(olderPartsFrom(1, true), 0, "a single row is the live tail");
		assert.equal(olderPartsFrom(0, true), 0);
		assert.equal(olderPartsFrom(0, false), 0);
	});
});
