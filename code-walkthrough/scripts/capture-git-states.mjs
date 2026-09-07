#!/usr/bin/env node
// capture-git-states: take the SAME shot list against two git states and write
// matching `<name>-before.png` / `<name>-after.png` pairs for code-walkthrough
// `compare` scenes.
//
// Two modes:
//
//   WORKTREE (recommended; --worktree): for any side that is a git ref (not
//   WORKING), build+run that commit in an isolated `git worktree` on a separate
//   --port. Your main working tree and your running app are NEVER touched. The
//   worktree is created only for the side(s) that need it and removed afterwards.
//
//   IN-PLACE (default): `git checkout -f` each ref in your main tree, run
//   --rebuild, capture, and restore your original branch + stashed changes at the
//   end. Simpler, but it disrupts your running app and mutates your tree.
//
// Usage:
//   node capture-git-states.mjs <shotlist.json> \
//        --before <ref> [--after <ref|WORKING>] \
//        --rebuild "<cmd that brings an app up at the checked-out code>" \
//        [--worktree --port 8090] \
//        [--ready <url>] [--ready-timeout 300] [--settle 2500] [--out-dir DIR]
//
//   --before        git ref for the "before" frames (e.g. HEAD~1, a sha, a branch)
//   --after         git ref for the "after" frames; default WORKING (your current
//                   working tree — the running app is assumed to reflect it, so no
//                   rebuild runs for that side)
//   --rebuild       shell cmd that starts an app at the current code. It must
//                   return promptly (background the server itself). In WORKTREE
//                   mode it runs with cwd = the worktree and env PORT set, so use
//                   $PORT (e.g. `-Dserver.port=$PORT`); no kill step is needed
//                   (fresh port). In IN-PLACE mode it must also stop the old
//                   server (the tool then verifies down→up).
//   --worktree      isolate ref builds in a git worktree on --port (non-disruptive)
//   --port          port for the worktree app (default 8090); must be free
//   --ready         URL polled for readiness (default: shot list baseUrl). In
//                   worktree mode the port is swapped to --port automatically.
//   --ready-timeout seconds to wait for readiness (default 300 — a first build
//                   after a checkout can rebuild the whole frontend)
//   --down-timeout  IN-PLACE only: seconds to wait for the old server to stop (60)
//   --settle        extra ms after ready before capturing (default 2500)
//   --out-dir       passed through to capture-shots
//
// SAFETY: requires a git repo. WORKTREE mode refuses to run (so you can confirm
// it's safe) if --rebuild is missing or --port is busy, and always removes the
// worktree + kills the worktree app at the end. IN-PLACE mode stashes uncommitted
// changes (incl. untracked), uses `git checkout -f` between refs, and restores
// your branch + stash even on failure — but commit/back up anything precious first.

