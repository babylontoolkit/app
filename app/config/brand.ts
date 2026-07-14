/**
 * Brand module — the single source of every user-facing brand string (SPEC §2.3, §2.5; CLAUDE.md
 * "Branding rule").
 *
 * **No bolt.diy marks in any user-facing surface, and nothing brand-shaped is ever hardcoded in a
 * component, email, meta tag, or the public play page.** Product name, attribution lines, and absolute
 * URLs all come from here (and from `APP_URL` / `PLAY_URL` env for the URLs). Swapping the brand is a
 * change to this one file — which is the whole point of the rule: the final name is undecided (SPEC
 * open questions) and must be swappable without a hunt through the codebase.
 *
 * This is intentionally minimal — the full brand module (logos, colours, taglines, support links,
 * `app/assets/brand/`) is Stage 5. It exists now because Stage 4 shipped the first public surface (the
 * §4.8 play page), and a hardcoded string there would be exactly the violation the rule forbids.
 */
export interface Brand {
  /** The product's working name. Final name undecided — change here only. */
  productName: string;

  /** The attribution shown on public shared games (§4.8 badge). The Toolkit, not the app-builder. */
  playBadgeAttribution: string;

  /** Call to action on the play badge — drives the remix growth loop. */
  playBadgeRemixLabel: string;
}

export const brand: Brand = {
  productName: 'Babylon Toolkit App Builder',
  playBadgeAttribution: 'Made with Babylon Toolkit',
  playBadgeRemixLabel: 'Remix this game',
};
