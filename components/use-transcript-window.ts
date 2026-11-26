"use client";

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { LhViewMessage } from "@/src/core";
import {
	fullRange,
	measuredHeights,
	pendingAsk,
	rangeCovers,
	revealScrollTop,
	rowIndexOf,
	sameRange,
	spacerHeights,
	transcriptRows,
	windowRange,
	windowedGroups,
	type RowMeasurement,
	type TranscriptAddress,
	type RowRange,
	type TranscriptRow,
	type WindowedGroup,
} from "./transcript-window";

/** The viewport the FIRST render assumes, having no scroller to measure yet —
 *  the server's render, or the one that happens the instant a session opens.
 *  A constant, not `window.innerHeight`: the server and the client's first
 *  render have to agree for hydration, and the real geometry replaces the
 *  assumption in the first layout effect anyway. */
const ASSUMED_VIEWPORT = 1000;
/** Built above and below the viewport, so ordinary scrolling never waits on a
 *  render. One viewport each way, with a floor for short windows. */
const BUFFER_MIN = 800;
/** Under-estimated rows can leave the viewport short, which the next pass
 *  fills from the heights it just measured. Bounded so a row whose height
 *  never settles cannot spin the loop. */
const MAX_CONVERGENCE_PASSES = 4;
/** The same, for putting the reading position back: a correction moves the
 *  scroller, which moves the window, which may move the row again. */
const MAX_RESTORE_PASSES = 12;
/** How long the reader's place is held after a change that replaced the whole
 *  transcript: long enough for the rows above them to settle — each laying
 *  itself out, a KaTeX pass, a web font — and short enough that the next thing
 *  the learner does is their own. Their own scroll releases it early
 *  (releaseReadingPosition). Measured at four depths of the 241-message
 *  session, opening and closing Find moves the reader's row 0px with this;
 *  the scroller's scrollTop moves by up to 5,000px, which is the content
 *  above them changing size, not the reader moving. */
const ANCHOR_HOLD_MS = 1200;

const useIsoLayoutEffect = typeof window === "undefined" ? useEffect : useLayoutEffect;

export interface TranscriptWindow {
	/** The groups to render, with each group's unbuilt parts as height. */
	groups: readonly WindowedGroup[];
	/** Stand-ins for the rows before and after the window. 0 = render none. */
	before: number;
	after: number;
	/** Remember where the reader is, BEFORE a change that replaces the whole
	 *  transcript at once — suspending the window or giving it back. Call it in
	 *  the event that causes the change, while the old DOM is still up. */
	captureReadingPosition: () => void;
	/** Ask for a row, so a jump can scroll to a passage the window has not
	 *  built. `built` = already in the DOM, `building` = asked for and one
	 *  render away, `unknown` = no such row in this session. */
	revealRow: (at: TranscriptAddress | undefined) => "built" | "building" | "unknown";
}

/**
 * The transcript window, wired to the scroller.
 *
 * Opens on the TAIL — where a session opens, because the transcript sticks to
 * the bottom — and follows the scroller from there, measuring what it builds
 * so the stand-ins it leaves behind reserve the same space.
 */
