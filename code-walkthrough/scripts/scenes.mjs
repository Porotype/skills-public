// Shared scene resolution for the code-walkthrough skill.
//
// A "scene action" (the JSON the user authors) is resolved here into plain data
// — code lines, diff rows, data-URI images, a rendered diagram SVG. This module
// has NO browser/Playwright dependency, so the SAME resolved data feeds three
// emitters: the video stage (stage.html via render-code.mjs), the HTML export,
// and the Markdown export. "Same presentation, different formats."
//
// Diagrams are rendered to SVG once, in Node, with beautiful-mermaid — so the
// identical diagram appears in the video, the HTML, and the MD.

import { readFileSync, existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join, resolve, extname, isAbsolute } from 'node:path';
// beautiful-mermaid is ESM-only (its package `exports` define no CJS entry), so
// it must be a static `import`, not createRequire — the latter throws
// ERR_PACKAGE_PATH_NOT_EXPORTED.
import { renderMermaidSVG } from 'beautiful-mermaid';

// Diagram theme — matches stage.css (the dark/orange look) so video, HTML and MD
// diagrams are visually identical. `transparent` lets the stage/section bg show.
export const DIAGRAM_THEME = {
  bg: '#0d1117', fg: '#c9d1d9', accent: '#ff7b29',
  surface: '#161b22', border: '#30363d', line: '#8b949e', muted: '#8b949e',
  font: 'system-ui, -apple-system, "Segoe UI", Roboto, sans-serif',
  transparent: true, padding: 24,
};

