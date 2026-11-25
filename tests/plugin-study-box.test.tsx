import React, { act } from "react";
(globalThis as Record<string, unknown>).React = React;
import assert from "node:assert/strict";
import * as path from "node:path";
import { test } from "node:test";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { parseHTML } from "linkedom";
import { AnsweredCard } from "../components/answered-card.tsx";
import { AppearanceProvider } from "../components/settings/appearance.tsx";
import { CONFIDENCE_COLORS, confidenceRailStyle } from "../components/confidence-rail.tsx";
import { QuestionDock } from "../components/question-dock.tsx";
import { CONFIDENCE_ROW_PAD } from "../components/question-layout.ts";
import { DEFAULT_THEME } from "../src/core/themes.ts";
import { buildAnswer, normalizeOptions, resolveCorrect, type QuestionData } from "../src/core/question-core.ts";

// The study plugin re-creates the quiz dock's look with hand-copied Tailwind class
// strings and the confidence color ramp, because those components are core-internal and
// not part of the study plugin SDK. This test RENDERS the real native components and the
// plugin's own editor/answered views side by side and compares what each actually put
// on screen (class sets, inline rail paint), so a core restyle fails here instead of
// silently drifting. It never reads source text.
//
// It carries forward the guard the superseded feynman-coach example's own frontend
// test used to keep over this same box.

const dom = parseHTML("<html><body></body></html>");
Object.assign(globalThis, {
	window: dom.window, document: dom.document, HTMLElement: dom.window.HTMLElement,
	IS_REACT_ACT_ENVIRONMENT: true,
});

const pluginDir = path.resolve("examples/plugins/study");
const { activate } = await import(path.join(pluginDir, "dist/main.js"));

function mountRenderer() {
	let renderer: { mountAnswerEditor: Function; mountAnswered: Function } | undefined;
	activate({
		registerQuestionRenderer: (definition: typeof renderer) => { renderer = definition; },
		registerSettings: () => () => {},
		registerAction: () => () => {},
		placeAction: () => () => {},
		ui: { openDialog: () => ({ update() {}, dispose() {} }) },
		signal: new AbortController().signal,
		call: async () => ({}),
		documents: { toMarkdown: async () => ({ name: "", markdown: "", notices: [] }) },
	});
	assert.ok(renderer, "registerQuestionRenderer was not called");
	return renderer!;
}

function editorProps(overrides: Record<string, unknown> = {}) {
	let last: unknown;
	const props = {
		input: { question: "Explain it back", payload: { mode: "full" } },
		chatId: "chat-1", questionId: "q1", contractVersion: 1, variant: "teach",
		signal: new AbortController().signal,
		answer: { status: "empty" },
		active: true,
		onChange(value: unknown) { last = value; },
		...overrides,
	};
	return { props, last: () => last };
}


type El = Element;
const classSet = (el: El | null | undefined): string[] => {
	assert.ok(el, "element not found");
	return [...new Set((el!.getAttribute("class") ?? "").split(/\s+/).filter(Boolean))].sort();
};
/** Smallest element whose text contains the marker (fewest chars, then fewest descendants). */
function byText(root: El, marker: string): El {
	const hits = [...root.querySelectorAll("*")].filter(el => (el.textContent ?? "").includes(marker));
	hits.sort((a, b) => (a.textContent!.length - b.textContent!.length) || (a.querySelectorAll("*").length - b.querySelectorAll("*").length));
	assert.ok(hits[0], `no element contains "${marker}"`);
	return hits[0]!;
}
function htmlOf(markup: string): El {
	const host = dom.document.createElement("div");
	host.innerHTML = markup;
	return host as unknown as El;
}

const quizInput = { question: "Which?", options: [{ label: "A" }, { label: "B" }], correctAnswer: "A", explanation: "Because." };
const quizQD = (): QuestionData => {
	const options = normalizeOptions(quizInput.options);
	return { id: "q1", kind: "quiz", mode: "single-select", question: quizInput.question, options,
		correctIndices: resolveCorrect(quizInput.correctAnswer, options).indices, explanation: quizInput.explanation,
		createdAt: new Date().toISOString() };
};

