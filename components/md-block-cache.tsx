"use client";

/**
 * THE CROSS-MOUNT MARKDOWN BLOCK CACHE (lesson-switch lag, 2026-11-25).
 *
 * Switching lessons unmounts the whole transcript and mounts the next one.
 * streamdown caches its unified PROCESSOR but never the rendered output —
 * `runSync(parse(content))` plus rehype-katex runs again for every block of
 * every message on every mount — so returning to a lesson rebuilds markdown
 * the app has already drawn once. On the learner's 237-message session that
 * is 1,288 blocks and ~1,600 KaTeX nodes per visit.
 *
 * WHAT IS CACHED: the block's own rendered HTML, read back out of the DOM
 * after React drew it. Nothing here re-parses, re-sanitizes or re-hardens
 * markdown: the stored string is output streamdown's own raw → sanitize →
 * harden → katex chain produced (see components/ai-elements/message.tsx),
 * and a repeat visit hands that exact string back as `innerHTML`.
 *
 * WHAT IS NOT CACHED (user ruling): any block whose output carries
 * interaction React owns — the hover copy corners (code, tables, display
 * math, mermaid), mermaid's async chart, streamdown's link-safety buttons,
 * images with load/error state, plugin-rendered containers. HTML has no
 * event handlers, so a cached copy of those would be dead chrome. They keep
 * today's rendering, every visit. MD_INTERACTIVE_SELECTOR is the gate, and
 * it reads the REAL rendered subtree rather than guessing from the markdown.
 *
 * THE WRAPPER: every block renders inside `<div data-md-block>`, cached or
 * not, so the capture has a node to read and the structure never differs
 * between a first and a repeat visit. The wrapper is `display: contents`
 * (app/globals.css), so it creates no box; the same file restores the
 * `space-y-4` rhythm streamdown's root applied to its direct children.
 *
 * STREAMING: a block still being written (`isIncomplete`) is never captured,
 * and a block whose content changed before the queued capture ran is dropped
 * (the node's current key no longer matches). So nothing half-parsed, and no
 * intermediate state of a streaming message, ever enters the cache.
 */

import { createContext, useContext, useEffect, useRef, useState } from "react";
import { Block, type BlockProps } from "streamdown";

/** "This surface is still being written." Streamdown's own `isIncomplete` is
 *  gated on its `isAnimating` prop, which this app does not pass (passing it
 *  would change how unfinished fences and diagrams render mid-stream), so the
 *  streaming surfaces declare it here instead: components/ai-elements/message
 *  turns `MessageResponse live` into this, chat.tsx and side-thread.tsx set it
 *  on the part being written. While it is true nothing is captured — a
 *  half-written paragraph is not output worth remembering, and the capture
 *  must not compete with the stream. Both are also covered without it: a
 *  block whose content changes before its capture runs is dropped. */
export const MdBlockLiveContext = createContext(false);

/** The markdown profile this surface renders with — the other half of "same
 *  input, same output". Streamdown rebuilds its resolved component and plugin
 *  objects per mount, so their identity says nothing across mounts; the
 *  surface declares instead. The shared transcript profile is the empty
 *  string; a surface that renders markdown its own way (a `components` or
 *  plugin override) declares MD_BLOCK_PROFILE_OPT_OUT and takes no part in
 *  the cache, rather than risk being served the transcript's markup.
 *  components/ai-elements/message.tsx decides which. */
export const MdBlockProfileContext = createContext("");

export const MD_BLOCK_PROFILE_OPT_OUT = "opt-out";

/** Total cached HTML, in UTF-16 code units (~2 bytes each). The learner's
 *  largest session renders ~1.2 M characters of cacheable HTML, so this
 *  holds a handful of sessions and evicts the least recently used block
 *  after that. */
export const MD_BLOCK_CACHE_MAX_CHARS = 4_000_000;

let maxChars = MD_BLOCK_CACHE_MAX_CHARS;

/** The cap, lowered: exported so the eviction tests can drive real evictions
 *  without allocating megabytes of markup. Resets the budget, never the
 *  entries — `clearMdBlockCache` does that. */
export function setMdBlockCacheMaxChars(next: number): void {
	maxChars = next;
	evict("");
}

/** A single block large enough to be a quarter of the budget is not worth
 *  the evictions it would cause. */
export const MD_BLOCK_MAX_CHARS = 1_000_000;

/** Rendered output that React, not the HTML, carries the behaviour of. One
 *  match anywhere in the block's subtree and the block is never cached.
 *  Deliberately wider than the components that exist today: a new
 *  interactive markdown override is excluded by default, and the cost of a
 *  false exclusion is one uncached block. */
