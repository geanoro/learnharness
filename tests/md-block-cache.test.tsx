/**
 * The cross-mount markdown block cache (components/md-block-cache.tsx).
 *
 * A lesson switch unmounts the transcript; streamdown re-parses every block
 * (plus KaTeX) when it comes back. These tests pin WHAT may be remembered and
 * what must never be: the cached copy is plain HTML with no event handlers,
 * so a block carrying interaction React owns would come back dead.
 *
 * Idiom: a real client render into linkedom (as display-math-copy.test.tsx
 * does), because the capture reads the rendered DOM. The scheduler is stubbed
 * so captures only run when this file says so — which also pins that the
 * capture never happens during the mount it would slow down. A mount that
 * queues nothing (`pending === 0`) is the observable for a cache HIT: the
 * cached branch is the only one that queues no capture.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { afterEach, describe, it } from "node:test";
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { parseHTML } from "linkedom";
import { MessageResponse } from "../components/ai-elements/message.tsx";
import {
	MD_BLOCK_CACHE_MAX_CHARS,
	clearMdBlockCache,
	flushMdBlockCaptures,
	mdBlockCacheStats,
	setMdBlockCacheMaxChars,
	setMdRenderSignature,
} from "../components/md-block-cache.tsx";

(globalThis as { React?: typeof React }).React = React;
const { window, document } = parseHTML("<html><body></body></html>");
Object.assign(globalThis, { window, document, IS_REACT_ACT_ENVIRONMENT: true });

/** The idle scheduler, stubbed: queued captures run only on an explicit
 *  flush, so "was anything queued during this mount?" stays observable. */
const idleWork: (() => void)[] = [];
Object.assign(globalThis, {
	requestIdleCallback: (cb: () => void) => idleWork.push(cb),
});

type Visit = { html: string; queued: number };

/** One visit to a lesson: mount, see what it queued, capture, unmount. */
async function visit(markdown: string, live = false): Promise<Visit> {
	return render(markdown, <MessageResponse live={live}>{markdown}</MessageResponse>);
}

async function render(markdown: string, element: React.ReactElement): Promise<Visit> {
	const host = document.createElement("div");
	document.body.append(host);
	const root = createRoot(host);
	await act(async () => root.render(element));
	const result = { html: host.innerHTML, queued: mdBlockCacheStats().pending };
	flushMdBlockCaptures();
	await act(async () => root.unmount());
	host.remove();
	return result;
}

afterEach(() => {
	clearMdBlockCache();
	setMdBlockCacheMaxChars(MD_BLOCK_CACHE_MAX_CHARS);
	setMdRenderSignature("");
	idleWork.length = 0;
});

