"use strict";
/** Shared-data override for this fork's coexistence with a separately
 * installed LearnHarness (owner, 2026-11-24): the packaged shell's DATA_DIR()
 * prefers an explicitly configured path over its own per-app default, so the
 * two apps can share one data/ folder (chats/graph/settings/jobs/plugins)
 * without sharing userData, auth.json, credentials, or logs. No symlink, no
 * code path inside config.ts/the stores changes — this only decides what
 * LH_DATA_DIR the Electron shell hands its server child. Documented in
 * docs/getting-started.md#data-privacy-and-usage. */
const fs = require("node:fs");
const path = require("node:path");

/** Lives inside THIS app's own userData, never the shared target. */
const CONFIG_FILE = "shared-data-dir.json";

/** Resolution order: the LH_SHARED_DATA_DIR env var, then this app's own
 * <userData>/shared-data-dir.json `{ "path": "..." }`, else null (caller
 * falls back to its per-app default). Either source names the OTHER app's
 * data/ folder directly, not its userData root. */
function resolveSharedDataDir({ env, userDataDir }) {
	if (typeof env.LH_SHARED_DATA_DIR === "string" && env.LH_SHARED_DATA_DIR.trim()) {
		return env.LH_SHARED_DATA_DIR;
	}
	try {
		const parsed = JSON.parse(fs.readFileSync(path.join(userDataDir, CONFIG_FILE), "utf8"));
		if (typeof parsed?.path === "string" && parsed.path.trim()) return parsed.path;
	} catch {
		/* absent, unreadable, or invalid config file — fall back to the per-app default */
	}
	return null;
}

module.exports = { CONFIG_FILE, resolveSharedDataDir };