async function withNativeQuizDock<T>(fn: (host: El, click: (el: El) => Promise<void>) => Promise<T>): Promise<T> {
	const host = dom.document.createElement("div"); dom.document.body.append(host);
	const root = createRoot(host as unknown as HTMLElement);
	try {
		await act(async () => root.render(<QuestionDock toolName="quiz" toolCallId="q1" input={quizInput as never}
			expanded onExpand={() => {}} onSubmit={() => {}} dictationClaim={false} />));
		return await fn(host as unknown as El, async el => { await act(async () => { (el as HTMLElement).click(); }); });
	} finally { await act(async () => root.unmount()); host.remove(); }
}

function mountPluginEditor() {
	const container = dom.document.createElement("div");
	const { props } = editorProps();
	mountRenderer().mountAnswerEditor(container, props);
	return container as unknown as El;
}

const nativeDontKnow = (host: El) => byText(host, "I don't know").closest("button")!;
const confidenceParts = (root: El) => ({
	row: root.querySelector("[data-question-confidence]"),
	label: byText(root, "Confidence"),
	track: root.querySelector('[data-testid="confidence-track"]'),
	value: root.querySelector('[data-testid="confidence-value"]'),
});

test("the study plugin's \"I don't know\" row and confidence row render with the real quiz dock's classes, idle and pressed", async () => {
	const plugin = mountPluginEditor();
	const pluginButton = plugin.querySelector('[data-testid="study-dont-know"]')!;
	await withNativeQuizDock(async (native, click) => {
		for (const pressed of [false, true]) {
			if (pressed) {
				await click(nativeDontKnow(native));
				(pluginButton as unknown as HTMLElement).dispatchEvent(new (dom.window as unknown as { Event: typeof Event }).Event("click", { bubbles: true }));
			}
			const nb = nativeDontKnow(native);
			const state = pressed ? "pressed" : "idle";
			assert.deepEqual(classSet(pluginButton), classSet(nb), `button ${state}`);
			assert.deepEqual(classSet(pluginButton.firstElementChild), classSet(nb.firstElementChild), `mark ${state}`);
			if (pressed) assert.deepEqual(classSet(pluginButton.firstElementChild!.firstElementChild), classSet(nb.firstElementChild!.firstElementChild), `dot ${state}`);
			const p = confidenceParts(plugin), n = confidenceParts(native);
			assert.deepEqual(classSet(p.label), classSet(n.label), `confidence label ${state}`);
			assert.deepEqual(classSet(p.track), classSet(n.track), `track ${state}`);
			assert.deepEqual(classSet(p.value), classSet(n.value), `value ${state}`);
			if (!pressed) {
				assert.deepEqual(classSet(p.row), classSet(n.row), "confidence row");
				assert.deepEqual(classSet(p.row!.firstElementChild), classSet(n.row!.firstElementChild), "confidence inner row");
				assert.deepEqual(classSet(plugin.querySelector('[data-testid="confidence-rail"]')), classSet(native.querySelector('[data-testid="confidence-rail"]')), "rail overlay");
				assert.deepEqual(classSet(plugin.querySelector('[data-testid="confidence-slider"]')), classSet(native.querySelector('[data-testid="confidence-slider"]')), "slider");
			}
		}
	});
});

test("the rail paint and the color ramp match the real confidence-rail exports, in the native dock and the study plugin", async () => {
	assert.equal(CONFIDENCE_ROW_PAD.split(" ").sort().join(" "), classSet(mountPluginEditor().querySelector("[data-question-confidence]")).join(" "));
	const expected = confidenceRailStyle(50);
	const plugin = mountPluginEditor().querySelector('[data-testid="confidence-rail"]') as unknown as HTMLElement;
	await withNativeQuizDock(async native => {
		const nativeRail = native.querySelector('[data-testid="confidence-rail"]') as unknown as HTMLElement;
		for (const rail of [plugin, nativeRail]) {
			assert.equal(rail.style.backgroundColor, expected.backgroundColor);
			assert.equal(rail.style.backgroundImage, expected.backgroundImage);
			assert.equal(rail.style.backgroundSize, expected.backgroundSize);
			assert.equal(rail.style.backgroundPosition, expected.backgroundPosition);
		}
	});
	// The ramp, observed through the real rail at each stop: the filled gradient segment's color.
	const stops = [0, 30, 50, 70, 90, 100];
	const container = dom.document.createElement("div");
	const { props } = editorProps();
	mountRenderer().mountAnswerEditor(container, props);
	const slider = container.querySelector('[data-testid="confidence-slider"]') as unknown as HTMLInputElement;
	const rail = container.querySelector('[data-testid="confidence-rail"]') as unknown as HTMLElement;
	stops.forEach((stop, i) => {
		slider.value = String(stop);
		slider.dispatchEvent(new (dom.window as unknown as { Event: typeof Event }).Event("input", { bubbles: true }));
		assert.equal(rail.style.backgroundImage, confidenceRailStyle(stop).backgroundImage, `rail at ${stop}`);
		assert.equal(slider.style.color, CONFIDENCE_COLORS[i], `thumb color at ${stop}`);
	});
});

