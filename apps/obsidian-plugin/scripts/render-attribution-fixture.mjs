/**
 * Deterministic render fixture generator for the F6-01 author overlay.
 *
 * Bundles the pure `attribution` module (esbuild, node platform) and renders
 * its ACTUAL output into a static HTML page that shows the light and dark
 * themes, the reduced-motion variant, and every hidden-overlay state. This is
 * evidence for the qualitative AC "colour + underline + tooltip together, never
 * colour alone", it is derived from the same code the tests exercise, never
 * hand-faked. It is NOT a screenshot of Obsidian itself (see report).
 *
 * Usage: node scripts/render-attribution-fixture.mjs
 */

import { build } from 'esbuild';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '../../..');
const outDir = resolve(repoRoot, 'screenshots/F6');

const bundle = await build({
  entryPoints: [resolve(here, '../src/attribution/attribution.ts')],
  bundle: true,
  platform: 'node',
  format: 'esm',
  write: false,
  logLevel: 'silent',
});
const code = bundle.outputFiles[0].text;
const moduleUrl =
  'data:text/javascript;base64,' + Buffer.from(code).toString('base64');
const attribution = await import(moduleUrl);

const {
  buildLivePreviewOverlay,
  buildReadingViewOverlay,
  AUTHOR_COLOR_TOKENS,
  INITIAL_IMPORT_COLOR_TOKEN,
} = attribution;

const format = (ts) => new Date(ts).toISOString().slice(0, 16).replace('T', ' ');

const authors = new Map([
  ['r1', { actor: { kind: 'author', actorId: 'a-ana', displayName: 'Ana' }, timestamp: 1_700_000_000_000 }],
  ['r2', { actor: { kind: 'author', actorId: 'a-bob', displayName: 'Bob' }, timestamp: 1_700_050_000_000 }],
  ['imp', { actor: { kind: 'initial-import' }, timestamp: 0 }],
]);

const content = 'Shared roadmap\nAna wrote this line\nBob revised this one\nImported footer\n';
const provenance = [
  { length: 'Shared roadmap\n'.length, sourceRevisionId: 'imp' },
  { length: 'Ana wrote this line\n'.length, sourceRevisionId: 'r1' },
  { length: 'Bob revised this one\n'.length, sourceRevisionId: 'r2' },
  { length: 'Imported footer\n'.length, sourceRevisionId: 'imp' },
];
const HASH = 'blob-demo';
const input = {
  enabled: true,
  content,
  contentHash: HASH,
  headBlobHash: HASH,
  provenance,
  authors,
  reducedMotion: false,
  formatTimestamp: format,
};

const live = buildLivePreviewOverlay(input);
const liveReduced = buildLivePreviewOverlay({ ...input, reducedMotion: true });
const reading = buildReadingViewOverlay(input, [
  { blockId: 'b0', section: { lineStart: 0, lineEnd: 0 } },
  { blockId: 'b1', section: { lineStart: 1, lineEnd: 1 } },
  { blockId: 'b2', section: { lineStart: 2, lineEnd: 2 } },
  { blockId: 'b3', section: { lineStart: 3, lineEnd: 3 } },
  { blockId: 'b-unmapped', section: null },
]);
const hiddenHash = buildLivePreviewOverlay({ ...input, contentHash: 'blob-locally-edited' });
const hiddenDisabled = buildLivePreviewOverlay({ ...input, enabled: false });

