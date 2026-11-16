import type { UiDiff } from '../ui/compare';
import type { UiTreeDifference } from '../ui/diff';

/**
 * HTML-escape every interpolated value.
 *
 * `&` first, or the other replacements would double-escape. The result is safe
 * inside text nodes and double-quoted attributes; the page emits no single
 * quotes into attribute values.
 */
function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

const STYLE = `
:root { color-scheme: light; }
* { box-sizing: border-box; }
body { margin: 0; padding: 2rem 1.25rem 4rem; font: 15px/1.5 system-ui, -apple-system, "Segoe UI", sans-serif; color: #1c1f24; background: #f6f7f9; }
main { max-width: 1100px; margin: 0 auto; }
h1 { margin: 0 0 .25rem; font-size: 1.75rem; letter-spacing: -.02em; }
h2 { margin: 1.5rem 0 .5rem; font-size: 1.15rem; }
p { margin: .35rem 0; }
code { font: 13px/1.4 ui-monospace, "Cascadia Code", Consolas, monospace; }
.meta { color: #6b7480; font-size: .85rem; }
.card { background: #fff; border: 1px solid #e2e5e9; border-radius: 8px; padding: 1rem 1.1rem; margin: 0 0 1rem; }
.banner { border-left: 4px solid #b45309; background: #fff7ed; padding: .75rem 1rem; border-radius: 6px; margin: 1rem 0; }
.banner h2 { margin: 0 0 .3rem; font-size: 1rem; color: #92400e; }
.banner ul { margin: .3rem 0 0; padding-left: 1.2rem; }
table { width: 100%; border-collapse: collapse; font-size: .88rem; }
th, td { text-align: left; padding: .35rem .5rem; border-bottom: 1px solid #eef0f2; vertical-align: top; }
th { color: #5b6470; font-weight: 600; font-size: .78rem; text-transform: uppercase; letter-spacing: .04em; }
td.num { text-align: right; font-variant-numeric: tabular-nums; }
.chip { display: inline-block; font-size: .72rem; font-weight: 600; padding: .08rem .45rem; border-radius: 999px; background: #eef1f4; text-transform: lowercase; }
.chip.added { background: #eff6ff; color: #1d4ed8; }
.chip.removed { background: #fef2f2; color: #b91c1c; }
.chip.changed { background: #fff7ed; color: #9a3412; }
.screens { display: flex; gap: 1rem; flex-wrap: wrap; }
.screens figure { margin: 0; flex: 1 1 320px; }
.screens img { max-width: 100%; height: auto; border: 1px solid #d7dbe0; border-radius: 6px; }
figcaption { color: #6b7480; font-size: .8rem; }
footer { margin-top: 2rem; color: #6b7480; font-size: .8rem; }
`.trim();

/** One difference row: what changed, where, and the attribute pairs. */
function differenceRow(difference: UiTreeDifference): string {
  const pairs = (difference.attributes ?? [])
    .map((attr) =>
      `<code>${escapeHtml(attr.name)}</code>: ` +
      `${escapeHtml(attr.before)} → ${escapeHtml(attr.after)}`)
    .join('<br>');
  const bounds = difference.bounds === undefined
    ? ''
    : `${difference.bounds.left},${difference.bounds.top}` +
      ` ${difference.bounds.right},${difference.bounds.bottom}`;
  return [
    '<tr>',
    `<td><span class="chip ${escapeHtml(difference.change)}">${escapeHtml(difference.change)}</span></td>`,
    `<td><code>${escapeHtml(difference.path)}</code></td>`,
    `<td>${escapeHtml(difference.type)}</td>`,
    `<td>${escapeHtml(difference.identity)}</td>`,
    `<td class="dim">${escapeHtml(bounds)}</td>`,
    `<td>${pairs}</td>`,
    '</tr>',
  ].join('');
}

/**
 * Render the UI comparison page.
 *
 * Self-contained except for the two marked PNGs beside it: no scripts, no
 * network access, inline CSS. The tolerance and the geometry threshold are
 * stated in the page, so a reader can tell how much difference the numbers
 * already forgive without opening the docs.
 */
