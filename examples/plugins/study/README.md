# Study

One plugin for the whole study loop, instead of three that each wanted their own
settings page and their own copy of the course list:

- **the explain-back checkpoint** — when a plan node closes, the teacher offers a
  box where the learner explains the node back in plain words, with its own
  confidence bar (merged from the `feynman-coach` example),
- **the course slides, behind a librarian** — one tool is the only door to the
  slides, and it answers with the deck's own text and a page number rather than a
  summary (merged from the `course-material` example),
- **the learner's own Logseq notes** — what they highlighted, rephrased and said
  they were unsure about, as teacher context.

## Installing

Copy this directory into the plugins directory shown in **Settings → Community
plugins**, keeping the `study/` folder and its required `dist/manifest.json`. No
build is needed. Refresh and enable **Study**.

`dist/` ships plain files: `main.js` (every frontend surface, in one file because
only `manifest.main` and `manifest.styles` are served — a sibling import would
404), `backend.cjs`, and four backend-only modules it requires — `librarian.cjs`,
`phase.cjs`, `logseq.cjs`, `logseq-mcp.cjs`, `logseq-notes.cjs`. Those are never
publicly served: the asset route allowlists only the declared frontend entries
and `assets/`.

Preserve a sibling `study/data/` when replacing `dist/`, and never distribute it
or place it in `dist/data/`.

### Migrating from the two examples it replaces

**The old plugins keep working and are not removed.** Disable **Feynman coach
checkpoint** and **Course material** when you enable Study, or you get both: the
offers and the costs are duplicated, and nothing is shared.

Settings do **not** carry over — plugin data is per-plugin, and a plugin may not
read another's. **Re-add each course once** (name, folder, Logseq name), and
index it. That is the whole migration.

The new plugin deliberately uses its own names (`course_library`,
`study_explain`, question type `study-explain`). The host accumulates native tool
names across *every* enabled plugin and refuses a collision by dropping the whole
contribution of the plugin that loses — and packages are visited in sorted id
order, so `study` would lose to `course-material` and `feynman-coach`. Reusing
their names would have made this plugin silently contribute nothing whenever an
old one was still enabled.

## Once per course: the settings page

One page, three parts.

**Courses.** A course is a name, a folder of slide PDFs, and the name its
`[[COURSE]]` block has in Logseq. On the desktop app, **Choose folder…** opens
the OS folder chooser and that single gesture does two things: it records the
folder's absolute path, and it hands the plugin the PDFs themselves so the
librarian's index can be built right there. Progress is reported deck by deck.

**Logseq notes.** The server URL and token for the Logseq app's own local MCP
server, plus **Test**. The token is stored by the plugin and never read back: the
field shows "Token saved — type to replace", and saving the URL alone keeps it.

**Explain-back checkpoint.** A switch. Off unregisters the question type, which
removes the box *and its rules* from every turn.

Adding a course is refused for a relative path, a missing folder, a duplicate
name, or a file that is not a directory.

### Why the folder is chosen with a directory input

A plugin cannot read a PDF from disk in its backend. `docs/plugin-authoring.md`
is explicit: *"There is no backend documents member, public error-code DTO,
path/URL/token input, or file-picker API. Use a native input and this helper"* —
and `PluginBackendContext` indeed has no `documents` member. The host's PDF
conversion, `ctx.documents.toMarkdown`, exists only on the frontend and takes a
browser `File`.

So the index is built where the files are: in the page, from a native
`<input type="file" webkitdirectory>` — the same control the app's own **Extract
files… → Folder** uses — with `window.lh.getPathForFile` turning one of the
chosen files into the folder's absolute path, exactly as the composer's
attachments do. One gesture, both results, no new dependency and no model call.

`window.lh` is not part of the documented plugin API, so it may change, and it
does not exist in the browser or the dev preview. Where it is missing the
settings page falls back to a typed absolute path (or `~/folder`) and says so;
**Index** still works from each course's own button.

**PowerPoint** is not readable anywhere in LearnHarness. A `.pptx` deck has to be
exported to PDF first; the settings hint, the picker and the tool all say so
rather than failing quietly.

## Once per session: the picker

The **Study** button in a teaching or practice session's top bar opens a box:
pick today's course, tick the decks to teach from, and turn **Use my Logseq
notes** on if you want them. Tick nothing and the whole course is in scope. Decks
that are not indexed say so, and can be indexed from here without leaving the
session.

The binding is per chat and explicit. The picker's action context carries the
session id, which is the same chat id the backend's per-turn tool factory
receives, so what is ticked in that box is exactly what the librarian answers for
in that session — and only that one.

**Nothing is selected until you select it, and until then the teacher is told
nothing at all** (see the budget below). Discoverability lives in the UI — the
top-bar button — not in tokens spent on every session that has no course.

## The librarian

One tool, `course_library`, is the only way the slides enter a lesson.

- Called with no `terms`, it reports what is in scope: each deck, how many
  searchable pages it has, and for an unindexed deck the absolute path a native
  `pdf` job would need.
- Called with `terms` — several at once — it returns the **top ranked excerpts,
  cut verbatim out of the page text**, each labelled with its deck and page.

