import type { LhViewMessage, LhViewPart } from "@/src/core";
import { isSubagentSteer } from "./transcript-rows";

/**
 * THE TRANSCRIPT WINDOW: which rows of a session are allowed to exist in the
 * DOM right now.
 *
 * Containment (`data-older-transcript-row`, PR #7) stops the browser laying
 * out and painting rows that are off screen, but React still BUILDS them: a
 * 237-message session constructs ~45,000 DOM nodes and ~1,582 KaTeX nodes on
 * every switch into it, and that construction is the switch's remaining
 * ~0.6-0.7 s of blocking main-thread work. Nothing short of not building them
 * removes it.
 *
 * THE ROW IS THE PART, NOT THE MESSAGE. `projectView` merges consecutive
 * native messages into one view row, so that session projects to 17 view
 * messages of which two are 18,360 px and 25,895 px tall. Windowing at the
 * message level would still build a whole 25,895 px group to show 900 px of
 * it; the per-part rows containment already targets are the unit that makes
 * the window small. An assistant group therefore contributes one row per
 * part, every other message is one row, and the render re-groups the rows it
 * mounts back under their own <Message> wrapper so the markup and the prose
 * geometry are the ones the transcript already had.
 *
 * Pure on purpose: everything here is arithmetic over row heights, so the
 * window is unit-testable without a layout engine.
 */

/** One renderable unit of the transcript. */
export interface TranscriptRow {
	/** Index into the view messages. */
	mi: number;
	/** Index into that message's parts, or null when the message is one row. */
	pi: number | null;
	/** Identity for the measured-height map. Stable for a given session. */
	id: string;
	/** Height to assume until this row has been laid out at least once. */
	estimate: number;
}

/**
 * Per-row height guesses, before anything is measured.
 *
 * A wrong guess costs scrollbar accuracy and at most one extra convergence
 * pass. It never costs reading position: the window always covers the
 * viewport, so the row the reader is looking at is always built.
 *
 * FITTED, NOT GUESSED, and fitted to EVERY row. The containment rules
 * (globals.css) estimate only passages and cards and let every other row lay
 * itself out, so their two numbers absorb the rest of the transcript's height
 * between them; a window that replaces every unbuilt row with a stand-in has
 * to price each kind on its own or it double-counts. Measured on the same
 * 241-message teaching transcript, with the window suspended and every row
 * laid out: 301 rows, 65,233px of scroller. The means below reproduce its
 * 64,875px of rows exactly, where the containment pair applied per row
 * overshot it by 7,901px (+12%). The globals.css intrinsic sizes are the same
 * numbers, so a row the browser reserves space for and a row this window
 * reserves space for are worth the same.
 *
 * Still a heuristic from ONE transcript, and `tool` and `plan` rest on 9 and
 * 1 rows: a session shaped differently sits off until its rows are seen.
 */
export const ROW_ESTIMATE = {
	/** A prose passage: `[data-older-transcript-row="passage"]`. n=48. */
	passage: 625,
	/** A graded question card: `[data-older-transcript-row="card"]`. n=64. */
	card: 405,
	/** A learner turn, a marker card, a steer delivery. n=3. */
	message: 340,
	/** A step hairline / phase divider. n=114. */
	rule: 40,
	/** A collapsed reasoning block. n=61. */
	reasoning: 32,
	/** A plan snapshot block. n=1. */
	plan: 1040,
	/** Any other tool part. n=9. */
	tool: 32,
} as const;

/** Does this message render as exactly one row (no <Message> wrapper)? */
export function wholeMessageRow(message: LhViewMessage): boolean {
	if (message.role !== "assistant") return true;
	return message.parts.length === 0;
}

function partEstimate(part: LhViewPart): number {
	if (part.pluginProblem) return ROW_ESTIMATE.card;
	if (part.pluginQuestion) return ROW_ESTIMATE.card;
	switch (part.type) {
		case "text":
			return ROW_ESTIMATE.passage;
		case "step-start":
			return ROW_ESTIMATE.rule;
		case "reasoning":
			return ROW_ESTIMATE.reasoning;
		case "data-plan-block":
			return ROW_ESTIMATE.plan;
		case "tool-quiz":
		case "tool-probe":
		case "tool-ask_user_question":
		case "tool-explain":
		case "tool-recall":
			// Only an answered call renders (a graded card); a pending one lives
			// in the dock and a clean execution renders nothing.
			return part.state === "output-available" ? ROW_ESTIMATE.card : 0;
		default:
			return part.type.startsWith("tool-") ? ROW_ESTIMATE.tool : 0;
	}
}

