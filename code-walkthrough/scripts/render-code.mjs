#!/usr/bin/env node
// code-walkthrough renderer: narrated walkthrough of CODE and its effect on the UI.
//
// Reuses the feature-walkthrough pipeline (edge-tts + Playwright video + ffmpeg mux) but
// instead of driving a live app it drives a "stage" page (stage.html) that
// renders syntax-highlighted code, diffs, before/after UI comparisons, and
// Mermaid diagrams — paced to the narration.
//
// Usage: render-code.mjs <script.json> [output-base] [--burn] [--keep-tmp]
// Output: <output-base>.mp4 and <output-base>.srt
//
// Run from inside the git repo whose code you are presenting (file/diff scenes
// resolve paths and refs against that repo).

import { spawnSync, execFileSync, spawn } from 'node:child_process';
import {
  readFileSync, writeFileSync, mkdirSync, existsSync, rmSync, readdirSync, statSync, copyFileSync,
} from 'node:fs';
import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { dirname, join, resolve, basename, extname, isAbsolute } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
import { makeScenes, groupScenes } from './scenes.mjs';
import { writeMarkdown, buildHtml } from './export-docs.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const skillRequire = createRequire(join(__dirname, 'package.json'));
const STAGE_HTML = join(__dirname, 'stage.html');
const STAGE_CSS = join(__dirname, 'stage.css');

const EDGE_TTS = resolveEdgeTts();

// ---------- arg parsing ----------
const rawArgs = process.argv.slice(2);
const flags = new Set(rawArgs.filter((a) => a.startsWith('--')));
const positional = rawArgs.filter((a) => !a.startsWith('--'));
if (positional.length < 1) {
  console.error('Usage: render-code.mjs <script.json> [output-base] [--burn] [--keep-tmp] [--no-video] [--no-md] [--no-html]');
  process.exit(2);
}
const scriptPath = resolve(positional[0]);
const scriptName = basename(scriptPath).replace(/\.json$/, '');
const KIND = 'code-walkthrough';
// Default output: a per-walkthrough folder `<script-dir>/<name>/` holding
// <name>-code-walkthrough.{mp4,srt,html,md} + images/. The skill suffix keeps
// these files distinguishable from a feature-walkthrough of the same <name> (the
// two skills emit identically-stemmed artifacts otherwise). A positional
// output-base overrides the prefix verbatim.
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
// (--no-video) needs just the Node/chromium deps.
if (doVideo) ensureSystemDeps();
await ensureNodeDeps();
const playwrightEntry = skillRequire.resolve('playwright');
const playwrightMod = await import(pathToFileURL(playwrightEntry).href);
const chromium = playwrightMod.chromium || playwrightMod.default?.chromium;
if (!chromium) die('Could not load playwright chromium driver.');

// ---------- load script ----------
const script = JSON.parse(readFileSync(scriptPath, 'utf8'));
const voice = script.voice || 'en-US-AndrewNeural';
const viewport = script.viewport || { width: 1280, height: 800 };
const headless = script.headless !== false;
const scenes = script.scenes || script.steps || [];
if (!scenes.length) die('Script has no scenes.');
const codeTheme = script.codeTheme || 'github-dark';
const intro = resolveIntro(script);
const repoRoot = gitRoot() || process.cwd();
const scenesApi = makeScenes(repoRoot);
const expandHighlight = scenesApi.expandHighlight;

log(`▶ ${script.title || basename(scriptPath)}`);
log(`  repo=${repoRoot}  voice=${voice}  scenes=${scenes.length}  headless=${headless}`);

const tmpDir = `${outputBase}.tmp`;
if (existsSync(tmpDir)) rmSync(tmpDir, { recursive: true, force: true });
mkdirSync(tmpDir, { recursive: true });
mkdirSync(dirname(outputBase), { recursive: true });