// Build the resolver bound to a git repo root.
export function makeScenes(repoRoot) {
  function resolveRepoPath(p) {
    if (isAbsolute(p)) return p;
    const atRoot = join(repoRoot, p);
    if (existsSync(atRoot)) return atRoot;
    return resolve(process.cwd(), p);
  }

  // Read a source file, optionally at a git ref. No ref = working tree (disk).
  function readSource(file, ref) {
    if (!ref || ref === 'working' || ref === 'worktree') return readFileSync(resolveRepoPath(file), 'utf8');
    const r = spawnSync('git', ['show', `${ref}:${file}`], { cwd: repoRoot, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
    if (r.status !== 0) throw new Error(`git show ${ref}:${file} failed: ${r.stderr.trim()}`);
    return r.stdout;
  }

  // Build a unified diff. Selection rules:
  //   { ref }       → that commit's own diff  (git show <ref>)
  //   { base, ref } → git diff base..ref
  //   (neither)     → working tree vs HEAD    (git diff HEAD)
  function gitDiff(a) {
    const files = a.allFiles ? [] : ['--', a.file];
    const ctx = a.context != null ? `-U${a.context}` : '-U3';
    let args;
    if (a.ref && a.base) args = ['diff', ctx, `${a.base}`, `${a.ref}`, ...files];
    else if (a.ref)      args = ['show', ctx, '--format=', a.ref, ...files];
    else                 args = ['diff', ctx, a.base || 'HEAD', ...files];
    const r = spawnSync('git', args, { cwd: repoRoot, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
    if (r.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${r.stderr.trim()}`);
    return r.stdout;
  }

  function toDataUri(p) {
    const abs = resolveRepoPath(p);
    if (!existsSync(abs)) throw new Error(`image not found: ${p} (looked at ${abs})`);
    const ext = extname(abs).toLowerCase().slice(1);
    const mime = ext === 'svg' ? 'image/svg+xml' : ext === 'jpg' || ext === 'jpeg' ? 'image/jpeg'
      : ext === 'gif' ? 'image/gif' : ext === 'webp' ? 'image/webp' : 'image/png';
    return `data:${mime};base64,${readFileSync(abs).toString('base64')}`;
  }

  function resolveCode(a) {
    let text;
    if (typeof a.code === 'string') text = a.code;
    else if (a.file) text = readSource(a.file, a.ref);
    else throw new Error('code: needs `file` (with optional `ref`) or inline `code`');
    const allLines = text.replace(/\n$/, '').split('\n');
    let startNo = 1, slice = allLines;
    if (a.lines) {
      const [s, e] = parseRange(a.lines);
      startNo = s;
      slice = allLines.slice(s - 1, e);
    }
    const lines = slice.map((t, i) => ({ no: startNo + i, text: t }));
    return {
      fname: a.title || a.file || 'snippet',
      lang: a.lang || langFor(a.file),
      badge: a.badge,
      lines,
      highlight: expandHighlight(a.highlight),
    };
  }

  function resolveDiff(a) {
    let diffText;
    if (typeof a.diff === 'string') diffText = a.diff;
    else if (a.file || a.allFiles) diffText = gitDiff(a);
    else throw new Error('diff: needs `file`/`allFiles` (with refs) or inline `diff`');
    const rows = parseUnifiedDiff(diffText, { context: a.context });
    if (!rows.length) throw new Error('diff: produced no rows (empty diff?) — check refs/file path');
    return {
      fname: a.title || a.file || 'diff',
      lang: a.lang || langFor(a.file),
      badge: a.badge || 'diff',
      rows,
      highlight: expandHighlight(a.highlight),
    };
  }

  function resolveImage(a) {
    const p = a.path || a.src;
    if (!p) throw new Error('image: needs `path`');
    return { src: toDataUri(p), srcPath: resolveRepoPath(p), caption: a.caption };
  }

  function resolveCompare(a) {
    if (!a.before || !a.after) throw new Error('compare: needs `before` and `after` image paths');
    return {
      before: toDataUri(a.before),
      after: toDataUri(a.after),
      beforePath: resolveRepoPath(a.before),
      afterPath: resolveRepoPath(a.after),
      mode: a.mode || 'wipe',
      caption: a.caption,
      beforeLabel: a.beforeLabel,
      afterLabel: a.afterLabel,
      hold: a.hold, transition: a.transition,
    };
  }

  function resolveDiagram(a) {
    let def = a.mermaid || a.def;
    if (!def && a.path) def = readFileSync(resolveRepoPath(a.path), 'utf8');
    if (!def) throw new Error('diagram: needs `mermaid` (inline) or `path`');
    let svg;
    try {
      svg = renderMermaidSVG(def, DIAGRAM_THEME);
    } catch (e) {
      // One bad diagram must not abort the whole render.
      svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 600 80">`
        + `<text x="12" y="44" fill="#f85149" font-family="monospace" font-size="15">`
        + `mermaid error: ${escapeXml(e.message)}</text></svg>`;
    }
    return { svg, def, caption: a.caption };
  }

  function resolveScene(action) {
    if (!action) return null;
    switch (action.type) {
      case 'code':    return resolveCode(action);
      case 'diff':    return resolveDiff(action);
      case 'image':   return resolveImage(action);
      case 'compare': return resolveCompare(action);
      case 'diagram': return resolveDiagram(action);
      case 'focus': case 'section': case 'wait': case 'screenshot':
      case 'box': case 'clearBoxes': case 'resetBackground':
        return action;
      default: throw new Error(`Unknown action type: ${action.type}`);
    }
  }

  return { resolveScene, resolveCode, resolveDiff, resolveImage, resolveCompare, resolveDiagram,
    readSource, gitDiff, toDataUri, resolveRepoPath, expandHighlight, parseRange, langFor };
}

// =============================================================
// pure helpers (no repo state)
// =============================================================

// Parse unified diff → rows. ctx/add carry the new-file line number; del has none.
export function parseUnifiedDiff(text, { context } = {}) {
  const rows = [];
  let newNo = 0;
  let firstHunk = true;
  for (const line of text.split('\n')) {
    if (line.startsWith('diff ') || line.startsWith('index ') ||
        line.startsWith('--- ') || line.startsWith('+++ ') ||
        line.startsWith('new file') || line.startsWith('deleted file') ||
        line.startsWith('similarity ') || line.startsWith('rename ') ||
        line.startsWith('old mode') || line.startsWith('new mode')) continue;
    if (line.startsWith('@@')) {
      const m = /\+(\d+)/.exec(line);
      newNo = m ? parseInt(m[1], 10) : newNo;
      const label = (line.split('@@')[2] || '').trim();
      if (!firstHunk) rows.push({ kind: 'hunk', text: label ? `   ⋯  ${label}` : '   ⋯', no: null });
      firstHunk = false;
      continue;
    }
    if (line.startsWith('+')) { rows.push({ kind: 'add', text: line.slice(1), no: newNo }); newNo++; }
    else if (line.startsWith('-')) { rows.push({ kind: 'del', text: line.slice(1), no: null }); }
    else if (line.startsWith('\\')) { /* "\ No newline at end of file" */ }
    else { rows.push({ kind: 'ctx', text: line.slice(1), no: newNo }); newNo++; }
  }
  while (rows.length && rows[rows.length - 1].kind === 'ctx' && rows[rows.length - 1].text === '') rows.pop();
  return rows;
}

export function parseRange(spec) {
  if (Array.isArray(spec)) return [spec[0], spec[1]];
  const s = String(spec).trim();
  const m = /^(\d+)\s*[-:]\s*(\d+)$/.exec(s);
  if (m) return [parseInt(m[1], 10), parseInt(m[2], 10)];
  const n = parseInt(s, 10);
  return [n, n];
}

// highlight accepts numbers and "a-b" range strings → flat list of line numbers.
export function expandHighlight(spec) {
  if (!spec) return [];
  const arr = Array.isArray(spec) ? spec : [spec];
  const out = [];
  for (const item of arr) {
    if (typeof item === 'number') out.push(item);
    else {
      const [s, e] = parseRange(item);
      for (let n = s; n <= e; n++) out.push(n);
    }
  }
  return out;
}

export function langFor(file) {
  if (!file) return null;
  const ext = extname(file).toLowerCase().slice(1);
  const map = {
    java: 'java', kt: 'kotlin', js: 'javascript', mjs: 'javascript', cjs: 'javascript',
    ts: 'typescript', tsx: 'typescript', jsx: 'javascript', py: 'python', rb: 'ruby',
    go: 'go', rs: 'rust', c: 'c', h: 'c', cpp: 'cpp', cc: 'cpp', cs: 'csharp',
    php: 'php', swift: 'swift', scala: 'scala', sh: 'bash', bash: 'bash', zsh: 'bash',
    sql: 'sql', html: 'xml', xml: 'xml', css: 'css', scss: 'scss', json: 'json',
    yml: 'yaml', yaml: 'yaml', md: 'markdown', toml: 'ini', properties: 'properties',
  };
  return map[ext] || null;
}

function escapeXml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// =============================================================
// grouping — collapse "talk-through" beats into one visual block
// =============================================================
//
// A code/diff/image/compare/diagram/section scene opens a new visual block.
// focus/wait/box/clearBoxes don't show anything new — they re-spotlight or pause
// the CURRENT visual — so in a static doc their narration is folded into the
// open block, and a focus chain's highlight lines are unioned onto it. This turns
// a "diff + three focus beats" sequence into one annotated block in MD/HTML
// (the video still plays each beat in sequence).
const VISUAL = new Set(['code', 'diff', 'image', 'compare', 'diagram', 'section']);

export function groupScenes(scenes) {
  const groups = [];
  let cur = null;
  for (const s of scenes) {
    const type = s.action?.type;
    if (!type || VISUAL.has(type)) {
      cur = { action: s.action, resolved: s._resolved, narration: [], highlight: new Set() };
      if (s.narration) cur.narration.push(s.narration.trim());
      if (s._resolved?.highlight) for (const n of s._resolved.highlight) cur.highlight.add(n);
      groups.push(cur);
    } else {
      // focus/wait/box/clearBoxes: attach to the open block.
      if (!cur) { cur = { action: { type: 'section' }, resolved: { title: '' }, narration: [], highlight: new Set() }; groups.push(cur); }
      if (s.narration) cur.narration.push(s.narration.trim());
      if (type === 'focus') {
        const hl = expandHighlight(s.action.highlight);
        // An explicit empty focus ("highlight": []) clears the spotlight.
        if (hl.length) for (const n of hl) cur.highlight.add(n);
      }
    }
  }
  return groups.map((g) => ({ ...g, narration: g.narration.join(' '), highlight: [...g.highlight] }));
}
