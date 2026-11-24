import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { test } from "node:test";
import { parseHTML } from "linkedom";
import { CONFIDENCE_COLORS, confidenceRailStyle } from "../components/confidence-rail.tsx";
import { CONFIDENCE_ROW_PAD } from "../components/question-layout.ts";

// Finding 4/5 from the independent critique (data/lh-feynman-critica/report.md): the
// plugin hand-copies Tailwind class strings and the confidence color ramp from these
// core-internal, non-SDK components with no guard against drift. This test reads the
// plugin's own copies out of its real dist/main.js and checks them against the LIVE
// core sources/exports at test time — a core rename or restyle fails this test instead
// of silently drifting unnoticed.

const pluginDir = path.resolve("examples/plugins/feynman-coach");
const mainSource = fs.readFileSync(path.join(pluginDir, "dist/main.js"), "utf8");
const questionDockSource = fs.readFileSync(path.resolve("components/question-dock.tsx"), "utf8");
const answeredCardSource = fs.readFileSync(path.resolve("components/answered-card.tsx"), "utf8");
const confidenceRailSource = fs.readFileSync(path.resolve("components/confidence-rail.tsx"), "utf8");

/** Reads a top-level `const NAME = <expr>;` out of trusted own-repo source text.
 * `<expr>` is always a literal string/array/number in these files — no external
 * input ever reaches this eval. */
function constValue(source: string, name: string): unknown {
	const match = source.match(new RegExp(`const ${name} = ([^;]*);`, "s"));
	assert.ok(match, `const ${name} not found in source`);
	return new Function(`return (${match![1]})`)();
}
function singleMatch(source: string, pattern: RegExp, label: string): string {
	const match = source.match(pattern);
	assert.ok(match, `pattern not found: ${label}`);
	return match![1]!;
}

const { activate } = await import(path.join(pluginDir, "dist/main.js"));

function mountRenderer() {
	let renderer: { mountAnswerEditor: Function; mountAnswered: Function } | undefined;
	activate({ registerQuestionRenderer: (definition: typeof renderer) => { renderer = definition; } });
	assert.ok(renderer, "registerQuestionRenderer was not called");
	return renderer!;
}

function editorProps(doc: Document, overrides: Record<string, unknown> = {}) {
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

test("the plugin's hand-copied classes and color ramp match the live core sources", () => {
	// The exact six-stop ramp (components/confidence-rail.tsx export), not a copy that
	// could silently diverge from a future owner-ruled palette change.
	assert.deepEqual(constValue(mainSource, "CONFIDENCE_COLORS"), CONFIDENCE_COLORS);
	assert.deepEqual(constValue(mainSource, "CONFIDENCE_STOPS"), [0, 30, 50, 70, 90, 100]);

	// Named consts in question-dock.tsx: exact-value comparison against the live file.
	for (const [pluginName, liveName] of [
		["QC_OPTION_ROW", "QC_OPTION_ROW"],
		["QC_OPTION_MARK", "QC_OPTION_MARK"],
		["CONFIDENCE_LABEL", "QC_CONFIDENCE_LABEL"],
		["CONFIDENCE_TRACK", "QC_CONFIDENCE_TRACK"],
		["CONFIDENCE_VALUE", "QC_CONFIDENCE_VALUE"],
	] as const) {
		assert.equal(constValue(mainSource, pluginName), constValue(questionDockSource, liveName), `${pluginName} vs ${liveName}`);
	}
	// CONFIDENCE_ROW_PAD is exported from components/question-layout.ts; import it directly.
	assert.equal(constValue(mainSource, "CONFIDENCE_ROW_PAD"), CONFIDENCE_ROW_PAD);

	// Inline (non-const) literals in question-dock.tsx — the "Your answer" composer-twin
	// field this box reuses verbatim, located by their fixed neighboring markup.
	const answerFieldWrap = singleMatch(questionDockSource,
		/data-testid=\{qd\.mode === "text" \? "answer-field" : "thinking-field"\}\s*className="([^"]*)"/,
		"answer field wrap className");
	assert.equal(constValue(mainSource, "ANSWER_FIELD_WRAP"), answerFieldWrap);
	const answerFieldLabel = singleMatch(questionDockSource,
		/className="([^"]*)">\s*\{qd\.mode === "text" \? "Your answer" : "YOUR THINKING"\}/,
		"answer field label className");
	assert.equal(constValue(mainSource, "ANSWER_FIELD_LABEL"), answerFieldLabel);
	const answerFieldInput = singleMatch(questionDockSource,
		/placeholder="Type your answer…"\s*className="([^"]*)"/,
		"answer field input className");
	assert.equal(constValue(mainSource, "ANSWER_FIELD_INPUT"), answerFieldInput);

	// Inline literals in answered-card.tsx — the saved explanation/confidence record.
	const answeredText = singleMatch(answeredCardSource, /answer\.text && <div className="([^"]*)">/, "answered text className");
	assert.equal(constValue(mainSource, "ANSWERED_TEXT"), answeredText);
	const answeredRow = singleMatch(answeredCardSource, /className="([^"]*)" data-testid="answered-confidence">/, "answered confidence row className");
	assert.equal(constValue(mainSource, "ANSWERED_ROW"), answeredRow);
	const answeredDontKnow = singleMatch(answeredCardSource, /className="([^"]*)">Answered/, "answered dontKnow note className");
	assert.equal(constValue(mainSource, "ANSWERED_DONT_KNOW"), answeredDontKnow);

	// The static rail: ConfidenceRail's own base class (components/confidence-rail.tsx)
	// plus the extra className answered-card.tsx actually passes it.
	const railBase = singleMatch(confidenceRailSource, /cn\("([^"]*)", className\)/, "ConfidenceRail base className");
	const railExtra = singleMatch(answeredCardSource, /<ConfidenceRail value=\{answer\.confidence\} className="([^"]*)"/, "ConfidenceRail className prop");
	assert.equal(constValue(mainSource, "STATIC_RAIL"), `${railBase} ${railExtra}`);

	// The rail's actual PAINT (gradient/tick math): call the live confidenceRailStyle and
	// compare to what the rendered rail element ends up with, not a copied string.
	const { document } = parseHTML("<html><body></body></html>");
	const renderer = mountRenderer();
	const container = document.createElement("div");
	const { props } = editorProps(document as unknown as Document);
	renderer.mountAnswerEditor(container, props);
	const liveRail = container.querySelector('[data-testid="confidence-rail"]') as unknown as HTMLElement;
	const expected = confidenceRailStyle(50);
	assert.equal(liveRail.style.backgroundColor, expected.backgroundColor);
	assert.equal(liveRail.style.backgroundImage, expected.backgroundImage);
	assert.equal(liveRail.style.backgroundSize, expected.backgroundSize);
	assert.equal(liveRail.style.backgroundPosition, expected.backgroundPosition);
});

