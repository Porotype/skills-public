---
name: feature-walkthrough
description: Record a narrated walkthrough of implemented features, workflows, commits, or uncommitted changes using Playwright and TTS. Emits three formats from one script into a per-walkthrough folder — a narrated video (MP4 + SRT), a standalone HTML page, and a Markdown step-by-step summary (narration + screenshot per step). Use when the user says "/feature-walkthrough", asks to record a demo, make a demo video, create a narrated walkthrough, or capture a feature walkthrough.
---

# Feature walkthrough

Records a headless, narrated walkthrough of features in the current project, driving
the live app with Playwright. From one script it emits a video **and** a standalone
HTML page **and** a Markdown step-by-step summary (sibling to the `code-walkthrough`
skill, which does the same for code/diffs). The pipeline is:

1. **Resolve scope** — what to demo (use cases / commit / diff).
2. **Author a script** — a JSON list of `{narration, action}` steps.
3. **Render** — synthesize each line, drive the app while recording and **timing every
   step**, then lay the narration onto the timeline that was actually observed, mux to
   mp4 + sidecar SRT; then per-step screenshots → HTML + Markdown (all in one folder).

The ordering in step 3 matters and is the thing most likely to surprise you: **where a
line belongs cannot be known before the app has been driven.** See "How narration is
timed" below.

The renderer at `scripts/render-demo.mjs` handles step 2's *execution*. You write the JSON; it does the rest.

---

## Step 1 — Resolve scope

Parse the user's argument:

| User says | Source of truth |
|-----------|-----------------|
| `uc-001`, `uc-001 to uc-005`, "the login use case" | files in `spec/use-cases/use-case-XXX-*.md` |
| "last commit", "HEAD" | `git show --stat HEAD` + the changed files |
| `<sha>` | `git show --stat <sha>` |
| "uncommitted changes", "working tree" | `git status` + `git diff` (staged + unstaged) |
| free-form ("show the expense flow") | infer — read the most relevant use case file |

If ambiguous, ask **once** with `AskUserQuestion` before authoring the script. Do not ask for confirmation on every detail.

## Step 2 — Ensure the app is running

The renderer drives a real browser against a live URL. Default URL is `http://localhost:8080` (override per script).

Check if the dev server is reachable (`curl -sf -o /dev/null http://localhost:8080 && echo up`). If not, start it in the background (e.g. `./mvnw spring-boot:run` for Vaadin applications) and wait for it to come up before recording. If you can't start it, tell the user and stop.

