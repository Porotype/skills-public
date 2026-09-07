---
name: code-walkthrough
description: Record a narrated walkthrough that explains CODE and a code change from a developer's perspective — for review, onboarding, or understanding a diff. Emits three formats from one script into a per-walkthrough folder — a narrated video (MP4 + SRT), a standalone HTML page, and a Markdown summary. Renders syntax-highlighted code and diffs, spotlights the lines being discussed, shows before/after UI screenshots (wipe/fade + an HTML slider), and draws Mermaid diagrams for architectural or flow changes. Use when the user says "/code-walkthrough", asks to explain/present/walk through a diff, commit, PR, or uncommitted changes, "make a code walkthrough", "show what this change does", or "narrate this code".
---

# Code walkthrough

Records a headless, narrated walkthrough of **code and what it changes** — the
developer's view, not the end-user's. The use case is *reviewing or understanding
code*: "here are some changes, let me explain what they mean." (It can also
present a feature or API — "here's how Binder works" — but the primary focus is
explaining a changeset.)

The pipeline mirrors the `feature-walkthrough` skill (TTS + Playwright recording + ffmpeg
mux), but instead of driving the live app it drives a **presentation stage**
that renders code, diffs, before/after UI comparisons, and diagrams — paced to
the narration.

From **one scene script** the renderer emits **three formats that share the same
presentation** — a narrated **MP4** (+ SRT), a standalone **HTML** page (the
video at the top, then the same code/diffs/diagrams as scrollable sections with
an interactive before/after slider), and a **Markdown** transcript (fenced diffs,
diagram images, screenshots). All three are collected in **one folder per
walkthrough**. Same resolution, same diagram SVG, same look — different formats.

1. **Resolve scope** → a changeset (or a free-form topic).
2. **Author a scene script** — JSON list of `{narration, action}`.
3. **Render** — `scripts/render-code.mjs` does TTS, records the stage, muxes the
   MP4 + SRT, then derives the HTML and Markdown from the same scenes.

You write the JSON; the renderer does the rest. **Run it from inside the git
repo** whose code you're presenting — `file`/`diff`/`ref` resolve against it.

---

## Step 1 — Resolve scope

Parse the user's argument into a changeset:

| User says | Source of truth |
|-----------|-----------------|
| "uncommitted", "working tree", "my changes" | `git diff HEAD` (+ untracked) — use `diff` actions with no `ref` |
| "last commit", "HEAD" | `git show HEAD` — use `diff` actions with `"ref": "HEAD"` |
| `<sha>`, "commit abc123" | that commit — `"ref": "<sha>"` |
| `uc-001`, "the login use case" | resolve the UC to a commit/range first (search `git log --grep`, or read `spec/use-cases/…`), then treat as a sha/range. If it can't be resolved to a changeset, say so. |
| free-form ("explain how Binder is wired") | infer — read the relevant files and present with `code` + `diagram` scenes (no diff) |

If genuinely ambiguous, ask **once** with `AskUserQuestion`. Otherwise pick the
obvious interpretation and proceed.

**Read the actual diff before authoring** (`git show <ref>`, `git diff HEAD`).
The narration must reflect what the code does — open the files, understand the
change, then script it.

### Choose the shape of the demo to fit the change

- **Small, local change** (a few lines, one file) → a `diff` scene plus a couple
  of `focus` beats. (See `chat-alignment-fix.json`.)
- **Architectural / structural change** (new wiring, new component, moved
  responsibility) → lead with a `diagram`, then `diff` the key seams. (See
  `talk-creates-macros.json`.)
- **A changed user flow** → a `diagram` (sequence or flowchart) of the new flow,
  then the code that implements it, then a UI `compare` if the screen changed.

### Does this change the UI? Then a before/after is the default.

