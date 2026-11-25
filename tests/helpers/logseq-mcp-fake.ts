/**
 * A fake Logseq MCP server for the logseq-notes example plugin's integration
 * test, plus synthetic seed journals.
 *
 * It mirrors the behaviour observed against the real Logseq app (DB version),
 * including the limits that shaped the plugin:
 *  - `getPage(<page name>)` returns only the page's DIRECT children.
 *  - `getPage(<block uuid>)` returns that block's entity (with `hl-page` and
 *    `asset`), never its children.
 *  - numeric block ids are not addressable at all.
 *  - `searchBlocks` is the only way to reach deep blocks.
 *
 * The seed is synthetic: a made-up course, written in the terse,
 * typo-carrying, nested style the learner actually uses, so the plugin's output
 * can be judged against realistic input without copying anyone's real notes.
 */
import * as http from "node:http";
import type { AddressInfo } from "node:net";

export type FakeBlock = {
	id: number;
	uuid: string;
	title: string;
	/** Numeric id of the parent block, or the page's own container id. */
	parent: number;
	page: string;
	level: number;
	tags?: { id: number; ident: string; title: string }[];
	/** PDF-annotation slide page, as Logseq's `hl-page`. */
	hlPage?: number;
	/** Numeric id of the owning asset block, as Logseq's `asset: {id}`. */
	assetId?: number;
};

export type FakePage = { uuid: string; title: string; containerId: number; journalDay?: number };

export type FakeSeed = { pages: FakePage[]; blocks: FakeBlock[] };

const ANNOTATION = { id: 180, ident: ":logseq.class/Pdf-annotation", title: "PDF Annotation" };
const ASSET = { id: 176, ident: ":logseq.class/Asset", title: "Asset" };

const DISTSYS_20 = "00000001-2026-1120-0000-000000000000";
const DISTSYS_21 = "00000001-2026-1121-0000-000000000000";
const DISTSYS_23 = "00000001-2026-1123-0000-000000000000";
const OTHER = "00000001-2026-1122-0000-000000000000";

