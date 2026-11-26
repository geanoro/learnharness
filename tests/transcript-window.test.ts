import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
	fullRange,
	measuredHeights,
	pendingAsk,
	messageJumpTargets,
	rangeCovers,
	rowIndexOf,
	revealScrollTop,
	rowOffsets,
	spacerHeights,
	transcriptRows,
	windowRange,
	windowedGroups,
	ROW_ESTIMATE,
	type RowMeasurement,
	type TranscriptRow,
} from "../components/transcript-window.ts";
import type { LhViewMessage, LhViewPart } from "../src/core/index.ts";

/* The window is the switch cost: a 237-message teaching session projects to
 * 17 view messages, two of them 18,360 px and 25,895 px tall, so the rows
 * that decide how much gets BUILT are the parts inside a group, not the
 * groups. These assertions pin the arithmetic that chooses them. */

function text(id: string, chars = "prose"): LhViewPart {
	return { type: "text", id, text: chars } as unknown as LhViewPart;
}

function assistant(id: string, parts: LhViewPart[]): LhViewMessage {
	return { id, role: "assistant", parts } as unknown as LhViewMessage;
}

function learner(id: string): LhViewMessage {
	return { id, role: "user", parts: [text(`${id}-t0`, "a question")] } as unknown as LhViewMessage;
}

const empty = new Map<string, number>();

describe("transcriptRows", () => {
	it("gives an assistant group one row per part and every other message one row", () => {
		const rows = transcriptRows([
			learner("u1"),
			assistant("a1", [text("a1-t0"), text("a1-t1"), { type: "step-start" } as unknown as LhViewPart]),
			learner("u2"),
		]);
		assert.deepEqual(rows.map((row) => [row.mi, row.pi]), [
			[0, null], [1, 0], [1, 1], [1, 2], [2, null],
		]);
		assert.deepEqual(rows.map((row) => row.id), ["u1", "a1:0", "a1:1", "a1:2", "u2"]);
	});

	it("estimates a passage and a graded card the way the containment rules do", () => {
		const answered = { type: "tool-quiz", state: "output-available" } as unknown as LhViewPart;
		const pendingCall = { type: "tool-quiz", state: "input-available" } as unknown as LhViewPart;
		const rows = transcriptRows([assistant("a1", [text("a1-t0"), answered, pendingCall])]);
		assert.deepEqual(rows.map((row) => row.estimate), [ROW_ESTIMATE.passage, ROW_ESTIMATE.card, 0]);
	});

	it("keeps a part-less assistant message as one row rather than dropping it", () => {
		const rows = transcriptRows([assistant("a1", [])]);
		assert.deepEqual(rows.map((row) => [row.mi, row.pi]), [[0, null]]);
	});

	it("keeps legacy empty ids distinct", () => {
		const rows = transcriptRows([learner(""), learner("")] as LhViewMessage[]);
		assert.deepEqual(rows.map((row) => row.id), ["m-0", "m-1"]);
	});
});

function uniform(count: number, height: number): TranscriptRow[] {
	return Array.from({ length: count }, (_, i) => ({ mi: i, pi: null, id: `r${i}`, estimate: height }));
}

describe("windowRange", () => {
	const rows = uniform(100, 100); // 10,000 px of transcript

	it("opens a session at the tail, which is where the transcript sticks", () => {
		const range = windowRange({ rows, heights: empty, scrollTop: Number.POSITIVE_INFINITY, viewport: 1000, buffer: 1000 });
		assert.deepEqual(range, { start: 80, end: 100 });
	});

	it("covers the viewport plus the buffer above and below", () => {
		const range = windowRange({ rows, heights: empty, scrollTop: 5000, viewport: 1000, buffer: 1000 });
		// 4,000 px .. 7,000 px
		assert.deepEqual(range, { start: 40, end: 70 });
		assert.ok(rangeCovers({ rows, heights: empty, scrollTop: 5000, viewport: 1000, buffer: 1000 }, range));
	});

	it("clamps at the top without leaving the viewport uncovered", () => {
		const range = windowRange({ rows, heights: empty, scrollTop: 0, viewport: 1000, buffer: 1000 });
		assert.equal(range.start, 0);
		assert.ok(range.end >= 20);
	});

	it("is never empty, even for one short row", () => {
		const range = windowRange({ rows: uniform(1, 10), heights: empty, scrollTop: 0, viewport: 1000, buffer: 1000 });
		assert.deepEqual(range, { start: 0, end: 1 });
	});

	it("prefers a measured height over the estimate", () => {
		const heights = new Map([["r0", 5000]]);
		const range = windowRange({ rows, heights, scrollTop: 0, viewport: 1000, buffer: 0 });
		assert.deepEqual(range, { start: 0, end: 1 });
	});

	it("reports a short window when under-estimated rows left the viewport uncovered", () => {
		const request = { rows, heights: empty, scrollTop: 5000, viewport: 1000, buffer: 1000 };
		assert.equal(rangeCovers(request, { start: 49, end: 51 }), false);
	});
});

