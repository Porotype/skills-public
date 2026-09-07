#!/usr/bin/env node
// capture-shots: take clean, consistent UI screenshots for code-walkthrough `image` /
// `compare` scenes. Drives a *running* app with Playwright and saves a PNG per
// shot — hiding Vaadin dev-tools, at a fixed viewport and device scale so
// before/after frames line up.
//
// Usage:
//   node capture-shots.mjs <shotlist.json> [--out-dir DIR] [--suffix S] [--base URL]
//
//   --out-dir   where PNGs land (default: ./demo/code-walkthrough/assets)
//   --suffix    appended to every shot name, e.g. "-before" (default: none)
//   --base      override baseUrl from the shot list
//
// Shot list schema:
//   {
//     "baseUrl": "http://localhost:8080",
//     "viewport": { "width": 1000, "height": 640 },
//     "deviceScaleFactor": 2,
//     "hideDevTools": true,
//     "storageState": "auth.json",            // optional Playwright storage state
//     "shots": [
//       {
//         "name": "chat",                       // -> <out-dir>/chat<suffix>.png
//         "url": "/",                           // relative to baseUrl (optional if reusing page)
//         "steps": [ <action>, ... ],           // optional interactions before the shot
//         "element": { "selector": "vaadin-dialog-overlay" },  // crop to one element
//         "clip": { "x":0, "y":0, "width":1000, "height":640 },// or a fixed rect
//         "fullPage": false,                    // or whole scrollable page
//         "settle": 350                         // ms to wait before snapping (default 250)
//       }
//     ]
//   }
//
// Actions (a step): { "type": "click|fill|type|press|hover|waitFor|wait|scroll|eval", ... }
//   click/hover/scroll/waitFor: a locator (see below)
//   fill/type:                  a locator + "value" (type adds "delay")
//   press:                      "key"
//   wait:                       "ms"
//   waitFor:                    a locator + optional "state","timeout"
//   eval:                       "script" (string, runs in page)
// Locator (exactly one): selector | role(+name) | label | placeholder | text(+exact) | testId

import { spawnSync } from 'node:child_process';
import { readFileSync, mkdirSync, existsSync } from 'node:fs';
import { dirname, join, resolve, isAbsolute } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';

const __dirname = dirname(fileURLToPath(import.meta.url));
const skillRequire = createRequire(join(__dirname, 'package.json'));

const rawArgs = process.argv.slice(2);
const positional = [];
const opts = {};
for (let i = 0; i < rawArgs.length; i++) {
  const a = rawArgs[i];
  if (a === '--out-dir') opts.outDir = rawArgs[++i];
  else if (a === '--suffix') opts.suffix = rawArgs[++i];
  else if (a === '--base') opts.base = rawArgs[++i];
  else positional.push(a);
}
if (positional.length < 1) die('Usage: capture-shots.mjs <shotlist.json> [--out-dir DIR] [--suffix S] [--base URL]');
const listPath = resolve(positional[0]);
if (!existsSync(listPath)) die(`Shot list not found: ${listPath}`);

await ensureNodeDeps();
const playwrightEntry = skillRequire.resolve('playwright');
const playwrightMod = await import(pathToFileURL(playwrightEntry).href);
const chromium = playwrightMod.chromium || playwrightMod.default?.chromium;
if (!chromium) die('Could not load playwright chromium driver.');

const list = JSON.parse(readFileSync(listPath, 'utf8'));
const baseUrl = (opts.base || list.baseUrl || 'http://localhost:8080').replace(/\/$/, '');
const viewport = list.viewport || { width: 1000, height: 640 };
const deviceScaleFactor = list.deviceScaleFactor || 2;
const suffix = opts.suffix || '';
const outDir = resolve(opts.outDir || join(process.cwd(), 'demo', 'code-walkthrough', 'assets'));
const shots = list.shots || [];
if (!shots.length) die('Shot list has no shots.');
mkdirSync(outDir, { recursive: true });

log(`▶ capturing ${shots.length} shot(s)`);
log(`  base=${baseUrl}  viewport=${viewport.width}x${viewport.height}@${deviceScaleFactor}x  out=${outDir}${suffix ? `  suffix=${suffix}` : ''}`);

const browser = await chromium.launch({ headless: list.headless !== false });
const ctxOpts = { viewport, deviceScaleFactor };
if (list.storageState && existsSync(resolve(list.storageState))) ctxOpts.storageState = resolve(list.storageState);
const context = await browser.newContext(ctxOpts);
if (list.hideDevTools !== false) await context.addInitScript(hideDevToolsScript);
const page = await context.newPage();
page.on('pageerror', (e) => console.error('   [pageerror]', e.message));