Use a seeded test account known to exist (read the spec or seeder code — don't guess).

## Step 3 — Write the demo script

Save it at `demo/feature-walkthrough/<name>.json` in the working directory (the
`code-walkthrough` skill mirrors this — it saves at `demo/code-walkthrough/<name>.json`).
One file per video. For multi-use-case demos, either:
- **separate videos**: one script per UC (default — easier to re-record), or
- **single stitched video**: one script with a `Chapter` narration line between sections.

Ask the user which they want if demoing more than one UC.

### Schema

```json
{
  "title": "Login (UC-001)",
  "baseUrl": "http://localhost:8080",
  "voice": "en-US-AvaNeural",
  "viewport": { "width": 1280, "height": 800 },
  "headless": true,
  "intro": {
    "title": "Login flow",
    "subtitle": "Use case 001",
    "ms": 3000,
    "narration": "Welcome — let's walk through the login flow.",
    "background": "linear-gradient(135deg, #1976d2 0%, #1a2d4a 100%)"
  },
  "highlights": true,
  "steps": [
    { "narration": "...", "action": { "type": "goto", "url": "/login" } }
  ]
}
```

All top-level fields except `steps` are optional. Defaults: `voice = en-US-AvaNeural`, `viewport = 1280x800`, `baseUrl = http://localhost:8080`, `headless = true`, `highlights = true`, `intro = { title: <script.title>, ms: 2500 }`, `hideDevTools = true` (hides `vaadin-dev-tools` and `copilot-main` overlays so they don't bleed into the recording).

### Intro screen

Without an intro the recording's first frame is a blank white browser canvas, which looks awful when shared. By default the renderer shows a generated title card for 2.5s using `script.title`. Override with:

- **Custom title card**: `intro: { title, subtitle, note, ms, narration, background, color }`. `background` accepts any CSS background value (gradient, solid color, image). `ms` is **how long the title card stays on screen** (default 2500). If `narration` is longer than `ms`, the card fades to the first UI screen and narration *continues* over it — so the screen keeps moving while the voice keeps talking. Keep `ms` short (2–4s) unless your narration is short too.
- **Pre-roll the first UI**: `intro: { type: "preroll", ms: 1500 }`. The renderer navigates to the first `goto` URL during the intro window so the video opens on real UI rather than a card.
- **None**: `intro: false`. Will start with a blank frame — only use this if you'll edit the video later.

The intro is silent unless you set `intro.narration`. SRT captions are offset automatically.

### Action types

| `type` | Required fields | Notes |
|--------|-----------------|-------|
| `goto` | `url` (relative ok) | Navigate. Use as the first step. |
| `click` | locator | See "Locators" below. |
| `fill` | locator, `value` | For inputs. Clears first. |
| `type` | locator, `value`, `delay?` | Keystroke-by-keystroke (looks human). Default delay 50ms. |
| `press` | `key` | E.g. `"Enter"`, `"Tab"`. |
| `upload` | `file` or `files[]` (+ optional locator) | Attaches local file(s) to a file input — paths relative to the script's folder. With no locator it targets the first `input[type=file]`, which is what you want for upload widgets that hide the real input (e.g. `vaadin-upload`). |
| `hover` | locator | |
| `waitFor` | locator, `state?`, `timeout?` | Default state `visible`, timeout 10s. |
| `wait` | `ms` (+ optional locator) | Hard pause. With a locator it means *wait up to `ms`, but stop as soon as this appears* — the right way to narrate over a slow backend without stalling once the result lands. |
| `scroll` | locator | scrollIntoViewIfNeeded |
| `highlight` | locator | Briefly outlines the element in orange. Great for drawing the eye. |
| `screenshot` | `path` | Side artifact, not muxed into the video. |
| `clearCookies` | — | Wipes cookies. Use to "sign out" between sections without UI navigation. |
| `box` | locator OR `rect` | Draws a coloured rectangle overlay. Auto-clears at end of step. See "Highlights" below. |
| `clearBoxes` | `id?` | Manually clear a persistent box by id, or all boxes when id is omitted. |

### Locators (use exactly one per action)

```json
{ "selector": "input[name=username]" }        // CSS / Playwright selector
{ "role": "button", "name": "Sign in" }       // ARIA role + accessible name
{ "label": "Username" }                       // form label
{ "placeholder": "Search name…" }             // placeholder attribute
{ "text": "My profile" }                      // visible text
{ "testId": "submit-btn" }                    // data-testid
```

Prefer `role`/`text`/`label` over CSS — they survive Vaadin's shadow DOM and won't break when class names change. Use CSS only for plain HTML inputs and when nothing else works.

### Highlights

Use `box` actions to point the viewer's eye at something while narration plays. Most useful when the narration describes the page rather than driving an action.

```json
{ "narration": "There's a user menu in the top-right with profile and sign-out.",
  "action": { "type": "box", "role": "button", "name": "Open user menu", "caption": "User menu", "color": "#ff5722" } }
```

```json
{ "narration": "The status badge in the lower-left shows sync state.",
  "action": { "type": "box", "rect": { "x": 16, "y": 720, "width": 140, "height": 32 } } }
```

Options:

| Field | Meaning |
|-------|---------|
| locator fields (`selector`/`role`/`text`/`label`/`placeholder`/`testId`) | Box wraps the element's bounding box. |
| `rect: { x, y, width, height }` | Absolute viewport coordinates. Use when no element fits. |
| `caption` | Short text label rendered on the box's top edge. (Don't use `label` here — that's reserved for locating form elements by their `<label>`.) |
| `color` | CSS colour for the border + label background. Default `#ff5722`. |
| `style` | `solid` (default) or `dashed`. |
| `pad` | Extra pixels around the bounding box. Default `6`. |
| `id` | Identifier; use to clear or replace a specific box later. |
| `persist` | Keep the box on screen past this step. Clear with `clearBoxes` (or `clearBoxes` with the same `id`). |

By default a box auto-clears when its step finishes. For a box that spans several narrated steps, set `persist: true`, then add a later step with `{ "action": { "type": "clearBoxes", "id": "<id>" } }`.

**Turning highlights off globally**: set `"highlights": false` at the top of the script. All `box` and `clearBoxes` actions become no-ops — useful when you want a clean, unannotated take.

### How narration is timed

The renderer records first and narrates second. Each step is timed as it runs, and the
audio track is then assembled against those observed times, with silence covering the
gaps. The `.srt` is generated from the same numbers, so captions, voice and picture
cannot disagree.

Per step, the line is spoken:

| Step | When the voice starts | Why |
|------|----------------------|-----|
| action finished quickly (≤ `leadMs`, default 1200ms) | at the **start** of the step | the voice leads the click, which is how it reads best |
| action **blocked** — `waitFor` on a live app, a slow navigation | when the action **finishes** | the line describes what the action produced; it must not play while that is still loading |
| `wait`, or no action at all | at the **start** of the step | pacing steps exist precisely to talk over a busy screen |

Override per step with `"narrationAt": "start" | "end"` (default `"auto"`). Use
`"start"` for a line that sets up something the viewer is about to watch — *"Now watch,
because you'll miss it"* before a click — which otherwise lands after the thing happened.

**Long waits become silence, and the renderer tells you so.** After recording it prints
every step whose action outran its line:

```
   waited on the app in 2 step(s) — narration held until each was ready:
     step 16: action 1m05s vs narration 5.9s
   → that is silence on screen. Add narrated `wait` steps before those
     steps if you want the voice to cover the app's thinking time.
```

That is the number to write to. There are two ways to answer it, and you want both:

**1. Play the boring part fast (on by default).** Any span where nothing is being said and
which lasts longer than `minSeconds` is time-compressed in the finished video — so a
90-second AI turn becomes about ten seconds of visibly fast progress, and the narration
picks up the instant the result lands. This is usually the better answer: nobody needs
ninety seconds of commentary on a spinner, and watching the work rush past reads as
"this took a while" without costing the viewer a while. Tune or disable it:

```json
"speedUpQuiet": { "minSeconds": 3.5, "factor": 8, "keepSeconds": 2.5 }
"speedUpQuiet": false
```

`factor` is the maximum speed-up and `keepSeconds` the floor, so a span is never
compressed into a subliminal flash. The renderer reports what it did:

```
   sped up 2 quiet span(s) — 1m38s of silence removed
     1m42s → 12.8s  (×8.0)
```

**2. Talk over the interesting part.** Speed-up is for dead time; the first stretch of a
long wait is usually *not* dead, because there is something worth saying about what the
assistant is doing. The pattern is: **several narrated `wait` steps to talk over the
work, then one `waitFor` whose line describes the result.** Give those `wait` steps the
same locator the `waitFor` uses and they stop early when the result arrives, so a fast run
skips them and a slow run gets both — narration first, then fast-forward for the rest.

Two related knobs: `tailMs` (default 1200) holds the last frame after the final word, and
`leadMs` (default 1200) is the "finished quickly" threshold above.

### Attach each line to the step that *produces* what it describes

The commonest sync complaint is not a renderer bug at all. A line written like this:

```json
{ "narration": "Here it is. Four generic lines — nothing says where the work is.",
  "action": { "type": "goto", "url": "/meetings" } },
{ "narration": null,
  "action": { "type": "click", "text": "Aurora sprint review" } }
```

plays over the meetings *list*. The agenda it describes only appears after the **next**
step. The renderer is doing exactly what it was told; the script is wrong. Move the line
down to the step that reveals the thing:

```json
{ "narration": "Her week: four meetings, one of them Friday's review.",
  "action": { "type": "goto", "url": "/meetings" } },
{ "narration": "Here it is. Four generic lines — nothing says where the work is.",
  "action": { "type": "click", "text": "Aurora sprint review" } }
```

Same trap with tabbed views: navigating to a record opens its *first* tab, so a line about
what is on the third tab needs a `click` on that tab to hang from. **Read your script asking
"is this on screen yet?" for every line** — and then verify it (below), because the answer
is not obvious from the JSON.

### Writing good narration

- **One thought per step.** ~1–3 sentences, ~5–15 words. Long paragraphs make the video crawl.
- **Describe what's happening on screen, not what the code does.** "We sign in as admin" beats "POST /login with admin credentials".
- **Lead with action verbs.** "Open the directory.", "Pick Alice."
- **Don't read fields aloud verbatim.** "Enter the admin credentials" > "Type 'admin' in username then 'admin' in password".
- **Pace pauses with `wait` only when you need silence on screen** (e.g. showing a result). Otherwise narration is the timer.
- **Chapters**: for multi-section videos, use a step with no action: `{ "narration": "Next: managing users.", "action": null }`.

### Tips for Vaadin apps

- The `LoginForm` username/password fields are real `<input>`s — `{ "selector": "input[name=username]" }` works.
- Buttons (`vaadin-button`, `vaadin-menu-bar-button`) expose ARIA — prefer `{ "role": "button", "name": "Sign in" }`.
- Items in `vaadin-side-nav`, `vaadin-menu-bar`, dialogs: `{ "text": "User Management" }` reliably finds them.
- Grids: rows are `vaadin-grid-cell-content` — usually `{ "text": "alice" }` is the simplest way to click a specific row.
- For the avatar/user menu, target `{ "role": "button", "name": "..." }` if accessible, else fall back to a CSS selector on `vaadin-avatar`.

If unsure about a selector, read the relevant `*.java` view file in `src/main/java/.../views/` — it shows the exact components.

## Step 4 — Render

```bash
node <skill-dir>/scripts/render-demo.mjs <script.json> [output-base] \
  [--burn] [--keep-tmp] [--no-video] [--no-md] [--no-html]
```

By default this emits **three formats into one folder per walkthrough**:

```
demo/feature-walkthrough/<name>/
  <name>-feature-walkthrough.mp4  <name>-feature-walkthrough.srt   ← narrated video + captions
  <name>-feature-walkthrough.html  ← standalone page: video on top, numbered steps + screenshots
  <name>-feature-walkthrough.md    ← step-by-step summary (narration + screenshot per step)
  images/                          ← the per-step screenshots
```

The `-feature-walkthrough` suffix keeps the files distinguishable from a
`code-walkthrough` of the same `<name>` (whose artifacts carry `-code-walkthrough`),
so a stray `<name>-feature-walkthrough.mp4` is self-identifying in a browser tab or
file listing.

- The MD/HTML are a **step-by-step summary**: each step's narration paired with a
  screenshot captured at that beat. The HTML embeds the video at the top and is
  self-contained (CSS inlined); the MD links the video and references `images/`,
  so the folder travels as a unit. The video itself is unchanged.
- `output-base` defaults to `<script-dir>/<name>/<name>-feature-walkthrough`. Pass
  one to override (used verbatim — no suffix is added to an explicit base).
- `--no-video` / `--no-md` / `--no-html` skip a format. **`--no-video`** still
  drives the app and captures the per-step screenshots, so it builds the docs
  **without needing `edge-tts`/`ffmpeg`** — a fast way to produce a screenshot
  walkthrough (the sibling `code-walkthrough` skill has the same flags).
- `--burn` burns subtitles into the video instead of a sidecar SRT (still writes .srt).
- `--keep-tmp` keeps the intermediate audio/video files for debugging.

**First run**: the renderer auto-installs its Node deps (`playwright` + the chromium browser) and (for video) checks for `ffmpeg` and `edge-tts`. If either is missing it prints the install command and exits. On Debian/Ubuntu: `sudo apt-get install -y ffmpeg && pip3 install edge-tts`. On macOS: `brew install ffmpeg && pip3 install edge-tts`.

## Step 5 — Verify the sync

Do not eyeball this and do not assume it. Run:

```bash
node <skill-dir>/scripts/verify-sync.mjs demo/feature-walkthrough/<name>/
```

It works on the finished files with no help from the renderer: each step screenshot is a
picture of a known moment, the `.srt` claims a time for it, and the script solves for the
time shift that best aligns the whole sequence — then does it again over the first and last
thirds, because *accumulating* drift is the failure that matters. A shift within ±1s (the
1 fps sampling resolution) is correct. Exit code is non-zero if it isn't.

It also reports how sharp each fit is. A `?` and a low fit number means that section's
screen barely changes, so the measurement is weak there — the tool says so rather than
inventing a drift. When the fit is weak and you still want certainty, check one moment by
hand: take a cue's start time from the `.srt` and pull that frame —

```bash
ffmpeg -ss <cue-start> -i <name>-feature-walkthrough.mp4 -frames:v 1 /tmp/check.png
```

— and confirm the screen shows what the line is talking about.

## Step 6 — Report

Tell the user the walkthrough **folder** and the files in it (mp4/srt, html, md) and
the total duration (the renderer prints it). If you stopped/started the dev server,
mention it.

Don't commit demo artifacts unless asked — they're large. Add
`demo/feature-walkthrough/*/` to `.gitignore` if it isn't already.

---

## Voice catalog (edge-tts)

Good defaults — all free, no API key, network call to Microsoft:

| Voice ID | Style |
|----------|-------|
| `en-US-AvaNeural` | Warm, conversational (default) |
| `en-US-AndrewNeural` | Calm male, good for technical |
| `en-US-EmmaNeural` | Bright, upbeat |
| `en-GB-RyanNeural` | British male |
| `en-GB-SoniaNeural` | British female |

Full list: `edge-tts --list-voices`. For an offline alternative, swap `edge-tts` for `piper` in `render-demo.mjs` (not built in — open a follow-up if needed).

## Failure modes & how to recover

- **Playwright timeout on a locator** → the selector is wrong or the app state isn't ready. Re-read the view file, prefer a `role`/`text` locator, add a `waitFor` step before the click.
- **Long stretches of silence** → a step blocked far longer than its line. Quiet spans are time-compressed automatically; if one still drags, either lower `speedUpQuiet.keepSeconds` or add narrated `wait` steps ahead of the slow step. Read the "waited on the app" report the renderer prints.
- **A fast-forwarded span you wanted at full speed** → it had no narration, so the renderer treated it as dead time. Give that step a line, or set `"speedUpQuiet": false`.
- **A line lands after the thing it introduces** → set `"narrationAt": "start"` on that step.
- **Video and voice drift apart** → should be impossible now; the audio is built from recorded timings. If you see it, suspect a step that mutates the page *after* its action returns (an async re-render), and add a short `wait` to absorb it.
- **TTS sounds rushed** → split a step into two shorter ones, or insert a chapter step with a short narration line.
- **Audio out of sync after editing** → re-render from the JSON; never hand-edit the mp4.
