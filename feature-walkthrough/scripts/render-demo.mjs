#!/usr/bin/env node
// Narrated-demo renderer: TTS + Playwright video + ffmpeg mux.
//
// Usage: render-demo.mjs <script.json> [output-base] [--burn] [--keep-tmp]
//
// Output: <output-base>.mp4 and <output-base>.srt.

import { spawnSync, execFileSync, spawn } from 'node:child_process';
import {
  readFileSync, writeFileSync, mkdirSync, existsSync, rmSync, readdirSync, statSync, copyFileSync,
} from 'node:fs';
import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { dirname, join, resolve, basename } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
import { buildMarkdown, buildHtml } from './export-docs.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const skillRequire = createRequire(join(__dirname, 'package.json'));

// edge-tts may be installed in the skill's local venv or on PATH.
const EDGE_TTS = resolveEdgeTts();

// ---------- arg parsing ----------
const rawArgs = process.argv.slice(2);
const flags = new Set(rawArgs.filter((a) => a.startsWith('--')));
const positional = rawArgs.filter((a) => !a.startsWith('--'));
if (positional.length < 1) {
  console.error('Usage: render-demo.mjs <script.json> [output-base] [--burn] [--keep-tmp] [--no-video] [--no-md] [--no-html]');
  process.exit(2);
}
const scriptPath = resolve(positional[0]);
const scriptName = basename(scriptPath).replace(/\.json$/, '');
const KIND = 'feature-walkthrough';
// Default output: a per-walkthrough folder `<script-dir>/<name>/` holding
// <name>-feature-walkthrough.{mp4,srt,html,md} + images/. The skill suffix keeps
// these files distinguishable from a code-walkthrough of the same <name> (the two
// skills emit identically-stemmed artifacts otherwise). A positional output-base
// overrides the prefix verbatim.
const outputBase = positional[1] ? resolve(positional[1]) : join(dirname(scriptPath), scriptName, `${scriptName}-${KIND}`);
const outDir = dirname(outputBase);
const outName = basename(outputBase); // file stem the docs reference (e.g. for ./<stem>.mp4)
const imagesDir = join(outDir, 'images');
const burn = flags.has('--burn');
const keepTmp = flags.has('--keep-tmp');
const doVideo = !flags.has('--no-video');
const doMd = !flags.has('--no-md');
const doHtml = !flags.has('--no-html');

if (!existsSync(scriptPath)) die(`Script not found: ${scriptPath}`);

// ---------- dependency bootstrap ----------
// ffmpeg + edge-tts are only needed to produce the video; a docs-only pass
// (--no-video) drives the app for screenshots and needs just Node/chromium.
if (doVideo) ensureSystemDeps();
await ensureNodeDeps();
const playwrightEntry = skillRequire.resolve('playwright');
const playwrightMod = await import(pathToFileURL(playwrightEntry).href);
const chromium = playwrightMod.chromium || playwrightMod.default?.chromium;
if (!chromium) die('Could not load playwright chromium driver.');

// ---------- load script ----------
const script = JSON.parse(readFileSync(scriptPath, 'utf8'));
const voice = script.voice || 'en-US-AvaNeural';
const baseUrl = (script.baseUrl || 'http://localhost:8080').replace(/\/$/, '');
const viewport = script.viewport || { width: 1280, height: 800 };
const headless = script.headless !== false;
const steps = script.steps || [];
if (!steps.length) die('Script has no steps.');
const highlightsEnabled = script.highlights !== false;
const intro = resolveIntro(script);

log(`▶ ${script.title || basename(scriptPath)}`);
log(`  base=${baseUrl}  voice=${voice}  steps=${steps.length}  headless=${headless}`);

const tmpDir = `${outputBase}.tmp`;
if (existsSync(tmpDir)) rmSync(tmpDir, { recursive: true, force: true });
mkdirSync(tmpDir, { recursive: true });
mkdirSync(dirname(outputBase), { recursive: true });

// ---------- 1. synthesize narration (video only) ----------
//
// Only *synthesis* happens here. The narration track is assembled after the
// recording pass, because where each line belongs on the timeline is not
// knowable until the app has actually been driven — see step 2b.
const durations = new Array(steps.length).fill(0);
const audioPaths = new Array(steps.length);
// Filled by the recording pass: the wall-clock instant at which each step's
// narration should begin.
const speakWall = new Array(steps.length).fill(null);
// Wall-clock marks taken during the recording pass. Everything is converted to
// video time afterwards, against the video that was actually produced.
let wallStart = 0, wallReady = 0, wallEnd = 0;
// How long each step's action really took, for the drift report.
const actionMs = new Array(steps.length).fill(0);
let total = 0, introDuration = 0, introAudioPath = null, fullAudio = null;
let videoDuration = 0;