/** Synthetic study journals: a made-up distributed-systems course. */
export const SEED: FakeSeed = {
	pages: [
		{ uuid: DISTSYS_20, title: "Nov 20th, 2026", containerId: 1000, journalDay: 20261120 },
		{ uuid: DISTSYS_21, title: "Nov 21st, 2026", containerId: 1100, journalDay: 20261121 },
		{ uuid: OTHER, title: "Nov 22nd, 2026", containerId: 1300, journalDay: 20261122 },
		{ uuid: DISTSYS_23, title: "Nov 23rd, 2026", containerId: 1200, journalDay: 20261123 },
		{ uuid: "6afc56cd-0000-43eb-9d91-3652cf47a58b", title: "DISTSYS", containerId: 1400 },
		{ uuid: "6afc1b59-0000-4192-8b2f-162e5913663a", title: "Consensus", containerId: 1401 },
	],
	blocks: [
		// ── Nov 20th: quiz line, course outline, then the Risorse highlights ──
		{ id: 1001, uuid: "b-1001", title: "Did the quiz for [[DISTSYS]] on [[Consensus]]", parent: 1000, page: DISTSYS_20, level: 1 },
		{ id: 1002, uuid: "b-1002", title: "", parent: 1000, page: DISTSYS_20, level: 1 },
		{ id: 1003, uuid: "b-1003", title: "[[DISTSYS]]", parent: 1000, page: DISTSYS_20, level: 1 },
		{ id: 1010, uuid: "b-1010", title: "Raft - leader election + log replication", parent: 1003, page: DISTSYS_20, level: 2 },
		{ id: 1011, uuid: "b-1011", title: "leader sends heartbeats, follower timeout -> candidate", parent: 1010, page: DISTSYS_20, level: 3 },
		{ id: 1012, uuid: "b-1012", title: "IDONT GET why randomized timeouts fix split vote", parent: 1010, page: DISTSYS_20, level: 3 },
		{ id: 1013, uuid: "b-1013", title: "", parent: 1003, page: DISTSYS_20, level: 2 },
		{ id: 1004, uuid: "b-1004", title: "Risorse", parent: 1000, page: DISTSYS_20, level: 1 },
		{ id: 1020, uuid: "b-1020", title: "DISTSYS lecture 3 - consensus and Raft", parent: 1004, page: DISTSYS_20, level: 2, tags: [ASSET] },
		{
			id: 1021, uuid: "b-1021", parent: 1020, page: DISTSYS_20, level: 3, tags: [ANNOTATION], hlPage: 12, assetId: 1020,
			title: "A leader is elected for a term; at most one leader per term, and every log entry is replicated by the leader",
		},
		{ id: 1022, uuid: "b-1022", title: "so term is like a logical clock?? not so confident", parent: 1021, page: DISTSYS_20, level: 4 },
		{
			id: 1023, uuid: "b-1023", parent: 1020, page: DISTSYS_20, level: 3, tags: [ANNOTATION], hlPage: 14, assetId: 1020,
			title: "Followers that do not hear from a leader within the election timeout become candidates and start a new term",
		},
		{ id: 1024, uuid: "b-1024", title: "", parent: 1023, page: DISTSYS_20, level: 4 },
		{ id: 1025, uuid: "b-1025", title: "ok this is the part i get", parent: 1023, page: DISTSYS_20, level: 4 },

		// ── Nov 21st: a second lecture, plus unrelated noise on the same day ──
		{ id: 1101, uuid: "b-1101", title: "[[DISTSYS]]", parent: 1100, page: DISTSYS_21, level: 1 },
		{ id: 1102, uuid: "b-1102", title: "safety: committed entries never lost. bho how do they prove it", parent: 1101, page: DISTSYS_21, level: 2 },
		{ id: 1103, uuid: "b-1103", title: "Risorse", parent: 1100, page: DISTSYS_21, level: 1 },
		{ id: 1120, uuid: "b-1120", title: "DISTSYS lecture 4 - log compaction", parent: 1103, page: DISTSYS_21, level: 2, tags: [ASSET] },
		{
			id: 1121, uuid: "b-1121", parent: 1120, page: DISTSYS_21, level: 3, tags: [ANNOTATION], hlPage: 7, assetId: 1120,
			title: "Snapshotting discards log entries up to a point and stores the current system state, so the log does not grow without bound",
		},
		{ id: 1122, uuid: "b-1122", title: "why not just keep the log?? disk is cheap", parent: 1121, page: DISTSYS_21, level: 4 },
		{ id: 1104, uuid: "b-1104", title: "TCS excercise", parent: 1100, page: DISTSYS_21, level: 1 },

		// ── Nov 23rd: revision, with a link-only pointer back to a highlight ──
		{ id: 1201, uuid: "b-1201", title: "[[DISTSYS]] revision before exam", parent: 1200, page: DISTSYS_23, level: 1 },
		{
			id: 1202, uuid: "b-1202", parent: 1201, page: DISTSYS_23, level: 2,
			title: "[[A leader is elected for a term; at most one leader per term, and every log entry is replicated by the leader]]",
		},
		{ id: 1203, uuid: "b-1203", title: "redo the election timeout excercise", parent: 1201, page: DISTSYS_23, level: 2 },

		// ── An unrelated day, so a search cannot match the whole graph ────────
		{ id: 1301, uuid: "b-1301", title: "groceries + call the landlord", parent: 1300, page: OTHER, level: 1 },
	],
};

type ToolCall = { name: string; args: Record<string, unknown> };

/** Flat search hit, shaped exactly like the real server's `searchBlocks`. */
function hit(block: FakeBlock) {
	return {
		uuid: block.uuid,
		id: block.id,
		title: block.title,
		fullTitle: block.title,
		content: block.title,
		parent: block.parent,
		page: block.page,
		"page?": null,
		...(block.tags ? { tags: block.tags } : {}),
	};
}

/** Block entity, shaped like `getPage(<block uuid>)` on the real server. */
function entity(block: FakeBlock) {
	return {
		uuid: block.uuid,
		title: block.title,
		parent: { id: block.parent },
		page: { id: 0 },
		"collapsed?": false,
		...(block.hlPage === undefined ? {} : { "hl-page": block.hlPage, "ls-type": "annotation" }),
		...(block.assetId === undefined ? {} : { asset: { id: block.assetId } }),
	};
}

/**
 * Stands in for the real server's fuzzy search: blocks whose own text matches,
 * plus everything nested beneath a matching block (that is how the learner's
 * notes under a highlight come back). Asset blocks are included ONLY when they
 * match the term themselves, so a query that misses the slide deck's name
 * exercises the plugin's unknown-asset path.
 */