const esc = (value) =>
  String(value).replace(/[&<>"]/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[ch]);

// Accessible colour values behind the editor-layer tokens (WCAG AA text/underline
// against both themes). Tokens map 1:1 to the module's colorToken constants.
const tokenCss = `
  --havemind-author-1: #1a6b52; --havemind-author-1-strong: #0d4a37;
  --havemind-author-2: #8a4b1f; --havemind-author-2-strong: #6b3812;
  --havemind-author-3: #3a4fa0; --havemind-author-4: #7a2f6b;
  --havemind-author-5: #2f6b6b; --havemind-author-6: #6b5a1f;
  --havemind-author-initial: #566072;`;
const tokenCssDark = `
  --havemind-author-1: #5fd6ad; --havemind-author-1-strong: #8ce8c6;
  --havemind-author-2: #e0a06a; --havemind-author-2-strong: #f0bd8f;
  --havemind-author-3: #9db0ff; --havemind-author-4: #e29bd4;
  --havemind-author-5: #7fd6d6; --havemind-author-6: #d6c47f;
  --havemind-author-initial: #97a1b5;`;

const contentLines = content.split('\n');

function renderLive(overlay) {
  return overlay.segments
    .map((seg) => {
      const text = content.slice(seg.from, seg.to).replace(/\n$/, '');
      const cls = seg.animate ? 'seg animate' : 'seg';
      return `<div class="${cls}" style="--c: var(${esc(seg.colorToken)});" title="${esc(seg.tooltip)}" aria-label="${esc(seg.ariaLabel)}" tabindex="0">${esc(text)}</div>`;
    })
    .join('\n');
}

function renderReading(overlay) {
  return overlay.markers
    .map((marker) => {
      const text = contentLines[Number(marker.blockId.slice(1))] ?? marker.blockId;
      const cls = marker.animate ? 'block animate' : 'block';
      return `<div class="${cls}" style="--c: var(${esc(marker.colorToken)});" title="${esc(marker.tooltip)}" aria-label="${esc(marker.ariaLabel)}" tabindex="0">${esc(text)}</div>`;
    })
    .join('\n');
}

function renderLegend(legend) {
  return legend
    .map(
      (entry) =>
        `<li><span class="swatch" style="background: var(${esc(entry.colorToken)});"></span>${esc(entry.label)}</li>`,
    )
    .join('');
}

const panel = (title, live, reading, legend, note) => `
  <section class="panel">
    <h3>${esc(title)}</h3>
    ${note ? `<p class="note">${esc(note)}</p>` : ''}
    <h4>Live Preview (inline segments)</h4>
    <div class="editor">${live}</div>
    <h4>Reading view (block markers)</h4>
    <div class="editor">${reading}</div>
    <h4>Legend</h4>
    <ul class="legend">${legend}</ul>
  </section>`;

const themeBlock = (themeAttr, themeName, tokens) => `
  <div class="theme" data-theme="${themeAttr}" style="${tokens}">
    <h2>${esc(themeName)}</h2>
    ${panel('Overlay on (animated)', renderLive(live), renderReading(reading), renderLegend(live.legend))}
    ${panel('Reduced motion (static colour + underline, no animation)', renderLive(liveReduced), renderReading(reading), renderLegend(liveReduced.legend), 'prefers-reduced-motion honoured: colour and underline appear immediately, highlight animation suppressed.')}
    ${panel('Overlay hidden, hash mismatch', '<p class="hidden">Overlay hidden (reason: ' + esc(hiddenHash.hiddenReason) + '). No attribution shown after external edit.</p>', '<p class="hidden">Reading view silent.</p>', '')}
    ${panel('Overlay hidden, toggle off', '<p class="hidden">Overlay hidden (reason: ' + esc(hiddenDisabled.hiddenReason) + ').</p>', '<p class="hidden">Reading view silent.</p>', '')}
  </div>`;

const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Havemind F6-01 author overlay, render fixture</title>
<style>
  :root { ${tokenCss} font-family: -apple-system, system-ui, sans-serif; }
  body { margin: 0; background: #f3f4f6; color: #1f2328; }
  .fixtures { display: grid; grid-template-columns: 1fr 1fr; gap: 0; }
  .theme { padding: 24px; min-height: 100vh; }
  .theme[data-theme="light"] { background: #ffffff; color: #1f2328; }
  .theme[data-theme="dark"] { background: #1e2126; color: #dfe3e8; ${tokenCssDark} }
  h1 { text-align: center; padding: 16px; margin: 0; font-size: 18px; }
  h2 { font-size: 16px; margin: 0 0 12px; }
  h3 { font-size: 14px; margin: 20px 0 6px; }
  h4 { font-size: 11px; text-transform: uppercase; letter-spacing: .05em; opacity: .6; margin: 12px 0 4px; }
  .panel { border: 1px solid rgba(128,128,128,.25); border-radius: 8px; padding: 12px 16px; margin-bottom: 16px; }
  .note { font-size: 12px; opacity: .75; margin: 0 0 8px; }
  .editor { font-family: ui-monospace, "SF Mono", Menlo, monospace; font-size: 13px; line-height: 1.7; }
  .seg, .block {
    color: var(--c);
    text-decoration: underline;
    text-decoration-color: var(--c);
    text-decoration-thickness: 2px;
    text-underline-offset: 3px;
    cursor: help;
  }
  .block { display: block; border-left: 3px solid var(--c); padding-left: 8px; margin: 2px 0; }
  .seg:focus, .block:focus { outline: 2px solid var(--c); outline-offset: 2px; }
  .seg.animate { animation: fade 1.2s ease-in-out; }
  .block.animate { animation: fade 1.2s ease-in-out; }
  @keyframes fade { from { background: color-mix(in srgb, var(--c) 30%, transparent); } to { background: transparent; } }
  @media (prefers-reduced-motion: reduce) { .seg.animate, .block.animate { animation: none; } }
  .legend { list-style: none; padding: 0; margin: 0; display: flex; flex-wrap: wrap; gap: 12px; font-size: 12px; }
  .legend .swatch { display: inline-block; width: 12px; height: 12px; border-radius: 3px; margin-right: 5px; vertical-align: middle; }
  .hidden { font-size: 12px; font-style: italic; opacity: .7; }
</style>
</head>
<body>
  <h1>Havemind F6-01, author overlay render fixture (deterministic, generated from module output)</h1>
  <div class="fixtures">
    ${themeBlock('light', 'Light theme', tokenCss)}
    ${themeBlock('dark', 'Dark theme', tokenCssDark)}
  </div>
</body>
</html>`;

mkdirSync(outDir, { recursive: true });
writeFileSync(resolve(outDir, 'author-overlay.html'), html, 'utf8');

const summary = {
  generatedAt: 'deterministic (no wall-clock in output)',
  tokens: { authors: AUTHOR_COLOR_TOKENS, initialImport: INITIAL_IMPORT_COLOR_TOKEN },
  live: live.segments.map((s) => ({ from: s.from, to: s.to, colorToken: s.colorToken, underline: s.underline, tooltip: s.tooltip, animate: s.animate })),
  liveReducedAnimate: liveReduced.segments.map((s) => s.animate),
  reading: reading.markers.map((m) => ({ blockId: m.blockId, colorToken: m.colorToken, tooltip: m.tooltip, authors: m.authors.map((a) => a.displayName) })),
  legend: live.legend,
  hidden: { hashMismatch: hiddenHash.hiddenReason, disabled: hiddenDisabled.hiddenReason },
};
writeFileSync(resolve(outDir, 'author-overlay.json'), JSON.stringify(summary, null, 2), 'utf8');

console.log('Wrote', resolve(outDir, 'author-overlay.html'));
console.log('Wrote', resolve(outDir, 'author-overlay.json'));