if (doVideo) {
  log('① Synthesizing narration…');
  const cacheDir = process.env.DEMO_VIDEO_TTS_CACHE_DIR
    || join(homedir(), '.cache', 'demo-video-tts');
  mkdirSync(cacheDir, { recursive: true });
  const stepLogs = new Array(steps.length);
  let cacheHits = 0;

  const synthStep = async (i) => {
    const s = steps[i];
    const text = (s.narration || '').trim();
    const audioPath = join(tmpDir, `seg-${String(i).padStart(4, '0')}.mp3`);
    if (text) {
      const key = createHash('sha256').update(`${voice}\x00${text}`).digest('hex').slice(0, 24);
      const cached = join(cacheDir, `${key}.mp3`);
      if (existsSync(cached)) {
        copyFileSync(cached, audioPath);
        cacheHits++;
      } else {
        await runAsync(EDGE_TTS[0], [...EDGE_TTS.slice(1), '--voice', voice, '--text', text, '--write-media', audioPath]);
        copyFileSync(audioPath, cached);
      }
      durations[i] = probeDuration(audioPath);
    } else {
      // Silent 0.4s placeholder so timing lines up cleanly.
      await runAsync('ffmpeg', [
        '-y', '-f', 'lavfi', '-i', 'anullsrc=r=24000:cl=mono', '-t', '0.4',
        '-q:a', '9', '-acodec', 'libmp3lame', audioPath,
      ]);
      durations[i] = 0.4;
    }
    audioPaths[i] = audioPath;
    stepLogs[i] = `   ${String(i + 1).padStart(2)}. ${fmtDuration(durations[i])}  ${truncate(text || '(silent)', 70)}`;
  };

  // Intro audio (silent unless intro.narration provided).
  const synthIntro = async () => {
    if (!intro) return;
    introAudioPath = join(tmpDir, 'intro.mp3');
    if (intro.narration) {
      const key = createHash('sha256').update(`${voice}\x00${intro.narration}`).digest('hex').slice(0, 24);
      const cached = join(cacheDir, `${key}.mp3`);
      if (existsSync(cached)) copyFileSync(cached, introAudioPath);
      else {
        await runAsync(EDGE_TTS[0], [...EDGE_TTS.slice(1), '--voice', voice, '--text', intro.narration, '--write-media', introAudioPath]);
        copyFileSync(introAudioPath, cached);
      }
      introDuration = probeDuration(introAudioPath);
      // If intro.ms is set and longer than narration, pad with silence; if shorter, use narration length.
      const targetSec = (intro.ms || 0) / 1000;
      if (targetSec > introDuration + 0.05) {
        const padded = join(tmpDir, 'intro-padded.mp3');
        await runAsync('ffmpeg', ['-y', '-i', introAudioPath, '-af', `apad=pad_dur=${(targetSec - introDuration).toFixed(3)}`, padded]);
        introAudioPath = padded;
        introDuration = probeDuration(padded);
      } else {
        introDuration = Math.max(introDuration, targetSec);
      }
    } else {
      introDuration = (intro.ms ?? 2500) / 1000;
      await runAsync('ffmpeg', [
        '-y', '-f', 'lavfi', '-i', 'anullsrc=r=24000:cl=mono', '-t', String(introDuration),
        '-q:a', '9', '-acodec', 'libmp3lame', introAudioPath,
      ]);
    }
  };

  // Synthesize all segments concurrently (capped). edge-tts is a cloud round-trip
  // per call, so the serial version dominated wall-clock; this collapses it.
  await Promise.all([synthIntro(), mapLimit(steps.length, 6, synthStep)]);

  if (intro) log(`   intro: ${fmtDuration(introDuration)}  ${truncate(intro.narration || intro.title || '(silent)', 60)}`);
  for (const line of stepLogs) log(line);

  total = introDuration + durations.reduce((a, b) => a + b, 0);
  log(`  total narration: ${fmtDuration(total)}  (${cacheHits}/${steps.length} cached)`);

  // The .srt and the mixed narration track are built in 2b, once the recorder
  // knows when each line's moment actually arrived.
}

// ---------- 2. drive the app: record video (optional) + capture per-step shots ----------
//
// Clean-first-frame strategy for the video (unchanged): render the intro CARD as
// a PNG, ffmpeg it into intro.mp4, then in the recording context navigate to the
// first URL ASAP and trim the about:blank flash (`demoTrimMs`). For the docs we
// also screenshot the page at the end of each step into images/ — those shots +
// the narration become the MD/HTML step-by-step summary.
log(doVideo ? '② Recording…' : '② Capturing steps…');
const totalIntroMs = intro ? Math.round(introDuration * 1000) : 0;
const cardMs = (intro && intro.type !== 'preroll') ? Math.min(intro.ms ?? 2500, totalIntroMs) : 0;
const overflowMs = (intro && intro.type !== 'preroll') ? totalIntroMs - cardMs : 0;
const browser = await chromium.launch({ headless });

const devToolsInitScript = () => {
  const css = `vaadin-dev-tools, copilot-main, vaadin-dev-tools-info { display: none !important; }`;
  const inject = () => {
    if (!document.head) return false;
    const style = document.createElement('style');
    style.textContent = css;
    document.head.appendChild(style);
    return true;
  };
  if (!inject()) document.addEventListener('DOMContentLoaded', inject, { once: true });
};

if (doMd || doHtml) mkdirSync(imagesDir, { recursive: true });
const shotPaths = new Array(steps.length).fill(null);
let mp4 = null, htmlPath = null, mdPath = null;