function search(seed: FakeSeed, term: string) {
	const needle = term.trim().toLowerCase();
	if (!needle) return [];
	const byId = new Map(seed.blocks.map(block => [block.id, block]));
	const direct = new Set(
		seed.blocks.filter(block => block.title.toLowerCase().includes(needle)).map(block => block.id),
	);
	const matched = new Set(direct);
	for (const block of seed.blocks) {
		for (let current = byId.get(block.parent); current; current = byId.get(current.parent)) {
			if (direct.has(current.id)) { matched.add(block.id); break; }
		}
	}
	return seed.blocks
		.filter(block => matched.has(block.id) && block.title.trim())
		.map(block => hit(block));
}

function handleTool(seed: FakeSeed, call: ToolCall) {
	if (call.name === "listPages") {
		return seed.pages.map(page => ({ title: page.title, uuid: page.uuid }));
	}
	if (call.name === "searchBlocks") {
		const blocks = search(seed, String(call.args.searchTerm ?? ""));
		return { blocks, "hasMore?": false, files: [] };
	}
	if (call.name === "getPage") {
		const name = String(call.args.pageName ?? "");
		const page = seed.pages.find(candidate => candidate.title.toLowerCase() === name.toLowerCase() || candidate.uuid === name);
		if (page) {
			// Only DIRECT children, exactly like the real server.
			const blocks = seed.blocks.filter(block => block.parent === page.containerId).map(block => ({
				uuid: block.uuid, id: block.id, title: block.title, level: 1, parent: { id: page.containerId },
			}));
			return { entity: { uuid: page.uuid, title: page.title, name: page.title.toLowerCase(), ...(page.journalDay ? { "journal-day": page.journalDay } : {}) }, blocks };
		}
		const block = seed.blocks.find(candidate => candidate.uuid === name);
		if (block) return { entity: entity(block), blocks: [] };
		return { error: `Page "${name}" not found` };
	}
	return undefined;
}

export type FakeServer = {
	url: string;
	/** Every tools/call the plugin made, in order. */
	calls: ToolCall[];
	close(): Promise<void>;
};

/**
 * @param options.token the bearer token the server accepts; any other value is 401.
 * @param options.seed  graph contents; defaults to SEED.
 */
export async function startFakeLogseqServer(options: { token: string; seed?: FakeSeed } = { token: "test-token" }): Promise<FakeServer> {
	const seed = options.seed ?? SEED;
	const calls: ToolCall[] = [];
	const server = http.createServer((request, response) => {
		const chunks: Buffer[] = [];
		request.on("data", chunk => chunks.push(chunk as Buffer));
		request.on("end", () => {
			const reply = (status: number, body?: unknown, headers: Record<string, string> = {}) => {
				response.writeHead(status, { "content-type": "application/json", ...headers });
				response.end(body === undefined ? "" : JSON.stringify(body));
			};
			if (request.method !== "POST") { reply(405, { error: "method not allowed" }); return; }
			if (request.headers.authorization !== `Bearer ${options.token}`) {
				reply(401, { statusCode: 401, error: "Unauthorized" });
				return;
			}
			let message: { id?: number; method?: string; params?: { name?: string; arguments?: Record<string, unknown> } };
			try { message = JSON.parse(Buffer.concat(chunks).toString("utf8")); }
			catch { reply(400, { error: "bad json" }); return; }
			if (message.method === "initialize") {
				reply(200, {
					jsonrpc: "2.0", id: message.id,
					result: { protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "fake-logseq", version: "0.0.0" } },
				}, { "mcp-session-id": "fake-session" });
				return;
			}
			if (message.method === "notifications/initialized") { reply(202); return; }
			if (message.method === "tools/call") {
				const name = String(message.params?.name ?? "");
				const args = message.params?.arguments ?? {};
				calls.push({ name, args });
				const result = handleTool(seed, { name, args });
				if (result === undefined) {
					reply(200, { jsonrpc: "2.0", id: message.id, result: { isError: true, content: [{ type: "text", text: `Unknown tool ${name}` }] } });
					return;
				}
				// The real server answers tools/call with JSON text content.
				reply(200, { jsonrpc: "2.0", id: message.id, result: { content: [{ type: "text", text: JSON.stringify(result) }] } });
				return;
			}
			reply(200, { jsonrpc: "2.0", id: message.id, error: { code: -32601, message: "method not found" } });
		});
	});
	await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
	const { port } = server.address() as AddressInfo;
	return {
		url: `http://127.0.0.1:${port}/mcp`,
		calls,
		close: () => new Promise<void>(resolve => server.close(() => resolve())),
	};
}