describe("spacers and groups", () => {
	const messages = [
		learner("u1"),
		assistant("a1", [text("a1-t0"), text("a1-t1"), text("a1-t2"), text("a1-t3")]),
		learner("u2"),
	];
	const rows = transcriptRows(messages);
	const heights = new Map(rows.map((row) => [row.id, 100]));

	it("reserves everything outside the window, split between the outer and inner spacers", () => {
		const range = { start: 2, end: 4 }; // parts 1 and 2 of the group
		const spacers = spacerHeights(rows, heights, range);
		const groups = windowedGroups(rows, heights, range);
		assert.deepEqual(groups, [{ mi: 1, parts: [1, 2], before: 100, after: 100 }]);
		// Rows 0 (u1) and 1 (a1:0) sit before the window; a1:0 is the group's
		// own, so the outer spacer is only the learner turn.
		assert.equal(spacers.before, 200);
		assert.equal(spacers.before - groups[0]!.before, 100);
		// Rows 4 (a1:3) and 5 (u2) after; a1:3 is the group's own.
		assert.equal(spacers.after, 200);
		assert.equal(spacers.after - groups.at(-1)!.after, 100);
	});

	it("totals to the transcript's height whatever the window is", () => {
		const total = rowOffsets(rows, heights)[rows.length]!;
		for (let start = 0; start < rows.length; start++) {
			for (let end = start + 1; end <= rows.length; end++) {
				const range = { start, end };
				const spacers = spacerHeights(rows, heights, range);
				const built = (end - start) * 100;
				assert.equal(spacers.before + built + spacers.after, total, `range ${start}..${end}`);
			}
		}
	});

	it("groups consecutive rows of one message back under that message", () => {
		const groups = windowedGroups(rows, heights, fullRange(rows));
		assert.deepEqual(groups, [
			{ mi: 0, parts: null, before: 0, after: 0 },
			{ mi: 1, parts: [0, 1, 2, 3], before: 0, after: 0 },
			{ mi: 2, parts: null, before: 0, after: 0 },
		]);
	});
});

describe("messageJumpTargets", () => {
	// A jump names a NATIVE message id: projectView merges consecutive native
	// messages into one view row, so that id belongs to a text PART inside a
	// group far more often than to the view message the group became.
	const sourceId = (partId: string | undefined) => partId?.match(/^(.*)-t\d+$/)?.[1] || null;

	it("finds the part a native message's anchor was minted from", () => {
		const messages = [
			learner("u1"),
			assistant("a1", [text("src_one-t0"), { type: "step-start" } as unknown as LhViewPart, text("src_two-t0")]),
		];
		const rows = transcriptRows(messages);
		const targets = messageJumpTargets(messages, sourceId);
		assert.deepEqual(targets.get("src_two"), { mi: 1, pi: 2 });
		assert.equal(rowIndexOf(rows, targets.get("src_two")!), 3);
		// The view message's own id still resolves, to the group's first row.
		assert.deepEqual(targets.get("a1"), { mi: 1, pi: 0 });
		// A learner turn is its own row.
		assert.deepEqual(targets.get("u1"), { mi: 0, pi: null });
		assert.equal(rowIndexOf(rows, targets.get("u1")!), 0);
	});

	it("knows nothing of an id this session does not hold", () => {
		const targets = messageJumpTargets([learner("u1")], sourceId);
		assert.equal(targets.get("src_missing"), undefined);
		assert.equal(rowIndexOf(transcriptRows([learner("u1")]), { mi: 4, pi: null }), -1);
	});
});

describe("revealScrollTop", () => {
	it("scrolls a row that is not built into view with a lead-in", () => {
		const rows = uniform(100, 100);
		assert.equal(revealScrollTop(rows, empty, 50, 900), 5000 - 300);
	});

	it("never scrolls above the transcript's start", () => {
		const rows = uniform(100, 100);
		assert.equal(revealScrollTop(rows, empty, 0, 900), 0);
	});
});

describe("measuredHeights", () => {
	const entry = (id: string, top: number, bottom: number): RowMeasurement => ({ id, top, bottom, empty: false });

	it("gives each row the whole slot up to the next row, gaps included", () => {
		const out = measuredHeights([entry("a", 0, 90), entry("b", 100, 180)]);
		assert.equal(out.get("a"), 100); // 90 of box + 10 of gap
		assert.equal(out.get("b"), 80); // the last row has no next top
	});

	it("gives a row that rendered nothing no slot, and skips it for its neighbour", () => {
		const out = measuredHeights([
			entry("a", 0, 90),
			{ id: "gap", top: 0, bottom: 0, empty: true },
			entry("b", 100, 180),
		]);
		assert.equal(out.get("gap"), 0);
		assert.equal(out.get("a"), 100);
	});

	it("keeps what it knows rather than recording an out-of-order reading", () => {
		const out = measuredHeights([entry("a", 500, 590), entry("b", 100, 180)]);
		assert.equal(out.has("a"), false);
		assert.equal(out.get("b"), 80);
	});
});

describe("a reveal asks for a row once, until the window has built it", () => {
	const rows = transcriptRows([learner("u1"), learner("u2"), learner("u3"), learner("u4")]);
	const ask = { mi: 3, pi: null };
	it("stays pending while the row is outside the window", () => {
		assert.deepEqual(pendingAsk(ask, rows, { start: 0, end: 2 }), ask);
	});
	it("clears once the window covers the row, so a later ask for it scrolls again", () => {
		let asked = pendingAsk(ask, rows, { start: 0, end: 2 });
		asked = pendingAsk(asked, rows, { start: 2, end: 4 });
		assert.equal(asked, null);
		asked = pendingAsk(asked, rows, { start: 0, end: 2 });
		assert.equal(asked, null);
	});
	it("clears when the row no longer exists", () => {
		assert.equal(pendingAsk({ mi: 9, pi: null }, rows, { start: 0, end: 2 }), null);
	});
});