test("mounts the answer editor, publishes explanation+confidence on input/slide, and disposes cleanly", () => {
	const { document, window } = parseHTML("<html><body></body></html>");
	const renderer = mountRenderer();
	const container = document.createElement("div");
	const { props, last } = editorProps(document as unknown as Document);
	const handle = renderer.mountAnswerEditor(container, props);
	assert.deepEqual(last(), { status: "empty" }, "no text yet");

	const textarea = container.querySelector('[data-testid="feynman-explanation-input"]') as unknown as HTMLTextAreaElement;
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

test("the \"I don't know\" toggle mirrors the native control: clears/disables the field, bypasses confidence, and skips no retry budget", () => {
	const { document, window } = parseHTML("<html><body></body></html>");
	const renderer = mountRenderer();
	const container = document.createElement("div");
	const { props, last } = editorProps(document as unknown as Document);
	renderer.mountAnswerEditor(container, props);

	const textarea = container.querySelector('[data-testid="feynman-explanation-input"]') as unknown as HTMLTextAreaElement;
	textarea.value = "Some explanation typed before deciding.";
	textarea.dispatchEvent(new (window as unknown as { Event: typeof Event }).Event("input", { bubbles: true }));

	const dontKnow = container.querySelector('[data-testid="feynman-dont-know"]') as unknown as HTMLButtonElement;
	assert.equal(dontKnow.getAttribute("aria-pressed"), "false");
	dontKnow.dispatchEvent(new (window as unknown as { Event: typeof Event }).Event("click", { bubbles: true }));

	assert.equal(dontKnow.getAttribute("aria-pressed"), "true");
	assert.equal(textarea.value, "", "the field clears, mirroring the native mutual-exclusivity rule");
	assert.equal(textarea.disabled, true);
	const slider = container.querySelector('[data-testid="confidence-slider"]') as unknown as HTMLInputElement;
	assert.equal(slider.disabled, true);
	assert.equal((container.querySelector('[data-testid="confidence-value"]') as unknown as HTMLElement).textContent, "—");
	assert.deepEqual(last(), { status: "ready", value: { dontKnow: true } });

	dontKnow.dispatchEvent(new (window as unknown as { Event: typeof Event }).Event("click", { bubbles: true }));
	assert.equal(dontKnow.getAttribute("aria-pressed"), "false");
	assert.equal(textarea.disabled, false);
	assert.equal(slider.disabled, false);
	assert.deepEqual(last(), { status: "empty" }, "back to normal, empty until he types again");
});

test("mountAnswered renders the quoted explanation+confidence, or the dontKnow note — never both", () => {
	const { document } = parseHTML("<html><body></body></html>");
	const renderer = mountRenderer();

	const normal = document.createElement("div");
	renderer.mountAnswered(normal, { answer: { explanation: "A causes B.", confidence: 70 } });
	assert.equal(normal.querySelector('[data-testid="feynman-explanation-answered"]')!.textContent, "“A causes B.”");
	assert.equal((normal.querySelector('[data-testid="answered-confidence"] span') as unknown as HTMLElement).textContent, "70%");
	assert.equal(normal.querySelector('[data-testid="feynman-dont-know-answered"]'), null);

	const declined = document.createElement("div");
	renderer.mountAnswered(declined, { answer: { dontKnow: true } });
	assert.equal(declined.querySelector('[data-testid="feynman-explanation-answered"]'), null, "no quoted explanation for a decline");
	assert.equal(declined.querySelector('[data-testid="answered-confidence"]'), null, "no confidence record for a decline, matching the native dontKnow convention");
	assert.match(declined.querySelector('[data-testid="feynman-dont-know-answered"]')!.textContent!, /I don't know/);
});