export function useTranscriptWindow({ messages, scroller, suspended, stopScroll }: {
	messages: readonly LhViewMessage[];
	/** The transcript's scroll element; null until it is mounted. */
	scroller: HTMLElement | null;
	/** Suspend windowing — every row must exist in the DOM. */
	suspended: boolean;
	/**
	 * stick-to-bottom's escape, which this window has to pull itself.
	 *
	 * Its scroll handler DISCARDS a scroll event whenever one of its own
	 * resize differences is in flight ("when there's a resize difference
	 * ignore the resize event", useStickToBottom.js) — and a window change IS
	 * a content resize, arriving in the same tick as the scroll that caused
	 * it. So the learner's scroll away from the bottom never registered as an
	 * escape, the bottom lock stayed on, and its ResizeObserver scrolled the
	 * transcript straight back down: measured, a jump to 20,000px of a
	 * 66,000px session returned to the end within 400ms, where the
	 * unwindowed build held. Saying "not at the bottom" out loud, exactly as
	 * `scrollSessionTarget` does before a jump, is the fix.
	 */
	stopScroll?: () => void;
}): TranscriptWindow {
	const rows = useMemo(() => transcriptRows(messages), [messages]);
	const heights = useRef(new Map<string, number>()).current;
	/** Bumped whenever a measurement lands, so the spacers and groups derived
	 *  from the height map are recomputed — the map is mutated in place and
	 *  cannot be a dependency on its own. */
	const [measuredAt, setMeasuredAt] = useState(0);

	const rowsRef = useRef(rows);
	rowsRef.current = rows;
	const scrollerRef = useRef(scroller);
	scrollerRef.current = scroller;
	const suspendedRef = useRef(suspended);
	suspendedRef.current = suspended;
	const stopScrollRef = useRef(stopScroll);
	stopScrollRef.current = stopScroll;
	const passes = useRef(0);

	const request = useCallback((scrollTop?: number) => {
		const el = scrollerRef.current;
		const viewport = el?.clientHeight || ASSUMED_VIEWPORT;
		return {
			rows: rowsRef.current,
			heights,
			scrollTop: scrollTop ?? (el ? el.scrollTop : Number.POSITIVE_INFINITY),
			viewport,
			buffer: Math.max(BUFFER_MIN, viewport),
		};
	}, [heights]);

	const [range, setRange] = useState<RowRange>(() => (
		suspended ? fullRange(rows) : windowRange({
			rows, heights, scrollTop: Number.POSITIVE_INFINITY,
			viewport: ASSUMED_VIEWPORT, buffer: ASSUMED_VIEWPORT,
		})
	));

	const rangeRef = useRef<RowRange>(range);
	rangeRef.current = range;
	const apply = useCallback((scrollTop?: number) => {
		const next = suspendedRef.current ? fullRange(rowsRef.current) : windowRange(request(scrollTop));
		if (sameRange(rangeRef.current, next)) return;
		const el = scrollerRef.current;
		// Away from the end, the resize this is about to cause must not be
		// allowed to swallow the scroll that got us here (see stopScroll).
		if (el && el.scrollHeight - el.clientHeight - el.scrollTop > (el.clientHeight || ASSUMED_VIEWPORT) / 2) {
			stopScrollRef.current?.();
		}
		rangeRef.current = next;
		setRange(next);
	}, [request]);

	/** A new scroll position, new content or a new viewport: the window is
	 *  rebuilt from scratch and the convergence budget starts over. */
	const rewindow = useCallback((scrollTop?: number) => {
		passes.current = 0;
		apply(scrollTop);
	}, [apply]);

	/** What the built rows are worth, read out of the DOM. A row's height is
	 *  the distance to the next row's top, so it carries the flex gaps and
	 *  wrapper padding of its whole slot and the spacer that stands in for it
	 *  later reserves the same space. */
	const measure = useCallback((): boolean => {
		const el = scrollerRef.current;
		if (!el) return false;
		const origin = el.getBoundingClientRect().top - el.scrollTop;
		const entries: RowMeasurement[] = [...el.querySelectorAll<HTMLElement>("[data-lh-row]")].map((node) => {
			// The wrapper generates no box (display: contents), so the row's
			// extent is the extent of what it rendered; a part that renders
			// nothing has no children and no slot at all.
			const first = node.firstElementChild;
			const last = node.lastElementChild;
			const id = node.dataset.lhRow ?? "";
			if (!first || !last) return { id, top: 0, bottom: 0, empty: true };
			return {
				id,
				top: first.getBoundingClientRect().top - origin,
				bottom: last.getBoundingClientRect().bottom - origin,
				empty: false,
			};
		}).filter((entry) => entry.id);
		let changed = false;
		for (const [id, height] of measuredHeights(entries)) {
			if (heights.get(id) !== height) { heights.set(id, height); changed = true; }
		}
		if (changed) setMeasuredAt((version) => version + 1);
		return changed;
	}, [heights]);

	/**
	 * Hold the reading position across a change the browser's own scroll
	 * anchoring cannot absorb.
	 *
	 * Ordinary scrolling needs none of this: the window always covers the
	 * viewport, so the reader's row stays in the DOM and the browser's own
	 * scroll anchoring holds it while the spacer above changes size — the same
	 * mechanism that already absorbs a contained row swapping its estimate for
	 * its real height (measured: a row held to within 1px over six window
	 * changes). Suspending the window is different: every row appears at once
	 * and tens of thousands of pixels of stand-in collapse into real content
	 * in one commit, which anchoring does not absorb.
	 */
	const anchor = useRef<{ id: string; offset: number; tries: number; at: number } | null>(null);
	const rowNode = (el: HTMLElement, id: string) => {
		const escaped = typeof CSS !== "undefined" && typeof CSS.escape === "function" ? CSS.escape(id) : id;
		return el.querySelector<HTMLElement>(`[data-lh-row="${escaped}"]`);
	};
	const captureReadingPosition = useCallback(() => {
		const el = scrollerRef.current;
		anchor.current = null;
		if (!el) return;
		const top = el.getBoundingClientRect().top;
		// The first built row still on screen — what the reader is looking at.
		for (const node of el.querySelectorAll<HTMLElement>("[data-lh-row]")) {
			const first = node.firstElementChild;
			const id = node.dataset.lhRow;
			if (!first || !id) continue;
			const box = first.getBoundingClientRect();
			if (box.bottom <= top) continue;
			anchor.current = { id, offset: box.top - top, tries: 0, at: Date.now() };
			return;
		}
	}, []);
	/** The learner's own move outranks the hold: once they scroll, where they
	 *  were is no longer where they want to be. Without this release the hold
	 *  could only be short, and a long one is what it takes to outlast the
	 *  rows above them settling. */
	const releaseReadingPosition = useCallback(() => { anchor.current = null; }, []);
	/**
	 * Put the anchored row back where it was. True when nothing (more) is
	 * owed. Owns the anchor's lifetime: the rows that appeared keep settling
	 * for several frames — a contained row laying itself out, a KaTeX pass —
	 * and one correction at commit time lands ~1,000px short of where the
	 * reader was, so the hold stays until the content stops moving.
	 */
	const restoreReadingPosition = useCallback((): boolean => {
		const held = anchor.current;
		const el = scrollerRef.current;
		if (!held || !el) return true;
		if (held.tries >= MAX_RESTORE_PASSES || Date.now() - held.at > ANCHOR_HOLD_MS) {
			anchor.current = null;
			return true;
		}
		const first = rowNode(el, held.id)?.firstElementChild;
		if (!first) { anchor.current = null; return true; }
		const delta = first.getBoundingClientRect().top - el.getBoundingClientRect().top - held.offset;
		// Still held, not settled: more of the transcript may yet move.
		if (Math.abs(delta) < 1) return true;
		// CLAMPED to a viewport a pass: a correction moves the scroller, which
		// can move the row again, so a bad reading must not be able to fling
		// the transcript. A real settling never needs more than this per pass.
		const viewport = el.clientHeight || ASSUMED_VIEWPORT;
		el.scrollTop += Math.max(-viewport, Math.min(viewport, delta));
		held.tries += 1;
		return false;
	}, []);

	// Scroll, viewport resize and content resize all re-derive the window.
	// Scroll is read on a frame so a flung scroller does not re-render per
	// event; the content observer catches a row that settles late (a web font,
	// a KaTeX pass, an image) without waiting for the window to move.
	useEffect(() => {
		if (!scroller) return;
		let frame: number | null = null;
		const schedule = () => {
			if (frame !== null) return;
			frame = window.requestAnimationFrame(() => { frame = null; rewindow(); });
		};
		const remeasure = () => {
			if (frame !== null) return;
			frame = window.requestAnimationFrame(() => {
				frame = null;
				measure();
				// The rows that just settled may have moved the reader; the
				// window's own commits are not the only thing that can.
				restoreReadingPosition();
				rewindow();
			});
		};
		const release = () => releaseReadingPosition();
		scroller.addEventListener("wheel", release, { passive: true });
		scroller.addEventListener("touchstart", release, { passive: true });
		scroller.addEventListener("pointerdown", release, { passive: true });
		scroller.addEventListener("scroll", schedule, { passive: true });
		const viewport = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(schedule);
		viewport?.observe(scroller);
		const content = scroller.firstElementChild;
		const grown = content && typeof ResizeObserver !== "undefined" ? new ResizeObserver(remeasure) : null;
		if (content) grown?.observe(content);
		return () => {
			scroller.removeEventListener("wheel", release);
			scroller.removeEventListener("touchstart", release);
			scroller.removeEventListener("pointerdown", release);
			scroller.removeEventListener("scroll", schedule);
			viewport?.disconnect();
			grown?.disconnect();
			if (frame !== null) window.cancelAnimationFrame(frame);
		};
	}, [scroller, rewindow, measure, restoreReadingPosition, releaseReadingPosition]);

	const asked = useRef<TranscriptAddress | null>(null);

	// Opening a session, new messages, Find opening or closing.
	useEffect(() => { rewindow(); }, [rows, suspended, rewindow]);

	// Measure what was just built, then fill a viewport the estimates left
	// short, bounded so a row whose height never settles cannot spin.
	useIsoLayoutEffect(() => {
		asked.current = pendingAsk(asked.current, rows, range);
		const changed = measure();
		const settled = restoreReadingPosition();
		if (passes.current >= MAX_CONVERGENCE_PASSES) return;
		if (!changed && settled && rangeCovers(request(), range)) return;
		passes.current += 1;
		apply();
	}, [range, rows, suspended, measure, request, apply, restoreReadingPosition]);

	/**
	 * Take the scroller to where the asked-for row is going to be.
	 *
	 * Moving the SCROLLER, rather than pinning the window to a position the
	 * scroller is not at, is what makes this hold: every later recompute reads
	 * the scroller, so a window pinned somewhere else is thrown away by the
	 * very next pass (the measuring one, in the same commit). This lands on
	 * the estimated offset and the caller's own scroll — `scrollSessionTarget`,
	 * once the row exists — puts the passage exactly where it belongs.
	 */
	const revealRow = useCallback((at: TranscriptAddress | undefined): "built" | "building" | "unknown" => {
		if (!at) return "unknown";
		const index = rowIndexOf(rowsRef.current, at);
		if (index < 0) return "unknown";
		if (index >= range.start && index < range.end) {
			asked.current = null;
			return "built";
		}
		// ONCE PER ASK. The callers poll — session-navigation retries every
		// 64ms for as long as 20s — and re-issuing the scroll on every tick
		// made this fight anything else moving the scroller: against a held
		// reading position the two marched the transcript to its end in
		// ~20,000px steps.
		if (asked.current && asked.current.mi === at.mi && asked.current.pi === at.pi) return "building";
		asked.current = at;
		// A jump supersedes holding a place: the learner asked to be elsewhere.
		releaseReadingPosition();
		const el = scrollerRef.current;
		const top = revealScrollTop(rowsRef.current, heights, index, el?.clientHeight || ASSUMED_VIEWPORT);
		if (el) el.scrollTop = top;
		rewindow(top);
		return "building";
	}, [range.start, range.end, heights, rewindow, releaseReadingPosition]);

	// measuredAt stands in for the height map, which is mutated in place and
	// so cannot be a dependency on its own.
	const groups = useMemo(() => windowedGroups(rows, heights, range), [rows, heights, range, measuredAt]);
	const spacers = useMemo(() => spacerHeights(rows, heights, range), [rows, heights, range, measuredAt]);
	return {
		groups,
		// The outer spacer stands in for skipped MESSAGES; the first and last
		// built groups reserve their own skipped parts inside their own
		// wrappers, so those must not be counted twice.
		before: Math.max(0, spacers.before - (groups[0]?.before ?? 0)),
		after: Math.max(0, spacers.after - (groups.at(-1)?.after ?? 0)),
		revealRow,
		captureReadingPosition,
	};
}
