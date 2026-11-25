"use strict";
/**
 * Which phase a teaching session is in, folded from the native record.
 *
 * WHY THE PLUGIN COMPUTES THIS AT ALL. The learner asked for the librarian's
 * full instructions only while probing and planning, a one-line pointer once
 * teaching starts, and nothing at all otherwise. `PluginToolContext` carries
 * only `{chatId, agent}` — no phase — and the agent kind cannot stand in for
 * it, because the TEACHER does the planning as well as the teaching.
 *
 * WHY NOT `ctx.learning.listSessions()`. Its rows do carry a phase, but it is
 * implemented as `listChats()`, which reads and parses EVERY chat file on disk
 * (`src/store/chats.ts:81`). Paying that on every turn is exactly what commit
 * 43365927 ("read settings and coverage without the transcript") removed from
 * the host. `ctx.learning.getSession(chatId)` reads one file instead.
 *
 * THIS IS A COPY, with the drift risk a copy carries. The rule is the host's,
 * from `src/core/phases.ts:148` (`phaseAt3Lh`) and `probeDoneResultIds`
 * (`src/core/native-messages.ts:899`):
 *
 *   - probe: until a `probe_done` call has a clean, non-`ok:false` tool result.
 *   - plan:  until the first nodeId-tagged teaching question CALL.
 *   - teach: from that call onward, without waiting for its answer.
 *
 * It degrades in one direction only. The host also flips on a plugin-posed
 * teach question read through its private annotation API, which a plugin cannot
 * read; this fold instead matches teaching question calls BY TOOL NAME, so it
 * knows the native `quiz`/`explain` and this plugin's own box. Another plugin's
 * question type would be missed, leaving the session in `plan` — fuller
 * instructions than needed, never wrong ones.
 */

/** Native teaching question calls this fold can recognise by name. */
const TEACH_QUESTION_TOOLS = Object.freeze(["quiz", "explain"]);

const tagged = input => typeof input === "object" && input !== null
	&& typeof input.nodeId === "string" && input.nodeId.length > 0;

/** `probe_done` results that actually concluded, by result message id. */
function probeDoneResultIds(messages) {
	const calls = new Set();
	const results = new Set();
	for (const message of messages) {
		if (message?.role === "assistant") {
			if (message.stopReason === "error" || message.stopReason === "aborted") continue;
			for (const block of message.content ?? []) {
				if (block?.type === "toolCall" && block.name === "probe_done") calls.add(block.id);
			}
		} else if (
			message?.role === "toolResult" && message.toolName === "probe_done"
			&& calls.has(message.toolCallId) && !message.isError
			&& (message.details === null || message.details === undefined || message.details.ok !== false)
		) {
			results.add(message.id);
		}
	}
	return results;
}

/**
 * @param {readonly object[]} messages a native record's `messages`
 * @param {readonly string[]} [extraQuestionTools] this plugin's own teach tools
 * @returns {"probe" | "plan" | "teach"}
 */
function phaseOf(messages, extraQuestionTools) {
	const list = Array.isArray(messages) ? messages : [];
	const names = new Set([...TEACH_QUESTION_TOOLS, ...(extraQuestionTools ?? [])]);
	const concluded = probeDoneResultIds(list);
	let phase = "probe";
	for (const message of list) {
		if (message?.role === "toolResult") {
			if (phase === "probe" && concluded.has(message.id)) phase = "plan";
		} else if (message?.role === "assistant" && phase === "plan") {
			for (const block of message.content ?? []) {
				if (block?.type === "toolCall" && names.has(block.name) && tagged(block.arguments)) { phase = "teach"; break; }
			}
		}
	}
	return phase;
}

module.exports = { TEACH_QUESTION_TOOLS, phaseOf, probeDoneResultIds };
