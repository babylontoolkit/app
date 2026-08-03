/**
 * The pinned logo and its chrome plaque (SPEC §4.1a, §4.5.2; `index.scss` "THE LOGO IS PINNED" block).
 *
 * The owner's design: `.header-brand` (dock toggle + wordmark) is pinned over the sidebar column —
 * counter-translated when docked, floated above the drawer — so the sidebar's gradient strip slides
 * in UNDERNEATH the logo and the two blend into one continuous top bar. The user identity lives in
 * the sidebar's own user row (`SidebarIdentity`, where the date/time used to be) and the clock in
 * the footer.
 *
 * Pinned content hovers over the seam between two animation engines (framer-motion slides the
 * sidebar; a CSS transition pads the body), which do not reliably start on the same frame — so the
 * brand carries its OWN gradient backing (`::before` plaque). Every declaration asserted below was
 * got wrong once and fails SILENTLY (the page renders, computed styles read correctly, and only
 * mid-animation pixels are wrong):
 *
 *   • the plaque exists, is `absolute` (a transformed ancestor is the containing block for `fixed`
 *     descendants, so `fixed` travels with the counter-translate — measured peak 104 vs 75);
 *   • it overhangs LEFT (absorbs one-frame compositor lag) and never grows RIGHT (inside the brand's
 *     stacking context it would paint over the chat title and credits pill);
 *   • the brand is positioned, promoted up front, counter-translated when docked, floated above the
 *     sidebar (`z-logo` > `z-sidebar`);
 *   • the dead `body::before` band stays dead — it CANNOT paint (an opaque in-flow app-shell wrapper
 *     sits above any negative-z body pseudo) and shipped as a "fix" that could never fail;
 *   • the identity renders in the sidebar, not the header, with no fallback name.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const read = (p: string) => readFileSync(join(process.cwd(), p), 'utf8');

/** Strip comments so prose describing a retired rule can never satisfy an assertion about it. */
const stripCss = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '');
const stripTsx = (s: string) => s.replace(/\{\/\*[\s\S]*?\*\/\}/g, '').replace(/\/\*[\s\S]*?\*\//g, '');

const CSS = stripCss(read('app/styles/index.scss'));
const HEADER = stripTsx(read('app/components/header/Header.tsx'));
const MENU = stripTsx(read('app/components/sidebar/Menu.client.tsx'));

/** The declarations of the LAST rule whose selector matches exactly, or undefined. */
function ruleBody(selector: string): string | undefined {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

  // Boundary includes `{` so a rule nested inside a @media block is still found.
  const re = new RegExp(`(?:^|[{};])\\s*${escaped}\\s*\\{([^{}]*)\\}`, 'g');

  let last: string | undefined;
  let m = re.exec(CSS);

  while (m) {
    last = m[1];
    m = re.exec(CSS);
  }

  return last;
}

describe('the pinned brand and its plaque', () => {
  it('scanner controls: rules are found, absent rules are not, comments are stripped', () => {
    expect(ruleBody('.header-brand')).toContain('position');
    expect(ruleBody('.no-such-selector-anywhere')).toBeUndefined();
    expect(CSS).not.toContain('THE LOGO IS PINNED'); // comment prose must be gone
    expect(HEADER).not.toContain('blend into one continuous'); // comment prose must be gone
  });

  it('is FIXED to the viewport corner — no transform, no counter-translate, ever', () => {
    const brand = ruleBody('.header-brand')!;

    expect(brand).toMatch(/position:\s*fixed/);
    expect(brand).toMatch(/top:\s*0/);
    expect(brand).toMatch(/left:\s*0/);

    /*
     * 🔴 The brand held still by CANCELLATION for three rounds of this bug: body `padding-left`
     * pushed it right, a counter-`translateX` pulled it back, and the sum was zero only while two
     * different properties on two different pipelines stayed in lockstep. They did not — measured
     * live, the logo slid ~an inch on every toggle. Any transform on this element is that design
     * returning.
     */
    expect(CSS).not.toMatch(/\.header-brand[^{]*\{[^}]*transform/);
    expect(CSS).not.toMatch(/sidebar-docked[^{]*\.header-brand/);
    expect(brand).not.toMatch(/will-change/);
  });

  it('reserves its footprint in the header flow, so nothing slides under the logo', () => {
    expect(ruleBody('.header-brand-spacer')).toContain('--header-brand-width');
    expect(HEADER).toContain('header-brand-spacer');
    expect(CSS).toMatch(/--header-brand-width:\s*\d/);
  });

  it('keeps the content reflow on the shared curve — it slides, it does not snap', () => {
    /*
     * Docking reserves a 340px column, so content must move; snapping it was tried and a 340px
     * instant jump reads far louder than a 200ms glide. Safe to animate now ONLY because nothing is
     * counter-animated against it — the brand is `position: fixed`, asserted above.
     */
    expect(ruleBody('body.dock-animate')).toMatch(/padding-left var\(--dock-duration\) var\(--dock-ease\)/);
  });

  it('floats above the drawer so the strip slides UNDER the logo', () => {
    expect(HEADER).toMatch(/header-brand[^"']*z-logo/);

    const Z = read('app/styles/z-index.scss');
    const off = (cls: string) => {
      const m = new RegExp(`\\.${cls}\\s*\\{[^}]*z-index:\\s*\\$zIndexMax\\s*(-\\s*(\\d+))?`).exec(Z);
      expect(m, `.${cls} must be defined relative to $zIndexMax`).not.toBeNull();

      return m![2] ? Number(m![2]) : 0;
    };

    expect(off('z-logo')).toBeLessThan(off('z-sidebar'));
  });

  it('carries a gradient band covering the sidebar column, behind the logo', () => {
    const plaque = ruleBody('.header-brand::before');

    expect(plaque, 'the band is what keeps the lettering solid mid-toggle — see index.scss').toBeDefined();
    expect(plaque).toContain('--chrome-gradient');
    expect(plaque).toContain('--header-height');
    expect(plaque).toContain('--sidebar-dock-width');

    // Behind the logo, but inside the brand's own .z-logo context, so the drawer cannot get between.
    expect(plaque).toMatch(/z-index:\s*-1/);
    expect(plaque).toContain('pointer-events: none');
  });

  it('does not reintroduce the body band that could never paint', () => {
    expect(ruleBody('body::before')).toBeUndefined();
  });
});

describe('the identity lives in the sidebar, the clock in the footer', () => {
  it('the sidebar renders SidebarIdentity from the session; the header renders no name', () => {
    expect(MENU).toContain('useDisplayIdentity');
    expect(MENU).toContain('<SidebarIdentity />');

    // The header keeps the once-per-page session kick-off but prints no identity.
    expect(HEADER).toContain('useSession()');
    expect(HEADER).not.toContain('identity.name');
  });

  it('the header carries the wordmark, sized by height, from the brand module', () => {
    expect(HEADER).toContain('brand.assets.mark');
    expect(HEADER).toMatch(/h-8 w-auto/);
  });

  it('the loading state stays nameless — the RENDERED name is the store value, no fallback', () => {
    /*
     * `identity.name` is EMPTY while /api/me is in flight (~/lib/identity): printing a guess and
     * swapping it a moment later is the original wrong-name flash. (An `alt={identity.name || 'User'}`
     * on the avatar <img> is fine — accessibility text on a picture, not a name on screen.)
     */
    expect(MENU).toContain('>{identity.name}<');
    expect(MENU).not.toContain("'Guest User'");
  });
});
