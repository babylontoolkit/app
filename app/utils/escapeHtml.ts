/**
 * Escape a string for safe interpolation into HTML text or a double-quoted attribute.
 *
 * Used anywhere the server builds HTML from user-controlled values (the public play page, §4.8). A
 * shared page is world-readable, so an unescaped `<` in a game title is stored XSS. This is the one
 * function that turns that off; call it on EVERY interpolated value, with no exceptions.
 */
export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