const written = [];
try {
  for (const shot of shots) {
    if (!shot.name) die('Every shot needs a "name".');
    if (shot.url) await goto(page, shot.url);
    for (const step of shot.steps || []) await runStep(page, step);
    await page.waitForTimeout(shot.settle ?? 250);

    const out = join(outDir, `${shot.name}${suffix}.png`);
    if (shot.element) {
      await elementForShot(page, shot.element).screenshot({ path: out });
    } else if (shot.clip) {
      await page.screenshot({ path: out, clip: shot.clip });
    } else {
      await page.screenshot({ path: out, fullPage: !!shot.fullPage });
    }
    written.push(out);
    log(`   ✓ ${shot.name}${suffix}.png`);
  }
} catch (err) {
  console.error(`\n✗ capture failed: ${err.message}`);
  await browser.close();
  process.exit(1);
}
await browser.close();

log('');
for (const w of written) log(`✓ ${w}`);

// ============================================================
async function goto(page, url) {
  const full = /^(https?|file):/.test(url) ? url : baseUrl + (url.startsWith('/') ? url : '/' + url);
  await page.goto(full, { waitUntil: 'domcontentloaded' });
  await page.waitForLoadState('networkidle', { timeout: 2500 }).catch(() => {});
}

async function runStep(page, step) {
  const t = step.type;
  const fillable = t === 'fill' || t === 'type';
  const a = fillable ? { ...step, fillable: true } : step;
  switch (t) {
    case 'click':   await locator(page, a).click(); break;
    case 'fill':    await locator(page, a).fill(String(step.value ?? '')); break;
    case 'type':    await locator(page, a).pressSequentially(String(step.value ?? ''), { delay: step.delay ?? 60 }); break;
    case 'press':   await page.keyboard.press(step.key); break;
    case 'hover':   await locator(page, a).hover(); break;
    case 'scroll':  await locator(page, a).scrollIntoViewIfNeeded(); break;
    case 'waitFor': await locator(page, a).waitFor({ state: step.state || 'visible', timeout: step.timeout ?? 10000 }); break;
    case 'wait':    await page.waitForTimeout(step.ms ?? 500); break;
    case 'eval':    await page.evaluate(step.script); break;
    default: throw new Error(`Unknown step type: ${t}`);
  }
}

function baseLocator(page, a) {
  if (a.selector)    return page.locator(a.selector);
  if (a.role)        return page.getByRole(a.role, a.name ? { name: a.name } : undefined);
  if (a.label)       return page.getByLabel(a.label);
  if (a.placeholder) {
    const esc = a.placeholder.replace(/"/g, '\\"');
    if (a.fillable) return page.locator(`input[placeholder="${esc}"], textarea[placeholder="${esc}"]`);
    return page.getByPlaceholder(a.placeholder);
  }
  if (a.text)        return page.getByText(a.text, a.exact ? { exact: true } : undefined);
  if (a.testId)      return page.getByTestId(a.testId);
  throw new Error(`Step has no locator: ${JSON.stringify(a)}`);
}

function locator(page, a) { return baseLocator(page, a).first(); }

// Resolve a screenshot target to the *visible* match. Vaadin apps keep several
// detached/zero-size copies of overlay/template elements in the DOM (dialogs,
// combo-boxes, notifications), so a bare selector's .first() often lands on a
// hidden one. Filtering to visible picks the on-screen instance. Set
// `"visible": false` on the element to opt out.
function elementForShot(page, a) {
  const base = baseLocator(page, a);
  if (a.visible === false) return base.first();
  return base.filter({ visible: true }).first();
}

function hideDevToolsScript() {
  const css = `vaadin-dev-tools, copilot-main, vaadin-dev-tools-info { display: none !important; }`;
  const inject = () => {
    if (!document.head) return false;
    const style = document.createElement('style');
    style.textContent = css;
    document.head.appendChild(style);
    return true;
  };
  if (!inject()) document.addEventListener('DOMContentLoaded', inject, { once: true });
}

async function ensureNodeDeps() {
  if (existsSync(join(__dirname, 'node_modules', 'playwright'))) return;
  log('First run — installing playwright…');
  spawnSync('npm', ['install', '--silent', '--no-audit', '--no-fund'], { cwd: __dirname, stdio: 'inherit' });
  spawnSync('npx', ['--yes', 'playwright', 'install', 'chromium'], { cwd: __dirname, stdio: 'inherit' });
}

function log(m) { process.stderr.write(m + '\n'); }
function die(m) { console.error(m); process.exit(1); }