try {
  // Intro card → looped mp4 (video only).
  let introVideoPath = null;
  if (doVideo && intro) {
    const introCtx = await browser.newContext({ viewport });
    if (script.hideDevTools !== false) await introCtx.addInitScript(devToolsInitScript);
    const introPage = await introCtx.newPage();
    const firstStep = steps[0];
    const introMs = intro.type === 'preroll' ? totalIntroMs : cardMs;
    if (intro.type === 'preroll' && firstStep?.action?.type === 'goto') {
      await runAction(introPage, firstStep.action, baseUrl);
    } else {
      await introPage.setContent(renderIntroHtml(intro), { waitUntil: 'load' });
    }
    await introPage.waitForTimeout(150);
    const introPng = join(tmpDir, 'intro.png');
    await introPage.screenshot({ path: introPng, fullPage: false });
    await introCtx.close();
    introVideoPath = join(tmpDir, 'intro.mp4');
    run('ffmpeg', [
      '-y', '-loop', '1', '-t', (introMs / 1000).toFixed(3), '-i', introPng,
      '-vf', `scale=${viewport.width}:${viewport.height},setsar=1,fps=25,format=yuv420p`,
      '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '23', '-pix_fmt', 'yuv420p',
      introVideoPath,
    ], { quiet: true });
  }

  let demoTrimMs = 0;
  // Grant clipboard access so demos that drive the browser Clipboard API
  // (copy/paste buttons) succeed in headless Chromium instead of throwing
  // NotAllowedError. Harmless for demos that don't touch the clipboard.
  const clipboardPerms = ['clipboard-read', 'clipboard-write'];
  const context = await browser.newContext(doVideo
    ? { viewport, permissions: clipboardPerms, recordVideo: { dir: tmpDir, size: viewport } }
    : { viewport, permissions: clipboardPerms });
  if (script.hideDevTools !== false) await context.addInitScript(devToolsInitScript);
  const page = await context.newPage();
  // Capture is rolling from here. Every later mark is relative to this instant
  // and is rescaled onto the finished video below, rather than assumed equal to it.
  wallStart = Date.now();
  try {
    // The instant the demo proper is on screen; everything before it is the
    // about:blank flash and gets trimmed.
    wallReady = Date.now();
    let firstStepConsumed = false;
    if (doVideo && intro) {
      const firstStep = steps[0];
      if (firstStep?.action?.type === 'goto') {
        await runAction(page, firstStep.action, baseUrl);
        firstStepConsumed = true;
      } else {
        await page.goto('about:blank');
      }
      await page.waitForTimeout(150);
      wallReady = Date.now();
      if (overflowMs > 0) await page.waitForTimeout(overflowMs);
    }

    let boxesThisStep = [], boxesPersist = false;
    for (let i = 0; i < steps.length; i++) {
      const s = steps[i];
      const narrationMs = Math.round(durations[i] * 1000);
      const start = Date.now();
      boxesThisStep = []; boxesPersist = false;
      try {
        const action = (i === 0 && firstStepConsumed) ? null : s.action;
        await runAction(page, action, baseUrl, { onBox: (id, persist) => { boxesThisStep.push(id); if (persist) boxesPersist = true; } });
      } catch (err) {
        console.error(`\n✗ Step ${i + 1} failed: ${err.message}`);
        console.error(`  Narration: "${s.narration}"`);
        console.error(`  Action:    ${JSON.stringify(s.action)}`);
        throw err;
      }
      if (doVideo) {
        const actionDone = Date.now();
        actionMs[i] = actionDone - start;
        // When does this line get spoken?
        //
        //  - A step that finished quickly keeps the old behaviour: the voice
        //    starts with the step, so it leads the click rather than trailing it.
        //  - A step that *blocked* — a `waitFor` on a live app, a slow navigation —
        //    holds its line until the action is done, because the line describes
        //    what the action produced and must not play while it is still coming.
        //  - Pure pacing steps (`wait`, or no action) always speak from the top:
        //    giving the voice something to say while the screen is busy is their
        //    entire job.
        //
        // `narrationAt: "start" | "end"` overrides per step.
        const paced = !s.action || s.action.type === 'wait';
        const fast = (actionDone - start) <= (script.leadMs ?? 1200);
        const at = s.narrationAt || s.action?.narrationAt || 'auto';
        const speakAtStart = at === 'start' || (at === 'auto' && (paced || fast));
        const speakFrom = speakAtStart ? start : actionDone;
        speakWall[i] = speakFrom;
        const remaining = (speakFrom + narrationMs) - Date.now();
        if (remaining > 0) await page.waitForTimeout(remaining);
      } else {
        await page.waitForTimeout(200); // let the UI settle before the shot
      }
      // Per-step screenshot for the docs (after the action settles, before clearing boxes).
      if (doMd || doHtml) {
        const shot = join(imagesDir, `step-${String(i + 1).padStart(2, '0')}.png`);
        try { await page.screenshot({ path: shot }); shotPaths[i] = shot; } catch (e) { /* skip a bad shot */ }
      }
      if (boxesThisStep.length && !boxesPersist) {
        for (const id of boxesThisStep) await clearBoxes(page, id);
      }
    }
    // Let the final frame breathe rather than cutting on the last syllable.
    if (doVideo) await page.waitForTimeout(script.tailMs ?? 1200);
    wallEnd = Date.now();
  } finally {
    await context.close(); // flushes the video file
  }

  // ---------- 2b. lay the narration onto the timeline that was recorded -------
  //
  // This used to be a blind concatenation of the segments, done before the
  // browser ever opened. That silently assumed every step lasted exactly as long
  // as its own narration — which is false the moment a step waits on a live app.
  // One `waitFor` blocking for a minute put the voice a minute ahead of the
  // picture for the whole remainder of the video, and `-shortest` then cut off
  // the tail, so the steps the narrator had already described were never shown.
  //
  // Now each line is placed at the millisecond the recorder saw its moment
  // arrive, with silence covering the gaps.
  // ---------- 2a. put the wall clock onto the video's own clock ---------------
  //
  // The recorder can only mark *when* things happened by the wall clock, and the
  // finished video does not run on the wall clock: Playwright starts capturing at
  // context creation (not at the first navigation), and a screencast's real frame
  // rate drifts from wall time under load. Assuming the two were identical is what
  // put the narration out of step in the first place — and, once quiet spans were
  // being cut, made the cuts land in the middle of real content.
  //
  // So calibrate: the recording covers a known wall-clock span and produced a video
  // of known length, which fixes the scale between them. Everything downstream is
  // expressed in seconds of the finished video.
  let demoVideoFile = null, demoSeekSec = 0;
  let mapTl = (sec) => sec;          // video seconds → finished-video seconds
  let tlOf = (wall) => 0;            // wall-clock ms → finished-video seconds
  const cardSec = cardMs / 1000;
  let endSec = 0;
  if (doVideo) {
    demoVideoFile = newestFile(tmpDir, '.webm');
    if (!demoVideoFile) die('Playwright did not produce a video file.');

    const rawDur = probeDurationLoose(demoVideoFile);
    const wallSpan = (wallEnd - wallStart) / 1000;
    const scale = (rawDur > 0 && wallSpan > 0) ? rawDur / wallSpan : 1;
    const vid = (wall) => ((wall - wallStart) / 1000) * scale;   // → seconds into the raw file
    const trimSec = Math.max(0, vid(wallReady));
    demoSeekSec = trimSec;
    tlOf = (wall) => cardSec + (vid(wall) - trimSec);
    endSec = tlOf(wallEnd);
    if (Math.abs(scale - 1) > 0.02) {
      log(`   capture ran at ×${scale.toFixed(3)} of wall time (${fmtDuration(wallSpan)} → ${fmtDuration(rawDur)}) — corrected`);
    }
  }

  // ---------- 2b. speed up the spans where nobody is talking ------------------
  //
  // With the narration correctly held back, a step that blocks for a minute is a
  // minute of silence. Filling all of it with talk is one answer and often the
  // wrong one — nobody needs ninety seconds of commentary on a spinner. So the
  // quiet spans are played fast, which is what a human editor would do.
  if (doVideo) {
    const cfg = script.speedUpQuiet === false ? null : {
      minSeconds: 3.5, factor: 8, keepSeconds: 2.5,
      ...(typeof script.speedUpQuiet === 'object' ? script.speedUpQuiet : {}),
    };

    // Narration spans in finished-video seconds. The intro voice-over may run past
    // the intro card and over the start of the demo, so it occupies [0, introDuration).
    const introEndSec = introAudioPath ? introDuration : 0;
    const spans = [];
    let c = introEndSec;
    for (let i = 0; i < steps.length; i++) {
      const st = Math.max(speakWall[i] != null ? tlOf(speakWall[i]) : c, c);
      const en = st + durations[i];
      spans.push({ st, en });
      c = en;
    }
    endSec = Math.max(endSec, c);

    // A quiet span is any gap between one narration span and the next. Nothing
    // before introEndSec is ever touched — the intro voice-over is playing there.
    const zones = [];
    if (cfg) {
      let prev = introEndSec;
      for (const sp of spans) {
        if (sp.st - prev >= cfg.minSeconds) zones.push({ a: prev, b: sp.st });
        prev = sp.en;
      }
    }

    if (zones.length) {
      // Piecewise plan across the demo portion of the finished video.
      const plan = [];
      let cur = cardSec;
      for (const z of zones) {
        if (z.a > cur) plan.push({ a: cur, b: z.a, k: 1 });
        const len = z.b - z.a;
        const keep = Math.max(cfg.keepSeconds, len / cfg.factor);
        plan.push({ a: z.a, b: z.b, k: len / keep });
        cur = z.b;
      }
      if (endSec > cur) plan.push({ a: cur, b: endSec, k: 1 });

      const marks = [];
      let outCur = cardSec;
      for (const seg of plan) {
        marks.push({ ...seg, out: outCur });
        outCur += (seg.b - seg.a) / seg.k;
      }
      mapTl = (sec) => {
        if (sec <= cardSec) return sec;
        for (const m of marks) if (sec <= m.b) return m.out + (sec - m.a) / m.k;
        return outCur;
      };

      // Rebuild the demo stream. Times are seconds into the raw file, so the trim
      // folds in here and the mux no longer seeks.
      const toStream = (sec) => demoSeekSec + (sec - cardSec);
      const n = plan.length;
      const parts = [`[0:v]split=${n}${plan.map((_, i) => `[s${i}]`).join('')}`];
      plan.forEach((seg, i) => {
        const pts = seg.k === 1 ? 'PTS-STARTPTS' : `(PTS-STARTPTS)/${seg.k.toFixed(6)}`;
        parts.push(`[s${i}]trim=start=${toStream(seg.a).toFixed(3)}:end=${toStream(seg.b).toFixed(3)},setpts=${pts}[p${i}]`);
      });
      parts.push(`${plan.map((_, i) => `[p${i}]`).join('')}concat=n=${n}:v=1:a=0[outv]`);
      const compressed = join(tmpDir, 'demo-compressed.mp4');
      run('ffmpeg', ['-y', '-i', demoVideoFile, '-filter_complex', parts.join(';'),
        '-map', '[outv]', '-an', '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '23',
        '-pix_fmt', 'yuv420p', compressed], { quiet: true });
      demoVideoFile = compressed;
      demoSeekSec = 0;

      const saved = zones.reduce((t, z) => t + (z.b - z.a), 0)
        - plan.filter((x) => x.k !== 1).reduce((t, x) => t + (x.b - x.a) / x.k, 0);
      log(`   sped up ${zones.length} quiet span(s) — ${fmtDuration(saved)} of silence removed`);
      for (const z of zones.slice(0, 5)) {
        const len = z.b - z.a;
        const keep = Math.max(cfg.keepSeconds, len / cfg.factor);
        log(`     ${fmtDuration(len)} → ${fmtDuration(keep)}  (×${(len / keep).toFixed(1)})`);
      }
    }
  }

  if (doVideo) {
    const pieces = [];
    const cues = [];
    let cursorMs = 0;
    if (introAudioPath) {
      pieces.push(introAudioPath);
      cursorMs = Math.round(introDuration * 1000);
      const introText = (intro.narration || '').trim()
        || (intro.type === 'preroll' ? '' : intro.title || '');
      if (introText) cues.push({ start: 0, end: cursorMs / 1000, text: introText });
    }
    let silences = 0;
    for (let i = 0; i < steps.length; i++) {
      const wantMs = speakWall[i] != null
        ? Math.round(mapTl(tlOf(speakWall[i])) * 1000)
        : cursorMs;
      // Never overlap: a line can be late (rounding, a slow screenshot) but it
      // must not be spoken over the one before it.
      const placedMs = Math.max(wantMs, cursorMs);
      const gap = placedMs - cursorMs;
      if (gap >= 20) {
        const sil = join(tmpDir, `sil-${String(silences++).padStart(4, '0')}.mp3`);
        run('ffmpeg', ['-y', '-f', 'lavfi', '-i', 'anullsrc=r=24000:cl=mono',
          '-t', (gap / 1000).toFixed(3), '-q:a', '9', '-acodec', 'libmp3lame', sil],
          { quiet: true });
        pieces.push(sil);
        cursorMs = placedMs;
      }
      pieces.push(audioPaths[i]);
      const endMs = cursorMs + Math.round(durations[i] * 1000);
      cues.push({ start: cursorMs / 1000, end: endMs / 1000,
        text: (steps[i].narration || '').trim() || '♪' });
      cursorMs = endMs;
    }

    const concatList = pieces.map((f) => `file '${f.replace(/'/g, "'\\''")}'`).join('\n');
    const concatPath = join(tmpDir, 'concat.txt');
    writeFileSync(concatPath, concatList);
    fullAudio = join(tmpDir, 'narration.mp3');
    run('ffmpeg', ['-y', '-f', 'concat', '-safe', '0', '-i', concatPath, '-c', 'copy', fullAudio],
      { quiet: true });
    writeFileSync(`${outputBase}.srt`, buildSrt(cues));

    // Report the steps whose action outran the line attached to it. These are
    // where the old pipeline lost sync, and they are the places an author most
    // often wants another narrated `wait` so the video is not silent.
    const slow = steps.map((s, i) => ({ i, ms: actionMs[i], narr: Math.round(durations[i] * 1000) }))
      .filter((x) => x.ms - x.narr > 2000)
      .sort((a, b) => b.ms - a.ms);
    if (slow.length) {
      log(`   waited on the app in ${slow.length} step(s) — narration held until each was ready:`);
      for (const x of slow.slice(0, 5)) {
        log(`     step ${String(x.i + 1).padStart(2)}: action ${fmtDuration(x.ms / 1000)}`
          + ` vs narration ${fmtDuration(x.narr / 1000)}`);
      }
      log(`   → that is silence on screen. Add narrated \`wait\` steps before those`);
      log(`     steps if you want the voice to cover the app's thinking time.`);
    }
  }

  // ---------- 3. mux video (optional) ----------
  if (doVideo) {
    const videoFile = demoVideoFile;
    log('③ Muxing…');
    mp4 = `${outputBase}.mp4`;
    const srtEsc = `${outputBase}.srt`.replace(/'/g, "'\\''").replace(/:/g, '\\:');
    const muxArgs = ['-y'];
    if (introVideoPath) {
      muxArgs.push('-i', introVideoPath);
      if (demoSeekSec > 0) muxArgs.push('-ss', demoSeekSec.toFixed(3));
      muxArgs.push('-i', videoFile);
    } else {
      muxArgs.push('-i', videoFile);
    }
    muxArgs.push('-i', fullAudio);
    if (introVideoPath) {
      const norm = `scale=${viewport.width}:${viewport.height},setsar=1,fps=25,format=yuv420p`;
      let filter = `[0:v]${norm}[i];[1:v]${norm}[d];[i][d]concat=n=2:v=1:a=0`;
      if (burn) filter += `[c];[c]subtitles='${srtEsc}'[outv]`;
      else      filter += `[outv]`;
      muxArgs.push('-filter_complex', filter);
      muxArgs.push('-map', '[outv]', '-map', '2:a:0');
    } else {
      if (burn) muxArgs.push('-vf', `subtitles='${srtEsc}'`);
      muxArgs.push('-map', '0:v:0', '-map', '1:a:0');
    }
    // No `-shortest`: the audio track is exactly as long as it needs to be, and
    // the video is the thing being documented. Truncating to the voice is what
    // used to drop the end of the demo.
    muxArgs.push('-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '23',
      '-c:a', 'aac', '-b:a', '160k', '-movflags', '+faststart', mp4);
    run('ffmpeg', muxArgs, { quiet: true });
    videoDuration = probeDuration(mp4);
  }

  // ---------- 4. documents (MD + HTML) — narration + per-step screenshot ----------
  if (doMd || doHtml) {
    log('④ Building docs…');
    const docSteps = steps.map((s, i) => ({
      index: i + 1,
      narration: (s.narration || '').trim(),
      shot: shotPaths[i] ? `images/${basename(shotPaths[i])}` : null,
    })).filter((d) => d.narration || d.shot);
    const ctx = { name: outName, title: script.title, hasVideo: !!mp4 };
    if (doHtml) { htmlPath = `${outputBase}.html`; writeFileSync(htmlPath, buildHtml(docSteps, intro, ctx)); }
    if (doMd) { mdPath = `${outputBase}.md`; writeFileSync(mdPath, buildMarkdown(docSteps, intro, ctx)); }
  }
} finally {
  await browser.close();
}

if (!keepTmp) rmSync(tmpDir, { recursive: true, force: true });

log('');
if (mp4) { log(`✓ Video:    ${mp4}`); log(`✓ Captions: ${outputBase}.srt`); }
if (htmlPath) log(`✓ HTML:     ${htmlPath}`);
if (mdPath) log(`✓ Markdown: ${mdPath}`);
log(`  Folder:   ${outDir}`);
if (videoDuration) log(`  Duration: ${fmtDuration(videoDuration)}  (narration ${fmtDuration(total)})`);
else if (total) log(`  Duration: ${fmtDuration(total)}`);

// =============================================================
// helpers
// =============================================================

async function runAction(page, action, baseUrl, ctx = {}) {
  if (!action) return; // chapter / silent step
  const t = action.type;
  // For typing actions, hint the locator to target the inner <input> when only `placeholder` is given.
  const fillable = t === 'fill' || t === 'type';
  const action2 = fillable ? { ...action, fillable: true } : action;
  switch (t) {
    case 'goto': {
      const url = /^https?:/.test(action.url) ? action.url : baseUrl + (action.url.startsWith('/') ? action.url : '/' + action.url);
      // Vaadin keeps a push channel open, so 'networkidle' often never fires and
      // would block on the full goto timeout. Load fast, then briefly settle.
      await page.goto(url, { waitUntil: 'domcontentloaded' });
      await page.waitForLoadState('networkidle', { timeout: 2500 }).catch(() => {});
      break;
    }
    case 'click':   await locator(page, action).click();                                            break;
    case 'fill':    await locator(page, action2).fill(String(action.value ?? ''));                    break;
    case 'type':    await locator(page, action2).pressSequentially(String(action.value ?? ''), { delay: action.delay ?? 60 }); break;
    case 'press':   await page.keyboard.press(action.key);                                           break;
    // Attach local file(s) to a file input. `files` (or `file`) are paths, resolved
    // against the script's directory when relative. Targets the first
    // `input[type=file]` on the page unless a locator is given — which is what you
    // want for component libraries that hide the real input inside an upload widget.
    case 'upload': {
      const list = (action.files ?? [action.file]).filter(Boolean)
        .map(f => (f.startsWith('/') ? f : resolve(dirname(scriptPath), f)));
      const target = (action.selector || action.role || action.text || action.label
        || action.placeholder || action.testId)
        ? locator(page, action)
        : page.locator('input[type=file]').first();
      await target.setInputFiles(list);
      break;
    }
    case 'hover':   await locator(page, action).hover();                                             break;
    case 'waitFor': await locator(page, action).waitFor({ state: action.state || 'visible', timeout: action.timeout ?? 10000 }); break;
    // `wait` with a locator means "up to ms, but stop as soon as this appears" —
    // so a run of narrated waits covering a slow backend collapses the moment the
    // result lands instead of stalling on a screen that is already finished.
    case 'wait': {
      const ms = action.ms ?? 500;
      const hasTarget = action.selector || action.role || action.text || action.label
        || action.placeholder || action.testId;
      if (hasTarget) await locator(page, action).waitFor({ state: 'visible', timeout: ms }).catch(() => {});
      else await page.waitForTimeout(ms);
      break;
    }
    case 'scroll':  await locator(page, action).scrollIntoViewIfNeeded();                            break;
    case 'highlight': {
      const loc = locator(page, action);
      await loc.evaluate((el) => {
        const prevOutline = el.style.outline;
        const prevOffset = el.style.outlineOffset;
        const prevTransition = el.style.transition;
        el.style.transition = 'outline 150ms ease';
        el.style.outline = '3px solid #ff5722';
        el.style.outlineOffset = '3px';
        setTimeout(() => {
          el.style.outline = prevOutline;
          el.style.outlineOffset = prevOffset;
          el.style.transition = prevTransition;
        }, 1500);
      });
      break;
    }
    case 'screenshot': await page.screenshot({ path: action.path, fullPage: !!action.fullPage });    break;
    case 'clearCookies': await page.context().clearCookies(); break;
    case 'box': {
      if (!highlightsEnabled) break;
      const id = action.id || `box-${Math.random().toString(36).slice(2, 9)}`;
      let rect = action.rect;
      if (!rect && hasLocatorField(action)) {
        const loc = locator(page, action);
        try {
          await loc.waitFor({ state: 'visible', timeout: action.timeout ?? 5000 });
        } catch {
          throw new Error(`box: target not visible (${describeLocator(action)})`);
        }
        const box = await loc.boundingBox({ timeout: 2000 });
        if (!box) throw new Error('box: target element has no bounding box');
        const p = action.pad ?? 6;
        rect = { x: box.x - p, y: box.y - p, width: box.width + 2 * p, height: box.height + 2 * p };
      }
      if (!rect) throw new Error('box: needs either a locator (selector/role/text/label/placeholder/testId) or rect: {x,y,width,height}');
      await drawBox(page, { rect, id, caption: action.caption, color: action.color, style: action.style });
      if (ctx.onBox) ctx.onBox(id, !!action.persist);
      break;
    }
    case 'clearBoxes': {
      if (!highlightsEnabled) break;
      await clearBoxes(page, action.id);
      break;
    }
    default: throw new Error(`Unknown action type: ${t}`);
  }
}

function hasLocatorField(a) {
  return !!(a.selector || a.role || a.label || a.placeholder || a.text || a.testId);
}

function describeLocator(a) {
  if (a.selector) return `selector=${a.selector}`;
  if (a.role) return `role=${a.role}${a.name ? ` name=${a.name}` : ''}`;
  if (a.label) return `label=${a.label}`;
  if (a.placeholder) return `placeholder=${a.placeholder}`;
  if (a.text) return `text=${a.text}`;
  if (a.testId) return `testId=${a.testId}`;
  return JSON.stringify(a);
}

function resolveIntro(script) {
  if (script.intro === false) return null;
  if (!script.intro || script.intro === true) {
    return { title: script.title || 'Demo', ms: 2500 };
  }
  const intro = { ...script.intro };
  if (intro.type !== 'preroll') {
    intro.title = intro.title ?? script.title ?? 'Demo';
    intro.ms = intro.ms ?? 2500;
  } else {
    intro.ms = intro.ms ?? 1500;
  }
  return intro;
}

function renderIntroHtml(intro) {
  const bg = intro.background || 'linear-gradient(135deg, #1976d2 0%, #1a2d4a 100%)';
  const color = intro.color || '#ffffff';
  const title = escapeHtml(intro.title || '');
  const subtitle = escapeHtml(intro.subtitle || '');
  const note = escapeHtml(intro.note || '');
  return `<!doctype html><html><head><meta charset="utf-8"><style>
    html,body { margin:0; height:100%; }
    body { background: ${bg}; color: ${color};
      font: 500 16px/1.4 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
      display:flex; align-items:center; justify-content:center; flex-direction:column;
      text-align:center; padding: 4vmin; box-sizing:border-box; }
    .title { font-size: clamp(40px, 7vmin, 80px); font-weight: 700; letter-spacing: -0.02em; margin: 0 0 0.3em; }
    .subtitle { font-size: clamp(18px, 2.6vmin, 28px); opacity: 0.85; font-weight: 400; max-width: 32em; }
    .note { margin-top: 1.4em; font-size: clamp(13px, 1.6vmin, 16px); opacity: 0.6; }
  </style></head><body>
    <div class="title">${title}</div>
    ${subtitle ? `<div class="subtitle">${subtitle}</div>` : ''}
    ${note ? `<div class="note">${note}</div>` : ''}
  </body></html>`;
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

async function drawBox(page, { rect, caption, color = '#ff5722', style = 'solid', id, fade = true }) {
  await page.evaluate((args) => {
    const { rect, caption, color, style, id, fade } = args;
    let root = document.querySelector('#__demo_overlay__');
    if (!root) {
      root = document.createElement('div');
      root.id = '__demo_overlay__';
      Object.assign(root.style, {
        position: 'fixed', inset: '0', pointerEvents: 'none', zIndex: '2147483647',
      });
      document.documentElement.appendChild(root);
    }
    // Modal overlays (Vaadin dialogs, <dialog>, popovers) paint in the browser's
    // *top layer*, which sits above every z-index — so the plain div above can't
    // annotate anything inside a dialog. Promote the overlay root into the top
    // layer too, and re-promote on every draw: top-layer stacking follows
    // promotion order, so a dialog opened after us would cover the boxes again.
    try {
      if (!root.hasAttribute('popover')) {
        root.setAttribute('popover', 'manual');
        // Neutralize the UA popover styles (fit-content box, border, background).
        Object.assign(root.style, {
          width: '100vw', height: '100vh', margin: '0', padding: '0',
          border: '0', background: 'transparent', overflow: 'visible',
        });
      }
      if (root.matches(':popover-open')) root.hidePopover();
      root.showPopover();
    } catch { /* no popover support — the z-index above remains the fallback */ }
    const prev = root.querySelector(`[data-box-id="${id}"]`);
    if (prev) prev.remove();
    const box = document.createElement('div');
    box.setAttribute('data-box-id', id);
    Object.assign(box.style, {
      position: 'absolute',
      left: rect.x + 'px',
      top: rect.y + 'px',
      width: rect.width + 'px',
      height: rect.height + 'px',
      border: `3px ${style} ${color}`,
      borderRadius: '6px',
      boxShadow: `0 0 0 9999px rgba(0,0,0,0.0)`,
      transition: fade ? 'opacity 200ms ease, transform 200ms ease' : 'none',
      opacity: '0',
      transform: 'scale(1.03)',
      boxSizing: 'border-box',
    });
    if (caption) {
      const lbl = document.createElement('div');
      lbl.textContent = caption;
      Object.assign(lbl.style, {
        position: 'absolute',
        top: '-1.9em',
        left: '-3px',
        background: color,
        color: '#fff',
        font: '600 13px/1.4 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif',
        padding: '3px 9px',
        borderRadius: '4px 4px 4px 0',
        whiteSpace: 'nowrap',
        boxShadow: '0 1px 3px rgba(0,0,0,0.2)',
      });
      box.appendChild(lbl);
    }
    root.appendChild(box);
    // Animate in on next frame.
    requestAnimationFrame(() => {
      box.style.opacity = '1';
      box.style.transform = 'scale(1)';
    });
  }, { rect, caption, color, style, id, fade });
}

async function clearBoxes(page, id) {
  await page.evaluate((args) => {
    const root = document.querySelector('#__demo_overlay__');
    if (!root) return;
    if (args.id) {
      const el = root.querySelector(`[data-box-id="${args.id}"]`);
      if (el) {
        el.style.opacity = '0';
        setTimeout(() => el.remove(), 220);
      }
    } else {
      for (const el of root.querySelectorAll('[data-box-id]')) {
        el.style.opacity = '0';
        setTimeout(() => el.remove(), 220);
      }
    }
  }, { id });
}

function placeholderLocator(page, placeholder, fillable) {
  const esc = placeholder.replace(/"/g, '\\"');
  // When filling, target the inner input/textarea (Vaadin mirrors placeholder onto both host and input).
  if (fillable) {
    return page.locator(`input[placeholder="${esc}"], textarea[placeholder="${esc}"]`).first();
  }
  return page.getByPlaceholder(placeholder).first();
}

function locator(page, a) {
  if (a.selector)    return page.locator(a.selector).first();
  if (a.role)        return page.getByRole(a.role, a.name ? { name: a.name } : undefined).first();
  if (a.label)       return page.getByLabel(a.label).first();
  if (a.placeholder) return placeholderLocator(page, a.placeholder, a.fillable);
  if (a.text)        return page.getByText(a.text, a.exact ? { exact: true } : undefined).first();
  if (a.testId)      return page.getByTestId(a.testId).first();
  throw new Error(`No locator on action: ${JSON.stringify(a)}`);
}

function buildSrt(cues) {
  const out = [];
  let idx = 1;
  for (const c of cues) {
    out.push(String(idx++));
    out.push(`${fmtSrtTime(c.start)} --> ${fmtSrtTime(c.end)}`);
    out.push(c.text);
    out.push('');
  }
  return out.join('\n');
}

function fmtSrtTime(s) {
  const h  = Math.floor(s / 3600);
  const m  = Math.floor((s % 3600) / 60);
  const sec = Math.floor(s % 60);
  const ms = Math.round((s - Math.floor(s)) * 1000);
  return `${pad(h, 2)}:${pad(m, 2)}:${pad(sec, 2)},${pad(ms, 3)}`;
}

function fmtDuration(s) {
  if (s < 60) return `${s.toFixed(1)}s`;
  const m = Math.floor(s / 60);
  const r = s - m * 60;
  return `${m}m${r.toFixed(0).padStart(2, '0')}s`;
}

function pad(n, w) { return String(n).padStart(w, '0'); }

function truncate(s, n) { return s.length <= n ? s : s.slice(0, n - 1) + '…'; }

function probeDurationLoose(file) {
  try { return probeDuration(file); } catch { /* fall through */ }
  // Matroska written by a live screencast often has no duration in the header.
  const out = spawnSync('ffmpeg', ['-i', file, '-f', 'null', '-'], { encoding: 'utf8' });
  const log = `${out.stderr || ''}`;
  let last = 0;
  for (const m of log.matchAll(/time=(\d+):(\d\d):(\d\d(?:\.\d+)?)/g)) {
    last = Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]);
  }
  if (!last) die(`Could not determine the duration of ${file}`);
  return last;
}

function probeDuration(file) {
  const out = execFileSync('ffprobe', [
    '-v', 'error',
    '-show_entries', 'format=duration',
    '-of', 'default=noprint_wrappers=1:nokey=1',
    file,
  ], { encoding: 'utf8' }).trim();
  const d = parseFloat(out);
  if (!isFinite(d) || d <= 0) throw new Error(`ffprobe could not read duration of ${file}`);
  return d;
}

function newestFile(dir, ext) {
  const matches = readdirSync(dir)
    .filter((f) => f.endsWith(ext))
    .map((f) => ({ f, mtime: statSync(join(dir, f)).mtimeMs }))
    .sort((a, b) => b.mtime - a.mtime);
  return matches[0] ? join(dir, matches[0].f) : null;
}

function run(cmd, args, { quiet = false, cwd } = {}) {
  const res = spawnSync(cmd, args, {
    stdio: quiet ? 'pipe' : 'inherit',
    encoding: 'utf8',
    cwd,
  });
  if (res.status !== 0) {
    if (quiet && res.stderr) process.stderr.write(res.stderr);
    throw new Error(`${cmd} exited with ${res.status}`);
  }
  return res;
}

function runAsync(cmd, args, { cwd } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: ['ignore', 'ignore', 'pipe'], cwd });
    let stderr = '';
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) resolve();
      else { if (stderr) process.stderr.write(stderr); reject(new Error(`${cmd} exited with ${code}`)); }
    });
  });
}