export function renderUiDiffHtml(diff: UiDiff): string {
  const image = diff.image;
  const tree = diff.tree;

  const banner = diff.degraded.length === 0
    ? ''
    : [
        '<div class="banner">',
        '<h2>Partial comparison</h2>',
        '<ul>',
        ...diff.degraded.map((line) => `<li>${escapeHtml(line)}</li>`),
        '</ul>',
        '</div>',
      ].join('');

  const screens = diff.a.screenshot === null && diff.b.screenshot === null
    ? '<p class="meta">No screenshots on either side: this comparison is tree-only.</p>'
    : [
        '<h2>Marked screenshots</h2>',
        '<p class="meta">Every rectangle below is drawn in red on both images, at the ' +
          'bounds of a tree difference.</p>',
        '<div class="screens">',
        '<figure>',
        '<img src="ui-diff-marked-a.png" alt="side a with differences marked">',
        `<figcaption>a: ${escapeHtml(diff.a.dir)}</figcaption>`,
        '</figure>',
        '<figure>',
        '<img src="ui-diff-marked-b.png" alt="side b with differences marked">',
        `<figcaption>b: ${escapeHtml(diff.b.dir)}</figcaption>`,
        '</figure>',
        '</div>',
      ].join('');

  const imageNumbers = image === null
    ? '<p class="meta">No image comparison: at least one side has no screenshot.</p>'
    : [
        '<h2>Pixels</h2>',
        '<table>',
        '<thead><tr><th>number</th><th>value</th></tr></thead>',
        '<tbody>',
        `<tr><td>dHash a</td><td><code>${escapeHtml(image.dhashA)}</code></td></tr>`,
        `<tr><td>dHash b</td><td><code>${escapeHtml(image.dhashB)}</code></td></tr>`,
        `<tr><td>Hamming distance (0–64)</td><td class="num">${image.hamming}</td></tr>`,
        `<tr><td>Structural similarity</td><td class="num">${image.similarity}</td></tr>`,
        `<tr><td>Changed pixels (channel difference &gt; ${image.tolerance})</td>` +
          `<td class="num">${image.changedRatio}</td></tr>`,
        `<tr><td>Compared at</td><td class="num">${image.comparedWidth}×${image.comparedHeight}</td></tr>`,
        '</tbody>',
        '</table>',
        '<p class="meta">A pixel counts as changed when any channel differs by more ' +
          `than ${image.tolerance} of 255. Geometry differences under 5 px are not ` +
          'reported as tree differences. Similarity is 1 - hamming/64 and describes ' +
          'structure, not colour; the changed ratio describes pixels.</p>',
      ].join('');

  const treeRows = tree === null
    ? '<p class="meta">No tree comparison: at least one side has no ui.json.</p>'
    : (() => {
        const all = [...tree.added, ...tree.removed, ...tree.changed];
        const rows = all.length === 0
          ? '<tr><td colspan="6" class="meta">No node differences.</td></tr>'
          : all.map(differenceRow).join('');
        return [
          '<h2>Tree</h2>',
          `<p class="meta">${tree.unchanged} matched node` +
            `${tree.unchanged === 1 ? '' : 's'} with no difference.</p>`,
          '<table>',
          '<thead><tr><th>change</th><th>path</th><th>type</th><th>identity</th>' +
            '<th>bounds</th><th>attributes</th></tr></thead>',
          `<tbody>${rows}</tbody>`,
          '</table>',
        ].join('');
      })();

  const captureLines = [
    diff.a.startedAtMs === undefined ? undefined : `a captured at ${diff.a.startedAtMs} ms`,
    diff.b.startedAtMs === undefined ? undefined : `b captured at ${diff.b.startedAtMs} ms`,
  ].filter((line): line is string => line !== undefined);

  return [
    '<!doctype html>',
    '<html lang="en">',
    '<head>',
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    '<title>UI comparison</title>',
    `<style>${STYLE}</style>`,
    '</head>',
    '<body>',
    '<main>',
    '<h1>UI comparison</h1>',
    '<p class="meta">',
    `a: <code>${escapeHtml(diff.a.dir)}</code><br>`,
    `b: <code>${escapeHtml(diff.b.dir)}</code>`,
    '</p>',
    ...(captureLines.length === 0
      ? []
      : [`<p class="meta">${escapeHtml(captureLines.join(' · '))}</p>`]),
    banner,
    screens,
    imageNumbers,
    treeRows,
    '<footer>Generated by @ohos-perf/core. No scripts, no network access.</footer>',
    '</main>',
    '</body>',
    '</html>',
    '',
  ].join('\n');
}
