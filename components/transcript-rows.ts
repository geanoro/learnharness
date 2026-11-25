import type { LhViewMessage } from "@/src/core";

export function isSubagentSteer(message: LhViewMessage): boolean {
	return (message.metadata as { subagentResult?: unknown } | undefined)?.subagentResult != null;
}

/** Keep the latest learner turn and any live tail fully laid out. Background
 * deliveries and aborts carry teacher-facing text, not a new learner turn. */
export function newestLearnerTurnFrom(messages: readonly LhViewMessage[]): number {
	return messages.findLastIndex((message) => message.role === "user" && !isSubagentSteer(message)
		&& message.parts.some((part) => part.type === "text" || part.type === "image"));
}

/** Containment INSIDE a message group, not at the group level.
 *
 * `projectView` merges consecutive native messages into ONE view row, so a
 * 237-message teaching session projects to 17 rows and the group-level
 * marker is all-or-nothing over rows tens of thousands of pixels tall.
 * Measured on that session: the two largest groups are 18,360 px and
 * 25,895 px of a 63,217 px transcript and BOTH sit after the newest learner
 * turn (row 9 of 17), so `newestLearnerTurnFrom` leaves 82% of the height
 * uncontained. Applied per part instead, containment reaches all of it.
 *
 * The live tail keeps the group rule's intent: what is being written right
 * now stays fully laid out, so the last row's parts are never contained
 * while a turn runs. At rest every part may be contained — the ones on
 * screen are relevant to the user and render anyway. */
export function olderPartsFrom(messageCount: number, busy: boolean): number {
	return busy ? Math.max(0, messageCount - 1) : Math.max(0, messageCount);
}
