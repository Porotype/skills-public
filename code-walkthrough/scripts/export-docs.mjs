// code-walkthrough document emitters — Markdown + standalone HTML.
//
// Both are derived from the SAME resolved scene data the video uses (see
// scenes.mjs / render-code.mjs), so a walkthrough reads the same whichever
// format you open. The HTML reuses stage.css (the video's look) verbatim and
// embeds the per-scene markup serialized straight from the live stage, plus an
// interactive before/after slider; the Markdown uses native fenced blocks and
// image references so it renders anywhere (GitHub, editors) with no tooling.

import { writeFileSync, copyFileSync, mkdirSync } from 'node:fs';
import { join, basename, extname } from 'node:path';

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// [92, 395,396,397] → "92, 395–397"
function compressRanges(nums) {
  const s = [...new Set(nums)].sort((a, b) => a - b);
  const out = [];
  for (let i = 0; i < s.length; i++) {
    let j = i;
    while (j + 1 < s.length && s[j + 1] === s[j] + 1) j++;
    out.push(i === j ? `${s[i]}` : `${s[i]}–${s[j]}`);
    i = j;
  }
  return out.join(', ');
}

// =============================================================
// Markdown
// =============================================================

// groups: from groupScenes() — [{ action, resolved, narration, highlight:[] }]
// ctx: { base, name, imagesDir, hasVideo, srt }
export function writeMarkdown(groups, intro, ctx) {
  mkdirSync(ctx.imagesDir, { recursive: true });
  const usedNames = new Set();
  let diagramN = 0;

  // Copy a source image into images/ with a unique, readable name; return the
  // markdown-relative path.
  const copyImage = (absPath, hint) => {
    let nm = basename(absPath);
    if (hint) nm = `${hint}${extname(absPath) || '.png'}`;
    let final = nm, i = 2;
    while (usedNames.has(final)) { const e = extname(nm); final = `${nm.slice(0, -e.length || undefined)}-${i++}${e}`; }
    usedNames.add(final);
    copyFileSync(absPath, join(ctx.imagesDir, final));
    return `images/${final}`;
  };

  const out = [];
  // intro
  if (intro) {
    if (intro.kicker) out.push(`**${esc(intro.kicker).toUpperCase()}**`, '');
    out.push(`# ${intro.title || 'Code walkthrough'}`, '');
    if (intro.subtitle) out.push(`*${intro.subtitle}*`, '');
    if (ctx.hasVideo) out.push(`▶ [Watch the narrated video](./${ctx.name}.mp4)`, '');
    if (intro.note) out.push('`' + intro.note + '`', '');
    if (intro.narration) out.push(intro.narration, '');
    out.push('---', '');
  }

  for (const g of groups) {
    const a = g.action || {};
    const r = g.resolved || {};
    // A section is a chapter heading; its narration follows as prose.
    if (a.type === 'section') {
      if (r.title) out.push(`## ${r.title}`, '');
      if (r.subtitle) out.push(`*${r.subtitle}*`, '');
      if (g.narration) out.push(g.narration, '');
      continue;
    }
    if (g.narration) out.push(g.narration, '');
    switch (a.type) {
      case 'code': {
        if (g.highlight?.length) out.push(`*Focus: line${g.highlight.length > 1 ? 's' : ''} ${compressRanges(g.highlight)}*`, '');
        out.push('```' + (r.lang || ''));
        out.push(...r.lines.map((l) => l.text));
        out.push('```', '');
        break;
      }
      case 'diff': {
        out.push('```diff');
        out.push(...r.rows.map(rowToDiffLine));
        out.push('```', '');
        break;
      }
      case 'diagram': {
        const file = `images/diagram-${++diagramN}.svg`;
        writeFileSync(join(ctx.imagesDir, basename(file)), r.svg);
        out.push(`![${esc(r.caption || 'diagram')}](${file})`, '');
        if (r.caption) out.push(`*${r.caption}*`, '');
        break;
      }
      case 'image': {
        const rel = copyImage(r.srcPath);
        out.push(`![${esc(r.caption || basename(r.srcPath))}](${rel})`, '');
        if (r.caption) out.push(`*${r.caption}*`, '');
        break;
      }
      case 'compare': {
        const b = copyImage(r.beforePath, 'compare-before');
        const af = copyImage(r.afterPath, 'compare-after');
        out.push(`**${r.beforeLabel || 'Before'}**`, '', `![${esc(r.beforeLabel || 'before')}](${b})`, '');
        out.push(`**${r.afterLabel || 'After'}**`, '', `![${esc(r.afterLabel || 'after')}](${af})`, '');
        if (r.caption) out.push(`*${r.caption}*`, '');
        break;
      }
      default: break; // silent / wait
    }
  }

  const path = `${ctx.base}.md`;
  writeFileSync(path, out.join('\n').replace(/\n{3,}/g, '\n\n').trimEnd() + '\n');
  return path;
}

