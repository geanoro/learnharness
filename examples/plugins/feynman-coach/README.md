# Feynman coach checkpoint example

A dedicated explain-back question box, built via `registerQuestionType` +
`registerQuestionRenderer` (`docs/plugin-question-contract.md`): when a plan node
closes, the teacher poses it, the learner answers in plain words plus a confidence
pick on its own confidence bar, and the teacher reads the saved answer back.

Copy this directory into the plugins directory shown in **Settings → Community
plugins**, keeping the `feynman-coach/` folder and its required `dist/manifest.json`.
No build is needed. Refresh and enable **Feynman coach checkpoint**.

In a teacher session, a plan node closes when the teacher moves to a different node,
or the session ends; nodes are never marked finished, so returning to a node you'd
already closed (a detour, a rewritten plan, a correction) makes that earlier close
tentative — the next move-on from it is a fresh close, and the offer can fire again.
At every close, the teacher asks in ordinary prose whether the learner wants to try
the explain-back, or skip it. If so, it poses `feynman_explain` for that node: a box
with a text field (3-5 lines by default, one sentence in "short" mode — used when the
node was small or every check on it landed on the first try), an "I don't know" button,
and a six-stop confidence bar (0/30/50/70/90/100, same ramp and colors as the native
quiz confidence rail) the learner picks from. The editor (`dist/main.js`) reuses
the host's own global CSS: the "Your answer" field, the "I don't know" row, and the
confidence row/rail/slider/value markup are built with the exact same Tailwind utility
classNames as `components/question-dock.tsx`'s native quiz card and
`components/answered-card.tsx`'s saved confidence record — those classes are already
compiled into the app's stylesheet from the host's own usage, so the box picks up the
identical look without restyling from scratch or importing the (core-internal, non-SDK)
component itself.

The teacher grades the saved explanation strictly against the node — never right to be
kind — and reads confidence alongside the verdict: a confident explanation with a gap is
exactly the case that must not be waved through as a small tightening. A gap gets exactly
one named pointer back to the node (never the answer) in ordinary prose, then the teacher
re-poses the same box for a retry; at most two such rounds before the teacher gives the
correct version itself in prose. Picking "I don't know" is a genuine decline, not a wrong
answer and not a retry occasion: the teacher skips straight to giving the explanation
itself, without spending a retry on it.

The teacher never announces, names, or narrates this checkpoint as a method — only
the box itself (its label, its presence) is a visible, dedicated UI element; the
teacher's own words around it stay ordinary teaching prose. The teacher keeps full
control of pacing: it decides whether and when to pose the box, and nothing forces
it to fire.

No core edits, no new native tool beyond the one `registerQuestionType` builds
(`feynman_explain`), no persisted format or schema version change, no learning-data
writes. The saved answer (`explanation`+`confidence`, or `dontKnow: true`) lives in
the ordinary native plugin-question answer envelope, not in the knowledge graph: the
existing extraction pipeline reads only the teacher's own prose, never a learner's
saved answer (`docs/architecture.md`).

Off-network coverage: `tests/plugin-feynman-coach-integration.test.ts` loads this
actual external CommonJS backend, builds the real native teacher agent with it
enabled, and asserts both the composed system prompt and the posed `feynman_explain`
native tool/question-type registration. It also exercises the question/answer
schemas directly (accept/reject cases, including the confidence enum, the
whitespace-only-explanation refinement, and the `dontKnow` branch), and drives a
scripted teacher turn through a confident-but-gapped explanation to confirm the
retry pose actually fires. Its system-prompt assertions are a minimal wiring check
only: they show the instruction text reaches the composed prompt, not that a live
model grades differently. `tests/plugin-feynman-coach-frontend.test.tsx` mounts
`dist/main.js`'s real editor and answered view (publish/dispose, the "I don't know"
toggle and its draft retention, both render paths) and renders the real native
`QuestionDock` and `AnsweredCard` side by side with them, comparing the class sets
and rail paint each actually produced (never reading source text), so a core restyle
fails this test instead of silently drifting. This is not a claim of real-provider or human functional
acceptance of the teaching behavior.