// ---------- 0. resolve scene payloads (git/file reads happen here, not in browser) ----------
log('⓪ Resolving scenes…');
for (let i = 0; i < scenes.length; i++) {
  try {
    scenes[i]._resolved = scenesApi.resolveScene(scenes[i].action);
  } catch (err) {
    die(`Scene ${i + 1} (${scenes[i].action?.type}): ${err.message}`);
  }
}

// ---------- 1. synthesize narration + build audio (video only) ----------
const durations = new Array(scenes.length).fill(0.6);
let total = 0, introDuration = 0, introAudioPath = null, fullAudio = null;

if (doVideo) {
  log('① Synthesizing narration…');
  const cacheDir = process.env.DEMO_VIDEO_TTS_CACHE_DIR || join(homedir(), '.cache', 'demo-video-tts');
  mkdirSync(cacheDir, { recursive: true });
  const audioPaths = new Array(scenes.length);
  const stepLogs = new Array(scenes.length);
  let cacheHits = 0;

  const synthStep = async (i) => {
    const s = scenes[i];
    const text = (s.narration || '').trim();
    const audioPath = join(tmpDir, `seg-${String(i).padStart(4, '0')}.mp3`);
    if (text) {
      const key = createHash('sha256').update(`${voice}\x00${text}`).digest('hex').slice(0, 24);
      const cached = join(cacheDir, `${key}.mp3`);
      if (existsSync(cached)) { copyFileSync(cached, audioPath); cacheHits++; }
      else { await runAsync(EDGE_TTS[0], [...EDGE_TTS.slice(1), '--voice', voice, '--text', text, '--write-media', audioPath]); copyFileSync(audioPath, cached); }
      durations[i] = probeDuration(audioPath);
    } else {
      await runAsync('ffmpeg', ['-y', '-f', 'lavfi', '-i', 'anullsrc=r=24000:cl=mono', '-t', '0.6', '-q:a', '9', '-acodec', 'libmp3lame', audioPath]);
      durations[i] = 0.6;
    }
    audioPaths[i] = audioPath;
    stepLogs[i] = `   ${String(i + 1).padStart(2)}. ${fmtDuration(durations[i])}  [${scenes[i].action?.type || 'silent'}]  ${truncate(text || '(silent)', 56)}`;
  };

  const synthIntro = async () => {
    if (!intro) return;
    introAudioPath = join(tmpDir, 'intro.mp3');
    if (intro.narration) {
      const key = createHash('sha256').update(`${voice}\x00${intro.narration}`).digest('hex').slice(0, 24);
      const cached = join(cacheDir, `${key}.mp3`);
      if (existsSync(cached)) copyFileSync(cached, introAudioPath);
      else { await runAsync(EDGE_TTS[0], [...EDGE_TTS.slice(1), '--voice', voice, '--text', intro.narration, '--write-media', introAudioPath]); copyFileSync(introAudioPath, cached); }
      introDuration = probeDuration(introAudioPath);
      const targetSec = (intro.ms || 0) / 1000;
      if (targetSec > introDuration + 0.05) {
        const padded = join(tmpDir, 'intro-padded.mp3');
        await runAsync('ffmpeg', ['-y', '-i', introAudioPath, '-af', `apad=pad_dur=${(targetSec - introDuration).toFixed(3)}`, padded]);
        introAudioPath = padded; introDuration = probeDuration(padded);
      } else introDuration = Math.max(introDuration, targetSec);
    } else {
      introDuration = (intro.ms ?? 2800) / 1000;
      await runAsync('ffmpeg', ['-y', '-f', 'lavfi', '-i', 'anullsrc=r=24000:cl=mono', '-t', String(introDuration), '-q:a', '9', '-acodec', 'libmp3lame', introAudioPath]);
    }
  };

  await Promise.all([synthIntro(), mapLimit(scenes.length, 6, synthStep)]);
  if (intro) log(`   intro: ${fmtDuration(introDuration)}  ${truncate(intro.narration || intro.title || '(silent)', 56)}`);
  for (const line of stepLogs) log(line);
  total = introDuration + durations.reduce((a, b) => a + b, 0);
  log(`  total narration: ${fmtDuration(total)}  (${cacheHits}/${scenes.length} cached)`);

  // SRT (video sidecar)
  writeFileSync(`${outputBase}.srt`, buildSrt(scenes, durations, intro, introDuration));

  // concat audio
  const allAudio = introAudioPath ? [introAudioPath, ...audioPaths] : audioPaths;
  const concatPath = join(tmpDir, 'concat.txt');
  writeFileSync(concatPath, allAudio.map((p) => `file '${p.replace(/'/g, "'\\''")}'`).join('\n'));
  fullAudio = join(tmpDir, 'narration.mp3');
  run('ffmpeg', ['-y', '-f', 'concat', '-safe', '0', '-i', concatPath, '-c', 'copy', fullAudio], { quiet: true });
}

