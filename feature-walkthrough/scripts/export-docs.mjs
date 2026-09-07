// feature-walkthrough document emitters — Markdown + standalone HTML.
//
// A step-by-step summary of the demo: each step's narration paired with the
// screenshot captured at that beat (see render-demo.mjs). The HTML embeds the
// video at the top; the MD links it. Both reference screenshots in images/, so
// the per-walkthrough folder travels as a unit.

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// docSteps: [{ index, narration, shot: 'images/step-NN.png' | null }]
// intro: { title?, kicker?, subtitle?, note?, narration? } | null
// ctx: { name, title, hasVideo }

export function buildMarkdown(docSteps, intro, ctx) {
  const out = [];
  if (intro?.kicker) out.push(`**${esc(intro.kicker).toUpperCase()}**`, '');
  out.push(`# ${intro?.title || ctx.title || 'Feature walkthrough'}`, '');
  if (intro?.subtitle) out.push(`*${intro.subtitle}*`, '');
  if (ctx.hasVideo) out.push(`▶ [Watch the narrated demo](./${ctx.name}.mp4)`, '');
  if (intro?.narration) out.push(intro.narration, '');
  out.push('---', '');

  let n = 0;
  for (const s of docSteps) {
    n++;
    out.push(`### Step ${n}`, '');
    if (s.narration) out.push(s.narration, '');
    if (s.shot) out.push(`![Step ${n}](${s.shot})`, '');
  }
  return out.join('\n').replace(/\n{3,}/g, '\n\n').trimEnd() + '\n';
}

export function buildHtml(docSteps, intro, ctx) {
  const video = ctx.hasVideo
    ? `<video class="fw-video" controls preload="metadata" src="./${esc(ctx.name)}.mp4"></video>`
    : '';
  const header = `<header class="fw-head">
    ${intro?.kicker ? `<div class="fw-kicker">${esc(intro.kicker)}</div>` : ''}
    <h1 class="fw-title">${esc(intro?.title || ctx.title || 'Feature walkthrough')}</h1>
    ${intro?.subtitle ? `<div class="fw-subtitle">${esc(intro.subtitle)}</div>` : ''}
    ${intro?.narration ? `<p class="fw-lead">${esc(intro.narration)}</p>` : ''}
  </header>`;

  let n = 0;
  const steps = docSteps.map((s) => {
    n++;
    const shot = s.shot ? `<img class="fw-shot" src="${esc(s.shot)}" alt="Step ${n}">` : '';
    const narr = s.narration ? `<p class="fw-narration">${esc(s.narration)}</p>` : '';
    return `<section class="fw-step">
      <div class="fw-num">${n}</div>
      <div class="fw-body">${narr}${shot}</div>
    </section>`;
  }).join('\n');

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${esc(intro?.title || ctx.title || ctx.name)}</title>
<style>${CSS}</style>
</head>
<body>
<main class="fw-wrap">
${video}
${header}
${steps}
</main>
</body>
</html>
`;
}

const CSS = `
:root {
  --bg0:#0d1117; --bg1:#161b22; --fg:#c9d1d9; --muted:#8b949e; --accent:#ff7b29; --border:#30363d;
  --ui: system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
  --mono: ui-monospace, "SF Mono", Menlo, Consolas, monospace;
}
* { box-sizing: border-box; }
html, body { margin:0; }
body { background: radial-gradient(140% 90% at 50% 0%, #1b2330 0%, var(--bg0) 55%) fixed; color: var(--fg); font-family: var(--ui); }
.fw-wrap { max-width: 1100px; margin: 0 auto; padding: 34px 24px 110px; }
.fw-video { width: 100%; border-radius: 12px; border: 1px solid var(--border); box-shadow: 0 24px 70px rgba(0,0,0,.55); display: block; background:#000; margin-bottom: 10px; }
.fw-head { padding: 26px 4px 8px; border-bottom: 1px solid #21262d; margin-bottom: 8px; }
.fw-kicker { font-size: 13px; letter-spacing: .18em; text-transform: uppercase; color: var(--accent); font-weight: 600; margin-bottom: .8em; }
.fw-title { font-size: clamp(30px, 5vw, 50px); font-weight: 700; letter-spacing: -0.02em; margin: 0 0 .25em; color:#fff; }
.fw-subtitle { font-size: clamp(16px, 2.4vw, 22px); color: var(--muted); }
.fw-lead { font-size: 18px; line-height: 1.6; color: var(--fg); max-width: 72ch; }
.fw-step { display: flex; gap: 18px; align-items: flex-start; margin: 34px 0; }
.fw-num { flex: 0 0 auto; width: 38px; height: 38px; border-radius: 50%; background: var(--accent); color:#fff; font: 700 18px/38px var(--ui); text-align: center; box-shadow: 0 4px 14px rgba(255,123,41,.4); }
.fw-body { flex: 1 1 auto; min-width: 0; }
.fw-narration { font-size: 18px; line-height: 1.6; color: var(--fg); max-width: 72ch; margin: 4px 0 14px; }
.fw-shot { display: block; max-width: 100%; border-radius: 10px; border: 1px solid var(--border); box-shadow: 0 18px 50px rgba(0,0,0,.5); }
`;
