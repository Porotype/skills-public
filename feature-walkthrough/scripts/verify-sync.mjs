#!/usr/bin/env node
/**
 * Measure whether a rendered walkthrough's narration actually lines up with its
 * picture — on the finished file, with no help from the renderer that made it.
 *
 *   node verify-sync.mjs demo/feature-walkthrough/<name>/
 *
 * How it works. The renderer writes one screenshot per step (`images/step-NN.png`),
 * captured live at the moment that step finished — which is also the moment its
 * narration ends. So for every step there is a known picture and a claimed time
 * (the end of cue N in the .srt). This script finds where that picture *actually*
 * occurs in the video and reports the difference.
 *
 * Matching is on 64×64 greyscale frames sampled at 1 fps — one ffmpeg pass for the
 * whole video. Individual screenshots cannot be located on their own (a walkthrough
 * is mostly screens sitting still, so dozens of frames match equally well), so what
 * is solved for is the single time shift that best aligns the *whole sequence*, and
 * then the same shift over the first and last thirds. Two shifts that disagree mean
 * the drift accumulates, which is the signature of the picture and the voice running
 * at different rates — the failure this script exists to catch.
 *
 * Exit code is 1 if the global shift exceeds --tolerance (default 1.5s) or the drift
 * accumulates by more than 2s, so it can be used as a check rather than only read.
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { join, basename } from 'node:path';

const args = process.argv.slice(2);
const dir = args.find((a) => !a.startsWith('--'));
const tolArg = args.find((a) => a.startsWith('--tolerance='));
const tolerance = tolArg ? parseFloat(tolArg.split('=')[1]) : 1.5;
if (!dir) {
  console.error('usage: verify-sync.mjs <walkthrough-folder> [--tolerance=1.5]');
  process.exit(2);
}

const SIDE = 64;
const FRAME = SIDE * SIDE;

const files = readdirSync(dir);
const mp4 = files.find((f) => f.endsWith('.mp4'));
const srt = files.find((f) => f.endsWith('.srt'));
if (!mp4 || !srt) {
  console.error(`Need an .mp4 and an .srt in ${dir}`);
  process.exit(2);
}
const imagesDir = join(dir, 'images');
if (!existsSync(imagesDir)) {
  console.error(`No images/ in ${dir} — re-render without --no-md/--no-html.`);
  process.exit(2);
}

// ---- the video, one greyscale thumbnail per second -------------------------
const raw = execFileSync('ffmpeg', [
  '-v', 'error', '-i', join(dir, mp4),
  '-vf', `fps=1,scale=${SIDE}:${SIDE},format=gray`,
  '-f', 'rawvideo', '-',
], { maxBuffer: 1 << 28 });
const frames = [];
for (let o = 0; o + FRAME <= raw.length; o += FRAME) frames.push(raw.subarray(o, o + FRAME));
if (!frames.length) {
  console.error('Could not sample the video.');
  process.exit(2);
}

// ---- cue end times, skipping the intro cue if there is one -----------------
const cueTimes = [];
for (const m of readFileSync(join(dir, srt), 'utf8')
  .matchAll(/(\d\d):(\d\d):(\d\d),(\d\d\d) --> (\d\d):(\d\d):(\d\d),(\d\d\d)/g)) {
  const end = Number(m[5]) * 3600 + Number(m[6]) * 60 + Number(m[7]) + Number(m[8]) / 1000;
  cueTimes.push(end);
}

const shots = files.length && readdirSync(imagesDir)
  .filter((f) => /^step-\d+\.png$/.test(f))
  .sort((a, b) => Number(a.match(/\d+/)[0]) - Number(b.match(/\d+/)[0]));

// The intro carries a cue of its own when it has narration or a title card, so
// line the steps up from the end, where both lists are anchored on the last step.
const offset = Math.max(0, cueTimes.length - shots.length);

const thumbOf = (png) => {
  const out = spawnSync('ffmpeg', ['-v', 'error', '-i', png,
    '-vf', `scale=${SIDE}:${SIDE},format=gray`, '-f', 'rawvideo', '-'],
    { maxBuffer: 1 << 24 });
  return out.stdout && out.stdout.length >= FRAME ? out.stdout.subarray(0, FRAME) : null;
};
const diff = (a, b) => {
  let t = 0;
  for (let i = 0; i < FRAME; i++) t += Math.abs(a[i] - b[i]);
  return t / FRAME;
};

// A walkthrough is mostly screens that sit still, so matching each screenshot on
// its own is hopeless — dozens of frames are equally good candidates. What *is*
// well determined is the single time shift that best aligns the whole sequence,
// so solve for that instead, and solve it again over the first and last thirds to
// see whether the error accumulates (which is what runaway drift looks like).
const thumbs = [];
shots.forEach((f, i) => {
  const cueEnd = cueTimes[i + offset];
  if (cueEnd === undefined) return;
  const t = thumbOf(join(imagesDir, f));
  if (t) thumbs.push({ step: i + 1, cue: cueEnd, thumb: t });
});
if (!thumbs.length) {
  console.error('No step screenshots could be read.');
  process.exit(2);
}

const costAt = (list, shift) => {
  let total = 0, n = 0;
  for (const t of list) {
    const idx = Math.round(t.cue + shift);
    if (idx < 0 || idx >= frames.length) continue;
    total += diff(t.thumb, frames[idx]);
    n++;
  }
  return n ? { cost: total / n, n } : { cost: Infinity, n: 0 };
};

const solve = (list) => {
  let best = { shift: 0, cost: Infinity };
  const curve = new Map();
  for (let sh = -40; sh <= 40; sh += 1) {
    const { cost, n } = costAt(list, sh);
    if (n < Math.max(2, list.length * 0.6)) continue;
    curve.set(sh, cost);
    if (cost < best.cost) best = { shift: sh, cost };
  }
  // How sharp is the minimum? A walkthrough section where the screen barely
  // changes has an almost flat curve, and its "best" shift is noise. Saying so is
  // more useful than reporting a drift that isn't there.
  let away = Infinity;
  for (const [sh, cost] of curve) if (Math.abs(sh - best.shift) >= 5) away = Math.min(away, cost);
  best.sharpness = isFinite(away) ? away - best.cost : 0;
  best.weak = best.sharpness < 1.0;
  return best;
};

const third = Math.max(1, Math.floor(thumbs.length / 3));
const whole = solve(thumbs);
const early = solve(thumbs.slice(0, third));
const late  = solve(thumbs.slice(-third));

// Per-step residual once the global shift is taken out.
const residuals = thumbs.map((t) => {
  const base = diff(t.thumb, frames[Math.min(frames.length - 1, Math.max(0, Math.round(t.cue + whole.shift)))]);
  let bestIdx = null, bestD = Infinity;
  for (let d = -12; d <= 12; d++) {
    const idx = Math.round(t.cue + whole.shift) + d;
    if (idx < 0 || idx >= frames.length) continue;
    const v = diff(t.thumb, frames[idx]);
    if (v < bestD - 0.4) { bestD = v; bestIdx = d; }
  }
  return { step: t.step, cue: t.cue, off: bestIdx ?? 0, sharp: base - bestD };
});

console.log(`${basename(dir)}`);
console.log(`  aligned ${thumbs.length} step screenshots against the video (1 fps sampling, so ±1s is exact)`);
const mark = (r) => `${r.shift > 0 ? '+' : ''}${r.shift}s${r.weak ? '?' : ''}`;
console.log(`  best global shift ${mark(whole)} (fit ${whole.sharpness.toFixed(1)})`
  + `   first third ${mark(early)}   last third ${mark(late)}`);
const accumulation = Math.abs(late.shift - early.shift);
const trustEnds = !early.weak && !late.weak;
if (accumulation > 2 && trustEnds) {
  console.log(`  ⚠ drift ACCUMULATES by ${accumulation}s between the start and the end — the`);
  console.log(`    narration and the picture are running at different rates.`);
} else if (accumulation > 2) {
  console.log(`  (thirds disagree by ${accumulation}s, but at least one of them is a weak fit —`);
  console.log(`   too little on-screen change to locate. Not treated as drift.)`);
}
const off = residuals.filter((r) => Math.abs(r.off) > Math.max(tolerance, 1.001) && r.sharp > 4);
if (off.length) {
  console.log(`  ${off.length} step(s) individually off by more than ${tolerance}s:`);
  for (const r of off.slice(0, 8)) {
    console.log(`    step ${String(r.step).padStart(2)}: narration ends ${r.cue.toFixed(1)}s,`
      + ` that screen is ${r.off > 0 ? '+' : ''}${r.off}s away`);
  }
} else {
  console.log('  no step is individually off beyond the sampling resolution');
}
const bad = Math.abs(whole.shift) > tolerance || (accumulation > 2 && trustEnds);
process.exit(bad ? 1 : 0);