function rowToDiffLine(r) {
  if (r.kind === 'add') return '+' + r.text;
  if (r.kind === 'del') return '-' + r.text;
  if (r.kind === 'hunk') return r.text;
  return ' ' + r.text;
}

// =============================================================
// HTML
// =============================================================

// blocks: [{ group, fragment }] where fragment is serialized stage innerHTML for
// code/diff/diagram/image/section, or null for compare (built here as a slider).
// ctx: { base, name, stageCss, hasVideo }
export function buildHtml(blocks, intro, ctx) {
  const sections = blocks.map(({ group, fragment }) => {
    const a = group.action || {};
    const narr = group.narration ? `<p class="cv-narration">${esc(group.narration)}</p>` : '';
    let visual;
    if (a.type === 'compare') visual = compareSlider(group.resolved);
    else visual = `<div class="cv-visual">${fragment || ''}</div>`;
    return `<section class="cv-scene">${narr}${visual}</section>`;
  }).join('\n');

  const header = intro ? introHeader(intro, ctx) : '';
  const video = ctx.hasVideo
    ? `<video class="cv-video" controls preload="metadata" src="./${esc(ctx.name)}.mp4"></video>`
    : '';

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${esc(intro?.title || ctx.name)}</title>
<style>
${ctx.stageCss}
${DOC_CSS}
</style>
</head>
<body class="cv-doc">
<main class="cv-wrap">
${video}
${header}
${sections}
</main>
<script>${SLIDER_JS}</script>
</body>
</html>
`;
}

function introHeader(intro, ctx) {
  return `<header class="cv-head">
  ${intro.kicker ? `<div class="cv-kicker">${esc(intro.kicker)}</div>` : ''}
  <h1 class="cv-title">${esc(intro.title || 'Code walkthrough')}</h1>
  ${intro.subtitle ? `<div class="cv-subtitle">${esc(intro.subtitle)}</div>` : ''}
  ${intro.note ? `<div class="cv-note">${esc(intro.note)}</div>` : ''}
</header>`;
}

function compareSlider(r) {
  const bl = esc(r.beforeLabel || 'Before');
  const al = esc(r.afterLabel || 'After');
  const cap = r.caption ? `<div class="caption">${esc(r.caption)}</div>` : '';
  return `<div class="cv-visual"><div class="cv-cmpwrap">
  <div class="cv-compare" data-cv-compare>
    <img class="after" src="${r.after}" alt="${al}">
    <img class="before" src="${r.before}" alt="${bl}">
    <div class="cv-divider"></div>
    <span class="cv-tag b">${bl}</span>
    <span class="cv-tag a">${al}</span>
    <input class="cv-range" type="range" min="0" max="100" value="50" aria-label="Drag to compare before and after">
  </div>${cap}</div></div>`;
}

// Doc-level layout: neutralize stage.css's full-viewport positioning (the doc
// flows top-to-bottom) and style narration, the video, and the compare slider.
const DOC_CSS = `
html, body.cv-doc { overflow: auto; height: auto; min-height: 100%; }
body.cv-doc { background: radial-gradient(140% 90% at 50% 0%, #1b2330 0%, var(--bg0) 55%) fixed; }
.cv-wrap { max-width: 1180px; margin: 0 auto; padding: 34px 24px 110px; }
.cv-video { width: 100%; border-radius: 12px; border: 1px solid #30363d; box-shadow: 0 24px 70px rgba(0,0,0,.55); display: block; background: #000; margin-bottom: 10px; }
.cv-head { padding: 26px 4px 8px; border-bottom: 1px solid #21262d; margin-bottom: 16px; }
.cv-kicker { font-size: 13px; letter-spacing: .18em; text-transform: uppercase; color: var(--accent); font-weight: 600; margin-bottom: .8em; }
.cv-title { font-size: clamp(30px, 5vw, 50px); font-weight: 700; letter-spacing: -0.02em; margin: 0 0 .25em; color: #fff; }
.cv-subtitle { font-size: clamp(16px, 2.4vw, 22px); color: var(--muted); }
.cv-note { margin-top: 1em; font-family: var(--mono); font-size: 13px; color: #6e7681; }
.cv-scene { margin: 42px 0; }
.cv-narration { font-size: 18px; line-height: 1.62; color: #c9d1d9; max-width: 72ch; margin: 0 0 18px; }
.cv-visual { position: relative; }
/* neutralize stage's absolute/full-height layout inside flowing sections */
.cv-visual .editor { height: auto; max-height: 80vh; max-width: none; }
.cv-visual .code-scroll { max-height: 80vh; }
.cv-visual .diagram, .cv-visual .imgwrap, .cv-visual .section { height: auto; }
.cv-visual .diagram { gap: 16px; }
.cv-visual .diagram svg { max-height: 66vh; }
.cv-visual .imgwrap img { max-height: 80vh; }
.cv-visual .section { padding: 7vmin 6vmin; border: 1px solid #30363d; border-radius: 12px; background: var(--bg1); }
/* before/after slider */
.cv-cmpwrap { display: flex; flex-direction: column; align-items: center; gap: 16px; }
.cv-compare { position: relative; width: 100%; border-radius: 10px; overflow: hidden; border: 1px solid #30363d; box-shadow: 0 20px 60px rgba(0,0,0,.5); background: var(--bg1); }
.cv-compare img { display: block; width: 100%; height: auto; }
.cv-compare img.before { position: absolute; inset: 0; clip-path: inset(0 50% 0 0); }
.cv-divider { position: absolute; top: 0; bottom: 0; left: 50%; width: 2px; background: var(--accent); box-shadow: 0 0 12px rgba(255,123,41,.8); transform: translateX(-1px); pointer-events: none; z-index: 4; }
.cv-divider::after { content: '⇿'; position: absolute; top: 50%; left: 50%; width: 34px; height: 34px; transform: translate(-50%,-50%); border-radius: 50%; background: var(--accent); color: #fff; font: 600 16px/34px var(--ui); text-align: center; }
.cv-tag { position: absolute; top: 12px; z-index: 5; font: 600 13px var(--ui); color: #fff; padding: 4px 12px; border-radius: 20px; backdrop-filter: blur(4px); }
.cv-tag.b { left: 12px; background: rgba(120,120,130,.75); }
.cv-tag.a { right: 12px; background: rgba(255,123,41,.85); }
.cv-range { position: absolute; inset: 0; width: 100%; height: 100%; margin: 0; opacity: 0; cursor: ew-resize; }
`;

const SLIDER_JS = `
for (const c of document.querySelectorAll('[data-cv-compare]')) {
  const r = c.querySelector('.cv-range'), b = c.querySelector('img.before'), d = c.querySelector('.cv-divider');
  const upd = () => { const v = r.value; b.style.clipPath = 'inset(0 ' + (100 - v) + '% 0 0)'; d.style.left = v + '%'; };
  r.addEventListener('input', upd); upd();
}
`;
