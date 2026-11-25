import assert from "node:assert/strict";
import test, { after } from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "lh-session-record-views-"));
process.env.LH_DATA_DIR = scratch;
process.env.LH_AUTH_FILE = path.join(scratch, "empty-auth.json");
fs.writeFileSync(process.env.LH_AUTH_FILE, "{}", { mode: 0o600 });
const { chatStore } = await import("../src/store/chats.ts");
const { GET } = await import("../app/api/chats/[id]/route.ts");
const { sessionCoverage } = await import("../src/server/chats.ts");
after(() => fs.rmSync(scratch, { recursive: true, force: true }));

/**
 * THE NARROW SESSION READS (session-switch cost, 2026-11-25). Switching
 * sessions is a client-side navigation: the RSC payload already carries the
 * transcript. Every surface that needs only a field OF the record must say
 * so with `?view=`, because the full projection costs one transcript per
 * reader — on a 237-message session that was 468 KB each, and two readers
 * (the model control and the coverage ring) paid it on every switch.
 *
 * `view=stats` set the precedent (perf(chat): omit transcript from session
 * stats refreshes). These views are the same bargain for `settings` and
 * `coverage`: no transcript, no plugin-availability reconciliation, and the
 * same missing-session contract as the full read.
 */

/** A record big enough that a transcript leak is unmistakable. */
function fixture(title: string) {
	const record = chatStore.createChat(title);
	chatStore.saveMessages(record.id, Array.from({ length: 40 }, (_, i) => ({
		id: `msg-${i}`,
		role: "user" as const,
		content: [{ type: "text" as const, text: `transcript body ${i} `.repeat(40) }],
		timestamp: i + 1,
	})));
	return record.id;
}

const call = (id: string, query = "") =>
	GET(new Request(`http://localhost/api/chats/${id}${query}`), { params: Promise.resolve({ id }) });

test("the settings view serves the session's own model pin and no transcript", async () => {
	const id = fixture("settings view fixture");
	const settings = { model: { provider: "claude-code", id: "opus" }, thinkingLevel: "medium" as const };
	chatStore.saveSettings(id, settings);

	const response = await call(id, "?view=settings");
	assert.equal(response.status, 200);
	const body = await response.json();
	assert.deepEqual(body, { settings }, "the settings view carries the settings field alone");

	// The guarantee that matters for the switch cost: no transcript, at any
	// key. A future projection that re-adds messages here must fail.
	const serialized = JSON.stringify(body);
	assert.ok(!("messages" in body), "the settings view must not carry messages");
	assert.ok(!serialized.includes("transcript body"), "no transcript text may ride the settings view");
	assert.ok(serialized.length < 512, `the settings view must stay small, got ${serialized.length} bytes`);

	// It still agrees with the full read, so the control shows the same pin.
	const full = await (await call(id)).json();
	assert.deepEqual(body.settings, full.settings);
});

test("a legacy session with no settings reads as an absent pin, not a failure", async () => {
	const id = fixture("legacy settings fixture");
	const response = await call(id, "?view=settings");
	assert.equal(response.status, 200);
	assert.deepEqual(await response.json(), {}, "an unstamped session answers with no settings key");
});

test("the coverage view serves the ring's block and no transcript", async () => {
	const id = fixture("coverage view fixture");

	const response = await call(id, "?view=coverage");
	assert.equal(response.status, 200);
	const body = await response.json();
	assert.deepEqual(body, { coverage: sessionCoverage(id) }, "the coverage view carries the coverage block alone");

	const serialized = JSON.stringify(body);
	assert.ok(!("messages" in body), "the coverage view must not carry messages");
	assert.ok(!serialized.includes("transcript body"), "no transcript text may ride the coverage view");

	// Same derivation the full read reports, so the two surfaces agree.
	const full = await (await call(id)).json();
	assert.deepEqual(body.coverage, full.coverage);
});

test("the narrow views keep the missing-session contract", async () => {
	for (const view of ["?view=settings", "?view=coverage"]) {
		const response = await call("missing-session", view);
		assert.equal(response.status, 404, `${view} must 404 on an unknown session`);
		assert.deepEqual(await response.json(), { error: "Not found" }, `${view} 404 body`);
	}
});