import { spawnSync } from 'node:child_process';
import { readFileSync, existsSync, mkdirSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const CAPTURE = join(__dirname, 'capture-shots.mjs');

// ---- args ----
const raw = process.argv.slice(2);
const positional = [];
const o = { after: 'WORKING', readyTimeout: 300, settle: 2500, downTimeout: 60, restart: undefined, worktree: false, port: 8090 };
for (let i = 0; i < raw.length; i++) {
  const a = raw[i];
  if (a === '--before') o.before = raw[++i];
  else if (a === '--after') o.after = raw[++i];
  else if (a === '--rebuild') o.rebuild = raw[++i];
  else if (a === '--ready') o.ready = raw[++i];
  else if (a === '--ready-timeout') o.readyTimeout = Number(raw[++i]);
  else if (a === '--down-timeout') o.downTimeout = Number(raw[++i]);
  else if (a === '--restart') o.restart = true;
  else if (a === '--no-restart') o.restart = false;
  else if (a === '--worktree') o.worktree = true;
  else if (a === '--port') o.port = Number(raw[++i]);
  else if (a === '--settle') o.settle = Number(raw[++i]);
  else if (a === '--out-dir') o.outDir = raw[++i];
  else positional.push(a);
}
if (o.restart === undefined) o.restart = !!o.rebuild;
if (positional.length < 1 || !o.before) {
  die('Usage: capture-git-states.mjs <shotlist.json> --before <ref> [--after <ref|WORKING>] --rebuild "<cmd>" [--worktree --port 8090] [--ready URL] [--ready-timeout S] [--settle MS] [--out-dir DIR]');
}
const listPath = resolve(positional[0]);
if (!existsSync(listPath)) die(`Shot list not found: ${listPath}`);
const list = JSON.parse(readFileSync(listPath, 'utf8'));
const mainBase = (list.baseUrl || 'http://localhost:8080').replace(/\/$/, '');
const mainReady = (o.ready || mainBase).replace(/\/$/, '');

if (git(['rev-parse', '--is-inside-work-tree'], true).status !== 0) die('Not inside a git repository.');
const afterIsWorking = /^working$/i.test(o.after);

if (o.worktree) await runWorktreeMode();
else await runInPlaceMode();

log('\n✓ done. Pairs written: <name>-before.png / <name>-after.png');
log('  Wire them into a compare scene: { "type":"compare", "before":"…-before.png", "after":"…-after.png" }');

// ============================================================
// WORKTREE MODE — isolated, non-disruptive
// ============================================================
async function runWorktreeMode() {
  log(`▶ capture-git-states (worktree mode)`);
  log(`  before=${o.before}  after=${o.after}  port=${o.port}`);

  // --- safety preflight: refuse rather than do something unsafe ---
  const refSides = [o.before, o.after].filter((s) => !/^working$/i.test(s));
  if (refSides.length && !o.rebuild) {
    die('worktree mode needs --rebuild to build/run a ref in the worktree (use $PORT, e.g. `-Dserver.port=$PORT`).');
  }
  if (refSides.length && portInUse(o.port)) {
    die(`--port ${o.port} is in use. Refusing to start the worktree app there. ` +
        `Free that port or pass a different --port, then re-run (confirm it's safe first).`);
  }
  const altBase = withPort(mainBase, o.port);
  const altReady = withPort(mainReady, o.port);
  const worktrees = [];

  try {
    await captureSideWT(o.after, '-after', { worktrees, altBase, altReady });
    await captureSideWT(o.before, '-before', { worktrees, altBase, altReady });
  } finally {
    // Always tear down: kill the worktree app and remove every worktree we made.
    if (refSides.length) killPort(o.port);
    for (const wt of worktrees) {
      git(['worktree', 'remove', '--force', wt], true);
      try { rmSync(wt, { recursive: true, force: true }); } catch {}
    }
    git(['worktree', 'prune'], true);
    if (worktrees.length) log(`  cleaned up ${worktrees.length} worktree(s); main tree and app untouched`);
  }
}

async function captureSideWT(ref, suffix, ctx) {
  if (/^working$/i.test(ref)) {
    log(`\n— ${suffix.slice(1).toUpperCase()} (working tree; running app) —`);
    await waitReady(mainReady);
    capture(suffix, mainBase);
    return;
  }
  log(`\n— ${suffix.slice(1).toUpperCase()} (${ref} → worktree on :${o.port}) —`);
  const wt = join(tmpdir(), 'code-walkthrough-wt', `${sanitize(ref)}-${process.pid}-${ctx.worktrees.length}`);
  mkdirSync(dirname(wt), { recursive: true });
  const add = git(['worktree', 'add', '--detach', wt, ref], true);
  if (add.status !== 0) throw new Error(`git worktree add ${ref} failed: ${add.stderr.trim()}`);
  ctx.worktrees.push(wt);
  log(`  worktree: ${wt}`);

  // Run the rebuild inside the worktree, on the alt port.
  log(`  rebuild (cwd=worktree, PORT=${o.port}): ${o.rebuild}`);
  const r = spawnSync('sh', ['-c', o.rebuild], { cwd: wt, env: { ...process.env, PORT: String(o.port) }, stdio: 'inherit' });
  if (r.status !== 0) log(`  (rebuild exited ${r.status} — continuing to poll readiness)`);

  await waitReady(ctx.altReady);
  capture(suffix, ctx.altBase);

  // Stop this side's app before the next worktree reuses the port.
  killPort(o.port);
  await sleep(1500);
}

// ============================================================
// IN-PLACE MODE — mutates the main tree, restores at the end
// ============================================================
async function runInPlaceMode() {
  const origRef = currentRef();
  const dirty = git(['status', '--porcelain'], true).stdout.trim().length > 0;
  log(`▶ capture-git-states (in-place mode)`);
  log(`  before=${o.before}  after=${o.after}  orig=${origRef}  dirty=${dirty}`);
  log(`  ready=${mainReady}  rebuild=${o.rebuild ? `"${o.rebuild}"` : '(none)'}  restart-check=${o.restart}`);

  let stashed = false;
  const stashIfDirty = () => {
    if (stashed) return;
    if (git(['status', '--porcelain'], true).stdout.trim().length === 0) return;
    const r = git(['stash', 'push', '-u', '-m', 'code-walkthrough-capture'], true);
    if (r.status !== 0) throw new Error('git stash failed: ' + r.stderr.trim());
    stashed = true; log('  stashed uncommitted changes');
  };
  const checkout = (ref) => {
    const r = git(['checkout', '-f', ref], true);
    if (r.status !== 0) throw new Error(`git checkout -f ${ref} failed: ${r.stderr.trim()}`);
    log(`  checked out ${ref}`);
  };
  const rebuildAndWait = async () => {
    if (o.rebuild) { runRebuild(o.rebuild); if (o.restart) await waitDown(mainReady); }
    await waitReady(mainReady);
  };
  const restore = async () => {
    log('\n— RESTORE —');
    try { checkout(origRef); } catch (e) { console.error('  checkout orig failed:', e.message); }
    if (stashed) {
      const r = git(['stash', 'pop'], true);
      if (r.status !== 0) console.error('  stash pop failed — recover with `git stash list` / `git stash pop`:\n' + r.stderr);
      else { stashed = false; log('  restored stashed changes'); }
    }
    if (o.rebuild) { log('  rebuilding to original code…'); runRebuild(o.rebuild); if (o.restart) await waitDown(mainReady).catch((e) => log('  ' + e.message)); await waitReady(mainReady, true); }
    log(`  back on ${origRef}`);
  };

  try {
    if (afterIsWorking) { log('\n— AFTER (working tree; app assumed current) —'); await waitReady(mainReady); capture('-after', mainBase); }
    else { log(`\n— AFTER (${o.after}) —`); stashIfDirty(); checkout(o.after); await rebuildAndWait(); capture('-after', mainBase); }
    log(`\n— BEFORE (${o.before}) —`); stashIfDirty(); checkout(o.before); await rebuildAndWait(); capture('-before', mainBase);
  } catch (err) {
    console.error(`\n✗ ${err.message}`); await restore(); process.exit(1);
  }
  await restore();
}

// ============================================================
// shared helpers
// ============================================================
function runRebuild(cmd) {
  log(`  rebuild: ${cmd}`);
  const r = spawnSync('sh', ['-c', cmd], { stdio: 'inherit' });
  if (r.status !== 0) log(`  (rebuild command exited ${r.status} — continuing to poll readiness)`);
}

// Confirm the old server stopped (IN-PLACE). If it never goes down, the rebuild's
// kill did nothing (e.g. `lsof` not installed) and we'd screenshot the STALE
// server at the wrong code — so fail loudly.
async function waitDown(url) {
  const deadline = Date.now() + o.downTimeout * 1000;
  process.stderr.write(`  waiting for ${url} to go down …`);
  for (;;) {
    let up = false;
    try { const res = await fetch(url, { method: 'GET', redirect: 'manual' }); up = res.status > 0 && res.status < 500; } catch { up = false; }
    if (!up) { process.stderr.write(' down\n'); return; }
    if (Date.now() > deadline) {
      process.stderr.write(' STILL UP\n');
      throw new Error(`app at ${url} never went down after the rebuild — its kill step likely did nothing ` +
        `(e.g. \`lsof\` not installed). The before/after frames would be identical. Fix the --rebuild kill, ` +
        `pass --no-restart for a zero-downtime rebuild, or use --worktree (no kill needed).`);
    }
    await sleep(1000); process.stderr.write('.');
  }
}

async function waitReady(url, best = false) {
  const deadline = Date.now() + o.readyTimeout * 1000;
  process.stderr.write(`  waiting for ${url} …`);
  for (;;) {
    let ok = false;
    try { const res = await fetch(url, { method: 'GET', redirect: 'manual' }); ok = res.status > 0 && res.status < 500; } catch { ok = false; }
    if (ok) { process.stderr.write(' up\n'); break; }
    if (Date.now() > deadline) {
      process.stderr.write(' timeout\n');
      if (best) return;
      throw new Error(`app not ready at ${url} within ${o.readyTimeout}s`);
    }
    await sleep(2000); process.stderr.write('.');
  }
  if (o.settle) await sleep(o.settle);
}

function capture(suffix, base) {
  const args = [CAPTURE, listPath, '--suffix', suffix, '--base', base];
  if (o.outDir) args.push('--out-dir', o.outDir);
  const r = spawnSync('node', args, { stdio: 'inherit' });
  if (r.status !== 0) throw new Error(`capture-shots failed for suffix ${suffix}`);
}

function withPort(urlStr, port) {
  const u = new URL(urlStr); u.port = String(port);
  return u.toString().replace(/\/$/, '');
}
function portInUse(port) {
  const r = spawnSync('sh', ['-c', `ss -ltnH 'sport = :${port}' 2>/dev/null | grep -q .`]);
  if (r.status === 0) return true;        // ss found a listener
  // ss unavailable or no match — best-effort: a free port is the safe assumption
  return false;
}
function killPort(port) {
  spawnSync('sh', ['-c',
    `( lsof -i:${port} -t 2>/dev/null || ss -ltnpH 'sport = :${port}' 2>/dev/null | grep -oP 'pid=\\K[0-9]+' ) | xargs -r kill -9`],
    { stdio: 'ignore' });
}
function sanitize(ref) { return ref.replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 40); }
function currentRef() {
  const branch = git(['symbolic-ref', '--quiet', '--short', 'HEAD'], true);
  if (branch.status === 0 && branch.stdout.trim()) return branch.stdout.trim();
  return git(['rev-parse', 'HEAD'], true).stdout.trim();
}
function git(args, quiet = false) { return spawnSync('git', args, { encoding: 'utf8', stdio: quiet ? 'pipe' : 'inherit' }); }
function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }
function log(m) { process.stderr.write(m + '\n'); }
function die(m) { console.error(m); process.exit(1); }
