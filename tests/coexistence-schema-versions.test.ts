/** Guard for Feynman Harness ↔ installed LearnHarness v0.6.1 data sharing
 * (owner, 2026-11-24): the two apps share one data/ folder (see
 * electron/shared-data-dir.cjs), so a schema bump on this side is not a local
 * decision — it is read by whichever app opens that folder next. Per
 * data/lh-feynman-scout/report.md §4, the installed v0.6.1 app HIDES records
 * bumping any of these three constants rather than erroring loudly: chats
 * newer than CURRENT_CHAT_VERSION silently disappear from its sidebar, and
 * unrecognized fields inside an EXISTING settings section (e.g. `agent`) are
 * dropped on the installed app's next unrelated save. (A graph-format bump
 * instead throws loudly — still broken, just not silent.) This test pins the
 * three constants to the confirmed-matching v0.6.1 values; bumping any of
 * them is a conscious, reviewed decision about breaking that cross-app
 * sharing, not an incidental one. A pure additive change (a new field, a new
 * top-level settings section) never requires a bump and does not trip this
 * guard. */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { CURRENT_CHAT_VERSION } from "../src/core/contracts/chat.ts";
import { CURRENT_GRAPH_FORMAT_VERSION } from "../src/core/contracts/graph.ts";
import { CURRENT_SETTINGS_VERSION } from "../src/core/settings.ts";

describe("schema-version constants stay pinned to the installed LearnHarness v0.6.1 values", () => {
	it("CURRENT_CHAT_VERSION", () => {
		assert.equal(CURRENT_CHAT_VERSION, 2, "bumping this hides shared chats from the installed v0.6.1 app's sidebar — see this file's header comment");
	});

	it("CURRENT_GRAPH_FORMAT_VERSION", () => {
		assert.equal(CURRENT_GRAPH_FORMAT_VERSION, 1, "bumping this makes every graph read in the installed v0.6.1 app throw — see this file's header comment");
	});

	it("CURRENT_SETTINGS_VERSION", () => {
		assert.equal(CURRENT_SETTINGS_VERSION, 1, "bumping this is read by the installed v0.6.1 app's settings sanitizer — see this file's header comment");
	});
});