Decide this **now, in Step 1** — not as an afterthought. Look at the changed
files: if any touch a **view, component, layout, `@Route`, template, or CSS**
(for this repo: `*View.java`, files under `…/ui/`, `styles.css`, `@Route`/`@Menu`
changes), the change has a visible effect and the demo's spine should be a
**before/after `compare`**. A code walkthrough that only *describes* a visual
change, when you could have shown it, is a weaker demo.

So: enumerate the UI surfaces the diff touches, map them to the **routes/screens**
to capture (a changed `@Route` literally tells you which route moved — capture
both the old and new screen), and plan to capture those in Step 2 **before**
authoring scenes. Build the scene script around the real frames.

You may fall back to a single `image` or an illustrative mockup **only** when you
state a specific reason it's not feasible, e.g.:
- the screen needs data/AI/auth you can't reproduce headlessly, or
- the "before" commit genuinely doesn't build.

"It's slower" / "it rebuilds the app" is **not** a sufficient reason — that's what
worktree mode (below) is for. If you do fall back, say so in the narration and in
the final report.

## Step 2 — Gather material

**Code & diffs** come straight from git — you don't pre-extract them. A `code`
or `diff` action names a `file` and an optional `ref`; the renderer reads it.

**UI screenshots** (for `image` / `compare`) are captured by two bundled tools
that save consistent, dev-tools-free PNGs into `demo/code-walkthrough/assets/`. Prefer
these over the Playwright MCP tools — they pin the viewport and device scale so
before/after frames line up, can crop to a single element, and (for before/after)
drive the git states for you.

The app must be running. Check `curl -sf -o /dev/null http://localhost:8080 && echo up`;
start it if needed (for this repo: `OPENAI_API_KEY=… ./mvnw -Photswap spring-boot:run`).

#### `capture-shots.mjs` — one or more screenshots of the running app

Write a *shot list* JSON, then run it:

```bash
node <skill-dir>/scripts/capture-shots.mjs <shotlist.json> --out-dir demo/code-walkthrough/assets
```

```json
{
  "baseUrl": "http://localhost:8080",
  "viewport": { "width": 1000, "height": 640 },
  "deviceScaleFactor": 2,
  "hideDevTools": true,
  "shots": [
    { "name": "chat", "url": "/",
      "steps": [
        { "type": "click", "role": "button", "name": "Chat" },
        { "type": "type", "selector": "textarea", "value": "Create a macro" },
        { "type": "waitFor", "text": "saved" }
      ],
      "element": { "selector": "vaadin-dialog-overlay" } }
  ]
}
```

- Each shot writes `<name>.png` (or `<name><suffix>.png` with `--suffix`).
- `element` crops to one element; `clip` crops to a fixed rect; otherwise the
  viewport (or `fullPage: true`). A tight crop reads far better than a full page.
- **Capturing Vaadin overlays** (dialogs, combo-box popups, menus, notifications):
  the host element (`vaadin-dialog-overlay`, …) is zero-size — its visible card is
  a shadow part. Target the inner part with a piercing selector and a `~=` match:
  `{ "selector": "vaadin-dialog-overlay [part~=overlay]" }` (Playwright auto-pierces
  shadow DOM; it does **not** support `::part()`). Vaadin also keeps several
  detached copies of these elements in the DOM, so the tool auto-resolves an
  `element` target to the **visible** one — no extra work needed (override with
  `"visible": false`). Wait for a child you can see (`{ "waitFor", "text": "Send" }`)
  rather than the overlay host, which never reports "visible".
- `steps` use the same locators as scenes (`selector`/`role`+`name`/`label`/
  `placeholder`/`text`/`testId`) and actions (`click`/`fill`/`type`/`press`/
  `hover`/`waitFor`/`wait`/`scroll`/`eval`).
- `storageState` (a Playwright storage-state file) preloads auth if the screen
  is behind login.

#### `capture-git-states.mjs` — automatic before/after pairs