describe("markdown block cache", () => {
	it("captures off the mount, then serves the block from the cache", async () => {
		const md = "A plain teaching paragraph with *emphasis* and `code`.";
		const first = await visit(md);
		assert.match(first.html, /A plain teaching paragraph/);
		assert.equal(first.queued, 1, "the block was queued, not captured inline");
		assert.ok(idleWork.length > 0, "the capture was scheduled as idle work");
		assert.equal(mdBlockCacheStats().entries, 1, "and the flush stored it");

		const second = await visit(md);
		assert.equal(second.queued, 0, "the repeat visit queued nothing: it was a cache hit");
		assert.equal(second.html, first.html, "and renders byte-identical markup");
	});

	it("does not serve the transcript's output to a surface with its own markdown profile", async () => {
		const md = "Prose two different surfaces both render.";
		await visit(md);
		assert.equal(mdBlockCacheStats().entries, 1);

		// A `components` override renders its own markup for the same source.
		const own = await render(md, <MessageResponse components={{}}>{md}</MessageResponse>);
		assert.equal(own.queued, 0, "it takes no part in the cache at all");
		assert.equal(mdBlockCacheStats().entries, 1, "and stores nothing of its own");
		assert.match(own.html, /two different surfaces/, "while still rendering");
	});

	it("does not reuse output rendered under other settings", async () => {
		const md = "Prose rendered before the learner changed the theme.";
		await visit(md);
		assert.equal(mdBlockCacheStats().entries, 1);

		setMdRenderSignature(JSON.stringify({ theme: "paper", proseFontSize: 18 }));
		const after = await visit(md);
		assert.equal(after.queued, 1, "the appearance change made it a miss, not a hit");
		assert.equal(mdBlockCacheStats().entries, 2, "the old entry was not overwritten either");

		const again = await visit(md);
		assert.equal(again.queued, 0, "the new appearance has its own entry now");
	});

	it("never caches a block whose output carries interaction", async () => {
		for (const [name, md] of [
			["code fence", "```js\nconst x = 1;\n```"],
			["table", "| a | b |\n| --- | --- |\n| 1 | 2 |"],
			["display math", "$$\n\\int_0^1 x^2\\,dx = \\frac{1}{3}\n$$"],
			["link", "Read [the notes](https://example.com/notes) first."],
		] as const) {
			clearMdBlockCache();
			const first = await visit(md);
			assert.ok(first.html.length > 0, `${name} rendered`);
			assert.equal(mdBlockCacheStats().entries, 0, `${name} stayed out of the cache`);
			const second = await visit(md);
			assert.equal(second.queued, 1, `${name} is rendered live on every visit`);
		}
	});

	it("caches the prose of a message whose other blocks are interactive", async () => {
		const md = "First a paragraph.\n\n| a | b |\n| --- | --- |\n| 1 | 2 |\n\nAnd a closing paragraph.";
		const first = await visit(md);
		assert.equal(first.queued, 3, "all three blocks were offered");
		assert.equal(mdBlockCacheStats().entries, 2, "both prose blocks cached, the table not");
		const second = await visit(md);
		assert.equal(second.queued, 1, "only the table is parsed again");
		assert.equal(second.html, first.html, "the message still renders identically");
	});

	it("never caches anything while the text is still being written", async () => {
		const md = "A paragraph the model is still extending.";
		const streaming = await visit(md, true);
		assert.match(streaming.html, /still extending/, "it renders while streaming");
		assert.equal(streaming.queued, 0, "nothing was offered to the cache");
		assert.equal(mdBlockCacheStats().entries, 0, "and nothing was stored");

		const settled = await visit(md);
		assert.equal(settled.queued, 1, "the finished text is captured on the next visit");
		assert.equal(settled.html, streaming.html, "which renders the same markup");
	});

	it("starts capturing as soon as the stream ends, without a remount", async () => {
		const md = "The turn's last paragraph, now finished.";
		const host = document.createElement("div");
		document.body.append(host);
		const root = createRoot(host);
		try {
			await act(async () => root.render(<MessageResponse live>{md}</MessageResponse>));
			assert.equal(mdBlockCacheStats().pending, 0, "nothing queued while live");
			await act(async () => root.render(<MessageResponse live={false}>{md}</MessageResponse>));
			assert.equal(mdBlockCacheStats().pending, 1, "queued once the stream ended");
			flushMdBlockCaptures();
			assert.equal(mdBlockCacheStats().entries, 1);
		} finally {
			await act(async () => root.unmount());
			host.remove();
		}
	});

	it("drops a capture whose block moved on before it ran", async () => {
		const host = document.createElement("div");
		document.body.append(host);
		const root = createRoot(host);
		try {
			await act(async () => root.render(<MessageResponse>{"Half a sen"}</MessageResponse>));
			await act(async () => root.render(<MessageResponse>{"Half a sentence, then the rest."}</MessageResponse>));
			flushMdBlockCaptures();
			assert.equal(mdBlockCacheStats().entries, 1, "the intermediate text never entered the cache");
		} finally {
			await act(async () => root.unmount());
			host.remove();
		}
		const final = await visit("Half a sentence, then the rest.");
		assert.equal(final.queued, 0, "and what it settled on is what was kept");
	});

	it("holds the cap and evicts the least recently used block", async () => {
		// Equal-length prose, so the budget arithmetic is exact.
		const a = "Alpha paragraph, padded to one length.";
		const b = "Bravo paragraph, padded to one length.";
		const c = "Delta paragraph, padded to one length.";
		assert.equal(new Set([a.length, b.length, c.length]).size, 1);
		await visit(a);
		await visit(b);
		const twoBlocks = mdBlockCacheStats().chars;
		assert.equal(mdBlockCacheStats().entries, 2);

		// A budget that fits two of these blocks but not three.
		setMdBlockCacheMaxChars(twoBlocks);
		await visit(c);
		const stats = mdBlockCacheStats();
		assert.equal(stats.entries, 2, "the cap is held by eviction, not by refusing to store");
		assert.ok(stats.chars <= twoBlocks, `cap held: ${stats.chars} <= ${twoBlocks}`);

		assert.equal((await visit(b)).queued, 0, "B, read more recently, survived");
		assert.equal((await visit(a)).queued, 1, "A, the least recently used, was dropped");
	});
});