test("the study plugin's answer field matches the real free-text \"Your answer\" field", () => {
	const nativeRoot = htmlOf(renderToStaticMarkup(<QuestionDock toolName="ask_user_question" toolCallId="a1" input={{ question: "Q?" } as never}
		expanded onExpand={() => {}} onSubmit={() => {}} />));
	const nativeWrap = nativeRoot.querySelector('[data-testid="answer-field"]')!;
	const plugin = mountPluginEditor();
	const pluginWrap = plugin.querySelector('[data-testid="answer-field"]')!;
	assert.deepEqual(classSet(pluginWrap), classSet(nativeWrap), "wrap");
	assert.deepEqual(classSet(pluginWrap.firstElementChild), classSet(nativeWrap.firstElementChild), "label");
	const nativeInput = classSet(nativeWrap.querySelector('[role="textbox"]'));
	const missing = classSet(plugin.querySelector("textarea")).filter(c => !nativeInput.includes(c));
	assert.deepEqual(missing, [], "every class the study plugin reuses on its input exists on the native field");
});

test("the study plugin's answered view matches the real AnsweredCard for a confident answer and for a decline", () => {
	const renderCard = (req: Parameters<typeof buildAnswer>[1]) => htmlOf(renderToStaticMarkup(
		<AppearanceProvider initialAppearance={{ adaptiveQuestions: false }} initialTheme={DEFAULT_THEME}>
			<AnsweredCard answer={buildAnswer(quizQD(), req)} input={quizInput} />
		</AppearanceProvider>));
	const renderer = mountRenderer();

	const nativeConfident = renderCard({ text: "A causes B.", confidence: 70 });
	const confident = dom.document.createElement("div") as unknown as El;
	renderer.mountAnswered(confident, { answer: { explanation: "A causes B.", confidence: 70 } });
	assert.deepEqual(classSet(confident.querySelector('[data-testid="study-explanation-answered"]')), classSet(byText(nativeConfident, "A causes B.")), "quoted text");
	const nativeRow = nativeConfident.querySelector('[data-testid="answered-confidence"]')!;
	const pluginRow = confident.querySelector('[data-testid="answered-confidence"]')!;
	assert.deepEqual(classSet(pluginRow), classSet(nativeRow), "confidence row");
	assert.deepEqual(classSet(pluginRow.firstElementChild), classSet(nativeRow.firstElementChild), "static rail");
	assert.deepEqual(classSet(pluginRow.lastElementChild), classSet(nativeRow.lastElementChild), "static value");
	const nativeRail = nativeRow.firstElementChild as unknown as HTMLElement;
	const pluginRail = pluginRow.firstElementChild as unknown as HTMLElement;
	const expected = confidenceRailStyle(70);
	for (const rail of [nativeRail, pluginRail]) {
		assert.equal(rail.style.backgroundImage, expected.backgroundImage);
		assert.equal(rail.style.backgroundSize, expected.backgroundSize);
		assert.equal(rail.style.backgroundPosition, expected.backgroundPosition);
	}

	const nativeDecline = renderCard({ dontKnow: true });
	const declined = dom.document.createElement("div") as unknown as El;
	renderer.mountAnswered(declined, { answer: { dontKnow: true } });
	assert.deepEqual(classSet(declined.querySelector('[data-testid="study-dont-know-answered"]')), classSet(byText(nativeDecline, "Answered")), "dontKnow note");
});