When the *code change itself* changes the UI, this captures the same shot list at
two git states and writes matching `<name>-before.png` / `<name>-after.png`. The
`--after` side defaults to `WORKING` (your current tree — captured from the
already-running app, no rebuild). Use `--before HEAD --after WORKING` for an
uncommitted change, or `--before <sha>~1 --after <sha>` for a landed commit.

**Use worktree mode (recommended).** Building a ref the in-place way checks it out
in your tree and restarts your app — slow and disruptive, which is exactly the
friction that tempts you to skip the before/after. `--worktree` instead builds the
ref in an isolated `git worktree` on a separate `--port`; **your working tree and
running app are never touched**, and the worktree is created only for the side(s)
that aren't `WORKING` and removed afterwards. The `--rebuild` command runs with
`cwd` = the worktree and env `PORT` set — so run on `$PORT` and **no kill step is
needed** (fresh port). For a Spring Boot + Vaadin app:

```bash
node <skill-dir>/scripts/capture-git-states.mjs <shotlist.json> \
  --before <sha>~1 --after <sha> --worktree --port 8090 \
  --rebuild "(OPENAI_API_KEY=$OPENAI_API_KEY nohup ./mvnw -Dmaven.test.skip=true spring-boot:run -Dserver.port=\$PORT >/tmp/cv-wt.log 2>&1 &)" \
  --ready http://localhost:8080/ --ready-timeout 600 --out-dir demo/code-walkthrough/assets
```

- Escape `\$PORT` so the tool (not your shell) expands it per worktree. `--ready`'s
  port is swapped to `--port` automatically for the worktree side.
- **The worktree instance must not reuse fixed ports the main app holds.** Note it
  runs plain `spring-boot:run` — **drop `-Photswap`**: that profile pins the JDWP
  debug port to 8000, so a second instance dies instantly with
  `bind failed: Address already in use`. The screenshot instance is throwaway —
  it doesn't need hotswap/debug. (Any tool with a hard-coded agent/debug port has
  the same problem; only `-Dserver.port=$PORT` is varied for you.)
- **Safety / "ask if unsure":** worktree mode **refuses to run** (exits with a
  clear message) if `--rebuild` is missing or `--port` is busy — surface that to
  the user and confirm before retrying rather than forcing it. It still works with
  a dirty main tree (it never touches it). A worktree build is heavier than an
  in-place one (fresh `target/`/frontend), so give a generous `--ready-timeout`
  (400s+). If the ref doesn't build, that side fails — pick refs you know compile.

**In-place mode (fallback).** Omit `--worktree`. The tool `git checkout -f`s each
ref in your tree, runs `--rebuild`, captures, and restores your branch + stashed
changes at the end (even on failure). `--rebuild` must also **stop** the old
server; the tool then verifies it went **down then up** (so a failed kill is a
loud error, not two identical frames). Spring Boot + Vaadin:

```
--rebuild "( lsof -i:8080 -t 2>/dev/null || ss -ltnpH 'sport = :8080' | grep -oP 'pid=\K[0-9]+' ) | xargs -r kill -9; sleep 1; (OPENAI_API_KEY=$OPENAI_API_KEY nohup ./mvnw -Photswap -Dmaven.test.skip=true spring-boot:run >/tmp/app.log 2>&1 &)" \
--ready http://localhost:8080/ --ready-timeout 300
```

Notes that apply to **both** modes (learned from real runs): kill by port
*portably* (`lsof` isn't always installed → fall back to `ss`); `-Dmaven.test.skip=true`
because `spring-boot:run` force-runs `test-compile` and a stale test on the ref
you're diffing would abort the build; generous `--ready-timeout` because switching
commits rebuilds the Vaadin frontend. In-place extras: `--no-restart` for a
zero-downtime live-reload server; `--down-timeout` bounds the wait for the old one
to stop.

#### Fallback: honest mockups

If the two states genuinely can't be reproduced (e.g. data you don't have), build
mockups — as `assets/make-mockups.mjs` does in the example — and **say in the
narration that they're illustrative**. Never pass a mockup off as a real screenshot.

