import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { parseHTML } from "linkedom";
import { revealJumpTarget, scrollSessionTarget } from "../components/session-navigation.tsx";

/* Jumping to a source passage must land on the passage, not on its estimate.
 *
 * Older passages are contained (`content-visibility: auto`), and a contained
 * row reports its `contain-intrinsic-block-size` estimate instead of its own
 * box until it is laid out. scrollSessionTarget scrolls by reading that box,
 * so the order matters: the spotlight class (which exempts the target from
 * containment) has to be applied BEFORE the read. These tests model
 * containment as "the box is the estimate until the exempting class is
 * present" and assert the landing position.
 *
 * ESTIMATE = 670px, the value globals.css uses for a passage; REAL = where
 * the passage actually sits once laid out. */
const ESTIMATE_TOP = 670;
const REAL_TOP = 120;

function harness() {
	const dom = parseHTML("<html><body></body></html>");
	const { document } = dom;
	const scroller = document.createElement("div");
	scroller.setAttribute("data-scroller", "");
	const target = document.createElement("div");
	target.className = "lh-source-passage";
	target.setAttribute("data-older-transcript-row", "passage");
	scroller.append(target);
	document.body.append(scroller);

	let scrolledTo: number | null = null;
	Object.assign(scroller, {
		scrollTop: 0,
		scrollHeight: 60_000,
		clientHeight: 900,
		scrollTo: (options: { top: number }) => { scrolledTo = options.top; },
	});
	Object.defineProperty(scroller, "getBoundingClientRect", {
		configurable: true, value: () => ({ top: 0, bottom: 900, height: 900 }),
	});
	// Containment, modelled: the target reports the estimate until the
	// spotlight class exempts it.
	Object.defineProperty(target, "getBoundingClientRect", {
		configurable: true,
		value: () => ({ top: target.hasAttribute("data-lh-measuring") ? REAL_TOP : ESTIMATE_TOP, bottom: 0, height: 0 }),
	});
	(dom.window as unknown as { getComputedStyle: unknown }).getComputedStyle = () => ({ overflowY: "auto" });
	Object.defineProperty(document, "defaultView", { configurable: true, value: dom.window });
	return { scroller, target, document, scrolled: () => scrolledTo };
}

describe("reading position on a jump into a contained passage", () => {
	it("lands on the passage's own box for an element target, painting nothing", () => {
		const { scroller, target, scrolled } = harness();
		scrollSessionTarget(target as unknown as HTMLElement, scroller as unknown as HTMLElement, null);
		assert.equal(scrolled(), REAL_TOP - 16);
		assert.ok(!target.classList.contains("lh-source-highlight"));
		assert.ok(!target.hasAttribute("data-lh-measuring"), "exemption is restored");
	});

	it("lands on the real box for a Range inside the contained row", () => {
		const { scroller, target, scrolled, document } = harness();
		const text = document.createTextNode("passage text");
		target.append(text);
		const range = {
			startContainer: text,
			getBoundingClientRect: () => ({ top: target.hasAttribute("data-lh-measuring") ? REAL_TOP : ESTIMATE_TOP }),
		};
		scrollSessionTarget(range as unknown as Range, scroller as unknown as HTMLElement, null);
		assert.equal(scrolled(), REAL_TOP - 16);
		assert.ok(!target.classList.contains("lh-source-highlight"));
	});

	it("hash jump spotlights the target and lands on its real box", () => {
		const { scroller, target, scrolled } = harness();
		revealJumpTarget(target as unknown as HTMLElement, scroller as unknown as HTMLElement, null);
		assert.ok(target.classList.contains("lh-source-highlight"));
		assert.equal(scrolled(), REAL_TOP - 16);
	});
});