// Run `fn(i)` for i in [0,n) with at most `limit` in flight at once.
async function mapLimit(n, limit, fn) {
  let next = 0;
  async function worker() {
    while (next < n) await fn(next++);
  }
  await Promise.all(Array.from({ length: Math.min(limit, n) }, worker));
}

function which(cmd) {
  const res = spawnSync('sh', ['-c', `command -v ${cmd}`], { encoding: 'utf8' });
  return res.status === 0 ? res.stdout.trim() : null;
}

// Resolve edge-tts as an argv PREFIX (command + leading args). We invoke the
// module through the venv's python (`python3 -m edge_tts`) rather than the
// venv's `bin/edge-tts` console script: that script's shebang hardcodes the
// venv's absolute path at creation time, so it breaks the moment the skill dir
// is copied or renamed (e.g. across ~/.codex, ~/.claude, …). `python -m` ignores
// the shebang and uses the venv's site-packages, so it stays portable.
function resolveEdgeTts() {
  const py = join(__dirname, '.venv', 'bin', 'python3');
  if (existsSync(py) && runsOk(py, ['-m', 'edge_tts', '--help'])) return [py, '-m', 'edge_tts'];
  if (runsOk('edge-tts', ['--help'])) return ['edge-tts'];                       // console script on PATH
  if (runsOk('python3', ['-m', 'edge_tts', '--help'])) return ['python3', '-m', 'edge_tts'];
  return null; // not found — ensureSystemDeps reports it (only needed for video)
}

