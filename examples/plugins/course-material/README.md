# Course material example

A course keeps forgetting where its slides are, and every session starts by
retyping a path. This plugin remembers the folder, and lets the learner say —
per session, in the UI, not in prose the teacher has to guess at — which course
today is about and which decks to teach from.

## How it works

1. **Once per course.** In **Settings → Community plugins → Course material**,
   add a course: a name, and the folder its slide PDFs live in. On the desktop
   app **Choose folder…** opens the same Finder dialog as the composer's
   paperclip, so the path is never typed. Name the course exactly as its
   `[[COURSE]]` block is named in your notes, so the two line up.
2. **Once per session.** In a teaching or practice session, the **Course
   material** button in the top bar opens a box: pick today's course, tick the
   decks to use — today's lecture, say — and press **Use these decks**. Tick
   nothing and the whole course is in scope. The button appears once the session
   does, so the teacher's opening turn usually finds nothing picked yet and asks
   you to pick — once you have, it looks again by itself on its next turn. You do
   not have to announce it.
3. **The teacher reads what was ticked.** At the start of the session it asks
   the plugin once what is selected, then sends one background PDF job per
   ticked deck. Not one per fact: that is the slow, expensive mistake this
   avoids.
4. **It teaches from those pages, and says which ones.** Every claim it takes
   from the slides comes back cited as deck plus page ("lecture-04.pdf, p. 12"),
   and it never cites a page it did not actually read. The moment it goes beyond
   the slides — background they assume, a step they skip, its own example, a
   correction — it says so in the same breath.
5. **Later steps get one more look.** When the lesson reaches a plan step the
   first briefs do not cover, the teacher may send one more targeted job for
   that step. One per step at most. If what it needs is in a deck you did not
   tick, it asks you to add it with the same button rather than reaching for it
   itself.

Nothing is selected until you select it, and with no course configured the
plugin contributes nothing at all — no instructions, no tool — so installing it
does not change a single prompt until it is used.

## Installing

Copy this directory into the plugins directory shown in **Settings → Community
plugins**, keeping the `course-material/` folder and its required
`dist/manifest.json`. No build is needed. Refresh and enable **Course
material**.

The settings page is the app's own File-access folder list, shape for shape: an
add line, then one line per course with its resolved path, its PDF count and a
Remove. Adding is refused for a relative path, a missing folder, a duplicate
name or a file that is not a directory.

**Choosing the folder** goes through `window.lh.chooseAttachmentFolder`, the
bridge the desktop app exposes to its own page for the composer's Folder
picker. That bridge is not part of the documented plugin API, so it may change;
and it does not exist in the browser or the dev preview at all. Where it is
missing the settings page falls back to a typed absolute path (or `~/folder`)
and says so.

**PowerPoint** is not readable anywhere in LearnHarness. A `.pptx` deck has to
be exported to PDF first; the settings hint, the picker and the tool all say so
rather than failing quietly.

**Logseq** is a separate plugin's job — nothing here reads a Logseq graph. The
only thing that links them is the course name: keep it identical to the
`[[COURSE]]` block in your notes.

## How a session is bound to a course

The binding is per chat, and explicit. The picker's action context carries the
session id, which is the same chat id the backend's per-turn tool factory
receives, so what is ticked in that box is exactly what the tool reports for
that session — and only that session. Another chat is unaffected.

That per-turn factory is also the reason nothing is contributed through
`registerInstructions`: it takes one static text the host composes into every
matching turn, so it can neither name a per-session choice nor stay out of the
sessions that made none. Everything the agent is told therefore travels with the
tool. Nothing is inferred from the session title; if nothing is selected, the
teacher says so and asks, rather than guessing a folder.

## What it adds to a turn

With at least one course configured, each prober/teacher/practice turn gets one
tool, `course_material`, and nothing else — no system-prompt text at all. The
tool reports this session's selection and lists those decks as absolute paths
(recursive, hidden folders skipped, 4 levels and 200 files at most, and the
reply itself capped — see below). It lists; it never reads: reading and citing
remain the native `pdf` job's work, unchanged. Its description carries the
grounding rules — ask once, slides first, one `pdf` job per ticked deck, at most
one extra targeted job per later plan step, cite deck plus page, never cite an
unread page, say when going beyond them — and carries them only in a session
that picked a course.

## What it costs in context

Nothing goes into the system prompt. `registerInstructions` takes one static
text that the host composes into **every** matching turn, so a rule about a
course would be charged to sessions that have nothing to do with one. The only
per-turn surface the plugin API offers is `registerTools`, whose factory
receives that turn's frozen `{chatId, agent}` — so the rules live in the tool's
description, sized to what the session actually selected.

Measured with the app's own system-prompt estimator convention, `chars / 4`
(`src/server/chat-handler.ts:367`):

| the session | per prober/teacher/practice turn |
| --- | --- |
| no course configured at all | **0 tokens** — nothing is registered |
| a course exists, this session picked none | **≈127 tokens** — one line saying the picker exists |
| this session picked a course | **≈294 tokens** — the grounding rules, where they apply |

And per call, once per session:

| | tokens |
| --- | --- |
| `course_material`, 2 ticked decks | ≈133 |
| `course_material`, whole 12-deck course | ≈584 |
| `course_material`, pathological 200-deck folder | ≈2,091, hard-capped |

Calls a normal lesson adds: **one** `course_material` (a second only when you
pick after the session has already started — the picker needs the session to
exist, so the first call often finds nothing and the tool asks to be called once
more), then **one** `pdf` job per ticked deck, plus at most one more targeted job per later plan step that the first
briefs do not cover. Nothing is per fact, and the per-turn cost does not grow
with the number of decks.

Three things keep it there. Folder paths are never in the turn — only course
names are; the tool supplies paths once, on request, so a deeply nested course
folder costs nothing per turn. The text states only what the host's own doctrine
does not already say (it does not re-explain that PDFs go through the `pdf` job,
or that jobs are fire-and-forget). And one tool reply is bounded to 60 rows or
8,000 characters, whichever comes first, over a walk already capped at 200
files; past that it says how many it left out and asks the learner to tick
today's decks instead.

For reference, the first version of this plugin put a static block in every
turn at ≈714 tokens, whether or not the session had anything to do with a
course, and an uncapped 200-deck folder returned ≈11,707 tokens in one call.

`tests/plugin-course-material-integration.test.ts` pins all of this: a session
with no course selected is asserted to carry no rules, and one tool reply is
asserted to stay bounded however many decks the folder holds.

Reading still goes through the app's own file access. If **Settings → Agent**
restricts it to listed folders, the course folder has to be listed there too —
this plugin does not widen that gate, and the settings page says so.

No code execution, no new question or problem type, no learning-data writes,
nothing in the knowledge graph. The plugin's own state is two files in its
`data/` directory — `courses.json` and `sessions.json`, each carrying its own
`"version": 1`, refused rather than reinterpreted when newer. Preserve sibling
`course-material/data/` when replacing `dist/`, and never distribute that data
or place it in `dist/data/`.

Disabling removes the tool from future turns and leaves
existing transcripts alone.

Off-network coverage: `tests/plugin-course-material-integration.test.ts` loads
this actual external CommonJS backend, drives its settings and session
operations, builds the real native teacher agent with it enabled, asserts the
composed prompt and the per-turn tool loadout for all three agent kinds, and
checks that a ticked deck is reported while an unticked one is not. It also
mounts this frontend against a stub host to check that the desktop build chooses
the folder through the native dialog, that the browser build falls back to a
typed path, and that the session picker is placed in the top bar. This is not a
claim of real-provider or human functional acceptance of the teaching behavior
itself.