export const MD_INTERACTIVE_SELECTOR = [
	// copy corners, mermaid expand, streamdown's link-safety and image
	// download buttons, plus anything focusable a future override adds
	"button",
	"input",
	"select",
	"textarea",
	'[contenteditable]:not([contenteditable="false"])',
	'[role="textbox"]',
	// the app's own overrides (components/md-blocks.tsx), including the
	// display-only profile where their buttons are absent but the async
	// render, the live-DOM serialization and the theme dependency remain
	'[data-testid="md-mermaid"]',
	'[data-testid="md-table"]',
	'[data-testid="md-math"]',
	'[data-testid="md-code"]',
	// streamdown's own interactive blocks
	'[data-streamdown="code-block"]',
	'[data-streamdown="image-wrapper"]',
	'[data-streamdown="link"]',
	"img",
	// plugin renderers own their container imperatively
	"[data-plugin-renderer]",
].join(",");

// ─── The render signature ────────────────────────────────────────────────────

/** The appearance that produced the cached HTML. Entries are keyed on it, so
 *  a settings change never serves markup rendered under the old settings —
 *  the stale entries simply stop being reachable and age out by LRU.
 *  components/settings/appearance.tsx pushes it as it applies appearance;
 *  the empty default is "as the server rendered it". */
let signature = "";

export function setMdRenderSignature(next: string): void {
	signature = next;
}

export function mdRenderSignature(): string {
	return signature;
}



// ─── The store: insertion-ordered Map as an LRU, capped by characters ────────

const cache = new Map<string, string>();
let cachedChars = 0;

export function mdBlockCacheStats(): { entries: number; chars: number; pending: number } {
	return { entries: cache.size, chars: cachedChars, pending: jobs.length };
}

/** Test and teardown seam: forget everything, including queued captures. */
export function clearMdBlockCache(): void {
	cache.clear();
	cachedChars = 0;
	jobs.length = 0;
}

/** Read and mark as most recently used. */
function take(key: string): string | undefined {
	const html = cache.get(key);
	if (html === undefined) return undefined;
	cache.delete(key);
	cache.set(key, html);
	return html;
}

function store(key: string, html: string): void {
	const previous = cache.get(key);
	if (previous !== undefined) {
		cache.delete(key);
		cachedChars -= previous.length;
	}
	cache.set(key, html);
	cachedChars += html.length;
	evict(key);
}

/** Drop least recently used entries until the budget holds. `keep` is never
 *  evicted: dropping the entry just stored would leave a loop that cannot
 *  make progress. */
function evict(keep: string): void {
	while (cachedChars > maxChars) {
		const oldest = cache.keys().next();
		if (oldest.done || oldest.value === keep) break;
		cachedChars -= cache.get(oldest.value)?.length ?? 0;
		cache.delete(oldest.value);
	}
}

// ─── The capture queue: off the switch's critical path ───────────────────────

/** A queued capture is only valid while the block it was queued for still
 *  holds that content. `owner` is a fresh identity per (node, key) pairing,
 *  replaced whenever the block re-renders into anything else — a streaming
 *  block's next token, a different block at the same list index, or a switch
 *  to a cached copy. An UNMOUNT replaces nothing, so a capture queued just
 *  before the lesson was left stays valid: the detached subtree serializes
 *  exactly the same, and that visit is precisely the one worth remembering.
 */
type Job = { node: HTMLElement; key: string; owner: object; ownerRef: { current: object } };
const jobs: Job[] = [];
let scheduled = false;

/** Serializing a transcript's worth of blocks is real work; it must not land
 *  inside the switch it is meant to make cheaper. The browser says how much
 *  of its idle window is left and that answer is authoritative — an 8 ms
 *  slice taken without asking overran the gaps between React's own transition
 *  slices and cost the first switch about a second of settle time in half the
 *  measured runs. This budget applies only where there is no deadline to
 *  honour: a forced idle run (didTimeout) and the no-requestIdleCallback
 *  fallback. */
const CAPTURE_FORCED_MS = 4;
const CAPTURE_IDLE_TIMEOUT_MS = 1_000;

/** A queued job holds a DOM node, often a detached one. Idle callbacks are
 *  throttled in a hidden tab, so the queue gets a ceiling of its own: one
 *  transcript's worth of blocks, then the oldest offers are dropped rather
 *  than held. Dropping an offer costs one uncached block. */
const CAPTURE_QUEUE_MAX = 4_000;