describe("markdown block wrappers", () => {
	const css = readFileSync("app/globals.css", "utf8");

	it("cost no box and keep streamdown's rhythm", () => {
		assert.match(css, /\[data-md-block\]\s*\{\s*display: contents;\s*\}/,
			"the wrapper creates no layout box");
		// Tailwind v4 compiles the root's `space-y-4` to
		// `:where(.space-y-4 > :not(:last-child)) { margin-block-end: 1rem }`.
		// The replacement must keep BOTH halves of that: the zero specificity
		// (so a heading's own mt-6/mb-2 still wins, as it does without the
		// wrappers) and the bottom-margin form.
		const spacing = /:where\(\.lh-prose > \[data-md-block\] > :not\(:last-child\)\),\s*:where\(\.lh-prose > \[data-md-block\]:not\(:last-child\) > :last-child\)\s*\{\s*margin-block-start: 0;\s*margin-block-end: 1rem;\s*\}/;
		assert.match(css, spacing, "the 1rem fallback gap, inside a block and across block boundaries, at zero specificity");
		// Zero specificity only means anything inside the layer: unlayered CSS
		// wins over every layered rule regardless, which is how the first
		// version of this rule beat the headings' own mt-6.
		const layer = css.indexOf("@layer utilities");
		assert.ok(layer >= 0 && css.indexOf(":where(.lh-prose > [data-md-block]") > layer,
			"the replacements sit in the utilities layer, with the rules they stand in for");
		assert.equal(/\[data-md-block\][^{]*\{[^}]*margin-top: 1rem/.test(css), false,
			"no high-specificity gap rule: it would override the margins headings set for themselves");
		assert.match(css, /\.lh-prose > \[data-md-block\]:first-child > :first-child\s*\{\s*margin-top: 0;\s*\}/,
			"nothing above the first element");
		assert.match(css, /\.lh-prose > \[data-md-block\]:last-child > :last-child\s*\{\s*margin-bottom: 0;\s*\}/,
			"nothing below the last element");
	});

	it("let the answered card keep its inline markdown", () => {
		assert.match(css, /\.lh-md-inline > \[data-md-block\]:first-child > p:first-child\s*\{\s*display: inline;\s*margin: 0;\s*\}/);
		const card = readFileSync("components/answered-card.tsx", "utf8");
		assert.equal(card.includes("[&>p:first-child]"), false,
			"the direct-child variant cannot reach through the wrapper any more");
		assert.equal(card.match(/lh-md-inline/g)?.length, 2, "both inline answer lines use the rule");
	});

	it("wrap every block, cached or not, so a repeat visit has the same structure", async () => {
		const md = "One paragraph.\n\nAnother paragraph.";
		const first = await visit(md);
		assert.equal(first.html.match(/data-md-block/g)?.length, 2, "each paragraph is wrapped — the blank line between them is not");
		const second = await visit(md);
		assert.equal(second.queued, 0, "served from the cache");
		assert.equal(second.html, first.html, "with the same structure");
	});
});