/** The transcript's rows, in render order. */
export function transcriptRows(messages: readonly LhViewMessage[]): TranscriptRow[] {
	const rows: TranscriptRow[] = [];
	messages.forEach((message, mi) => {
		const key = message.id || `m-${mi}`;
		if (wholeMessageRow(message)) {
			// Legacy records can carry empty ids; the index keeps rows unique
			// exactly as the render's key fallback does.
			rows.push({ mi, pi: null, id: key, estimate: isSubagentSteer(message) ? ROW_ESTIMATE.card : ROW_ESTIMATE.message });
			return;
		}
		message.parts.forEach((part, pi) => {
			rows.push({ mi, pi, id: `${key}:${pi}`, estimate: partEstimate(part) });
		});
	});
	return rows;
}

/** A row's height: measured if it has ever been laid out, else its guess. */
export function rowHeight(row: TranscriptRow, heights: ReadonlyMap<string, number>): number {
	const measured = heights.get(row.id);
	return measured === undefined ? row.estimate : measured;
}

/** Offsets of every row boundary: `offsets[i]` is the top of row `i`, and
 *  `offsets[rows.length]` is the transcript's full height. */
export function rowOffsets(rows: readonly TranscriptRow[], heights: ReadonlyMap<string, number>): number[] {
	const offsets = new Array<number>(rows.length + 1);
	let top = 0;
	for (let i = 0; i < rows.length; i++) {
		offsets[i] = top;
		top += rowHeight(rows[i]!, heights);
	}
	offsets[rows.length] = top;
	return offsets;
}

/** A row named the way the rest of the app names one: which message, and
 *  which of its parts (null when the message is one row). */
export interface TranscriptAddress { mi: number; pi: number | null }

/** A half-open row range `[start, end)`. */
export interface RowRange { start: number; end: number }

export function sameRange(a: RowRange, b: RowRange): boolean {
	return a.start === b.start && a.end === b.end;
}

/** Every row — the window suspended (Find is open, or the session is short). */
export function fullRange(rows: readonly TranscriptRow[]): RowRange {
	return { start: 0, end: rows.length };
}

export interface WindowRequest {
	rows: readonly TranscriptRow[];
	heights: ReadonlyMap<string, number>;
	/** The scroller's scrollTop. Clamped into the transcript. */
	scrollTop: number;
	/** The scroller's clientHeight. */
	viewport: number;
	/** How much to build above and below the viewport. */
	buffer: number;
}

/**
 * The rows that intersect the viewport plus the buffer above and below.
 *
 * Never empty, and never narrower than the viewport: the reader's own row is
 * always built, which is what keeps the browser's scroll anchoring able to
 * hold the reading position while rows above change size.
 */
export function windowRange({ rows, heights, scrollTop, viewport, buffer }: WindowRequest): RowRange {
	if (rows.length === 0) return { start: 0, end: 0 };
	const offsets = rowOffsets(rows, heights);
	const total = offsets[rows.length]!;
	// A scrollTop past the end (a fresh mount opening at the bottom passes
	// Infinity) reads as "show the tail".
	const top = Math.max(0, Math.min(scrollTop, total - viewport));
	const wantTop = top - buffer;
	const wantBottom = top + viewport + buffer;
	let start = rows.length - 1;
	for (let i = 0; i < rows.length; i++) {
		if (offsets[i + 1]! > wantTop) { start = i; break; }
	}
	let end = start + 1;
	for (let i = start; i < rows.length; i++) {
		if (offsets[i]! >= wantBottom) break;
		end = i + 1;
	}
	return { start, end };
}

/** Does this range cover the viewport plus its buffer, or did under-estimated
 *  row heights leave a gap the next pass has to fill? */
export function rangeCovers(request: WindowRequest, range: RowRange): boolean {
	const { rows, heights, scrollTop, viewport, buffer } = request;
	if (rows.length === 0) return true;
	const offsets = rowOffsets(rows, heights);
	const total = offsets[rows.length]!;
	const top = Math.max(0, Math.min(scrollTop, total - viewport));
	return (range.start === 0 || offsets[range.start]! <= top - buffer)
		&& (range.end === rows.length || offsets[range.end]! >= top + viewport + buffer);
}

/** The scroll offset that brings row `index` into view — how a jump (a graph
 *  link, a citation, a hash arrival) reaches a row that is not built yet. A
 *  third of a viewport of lead-in only has to land the row inside the window;
 *  `scrollSessionTarget` then places it exactly, once it exists. */
export function revealScrollTop(rows: readonly TranscriptRow[], heights: ReadonlyMap<string, number>, index: number, viewport: number): number {
	const offsets = rowOffsets(rows, heights);
	const clamped = Math.max(0, Math.min(index, rows.length - 1));
	return Math.max(0, (offsets[clamped] ?? 0) - viewport / 3);
}