It cannot summarise. An excerpt is a substring of the page, which is a structural
property rather than an instruction a model might drift from;
`tests/plugin-study-librarian.test.ts` asserts exactly that containment.

**Recall.** Decks may be Italian or English. Terms are folded for accents and
case (`perché` → `perche`) and put through deliberately crude suffix stripping,
so `elezione` finds `elezioni`, `libri` finds `libro`, and `studies` finds
`study`. That over-merges sometimes; a page whose text contains a term
*verbatim* always outranks one that survived only stemming, which is what keeps
precision.

**Image-only slides.** The host's converter has no OCR and drops pages with no
extractable text, reporting only how many it skipped. The plugin cannot render a
PDF page either: that code is core-only, and plugin asset serving is static. So
those pages stay outside the index, and the librarian **names them** and sends
the teacher to one native `pdf` job for that deck — which does read pages
visually. They are never silently reported as absent from the course.

A page's numbers are exact where the numbering betrays a gap (pages 1, 2, 4 with
one skipped means page 3). Pages skipped *after* the last page with text can only
be counted, not numbered, and are reported as "N more image pages".

**Staleness.** Each deck's cache records the size and mtime it was built from. A
deck whose file has changed reads as *not indexed* rather than answering from
stale text. Removing a course deletes its cached page text, except for decks another course still lists.

**Bounds.** The walk is PDFs only, hidden folders skipped, 4 levels and 200 files
at most. The cache keeps at most 400 pages per deck and 4,000 characters per
page; what that cuts is recorded and reported as missing from the index, never as absent from the course. One reply is at most 6 excerpts, 600 characters each and 3,600 overall.
The host's own conversion limits apply on the way in: 25 MiB per file, 1,000
pages, and **one conversion at a time across all plugins**, which is why indexing
is sequential and retries a busy slot once.

## The notes

With the notes on for a session, two read-only tools appear:
`logseq_read_course_notes` (read once when taking up the course) and
`logseq_search_notes` (when the learner mentions something they wrote). Both
return the learner's notes grouped by journal day, with their own notes kept
nested under the highlight they were written against, their uncertain phrasings
marked, and each highlight cited with its slide deck and page.

`course` may be omitted: the plugin fills in the course's Logseq name from the
settings page, because the model has never seen that `[[COURSE]]` block and
should not be made to guess it.

Read-only by construction: `logseq-mcp.cjs` refuses every tool outside
`searchBlocks`, `getPage` and `listPages`, so no code path here can reach
`upsertNodes`. A refused write never reaches the server. The token is never
logged, returned, or allowed into an error message. On failure a tool answers the
agent in plain words ("Open the Logseq app…") instead of throwing the turn away.

**The notes-to-flashcards export was dropped.** Measured against the same
lecture, the slide deck produced 13 facts / 19 cards to the export's 5 / 6, the
slide cards were the better ones, and — decisively — the slides answered the
learner's recorded doubts while the export only carried the questions
(`data/lh-logseq-plugin/evaluation.md`). Cards want the slides; the notes want a
teacher. Nothing here writes a file or touches the knowledge graph.

The one thing the notes cannot do: the Logseq MCP server's `getPage` returns only
a page's direct children and numeric block ids are not addressable, so highlights
nested deep in a journal are reachable only through `searchBlocks`. Deck names
are therefore best-effort — when a search does not also return the deck's own
block, a highlight is cited `slide p.7` rather than with a name the module cannot
see. It never invents one.

## What a turn costs

Nothing goes into the system prompt: **`registerInstructions` is never called.**
That API takes one static text used on *every* turn of the agents it names, with
no per-turn or per-chat hook, so a rule about a course would be charged to every
session, including the ones with no course. `registerTools`' factory is the only
per-turn surface the API offers — it receives that turn's frozen
`{chatId, agent}` — so every word rides a tool description, sized to what the
session selected and the phase it is in.

The phase comes from folding the one session record (`ctx.learning.getSession`),
not from `listSessions()`, whose rows do carry a phase but which reads and parses
*every* chat file on disk. See `phase.cjs`.

Measured with the app's own system-prompt convention, `chars / 4`
(`src/server/chat-handler.ts:367`), by
`tests/plugin-study-integration.test.ts` — which prints this table on every run
rather than trusting it to stay retyped correctly:

| the session | per turn |
| --- | --- |
| nothing configured — prober, practice | **0** |
| nothing configured — teacher | **483** (the explain-back box) |
| a course exists, this session picked none | **483** — the course adds nothing |
| course active, probing/planning — teacher | **745** |
| course active, teaching — teacher | **580** |
| course active — practice | **98** |
| course + notes active, probing/planning — teacher | **1,087** |
| course + notes active, teaching — teacher | **758** |
| course + notes, planning, explain-back off | **605** |
| everything off | **0** |

So the librarian's rules cost 262 tokens where they matter (probing and planning,
when the teacher is deciding what to teach) and 97 once teaching has started,
where a pointer is enough. The notes add 342 and 178 the same way.

Per call, not per turn:

