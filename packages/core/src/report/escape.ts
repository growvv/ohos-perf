/**
 * HTML-escape every interpolated value.
 *
 * `&` first, or the other replacements would double-escape. The result is safe
 * inside text nodes and double-quoted attributes; no renderer emits single
 * quotes into attribute values, but escaping them is cheaper than remembering
 * that at each call site.
 *
 * One copy serves every page the package writes — the report, the UI diff and
 * the flamegraph — so a page cannot escape less than its neighbours.
 */
export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