/**
 * Which row a jump's message id lands on.
 *
 * A jump — a hash arrival, a graph link, a citation — names a NATIVE message
 * id, and `projectView` merges consecutive native messages into one view row,
 * so that id usually belongs to a text PART in the middle of a group rather
 * than to the view message the group became (the part's anchor is
 * `message-<native id>`, minted from `part.id`'s `<native id>-t<n>` form).
 * Resolving only view ids would leave every such jump with nothing to find.
 * View ids are kept too: a learner turn or a marker card is its own row and
 * its view id IS its native id.
 */
export function messageJumpTargets(
	messages: readonly LhViewMessage[],
	/** `textPartMessageId`, passed in from the view that already imports it:
	 *  this module may only reach `@/src/core`'s barrel (the browser shell's
	 *  import rule), and one more value import from it is enough to push the
	 *  project's type checker over its instantiation budget (TS2589 in
	 *  src/core/plugin-view-context). */
	sourceMessageIdOf: (partId: string | undefined) => string | null,
): Map<string, TranscriptAddress> {
	const index = new Map<string, TranscriptAddress>();
	const remember = (id: string | null | undefined, at: TranscriptAddress) => {
		if (id && !index.has(id)) index.set(id, at);
	};
	messages.forEach((message, mi) => {
		remember(message.id, { mi, pi: wholeMessageRow(message) ? null : 0 });
		if (wholeMessageRow(message)) return;
		message.parts.forEach((part, pi) => {
			if (part.type === "text") remember(sourceMessageIdOf(part.id), { mi, pi });
		});
	});
	return index;
}

/** Where in the row list an address lands, or -1. */
export function rowIndexOf(rows: readonly TranscriptRow[], { mi, pi }: TranscriptAddress): number {
	return rows.findIndex((row) => row.mi === mi && row.pi === pi);
}

/** The heights the two spacers must stand in for: everything before the
 *  window, and everything after it. */
export function spacerHeights(rows: readonly TranscriptRow[], heights: ReadonlyMap<string, number>, range: RowRange): { before: number; after: number } {
	const offsets = rowOffsets(rows, heights);
	return {
		before: offsets[Math.min(range.start, rows.length)] ?? 0,
		after: (offsets[rows.length] ?? 0) - (offsets[Math.min(range.end, rows.length)] ?? 0),
	};
}

/** The windowed rows grouped back under their own message, so the render can
 *  rebuild each group's <Message> wrapper around just the parts it mounts.
 *  `before`/`after` are that group's unbuilt parts, as height. */
export interface WindowedGroup {
	mi: number;
	/** null for a whole-message row; else the mounted part indices, in order. */
	parts: number[] | null;
	before: number;
	after: number;
}

export function windowedGroups(rows: readonly TranscriptRow[], heights: ReadonlyMap<string, number>, range: RowRange): WindowedGroup[] {
	const groups: WindowedGroup[] = [];
	for (let i = range.start; i < range.end && i < rows.length; i++) {
		const row = rows[i]!;
		const last = groups.at(-1);
		if (last && last.mi === row.mi && last.parts && row.pi !== null) {
			last.parts.push(row.pi);
			continue;
		}
		groups.push({ mi: row.mi, parts: row.pi === null ? null : [row.pi], before: 0, after: 0 });
	}
	// A partially built group reserves its unbuilt parts INSIDE the wrapper,
	// so the group keeps the height the transcript's scroll geometry expects.
	for (const group of groups) {
		if (!group.parts) continue;
		const first = group.parts[0]!;
		const final = group.parts.at(-1)!;
		for (const row of rows) {
			if (row.mi !== group.mi || row.pi === null) continue;
			if (row.pi < first) group.before += rowHeight(row, heights);
			else if (row.pi > final) group.after += rowHeight(row, heights);
		}
	}
	return groups;
}

/** One mounted row, as read from the DOM. `empty` rows rendered nothing (a
 *  clean question execution, a tool part with no presentation) and have no
 *  box to read. */
export interface RowMeasurement { id: string; top: number; bottom: number; empty: boolean }

/**
 * What each mounted row's slot in the scroller is worth.
 *
 * The window is a CONTIGUOUS range of rows, so a row's slot runs to the next
 * row's top — which carries the flex gaps and wrapper padding between them,
 * and so the spacer that stands in for a skipped row reserves the same space
 * the row itself did. The last mounted row has no next top and contributes
 * its own box, short by one gap; a stray gap or two on a transcript tens of
 * thousands of pixels tall moves the scrollbar, not the reading position.
 */
export function measuredHeights(entries: readonly RowMeasurement[]): Map<string, number> {
	const out = new Map<string, number>();
	entries.forEach((entry, i) => {
		if (entry.empty) { out.set(entry.id, 0); return; }
		const next = entries.slice(i + 1).find((other) => !other.empty);
		const height = next ? next.top - entry.top : entry.bottom - entry.top;
		// A negative reading means the rows were not laid out in order; keep
		// what is already known rather than poisoning the map.
		if (height >= 0) out.set(entry.id, height);
	});
	return out;
}