| | tokens |
| --- | --- |
| `course_library` inventory, 2 decks, neither indexed | ≈165 |
| `course_library` inventory, 2 decks, both indexed | ≈131 |
| `course_library` search, one term | ≈167 |
| `course_library` search, three terms | ≈324 |
| `course_library` search, 80 long pages that all match | ≈663, hard-capped |
| `logseq_read_course_notes`, a three-day course | ≈425 |
| `logseq_read_course_notes`, hard cap | ≈1,000 |
| `logseq_search_notes`, hard cap | ≈700 |

The librarian's worst case is bounded by the reply caps, not by the course: the
same query against a course 20× larger returns the same 6 excerpts.

A normal lesson adds one `course_library` inventory call, a handful of searches
as the lesson needs them, one `logseq_read_course_notes`, and a `pdf` job only
for an image-only deck. Nothing is per fact, and no per-turn cost grows with the
number of decks: folder paths are never in a turn, only course names are.

### What consolidation actually saved

The three separate pieces, on one teacher turn with a course picked and notes on:
`feynman-coach` 774 (631 of it a `registerInstructions` text) + `course-material`
292 + the Logseq module 355 = **1,421**, and that was the bill in *every* phase.
With nothing picked it was still 1,254, because two of the three put text in the
system prompt whether or not the session used them.

The consolidated plugin pays 1,087 at its most expensive (planning), 758 while
teaching, 483 when nothing is picked, and **0** when nothing is configured —
which the old set could not reach at all.

## Boundaries

No core edits. No new native tool beyond the one `registerQuestionType` builds
(`study_explain`) and the ones `registerTools` adds. No persisted format or
schema version change, no learning-data writes, nothing in the knowledge graph,
no code execution, no new dependency.

Reading the slides still goes through the app's own file access: if
**Settings → Agent** restricts it to listed folders, the course folder has to be
listed there too — this plugin does not widen that gate, and the settings page
says so.

The plugin's own state is four kinds of file in its `data/` directory —
`courses.json`, `sessions.json`, `settings.json` and one `index/<hash>.json` per
deck — each carrying `"version": 1`, refused rather than reinterpreted when
newer. A corrupt or future index entry reads as *not indexed* and is rebuilt; it
never breaks a lesson.

Disabling removes the tools from future turns and leaves existing transcripts
alone.

## Two deliberate copies, and what pins them

Two things here are reimplemented rather than imported, because the originals are
core-internal and not part of the plugin SDK. Both are pinned by a test that
reads what the *real* component produced, not source text, so a core change fails
a test instead of drifting silently:

- **the box's look** — the answer field, the "I don't know" row and the
  confidence rail copy literal Tailwind class strings and the rail's paint
  algorithm from `components/question-dock.tsx`, `components/answered-card.tsx`
  and `components/confidence-rail.tsx`. `tests/plugin-study-box.test.tsx` renders
  the real native components and this plugin's views side by side and compares
  the class sets and inline rail paint each actually produced.
- **the phase rule** — `phase.cjs` copies the fold from `src/core/phases.ts` and
  `src/core/native-messages.ts`. It degrades in one direction only: the host also
  flips on a plugin-posed teach question read through a private annotation API,
  which a plugin cannot read, so this fold matches teaching question calls by
  tool name instead. Another plugin's question type would be missed, leaving the
  session in `plan` — fuller instructions than needed, never wrong ones.

Every other class name in `main.js` is one the host already emits for its own
settings UI; a plugin cannot ship new Tailwind utilities, so borrowing the host's
own strings is what makes these surfaces native.

## Coverage

Off-network, all of it:

- `tests/plugin-study-integration.test.ts` loads this actual external CommonJS
  backend, drives every settings and session operation, builds the real native
  teacher agent with it enabled, and asserts the per-turn loadout for all three
  agent kinds in each phase — including that an unpicked session and an
  unconfigured plugin contribute nothing. It prints the budget table above and
  asserts its three guarantees.
- `tests/plugin-study-librarian.test.ts` pins retrieval: page numbering,
  image-only derivation, Italian/English recall, verbatim-over-stem ranking, the
  output caps, and that every excerpt is a slice of the page it cites.
- `tests/plugin-study-logseq.test.ts` drives the notes module against a fake
  local MCP server (`tests/helpers/logseq-mcp-fake.ts`) that reproduces the real
  server's behaviour *and* its limits, seeded with synthetic journals in a real
  learner's terse, typo-carrying style. It asserts the rendered output, the
  bounded call counts, the caps under a 600-block graph, the read-only refusal,
  and that no failure ever echoes the token.
- `tests/plugin-study-frontend.test.ts` drives the settings page and the picker
  as DOM against a stub host: the one-gesture folder pick and index, the browser
  fallback, that an untouched token field sends no token, the picker's
  per-session binding, and that nothing outside the course is ever converted.
- `tests/plugin-study-box.test.tsx` is the render-parity guard described above.

This is not a claim of real-provider or human functional acceptance of the
teaching behaviour itself. The librarian's retrieval quality was measured on
synthetic decks; whether its ranking picks the *pedagogically* right page on a
real course is not something these tests can show.