## Step 3 — Write the scene script

Save at `demo/code-walkthrough/<name>.json`. One file per walkthrough. By default its
output lands in a sibling folder `demo/code-walkthrough/<name>/` (see Step 4).

### Schema

```json
{
  "title": "Chat alignment fix",
  "voice": "en-US-AndrewNeural",
  "codeTheme": "github-dark",
  "viewport": { "width": 1280, "height": 800 },
  "headless": true,
  "intro": {
    "kicker": "Code walkthrough",
    "title": "Chat alignment fix",
    "subtitle": "commit 8e3def7 — one file, six lines",
    "note": "src/main/java/…/ActivityOverlay.java",
    "narration": "Let's walk through a small fix…"
  },
  "scenes": [
    { "narration": "…", "action": { "type": "diff", "file": "…", "ref": "8e3def7" } }
  ]
}
```

Top-level fields except `scenes` are optional. Defaults: `voice =
en-US-AndrewNeural` (calm, good for technical), `codeTheme = github-dark`,
`viewport = 1280x800`, `headless = true`, `intro` = a generated title card from
`title`. Set `intro: false` to skip the card (first frame is then a dark stage,
not white). `scenes` is also accepted as `steps`.

### Action catalog

| `type` | Key fields | What it shows |
|--------|-----------|---------------|
| `code` | `file` (+ `ref?`), or inline `code`; `lines?`, `highlight?`, `lang?`, `title?`, `badge?` | Syntax-highlighted source in an editor frame. |
| `diff` | `file` (+ `ref?`/`base?`), or inline `diff`; `highlight?`, `context?`, `badge?` | Unified diff: adds green, dels red, with `+/-` gutter. |
| `focus` | `highlight` | Re-spotlight different lines on the **current** code/diff (no reload). The cheap way to "talk through" a snippet beat by beat. |
| `image` | `path`, `caption?` | A screenshot, fit to the stage on a dark mat. |
| `compare` | `before`, `after`, `mode?`, `caption?`, `beforeLabel?`, `afterLabel?`, `hold?`, `transition?` | Before/after screenshots; animates between them. |
| `diagram` | `mermaid` (inline) or `path`; `caption?` | A Mermaid diagram, pre-rendered to a themed SVG (same SVG in video/HTML/MD). |
| `section` | `title`, `subtitle?`, `background?` | A full-screen chapter/summary card. |
| `wait` | `ms` | Hold the current scene (silent). Use sparingly. |
| `screenshot` | `path` | Save a still of the stage (side artifact, not muxed). |
| `box` / `clearBoxes` | `rect:{x,y,width,height}`, `caption?`, `color?` | Draw a labeled rectangle in viewport coords — point at part of an `image`. |

### Resolving code & diffs from git

A `code`/`diff` action's `ref` selects *which version*:

- **`code`**: no `ref` = working tree (disk); `ref` = that version (`git show ref:file`).
  Use `lines: "80-120"` (or `[80,120]`) to show a window; the gutter shows real
  file line numbers.
- **`diff`**:
  - no refs → **working tree vs HEAD** (`git diff HEAD -- file`)
  - `"ref": "<sha>"` → **that commit's own diff** (`git show <sha>`)
  - `"base": "X", "ref": "Y"` → `git diff X Y -- file`
  - `"context": 1` tightens the diff (default 3 lines of context).

Prefer real `file` + `ref` over pasting inline `code`/`diff` — it stays accurate
and the gutter line numbers line up with the repo.

### Highlighting — "spotlight the line being discussed"

`highlight` accepts line numbers and `"a-b"` ranges, e.g. `[92]`,
`["395-399", 402]`. Highlighted lines glow with an accent bar; the rest dim, and
the view auto-scrolls to center them. Numbers are **real file/new-file line
numbers** (what the gutter shows).

Drive a walkthrough by keeping one `diff`/`code` scene mounted and following it
with `focus` beats:

