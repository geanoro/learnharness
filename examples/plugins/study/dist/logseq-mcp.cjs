"use strict";
/**
 * Minimal MCP client over streamable HTTP, enough for `initialize` plus
 * `tools/call` against the Logseq app's local server. The plugin cannot reuse
 * @modelcontextprotocol/sdk: a no-build example package ships plain files and
 * must bundle its JavaScript dependencies, so the handful of calls we need are
 * written out here instead.
 *
 * READ-ONLY BY CONSTRUCTION: callTool refuses any tool name outside
 * READ_ONLY_TOOLS, so no code path in this plugin can reach upsertNodes or any
 * other write, whatever a caller passes in.
 */

const PROTOCOL_VERSION = "2025-06-18";
const READ_ONLY_TOOLS = Object.freeze(["searchBlocks", "getPage", "listPages"]);

/** Errors the learner can act on, with the token kept out of the message. */
class LogseqError extends Error {
	constructor(message, kind) {
		super(message);
		this.name = "LogseqError";
		this.kind = kind;
	}
}

/** A token must never reach a message, a log or an event payload. */
function scrub(text, token) {
	const value = String(text ?? "");
	if (!token) return value;
	return value.split(token).join("<token>");
}

function describeTransportFailure(error, url) {
	const code = error?.cause?.code ?? error?.code;
	if (code === "ECONNREFUSED" || code === "ECONNRESET" || code === "ENOTFOUND" || code === "EHOSTUNREACH") {
		return new LogseqError(`Could not reach the Logseq MCP server at ${url}. Open the Logseq app (the server only runs while it is open) and check the server URL in the plugin settings.`, "unreachable");
	}
	if (error?.name === "AbortError" || error?.name === "TimeoutError") {
		return new LogseqError(`The Logseq MCP server at ${url} did not answer in time. Check that the Logseq app is open and responsive.`, "timeout");
	}
	return new LogseqError(`Could not talk to the Logseq MCP server at ${url}: ${error instanceof Error ? error.message : String(error)}`, "unreachable");
}

/** One streamable-HTTP response body: either plain JSON or an SSE stream. */
function parseBody(contentType, text) {
	if (!text.trim()) return undefined;
	if (/text\/event-stream/i.test(contentType ?? "")) {
		// Take the last `data:` payload that parses as a JSON-RPC message.
		let last;
		for (const line of text.split(/\r?\n/)) {
			if (!line.startsWith("data:")) continue;
			const payload = line.slice(5).trim();
			if (!payload) continue;
			try { last = JSON.parse(payload); } catch { /* keep scanning: a partial frame is not an answer */ }
		}
		return last;
	}
	return JSON.parse(text);
}

/**
 * @param {{url: string, token: string, fetchImpl?: typeof fetch, timeoutMs?: number, signal?: AbortSignal}} options
 */
function createClient(options) {
	const url = String(options.url || "").trim();
	const token = String(options.token || "");
	const doFetch = options.fetchImpl ?? globalThis.fetch;
	const timeoutMs = options.timeoutMs ?? 10000;
	if (!url) throw new LogseqError("Set the Logseq MCP server URL in the plugin settings.", "not-configured");
	if (!token) throw new LogseqError("Set the Logseq MCP server token in the plugin settings.", "not-configured");
	if (typeof doFetch !== "function") throw new LogseqError("This runtime has no fetch available for the Logseq MCP server.", "unreachable");

	let sessionId;
	let nextId = 1;
	let initialized;

	async function send(message, { expectAnswer = true } = {}) {
		const headers = {
			"content-type": "application/json",
			accept: "application/json, text/event-stream",
			authorization: `Bearer ${token}`,
			"mcp-protocol-version": PROTOCOL_VERSION,
		};
		if (sessionId) headers["mcp-session-id"] = sessionId;
		const timer = AbortSignal.timeout ? AbortSignal.timeout(timeoutMs) : undefined;
		const signals = [options.signal, timer].filter(Boolean);
		// AbortSignal.any keeps the caller's cancellation AND the request timeout.
		const signal = signals.length > 1 && AbortSignal.any ? AbortSignal.any(signals) : signals[0];
		let response;
		try {
			response = await doFetch(url, { method: "POST", headers, body: JSON.stringify(message), ...(signal ? { signal } : {}) });
		} catch (error) {
			throw describeTransportFailure(error, url);
		}
		if (response.status === 401 || response.status === 403) {
			throw new LogseqError("The Logseq MCP server rejected the token. Copy a current token from the Logseq app into the plugin settings.", "unauthorized");
		}
		if (response.status === 404 && sessionId) {
			throw new LogseqError("The Logseq MCP session expired. Try again; if it repeats, restart the Logseq app.", "session-expired");
		}
		const headerSession = response.headers?.get?.("mcp-session-id");
		if (headerSession) sessionId = headerSession;
		const text = await response.text().catch(() => "");
		if (!response.ok) {
			throw new LogseqError(`The Logseq MCP server answered ${response.status}: ${scrub(text, token).slice(0, 300) || "no details"}`, "server-error");
		}
		if (!expectAnswer) return undefined;
		let parsed;
		try {
			parsed = parseBody(response.headers?.get?.("content-type"), text);
		} catch {
			throw new LogseqError("The Logseq MCP server sent a reply this client could not read.", "server-error");
		}
		if (!parsed) throw new LogseqError("The Logseq MCP server sent an empty reply.", "server-error");
		if (parsed.error) {
			throw new LogseqError(`Logseq refused the request: ${scrub(parsed.error.message ?? "unknown error", token)}`, "server-error");
		}
		return parsed.result;
	}

	async function initialize() {
		initialized ??= (async () => {
			await send({
				jsonrpc: "2.0", id: nextId++, method: "initialize",
				params: {
					protocolVersion: PROTOCOL_VERSION,
					capabilities: {},
					clientInfo: { name: "learnharness-logseq-notes", version: "1.0.0" },
				},
			});
			// A server that ignores the notification is still usable; a transport
			// failure here would resurface on the first real call anyway.
			await send({ jsonrpc: "2.0", method: "notifications/initialized" }, { expectAnswer: false }).catch(() => {});
		})();
		try {
			await initialized;
		} catch (error) {
			initialized = undefined; // let a later call retry after the learner fixes the token
			throw error;
		}
	}

	/** Call one READ-ONLY Logseq tool and return its parsed JSON content. */
	async function callTool(name, args) {
		if (!READ_ONLY_TOOLS.includes(name)) {
			throw new LogseqError(`This plugin is read-only and never calls ${name}.`, "refused");
		}
		await initialize();
		const result = await send({ jsonrpc: "2.0", id: nextId++, method: "tools/call", params: { name, arguments: args ?? {} } });
		if (result?.isError) {
			const detail = (result.content ?? []).map(part => part?.text).filter(Boolean).join(" ").slice(0, 300);
			throw new LogseqError(`Logseq could not answer ${name}: ${scrub(detail || "no details", token)}`, "tool-error");
		}
		if (result && result.structuredContent !== undefined) return result.structuredContent;
		const texts = (result?.content ?? []).filter(part => part?.type === "text").map(part => part.text);
		if (!texts.length) return undefined;
		const joined = texts.join("");
		try { return JSON.parse(joined); } catch { return joined; }
	}

	return { callTool, get sessionId() { return sessionId; } };
}

module.exports = { createClient, LogseqError, scrub, READ_ONLY_TOOLS, PROTOCOL_VERSION };
