# Course material example

A course keeps forgetting where its slides are. This plugin remembers: one
course name, one folder of slide PDFs, stored in the plugin's own
`data/courses.json`. In a session about that course the prober, teacher and
practitioner read those decks first through the app's existing background PDF
reader, cite the pages it returns, and say when they go past the slides.

Copy this directory into the plugins directory shown in **Settings → Community
plugins**, keeping the `course-material/` folder and its required
`dist/manifest.json`. No build is needed. Refresh and enable **Course
material**, then open its settings page and add a course: a name and a folder,
absolute or `~/…`. The folder has to exist — adding is refused otherwise. The
settings page is the app's own File-access folder list, shape for shape: add
line, then one line per course with its resolved path, its PDF count and a
Remove.

PowerPoint is not supported anywhere in LearnHarness. A `.pptx` deck has to be
exported to PDF before any of this reaches it; the settings hint and the tool
both say so rather than failing quietly.

## How a session picks its course

The plugin does not bind a course to a chat, because the API has no per-chat
setting to bind it with: `registerInstructions` contributes one static text to
every matching turn, and the per-turn context a tool factory receives
(`{chatId, agent}`) carries no course the learner could have chosen.

So the choice stays where the learner already makes it — in what the session is
about. The instructions list every configured course with its folder and tell
the agent to settle on one at the start, from the session's title or the
learner's own words, and to name it in one clause so the learner can correct it
out loud. Naming the course in the session ("this is Basi di dati") is the
override; nothing matching means teach normally, and guessing a folder is
forbidden. Resolving a name to a folder is the plugin's job, not the model's:
`course_material` matches case-insensitively, exactly first and then on a single
unambiguous containment, and answers an unmatched name with the list of real
ones instead of an error.

This is the simplest mechanism that survives a restart and never silently
grounds a session in the wrong course. Its cost is honest: a session whose title
says nothing about the course needs one sentence from the learner.

## What it adds to a turn

With no course configured the plugin contributes **nothing** — no instructions,
no tool — so installing it does not change a single prompt until it is used.

With at least one course, each prober/teacher/practice turn gets:

- the course list and a grounding directive: slides first, `course_material`
  **once** per session (not per plan node, per question or per fact), one native
  `pdf` job per deck actually needed, cite deck plus page as the brief gives it,
  never cite a page it did not read, and say in the same breath when it goes
  beyond the slides — background they assume, a step they skip, its own example,
  a correction;
- one tool, `course_material`, which lists a course's PDFs (recursive, hidden
  folders skipped, 4 levels and 200 files deep at most) with absolute paths and
  sizes. It lists; it never reads. Reading and citing remain the native `pdf`
  job's work, unchanged.

Reading still goes through the app's own file access. If **Settings → Agent**
restricts it to listed folders, the course folder has to be listed there too —
this plugin does not widen that gate, and the settings page says so.

No code execution, no new question or problem type, no view or action, no
learning-data writes, nothing in the knowledge graph. The plugin's only
persistent state is its own `data/courses.json`, carrying its own
`"version": 1`; a newer version is refused rather than reinterpreted.

Disabling it removes the instructions and the tool from future turns and leaves
existing transcripts alone. Preserve sibling `course-material/data/` when
replacing `dist/`, and never distribute that data or place it in `dist/data/`.

Off-network coverage: `tests/plugin-course-material-integration.test.ts` loads
this actual external CommonJS backend, drives its settings operations, builds
the real native teacher agent with it enabled, and asserts the composed system
prompt and the per-turn tool loadout for all three agent kinds. This is not a
claim of real-provider or human functional acceptance of the teaching behavior
itself.