```json
{ "narration": "First the field type changes — Div to VerticalLayout.",
  "action": { "type": "focus", "highlight": [92] } },
{ "narration": "Then the builder configures it: no padding, full width, stretch.",
  "action": { "type": "focus", "highlight": "395-399" } },
{ "narration": "And the two manual flex overrides — in red — can be deleted.",
  "action": { "type": "focus", "highlight": [] } }
```

Deleted lines have no line number, so you can't `focus` them by number — clear
the spotlight (`"highlight": []`) and let their red color carry the point.

### Diagrams (Mermaid)

Use a `diagram` when structure or flow is the story — new wiring, a moved
responsibility, a changed sequence. Keep them small (5–9 nodes); a diagram that
needs scrolling won't read on screen.

Diagrams are rendered to a themed **SVG once, in Node** (`beautiful-mermaid`,
matched to the dark/orange palette) and reused verbatim in the video, the HTML,
and the MD — so they look identical and crisp everywhere. `flowchart`,
`sequenceDiagram`, `stateDiagram`, `classDiagram`, and ER/XY charts are
supported. A diagram that fails to parse renders as an inline `mermaid error: …`
note (it never aborts the render) — simplify and re-run.

```json
{ "narration": "Both surfaces now share one set of tools.",
  "action": { "type": "diagram", "caption": "After: voice mirrors chat",
    "mermaid": "flowchart LR\n  V([Voice]) --> ST[DraivScriptTools]\n  C([Chat]) --> ST\n  ST --> F[(scripts/*.json)]" } }
```

`flowchart` for architecture/dependencies, `sequenceDiagram` for a changed
user/request flow. Inline via `mermaid`, or point `path` at a `.mmd` file.

### Before/after UI (`compare`)

```json
{ "narration": "After the change, messages lay out edge to edge.",
  "action": { "type": "compare",
    "before": "demo/code-walkthrough/assets/chat-before.png",
    "after":  "demo/code-walkthrough/assets/chat-after.png",
    "mode": "wipe", "caption": "Old layout → new" } }
```

`mode`: `wipe` (default — a moving divider reveals "after"), `fade`, or `slide`.
The renderer holds on "before", then animates to "after" partway through the
narration, then holds on "after". Override timing with `hold` (ms before the
animation) and `transition` (ms of the animation).

### Writing good narration (developer voice)

- **Explain intent and consequence, not just mechanics.** "A Div has no layout of
  its own, so children fell back to default flow" beats "changed Div to
  VerticalLayout on line 92."
- **One idea per beat.** ~1–3 sentences. Let `focus` move with your words.
- **Name things as the code names them** — class, method, field. You're talking
  to someone who will read this code.
- **Lead the eye, then explain.** Show the `diff`, then `focus` the part you're
  about to discuss.
- **Chapters/summaries**: a `section` scene between parts, or to land the point.
- Pace with narration, not `wait`. Add `wait` only when you need silence on a
  diagram or screenshot.

## Step 4 — Render

```bash
node <skill-dir>/scripts/render-code.mjs <script.json> [output-base] \
  [--burn] [--keep-tmp] [--no-video] [--no-md] [--no-html]
```

By default this emits **all three formats into one folder per walkthrough**:

```
demo/code-walkthrough/<name>/
  <name>-code-walkthrough.mp4  <name>-code-walkthrough.srt   ← narrated video + captions
  <name>-code-walkthrough.html  ← standalone page: video on top, then sections + slider
  <name>-code-walkthrough.md    ← Markdown transcript (fenced diffs, diagram/screens)
  images/                       ← screenshots + diagram SVGs the MD references
```

The `-code-walkthrough` suffix keeps the files distinguishable from a
`feature-walkthrough` of the same `<name>` (whose artifacts carry
`-feature-walkthrough`), so a stray `<name>-code-walkthrough.mp4` is
self-identifying in a browser tab or file listing.