test("mounts the answer editor, publishes explanation+confidence on input/slide, and disposes cleanly", () => {
	const { document, window } = parseHTML("<html><body></body></html>");
	const renderer = mountRenderer();
	const container = document.createElement("div");
	const { props, last } = editorProps();
	const handle = renderer.mountAnswerEditor(container, props);
	assert.deepEqual(last(), { status: "empty" }, "no text yet");

	const textarea = container.querySelector('[data-testid="study-explanation-input"]') as unknown as HTMLTextAreaElement;
	textarea.value = "A causes B because of the mechanism.";
	textarea.dispatchEvent(new (window as unknown as { Event: typeof Event }).Event("input", { bubbles: true }));
	assert.deepEqual(last(), { status: "ready", value: { explanation: "A causes B because of the mechanism.", confidence: 50 } });

	const slider = container.querySelector('[data-testid="confidence-slider"]') as unknown as HTMLInputElement;
	slider.value = "90";
	slider.dispatchEvent(new (window as unknown as { Event: typeof Event }).Event("input", { bubbles: true }));
	assert.deepEqual(last(), { status: "ready", value: { explanation: "A causes B because of the mechanism.", confidence: 90 } });
	assert.equal((container.querySelector('[data-testid="confidence-value"]') as unknown as HTMLElement).textContent, "90%");

	handle.dispose();
	textarea.value = "changed after dispose";
	textarea.dispatchEvent(new (window as unknown as { Event: typeof Event }).Event("input", { bubbles: true }));
	assert.deepEqual(last(), { status: "ready", value: { explanation: "A causes B because of the mechanism.", confidence: 90 } }, "disposed editor publishes nothing further");
});

test("the \"I don't know\" toggle mirrors the native control: disables the field (keeping the draft), bypasses confidence, and skips no retry budget", () => {
	const { document, window } = parseHTML("<html><body></body></html>");
	const renderer = mountRenderer();
	const container = document.createElement("div");
	const { props, last } = editorProps();
	renderer.mountAnswerEditor(container, props);

	const textarea = container.querySelector('[data-testid="study-explanation-input"]') as unknown as HTMLTextAreaElement;
	textarea.value = "Some explanation typed before deciding.";
	textarea.dispatchEvent(new (window as unknown as { Event: typeof Event }).Event("input", { bubbles: true }));

	const dontKnow = container.querySelector('[data-testid="study-dont-know"]') as unknown as HTMLButtonElement;
	assert.equal(dontKnow.getAttribute("aria-pressed"), "false");
	dontKnow.dispatchEvent(new (window as unknown as { Event: typeof Event }).Event("click", { bubbles: true }));

	assert.equal(dontKnow.getAttribute("aria-pressed"), "true");
	assert.equal(textarea.value, "Some explanation typed before deciding.", "the draft is kept while disabled");
	assert.equal(textarea.disabled, true);
	const slider = container.querySelector('[data-testid="confidence-slider"]') as unknown as HTMLInputElement;
	assert.equal(slider.disabled, true);
	assert.equal((container.querySelector('[data-testid="confidence-value"]') as unknown as HTMLElement).textContent, "—");
	assert.deepEqual(last(), { status: "ready", value: { dontKnow: true } });

	dontKnow.dispatchEvent(new (window as unknown as { Event: typeof Event }).Event("click", { bubbles: true }));
	assert.equal(dontKnow.getAttribute("aria-pressed"), "false");
	assert.equal(textarea.disabled, false);
	assert.equal(slider.disabled, false);
	assert.equal(textarea.value, "Some explanation typed before deciding.", "toggling back off restores the draft");
	assert.deepEqual(last(), { status: "ready", value: { explanation: "Some explanation typed before deciding.", confidence: 50 } });
});

test("mountAnswered renders the quoted explanation+confidence, or the dontKnow note — never both", () => {
	const { document } = parseHTML("<html><body></body></html>");
	const renderer = mountRenderer();

	const normal = document.createElement("div");
	renderer.mountAnswered(normal, { answer: { explanation: "A causes B.", confidence: 70 } });
	assert.equal(normal.querySelector('[data-testid="study-explanation-answered"]')!.textContent, "“A causes B.”");
	assert.equal((normal.querySelector('[data-testid="answered-confidence"] span') as unknown as HTMLElement).textContent, "70%");
	assert.equal(normal.querySelector('[data-testid="study-dont-know-answered"]'), null);

	const declined = document.createElement("div");
	renderer.mountAnswered(declined, { answer: { dontKnow: true } });
	assert.equal(declined.querySelector('[data-testid="study-explanation-answered"]'), null, "no quoted explanation for a decline");
	assert.equal(declined.querySelector('[data-testid="answered-confidence"]'), null, "no confidence record for a decline, matching the native dontKnow convention");
	assert.match(declined.querySelector('[data-testid="study-dont-know-answered"]')!.textContent!, /I don't know/);
});