type IdleDeadline = { timeRemaining: () => number; didTimeout: boolean };
type IdleHost = { requestIdleCallback?: (cb: (deadline: IdleDeadline) => void, options?: { timeout: number }) => unknown };

function schedule(): void {
	if (scheduled || jobs.length === 0) return;
	scheduled = true;
	const idle = (globalThis as IdleHost).requestIdleCallback;
	if (typeof idle === "function") {
		idle((deadline) => {
			scheduled = false;
			drain(deadline);
		}, { timeout: CAPTURE_IDLE_TIMEOUT_MS });
	} else {
		setTimeout(() => {
			scheduled = false;
			drain(undefined);
		}, 0);
	}
}

/** Capture what fits in the window the browser is offering, then come back
 *  for the rest. */
function drain(deadline: IdleDeadline | undefined): void {
	const started = performance.now();
	while (jobs.length > 0) {
		// A forced run reports no time remaining at all, so it takes the
		// fixed slice rather than nothing.
		const left = deadline && !deadline.didTimeout
			? deadline.timeRemaining()
			: CAPTURE_FORCED_MS - (performance.now() - started);
		if (left <= 1) break;
		capture(jobs.shift()!);
	}
	schedule();
}

/** Test seam: run every queued capture now, with no idle wait. */
export function flushMdBlockCaptures(): void {
	while (jobs.length > 0) capture(jobs.shift()!);
}

function capture({ node, key, owner, ownerRef }: Job): void {
	if (ownerRef.current !== owner) return;
	if (cache.has(key)) return;
	if (node.querySelector(MD_INTERACTIVE_SELECTOR) !== null) return;
	const html = node.innerHTML;
	if (html.length === 0 || html.length > MD_BLOCK_MAX_CHARS) return;
	// Only store HTML that reproduces itself: `innerHTML` is re-parsed on the
	// way back in, and a fragment the parser would move or drop (table rows
	// outside a table, a tag the serializer wrote in another namespace) must
	// never become a repeat visit's markup.
	const probe = node.ownerDocument.createElement("div");
	probe.innerHTML = html;
	if (probe.innerHTML !== html) return;
	store(key, html);
}

// ─── The block component (streamdown's BlockComponent seam) ──────────────────

type Shown = { key: string; html: string | undefined };

/** streamdown's `Block`, with its rendered output remembered across mounts.
 *  Passed as `BlockComponent` from components/ai-elements/message.tsx. */
export function CachedBlock(props: BlockProps): React.JSX.Element {
	const content = typeof props.content === "string" ? props.content : "";
	// The blank line between two blocks is a block of its own and renders
	// nothing. Wrapping it would put an empty div between the wrappers, where
	// `:first-child`/`:last-child` would then find it instead of the first and
	// last elements of the prose. (Checked here, returned at the bottom: the
	// hooks below must run for every render of this block, and a streaming
	// block's content does start out blank.)
	const blank = content.trim() === "";
	// The server has no DOM to read and must not share a cache across
	// requests; it renders the live block, which is also what the client
	// hydrates into.
	const client = typeof document !== "undefined";
	const live = useContext(MdBlockLiveContext);
	const profile = useContext(MdBlockProfileContext);
	const shared = client && profile !== MD_BLOCK_PROFILE_OPT_OUT;
	const key = `${signature}\u0000${profile}\u0000${content}`;
	// The decision is taken once per key, at mount: a block that is already
	// drawn live must not be swapped for an HTML copy mid-life.
	const [shown, setShown] = useState<Shown>(() => ({ key, html: shared ? take(key) : undefined }));
	let current = shown;
	if (shown.key !== key) {
		current = { key, html: shared ? take(key) : undefined };
		setShown(current);
	}
	const host = useRef<HTMLDivElement>(null);
	const ownerRef = useRef<object>({});
	const cached = current.html !== undefined;
	const capturable = shared && !cached && !blank && !live && !props.isIncomplete;

	useEffect(() => {
		// Whatever this block now renders, anything queued for what it
		// rendered before is stale.
		ownerRef.current = {};
		const node = host.current;
		if (!capturable || node === null || cache.has(key)) return;
		jobs.push({ node, key, owner: ownerRef.current, ownerRef });
		if (jobs.length > CAPTURE_QUEUE_MAX) jobs.splice(0, jobs.length - CAPTURE_QUEUE_MAX);
		schedule();
	}, [capturable, key]);

	if (blank) return <Block {...props} />;
	if (current.html !== undefined) {
		return <div data-md-block="" dangerouslySetInnerHTML={{ __html: current.html }} />;
	}
	return (
		<div data-md-block="" ref={host}>
			<Block {...props} />
		</div>
	);
}