- `output-base` defaults to `<script-dir>/<name>/<name>-code-walkthrough` (the
  folder above). Pass one to override the prefix (used verbatim — no suffix is
  added to an explicit base); the folder is its `dirname`.
- The **HTML is self-contained** (CSS/JS/screenshots inlined) and embeds the video
  via a relative `./<name>-code-walkthrough.mp4` — move or zip the *folder* and it
  still works.
  The **MD** links the video and references `images/` so it renders on GitHub.
- `--no-video` / `--no-md` / `--no-html` skip a format. `--no-video` still builds
  the docs (no TTS/ffmpeg, just the headless stage) — fast for a docs-only pass.
- `--burn` burns subtitles into the video (also writes the sidecar `.srt`).
- `--keep-tmp` keeps intermediate audio/video for debugging.

**First run** auto-installs the renderer's Node deps (playwright + chromium,
`@highlightjs/cdn-assets`, `beautiful-mermaid`) and checks for `ffmpeg` and `edge-tts`. If
`edge-tts` is missing it prints the install command. (The renderer reuses the
sibling `feature-walkthrough` skill's `edge-tts` venv if present.) On Debian/Ubuntu:
`sudo apt-get install -y ffmpeg && pip3 install edge-tts`; macOS:
`brew install ffmpeg && pip3 install edge-tts`.

## Step 5 — Report

Tell the user the walkthrough **folder** and the files in it (mp4/srt, html, md)
plus total duration (the renderer prints them). The HTML is the nicest single
artifact to open (video + scrollable code/diagrams + before/after slider); the MD
is the copy-pasteable transcript. If you started the dev server or built other
commits to grab screenshots, say so and confirm their working tree is untouched
(worktree mode) or restored (in-place). **If the change affected the UI, state
whether the demo includes a before/after `compare` — and if it doesn't, give the
specific reason** (per the Step 1 gate), so it's a conscious omission, not an
accidental one. Don't commit demo artifacts unless asked — they're large; add
`demo/code-walkthrough/*/` to `.gitignore` if needed.

---

## Themes & voices

- **Code themes** (`codeTheme`): any highlight.js theme name —
  `github-dark` (default), `github-dark-dimmed`, `atom-one-dark`, `nord`,
  `monokai`, … Full list: `ls scripts/node_modules/@highlightjs/cdn-assets/styles`.
- **Diagram theme** is fixed to the dark/orange palette (in `scripts/scenes.mjs`,
  `DIAGRAM_THEME`) so diagrams match the stage and read the same in every format.
- **Voices** (`voice`, edge-tts): `en-US-AndrewNeural` (calm, technical —
  default), `en-US-AvaNeural` (warm), `en-GB-RyanNeural`, `en-US-EmmaNeural`.
  Full list: `edge-tts --list-voices`.

## Failure modes & recovery

- **`diff: produced no rows`** → the `ref`/`file` combo yielded an empty diff.
  Check the path is repo-relative and the ref actually touches that file
  (`git show <ref> --stat`).
- **Highlight lands on the wrong lines** → for a windowed `code` scene, `lines`
  sets the gutter numbering; `highlight` uses those same real numbers. For a
  `diff`, use **new-file** line numbers (the green/context gutter).
- **Diagram is cut off or tiny** → too many nodes, or a syntax error in the
  Mermaid source (it renders as `mermaid error: …`). Simplify; validate the
  Mermaid separately if unsure.
- **`compare` images look stretched** → both images should share an aspect ratio.
  Capture both screenshots at the same viewport/crop.
- **Image not found** → `path` is resolved relative to the git repo root (or
  absolute). Put screenshots under `demo/code-walkthrough/assets/`.
- **Audio out of sync after editing** → re-render from JSON; never hand-edit the mp4.

See `demo/code-walkthrough/` in this repo for worked examples
(`chat-alignment-fix.json`, `ui-before-after.json`, `talk-creates-macros.json`)
and their rendered output.