// ---------- 2. one browser → record video (optional) + serialize doc fragments ----------
const browser = await chromium.launch({ headless });
let mp4 = null, htmlPath = null, mdPath = null;
try {
  if (doVideo) {
    log('② Recording…');
    const totalIntroMs = intro ? Math.round(introDuration * 1000) : 0;
    const cardMs = intro ? Math.min(intro.ms ?? 2800, totalIntroMs) : 0;
    const overflowMs = intro ? totalIntroMs - cardMs : 0;

    // Intro card → png → mp4 (clean first frame, identical to feature-walkthrough).
    let introVideoPath = null;
    if (intro) {
      const introCtx = await browser.newContext({ viewport });
      const introPage = await introCtx.newPage();
      await introPage.setContent(renderIntroHtml(intro), { waitUntil: 'load' });
      await introPage.waitForTimeout(150);
      const introPng = join(tmpDir, 'intro.png');
      await introPage.screenshot({ path: introPng });
      await introCtx.close();
      introVideoPath = join(tmpDir, 'intro.mp4');
      run('ffmpeg', ['-y', '-loop', '1', '-t', (cardMs / 1000).toFixed(3), '-i', introPng,
        '-vf', `scale=${viewport.width}:${viewport.height},setsar=1,fps=25,format=yuv420p`,
        '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '23', '-pix_fmt', 'yuv420p', introVideoPath], { quiet: true });
    }

    let demoTrimMs = 0;
    const context = await browser.newContext({ viewport, recordVideo: { dir: tmpDir, size: viewport } });
    try {
      const page = await context.newPage();
      page.on('pageerror', (e) => console.error('   [stage pageerror]', e.message));
      const recordingStart = Date.now();
      await page.goto(pathToFileURL(STAGE_HTML).href, { waitUntil: 'load' });
      await injectStageAssets(page);
      await page.waitForFunction(() => window.Stage && window.Stage.ready === false, null, { timeout: 5000 }).catch(() => {});
      await page.waitForTimeout(150);
      demoTrimMs = Date.now() - recordingStart;
      if (overflowMs > 0) await page.waitForTimeout(overflowMs);

      const overruns = [];
      let boxesThisStep = [], boxesPersist = false;
      for (let i = 0; i < scenes.length; i++) {
        const s = scenes[i];
        const targetMs = Math.round(durations[i] * 1000);
        const start = Date.now();
        boxesThisStep = []; boxesPersist = false;
        try {
          await runAction(page, s.action, s._resolved, targetMs, { onBox: (id, persist) => { boxesThisStep.push(id); if (persist) boxesPersist = true; } });
        } catch (err) {
          console.error(`\n✗ Scene ${i + 1} failed: ${err.message}`);
          console.error(`  Narration: "${s.narration}"`);
          console.error(`  Action:    ${JSON.stringify(s.action)}`);
          throw err;
        }
        const elapsed = Date.now() - start;
        const remaining = Math.max(0, targetMs - elapsed);
        if (remaining) await page.waitForTimeout(remaining);
        // Scenes here are locally rendered and are *told* how long they have
        // (runAction takes targetMs), so they normally fit their narration and the
        // straight audio concat stays in sync. A scene that overruns anyway pushes
        // the picture behind the voice from that point on, exactly as it did in the
        // sibling feature-walkthrough skill — so say so rather than drift silently.
        if (elapsed > targetMs + 750) overruns.push({ i, elapsed, targetMs });
        if (boxesThisStep.length && !boxesPersist) for (const id of boxesThisStep) await clearBoxes(page, id);
      }
      if (overruns.length) {
        log(`   ⚠ ${overruns.length} scene(s) ran past their narration — the voice leads`);
        log(`     the picture from there on. Lengthen the narration or shorten the scene:`);
        for (const o of overruns.slice(0, 5)) {
          log(`     scene ${String(o.i + 1).padStart(2)}: ${fmtDuration(o.elapsed / 1000)}`
            + ` vs narration ${fmtDuration(o.targetMs / 1000)}`);
        }
      }
    } finally {
      await context.close();
    }

    const videoFile = newestFile(tmpDir, '.webm');
    if (!videoFile) die('Playwright did not produce a video file.');

    // mux
    log('③ Muxing…');
    mp4 = `${outputBase}.mp4`;
    const srtEsc = `${outputBase}.srt`.replace(/'/g, "'\\''").replace(/:/g, '\\:');
    const muxArgs = ['-y'];
    if (introVideoPath) {
      muxArgs.push('-i', introVideoPath);
      muxArgs.push('-ss', (demoTrimMs / 1000).toFixed(3), '-i', videoFile);
    } else muxArgs.push('-i', videoFile);
    muxArgs.push('-i', fullAudio);
    if (introVideoPath) {
      const norm = `scale=${viewport.width}:${viewport.height},setsar=1,fps=25,format=yuv420p`;
      let filter = `[0:v]${norm}[i];[1:v]${norm}[d];[i][d]concat=n=2:v=1:a=0`;
      filter += burn ? `[c];[c]subtitles='${srtEsc}'[outv]` : `[outv]`;
      muxArgs.push('-filter_complex', filter, '-map', '[outv]', '-map', '2:a:0');
    } else {
      if (burn) muxArgs.push('-vf', `subtitles='${srtEsc}'`);
      muxArgs.push('-map', '0:v:0', '-map', '1:a:0');
    }
    muxArgs.push('-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '23', '-c:a', 'aac', '-b:a', '160k', '-movflags', '+faststart', mp4);
    // No `-shortest`: if a scene overran, truncating to the narration would drop
    // the end of the walkthrough rather than just letting the tail run silent.
    run('ffmpeg', muxArgs, { quiet: true });
  }

  // ---------- 4. documents (MD + HTML) ----------
  if (doMd || doHtml) {
    log('④ Building docs…');
    const groups = groupScenes(scenes);
    const ctx = { base: outputBase, name: outName, imagesDir, hasVideo: !!mp4 };
    if (doHtml) {
      const fragments = await captureFragments(browser, groups);
      const blocks = groups.map((group, i) => ({ group, fragment: fragments[i] }));
      htmlPath = `${outputBase}.html`;
      writeFileSync(htmlPath, buildHtml(blocks, intro, { ...ctx, stageCss: readFileSync(STAGE_CSS, 'utf8') }));
    }
    if (doMd) mdPath = writeMarkdown(groups, intro, ctx);
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
if (total) log(`  Duration: ${fmtDuration(total)}`);

// Scene resolution (git/files/diagram-SVG → plain data) lives in scenes.mjs and
// is shared with the doc emitters; see `scenesApi` above.

// =============================================================
// browser action dispatch (drives window.Stage, paced to narration)
// =============================================================

async function runAction(page, action, resolved, targetMs, ctx = {}) {
  if (!action) return; // silent / chapter beat
  switch (action.type) {
    case 'code':    await page.evaluate((o) => window.Stage.showCode(o), resolved); break;
    case 'diff':    await page.evaluate((o) => window.Stage.showDiff(o), resolved); break;
    case 'focus':   await page.evaluate((o) => window.Stage.focus(o), { highlight: expandHighlight(action.highlight) }); break;
    case 'section': await page.evaluate((o) => window.Stage.showSection(o), { title: action.title, subtitle: action.subtitle, background: action.background }); break;
    case 'resetBackground': await page.evaluate(() => window.Stage.resetBackground()); break;
    case 'image':   await page.evaluate((o) => window.Stage.showImage(o), resolved); break;
    case 'diagram': await page.evaluate((o) => window.Stage.showDiagram(o), resolved); break;
    case 'compare': {
      await page.evaluate((o) => window.Stage.compare(o), resolved);
      const holdBefore = Math.min(action.hold ?? Math.round(targetMs * 0.32), 1800);
      const transition = action.transition ?? Math.min(Math.round(targetMs * 0.4), 1200);
      await page.waitForTimeout(holdBefore);
      await page.evaluate((t) => window.Stage.runCompare(t), transition);
      break;
    }
    case 'wait':    await page.waitForTimeout(action.ms ?? 600); break;
    case 'screenshot': await page.screenshot({ path: action.path, fullPage: !!action.fullPage }); break;
    case 'box': {
      const id = action.id || `box-${idCounter()}`;
      let rect = action.rect;
      if (!rect) throw new Error('box: needs rect:{x,y,width,height} (image/stage coords)');
      await drawBox(page, { rect, id, caption: action.caption, color: action.color, style: action.style });
      if (ctx.onBox) ctx.onBox(id, !!action.persist);
      break;
    }
    case 'clearBoxes': await clearBoxes(page, action.id); break;
    default: throw new Error(`Unknown action type: ${action.type}`);
  }
}

// =============================================================
// doc fragments — serialize each grouped block from the live stage
// =============================================================
//
// Reuses the EXACT stage rendering (highlight.js spans, diff rows, the inline
// diagram SVG) the video uses, so the HTML export is structurally identical to
// the frames — no second code/diff renderer. `compare` is skipped here; the HTML
// emitter builds an interactive slider for it instead. Each visual block applies
// its grouped (focus-union) highlight as a static spotlight.
async function captureFragments(browser, groups) {
  const ctx = await browser.newContext({ viewport });
  const frags = new Array(groups.length).fill(null);
  try {
    const page = await ctx.newPage();
    page.on('pageerror', (e) => console.error('   [docs pageerror]', e.message));
    await page.goto(pathToFileURL(STAGE_HTML).href, { waitUntil: 'load' });
    await injectStageAssets(page);
    for (let i = 0; i < groups.length; i++) {
      const g = groups[i];
      const type = g.action?.type;
      if (!type || type === 'compare') continue; // compare → slider in export-docs
      // Re-spotlight using the block's unioned focus lines.
      const resolved = g.resolved ? { ...g.resolved, highlight: g.highlight || [] } : g.resolved;
      switch (type) {
        case 'code':    await page.evaluate((o) => window.Stage.showCode(o), resolved); break;
        case 'diff':    await page.evaluate((o) => window.Stage.showDiff(o), resolved); break;
        case 'diagram': await page.evaluate((o) => window.Stage.showDiagram(o), resolved); break;
        case 'section': await page.evaluate((o) => window.Stage.showSection(o), { title: g.action.title, subtitle: g.action.subtitle }); break;
        case 'image':   await page.evaluate((o) => window.Stage.showImage(o), resolved); await page.waitForTimeout(40); break;
        default: continue;
      }
      await page.waitForTimeout(30);
      frags[i] = await page.evaluate(() => document.getElementById('stage').innerHTML);
    }
  } finally {
    await ctx.close();
  }
  return frags;
}

// =============================================================
// git helper
// =============================================================

function gitRoot() {
  const r = spawnSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' });
  return r.status === 0 ? r.stdout.trim() : null;
}

// =============================================================
// overlay boxes (for pointing at things inside images)
// =============================================================

let _idc = 0;
function idCounter() { return (++_idc).toString(36); }

async function drawBox(page, { rect, caption, color = '#ff7b29', style = 'solid', id }) {
  await page.evaluate((args) => {
    const { rect, caption, color, style, id } = args;
    let root = document.querySelector('#__cv_overlay__');
    if (!root) {
      root = document.createElement('div'); root.id = '__cv_overlay__';
      Object.assign(root.style, { position: 'fixed', inset: '0', pointerEvents: 'none', zIndex: '2147483647' });
      document.documentElement.appendChild(root);
    }
    const prev = root.querySelector(`[data-box-id="${id}"]`);
    if (prev) prev.remove();
    const box = document.createElement('div');
    box.setAttribute('data-box-id', id);
    Object.assign(box.style, {
      position: 'absolute', left: rect.x + 'px', top: rect.y + 'px', width: rect.width + 'px', height: rect.height + 'px',
      border: `3px ${style} ${color}`, borderRadius: '6px',
      transition: 'opacity 200ms ease, transform 200ms ease', opacity: '0', transform: 'scale(1.03)', boxSizing: 'border-box',
    });
    if (caption) {
      const lbl = document.createElement('div'); lbl.textContent = caption;
      Object.assign(lbl.style, { position: 'absolute', top: '-1.9em', left: '-3px', background: color, color: '#fff',
        font: '600 13px/1.4 system-ui, sans-serif', padding: '3px 9px', borderRadius: '4px 4px 4px 0', whiteSpace: 'nowrap' });
      box.appendChild(lbl);
    }
    root.appendChild(box);
    requestAnimationFrame(() => { box.style.opacity = '1'; box.style.transform = 'scale(1)'; });
  }, { rect, caption, color, style, id });
}

async function clearBoxes(page, id) {
  await page.evaluate((args) => {
    const root = document.querySelector('#__cv_overlay__');
    if (!root) return;
    const sel = args.id ? `[data-box-id="${args.id}"]` : '[data-box-id]';
    for (const el of root.querySelectorAll(sel)) { el.style.opacity = '0'; setTimeout(() => el.remove(), 220); }
  }, { id });
}

// =============================================================
// stage asset injection
// =============================================================

// Diagrams are pre-rendered to SVG in Node (scenes.mjs / beautiful-mermaid), so
// the stage only needs highlight.js for code/diff syntax colouring.
async function injectStageAssets(page) {
  const hljsJs = skillRequire.resolve('@highlightjs/cdn-assets/highlight.min.js');
  const hljsCss = resolveHljsTheme(codeTheme);
  await page.addStyleTag({ path: hljsCss });
  await page.addScriptTag({ path: hljsJs });
  await page.waitForFunction(() => !!window.hljs, null, { timeout: 5000 }).catch(() => {});
}

function resolveHljsTheme(theme) {
  const base = dirname(skillRequire.resolve('@highlightjs/cdn-assets/highlight.min.js'));
  const candidates = [
    join(base, 'styles', `${theme}.min.css`),
    join(base, 'styles', `${theme}.css`),
    join(base, 'styles', 'github-dark.min.css'),
  ];
  for (const c of candidates) if (existsSync(c)) return c;
  throw new Error(`highlight.js theme not found: ${theme}`);
}

// =============================================================
// intro / srt / shared helpers (from feature-walkthrough)
// =============================================================

function resolveIntro(script) {
  if (script.intro === false) return null;
  if (!script.intro || script.intro === true) return { title: script.title || 'Code walkthrough', ms: 2800 };
  const intro = { ...script.intro };
  intro.title = intro.title ?? script.title ?? 'Code walkthrough';
  intro.ms = intro.ms ?? 2800;
  return intro;
}

function renderIntroHtml(intro) {
  const bg = intro.background || 'radial-gradient(120% 120% at 50% 0%, #243042 0%, #0d1117 60%)';
  const color = intro.color || '#ffffff';
  return `<!doctype html><html><head><meta charset="utf-8"><style>
    html,body { margin:0; height:100%; }
    body { background:${bg}; color:${color};
      font:500 16px/1.4 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;
      display:flex; align-items:center; justify-content:center; flex-direction:column; text-align:center; padding:4vmin; box-sizing:border-box; }
    .kicker { font-size:clamp(13px,1.7vmin,17px); letter-spacing:0.18em; text-transform:uppercase; color:#ff7b29; margin-bottom:1.4em; font-weight:600; }
    .title { font-size:clamp(40px,7vmin,82px); font-weight:700; letter-spacing:-0.02em; margin:0 0 0.3em; }
    .subtitle { font-size:clamp(18px,2.6vmin,28px); opacity:0.82; font-weight:400; max-width:32em; }
    .note { margin-top:1.4em; font-size:clamp(13px,1.6vmin,16px); opacity:0.55; font-family:ui-monospace,Menlo,monospace; }
  </style></head><body>
    ${intro.kicker ? `<div class="kicker">${escapeHtml(intro.kicker)}</div>` : ''}
    <div class="title">${escapeHtml(intro.title || '')}</div>
    ${intro.subtitle ? `<div class="subtitle">${escapeHtml(intro.subtitle)}</div>` : ''}
    ${intro.note ? `<div class="note">${escapeHtml(intro.note)}</div>` : ''}
  </body></html>`;
}

function escapeHtml(s) { return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }

function buildSrt(scenes, durations, intro, introDuration) {
  let t = 0, idx = 1; const out = [];
  if (intro && introDuration > 0) {
    const introText = (intro.narration || '').trim() || (intro.title || '');
    if (introText) { out.push(String(idx++), `${fmtSrtTime(0)} --> ${fmtSrtTime(introDuration)}`, introText, ''); }
    t = introDuration;
  }
  for (let i = 0; i < scenes.length; i++) {
    const end = t + durations[i];
    out.push(String(idx++), `${fmtSrtTime(t)} --> ${fmtSrtTime(end)}`, (scenes[i].narration || '').trim() || '♪', '');
    t = end;
  }
  return out.join('\n');
}

function fmtSrtTime(s) {
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = Math.floor(s % 60), ms = Math.round((s - Math.floor(s)) * 1000);
  return `${pad(h, 2)}:${pad(m, 2)}:${pad(sec, 2)},${pad(ms, 3)}`;
}
function fmtDuration(s) { if (s < 60) return `${s.toFixed(1)}s`; const m = Math.floor(s / 60); return `${m}m${(s - m * 60).toFixed(0).padStart(2, '0')}s`; }
function pad(n, w) { return String(n).padStart(w, '0'); }
function truncate(s, n) { return s.length <= n ? s : s.slice(0, n - 1) + '…'; }

function probeDuration(file) {
  const out = execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=noprint_wrappers=1:nokey=1', file], { encoding: 'utf8' }).trim();
  const d = parseFloat(out);
  if (!isFinite(d) || d <= 0) throw new Error(`ffprobe could not read duration of ${file}`);
  return d;
}
function newestFile(dir, ext) {
  const m = readdirSync(dir).filter((f) => f.endsWith(ext)).map((f) => ({ f, mtime: statSync(join(dir, f)).mtimeMs })).sort((a, b) => b.mtime - a.mtime);
  return m[0] ? join(dir, m[0].f) : null;
}
function run(cmd, args, { quiet = false, cwd } = {}) {
  const res = spawnSync(cmd, args, { stdio: quiet ? 'pipe' : 'inherit', encoding: 'utf8', cwd });
  if (res.status !== 0) { if (quiet && res.stderr) process.stderr.write(res.stderr); throw new Error(`${cmd} exited with ${res.status}`); }
  return res;
}
function runAsync(cmd, args, { cwd } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: ['ignore', 'ignore', 'pipe'], cwd });
    let stderr = ''; child.stderr.on('data', (d) => { stderr += d; });
    child.on('error', reject);
    child.on('close', (code) => { if (code === 0) resolve(); else { if (stderr) process.stderr.write(stderr); reject(new Error(`${cmd} exited with ${code}`)); } });
  });
}
async function mapLimit(n, limit, fn) {
  let next = 0;
  async function worker() { while (next < n) await fn(next++); }
  await Promise.all(Array.from({ length: Math.min(limit, n) }, worker));
}
function which(cmd) { const res = spawnSync('sh', ['-c', `command -v ${cmd}`], { encoding: 'utf8' }); return res.status === 0 ? res.stdout.trim() : null; }
// Resolve edge-tts as an argv PREFIX (command + leading args). We invoke the
// module through a venv's python (`python3 -m edge_tts`) rather than the venv's
// `bin/edge-tts` console script: that script's shebang hardcodes the venv's
// absolute path at creation time, so it breaks the moment the skill dir is
// copied or renamed (e.g. across ~/.codex, ~/.claude, …). `python -m` ignores
// the shebang and uses the venv's site-packages, so it stays portable.
function resolveEdgeTts() {
  const venvPys = [
    join(__dirname, '.venv', 'bin', 'python3'),
    // Reuse the sibling feature-walkthrough skill's venv if present.
    join(__dirname, '..', '..', 'feature-walkthrough', 'scripts', '.venv', 'bin', 'python3'),
  ];
  for (const py of venvPys) {
    if (existsSync(py) && runsOk(py, ['-m', 'edge_tts', '--help'])) return [py, '-m', 'edge_tts'];
  }
  if (runsOk('edge-tts', ['--help'])) return ['edge-tts'];                       // console script on PATH
  if (runsOk('python3', ['-m', 'edge_tts', '--help'])) return ['python3', '-m', 'edge_tts'];
  return null; // not found — ensureSystemDeps reports it (only needed for video)
}
function runsOk(cmd, args) { const r = spawnSync(cmd, args, { stdio: 'ignore' }); return r.status === 0; }
function ensureSystemDeps() {
  const missing = [];
  if (!which('ffmpeg')) missing.push('ffmpeg');
  if (!which('ffprobe')) missing.push('ffprobe (part of ffmpeg)');
  if (!EDGE_TTS) missing.push('edge-tts');
  if (!missing.length) return;
  console.error('Missing required tools: ' + missing.join(', '));
  console.error('\nInstall on Debian/Ubuntu:\n  sudo apt-get update && sudo apt-get install -y ffmpeg python3-pip\n  pip3 install --user edge-tts');
  console.error('\nInstall on macOS:\n  brew install ffmpeg\n  pip3 install --user edge-tts');
  process.exit(3);
}
async function ensureNodeDeps() {
  const ok = existsSync(join(__dirname, 'node_modules', 'playwright'))
    && existsSync(join(__dirname, 'node_modules', '@highlightjs', 'cdn-assets'))
    && existsSync(join(__dirname, 'node_modules', 'beautiful-mermaid'));
  if (ok) return;
  log('First run — installing renderer deps (playwright + highlight.js + beautiful-mermaid)…');
  run('npm', ['install', '--silent', '--no-audit', '--no-fund'], { cwd: __dirname });
  log('Installing chromium browser…');
  run('npx', ['--yes', 'playwright', 'install', 'chromium'], { cwd: __dirname });
}
function log(msg) { process.stderr.write(msg + '\n'); }
function die(msg) { console.error(msg); process.exit(1); }
