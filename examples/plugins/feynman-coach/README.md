# Feynman coach checkpoint example

A deliberately small focused recipe: additive teacher instructions only, no tools,
no new question type, no backend storage. It adds one behavior on top of the
teacher's existing per-step `quiz`/`explain` checks: when a plan node closes, the
teacher asks the learner to explain the whole node back in plain words.

Copy this directory into the plugins directory shown in **Settings → Community
plugins**, keeping the `feynman-coach/` folder and its required `dist/manifest.json`.
No build is needed. Refresh and enable **Feynman coach checkpoint**.

In a teacher session, once a plan node closes (the teacher moves to the next node,
or ends the session), the teacher now asks for a short explain-back in the
learner's own words, without the terms it just introduced — full length (3-5
lines) by default, collapsing to one sentence when the node was small or every
check on it landed on the first try. The learner can always skip it. A gap in the
explanation gets exactly one named pointer back to the node (never the answer),
one retry, and at most two such rounds before the teacher gives the correct
version itself.

This is ordinary conversational text, not a tool call and not a labeled ritual:
the teacher is not instructed to announce the checkpoint, name a method, or mark
it as a distinct segment — doing so is a doctrine violation this plugin does not
introduce or excuse. The teacher keeps full control of pacing; this plugin cannot
force the checkpoint to fire.

No code execution, no new tools, no question type, no learning-data writes. The
learner's explain-back text is ordinary transcript prose; it is not written to the
knowledge graph by this plugin, and the existing extraction pipeline already reads
only the teacher's own prose, not the learner's answers (`docs/architecture.md`).

Off-network coverage: `tests/plugin-feynman-coach-integration.test.ts` loads this
actual external CommonJS backend, builds the real native teacher agent with it
enabled, and asserts the composed system prompt contains this plugin's
instructions. This is not a claim of real-provider or human functional
acceptance of the teaching behavior itself.