function runsOk(cmd, args) { const r = spawnSync(cmd, args, { stdio: 'ignore' }); return r.status === 0; }

function ensureSystemDeps() {
  const missing = [];
  if (!which('ffmpeg'))   missing.push('ffmpeg');
  if (!which('ffprobe'))  missing.push('ffprobe (part of ffmpeg)');
  if (!EDGE_TTS) missing.push('edge-tts');
  if (!missing.length) return;
  console.error('Missing required tools: ' + missing.join(', '));
  console.error('');
  console.error('Install on Debian/Ubuntu:');
  console.error('  sudo apt-get update && sudo apt-get install -y ffmpeg python3-pip');
  console.error('  pip3 install --user edge-tts   # then ensure ~/.local/bin is on PATH');
  console.error('');
  console.error('Install on macOS:');
  console.error('  brew install ffmpeg');
  console.error('  pip3 install --user edge-tts');
  process.exit(3);
}

async function ensureNodeDeps() {
  const nodeModules = join(__dirname, 'node_modules', 'playwright');
  if (existsSync(nodeModules)) return;
  log('First run — installing playwright (this takes a minute)…');
  run('npm', ['install', '--silent', '--no-audit', '--no-fund'], { cwd: __dirname });
  log('Installing chromium browser…');
  run('npx', ['--yes', 'playwright', 'install', 'chromium'], { cwd: __dirname });
}

function log(msg) { process.stderr.write(msg + '\n'); }
function die(msg) { console.error(msg); process.exit(1); }
