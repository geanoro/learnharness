# Feynman coach checkpoint example

A dedicated explain-back question box, built via `registerQuestionType` +
`registerQuestionRenderer` (`docs/plugin-question-contract.md`): when a plan node
closes, the teacher poses it, the learner answers in plain words plus a confidence
pick on its own confidence bar, and the teacher reads the saved answer back.

Copy this directory into the plugins directory shown in **Settings → Community
plugins**, keeping the `feynman-coach/` folder and its required `dist/manifest.json`.
No build is needed. Refresh and enable **Feynman coach checkpoint**.

In a teacher session, once a plan node closes (the teacher moves to the next node,
or ends the session), the teacher asks in ordinary prose whether the learner wants
to try the explain-back, or skip it. If so, it poses `feynman_explain` for that
node: a box with a text field (3-5 lines by default, one sentence in "short" mode
— used when the node was small or every check on it landed on the first try) and
a six-stop confidence bar (0/30/50/70/90/100, same ramp and colors as the native
quiz confidence rail) the learner picks from, visually consistent with but
independent of that core component — the plugin SDK does not expose the core
component itself. A gap in the explanation gets exactly one named pointer back to
the node (never the answer) in ordinary prose, then the teacher re-poses the same
box for a retry; at most two such rounds before the teacher gives the correct
version itself in prose.

The teacher never announces, names, or narrates this checkpoint as a method — only
the box itself (its label, its presence) is a visible, dedicated UI element; the
teacher's own words around it stay ordinary teaching prose. The teacher keeps full
control of pacing: it decides whether and when to pose the box, and nothing forces
it to fire.

No core edits, no new native tool beyond the one `registerQuestionType` builds
(`feynman_explain`), no persisted format or schema version change, no learning-data
writes. The saved answer (`explanation`, `confidence`) lives in the ordinary native
plugin-question answer envelope, not in the knowledge graph: the existing extraction
pipeline reads only the teacher's own prose, never a learner's saved answer
(`docs/architecture.md`).

Off-network coverage: `tests/plugin-feynman-coach-integration.test.ts` loads this
actual external CommonJS backend, builds the real native teacher agent with it
enabled, and asserts both the composed system prompt and the posed `feynman_explain`
native tool/question-type registration. It also exercises the question/answer
schemas directly (accept/reject cases, including the confidence enum and the
whitespace-only-explanation refinement). This is not a claim of real-provider or
human functional acceptance of the teaching behavior or frontend rendering itself.
