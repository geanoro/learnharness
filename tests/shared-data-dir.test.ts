/** Feynman Harness ↔ installed LearnHarness data sharing (owner, 2026-11-24):
 * electron/shared-data-dir.cjs decides what DATA_DIR() in electron/main.cjs
 * resolves to. Never touches the real ~/Library/Application Support — every
 * case below uses a fresh temp directory as the stand-in userData. */
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";

const { resolveSharedDataDir, CONFIG_FILE } = createRequire(import.meta.url)("../electron/shared-data-dir.cjs");

function tmpUserDataDir() {
	return fs.mkdtempSync(path.join(os.tmpdir(), "feynman-harness-userdata-"));
}

describe("resolveSharedDataDir", () => {
	it("returns null when nothing is configured, so the caller falls back to its own data/", () => {
		const userDataDir = tmpUserDataDir();
		assert.equal(resolveSharedDataDir({ env: {}, userDataDir }), null);
	});

	it("prefers the LH_SHARED_DATA_DIR env var over any config file", () => {
		const userDataDir = tmpUserDataDir();
		fs.writeFileSync(path.join(userDataDir, CONFIG_FILE), JSON.stringify({ path: "/from/config/data" }));
		const shared = "/from/env/data";
		assert.equal(resolveSharedDataDir({ env: { LH_SHARED_DATA_DIR: shared }, userDataDir }), shared);
	});

	it("falls back to the config file's path field when no env var is set", () => {
		const userDataDir = tmpUserDataDir();
		const shared = path.join(tmpUserDataDir(), "data");
		fs.writeFileSync(path.join(userDataDir, CONFIG_FILE), JSON.stringify({ path: shared }));
		assert.equal(resolveSharedDataDir({ env: {}, userDataDir }), shared);
	});

	it("ignores a blank env var and falls through to the config file", () => {
		const userDataDir = tmpUserDataDir();
		const shared = "/from/config/data";
		fs.writeFileSync(path.join(userDataDir, CONFIG_FILE), JSON.stringify({ path: shared }));
		assert.equal(resolveSharedDataDir({ env: { LH_SHARED_DATA_DIR: "" }, userDataDir }), shared);
	});

	it("falls back to null on a missing config file", () => {
		const userDataDir = tmpUserDataDir();
		assert.equal(resolveSharedDataDir({ env: {}, userDataDir: path.join(userDataDir, "absent") }), null);
	});

	it("falls back to null on invalid JSON", () => {
		const userDataDir = tmpUserDataDir();
		fs.writeFileSync(path.join(userDataDir, CONFIG_FILE), "{not json");
		assert.equal(resolveSharedDataDir({ env: {}, userDataDir }), null);
	});

	it("falls back to null when the config file's path field is missing or not a string", () => {
		const userDataDir = tmpUserDataDir();
		fs.writeFileSync(path.join(userDataDir, CONFIG_FILE), JSON.stringify({ path: 42 }));
		assert.equal(resolveSharedDataDir({ env: {}, userDataDir }), null);
	});

	it("rejects relative and ~ paths from env and config, logging why, instead of passing them on", () => {
		const userDataDir = tmpUserDataDir();
		const logs: string[] = [];
		const log = (m: string) => logs.push(m);
		assert.equal(resolveSharedDataDir({ env: { LH_SHARED_DATA_DIR: "~/data" }, userDataDir, log }), null);
		assert.equal(resolveSharedDataDir({ env: { LH_SHARED_DATA_DIR: "rel/data" }, userDataDir, log }), null);
		fs.writeFileSync(path.join(userDataDir, CONFIG_FILE), JSON.stringify({ path: "../data" }));
		assert.equal(resolveSharedDataDir({ env: {}, userDataDir, log }), null);
		assert.equal(logs.length, 3);
	});
});
