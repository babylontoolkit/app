/**
 * The toolbar's shared style must actually REACH the browser (SPEC §4.1a).
 *
 * This exists because of a failure with no error in it. SPEC §4.1a requires one shared button style,
 * imported and never re-typed, so it lives in `toolbar-button.ts` — and UnoCSS's default
 * `content.pipeline.include` is `/\.(vue|svelte|[jt]sx|…)/`, which covers `.tsx` but NOT `.ts`. The
 * classes in this file were therefore never extracted and their rules were never generated.
 *
 * What made it survive review is that it failed PARTIALLY. `h-7`, `px-2.5` and `border-white/15`
 * happen to appear in other `.tsx` files, so they were generated anyway; `w-7`, `hover:bg-white/10`,
 * `bg-white/15` and `z-[1000]` are unique to this file and simply vanished. The buttons kept their
 * height and border and lost their width; the menus kept their panel and lost their z-index, falling
 * behind the workbench. So the symptom looked like a design regression in components that were right.
 *
 * Two assertions, because either alone would have missed it:
 *
 *   1. **The pipeline includes `.ts`** — the actual root cause, and the thing a future config edit
 *      could quietly undo.
 *   2. **Every utility in every exported string generates a rule** — which catches the other half of
 *      the family: a typo'd or non-existent utility (`w-7.5`, `z-1000`) is equally silent, and no test
 *      that only checks the config would ever see it.
 */
import { describe, it, expect } from 'vitest';
import { createGenerator } from 'unocss';

/*
 * `~/*` maps to `app/*` only and `uno.config.ts` lives at the repo root, so no alias can reach it.
 * Importing the REAL config is the whole point: a copy of the include patterns would pass forever
 * while the actual build used something else.
 */
// eslint-disable-next-line no-restricted-imports
import config from '../../../uno.config';
import {
  TOOLBAR_BUTTON,
  TOOLBAR_ICON_BUTTON,
  TOOLBAR_ICON_BUTTON_FILLED,
  TOOLBAR_MENU_CONTENT,
  TOOLBAR_MENU_ITEM,
} from './toolbar-button';

/**
 * Utilities that legitimately generate nothing, and why.
 *
 * `animate-in` / `fade-in-*` / `zoom-in-*` are **tailwindcss-animate** classes. That plugin is not
 * installed and UnoCSS's presets do not provide them, so they are inert — the toolbar menus have never
 * had an open animation. Found by this test on its first meaningful run.
 *
 * Left in place rather than stripped: upstream bolt.diy uses the same trio in ~10 components
 * (`ui/Dropdown`, `ui/Tooltip`, `DeployButton`, `FileTree`, the settings tabs…), so removing ours
 * alone buys nothing, and removing all of them edits upstream files for a purely cosmetic no-op —
 * against the additive-first / minimal-upstream-diff rule. Listed HERE so it is a known fact rather
 * than a silent one; delete an entry the day the plugin lands.
 */
const INERT_BY_DESIGN = new Set(['animate-in', 'fade-in-80', 'zoom-in-95']);

const STYLES = {
  TOOLBAR_BUTTON,
  TOOLBAR_ICON_BUTTON,
  TOOLBAR_ICON_BUTTON_FILLED,
  TOOLBAR_MENU_CONTENT,
  TOOLBAR_MENU_ITEM,
};

/** `pipeline` is typed `false | { include? }`, so narrow once rather than casting at each use. */
function pipelineInclude(): RegExp[] {
  const pipeline = config.content?.pipeline;

  expect(pipeline, 'uno.config.ts must declare content.pipeline').toBeTruthy();

  const include = (pipeline as { include?: unknown }).include;

  expect(Array.isArray(include), 'content.pipeline.include must be an array of patterns').toBe(true);

  return include as RegExp[];
}

describe('the UnoCSS content pipeline', () => {
  it('scans plain .ts files — this file IS a plain .ts file', () => {
    expect(pipelineInclude().some((pattern) => pattern.test('app/components/header/toolbar-button.ts'))).toBe(true);
  });

  it('still scans everything it scanned before (the default set is REPLACED, not extended)', () => {
    const include = pipelineInclude();

    for (const path of ['app/components/header/Header.tsx', 'app/root.tsx', 'index.html', 'a.vue', 'a.svelte']) {
      expect(
        include.some((pattern) => pattern.test(path)),
        `${path} must still be scanned`,
      ).toBe(true);
    }
  });
});

describe('every toolbar utility generates a rule', () => {
  it.each(Object.entries(STYLES))('%s', async (name, classes) => {
    const uno = await createGenerator(config);

    /*
     * Generate each class ALONE. Generating the whole string at once would pass as long as ANY class
     * matched — which is precisely the partial failure this file exists to catch.
     *
     * ⚠️ Assert `matched.has(token)` — not that `css` is non-empty, and not that `matched` is
     * non-empty. Both were tried and both were vacuous: `generate` returns ~45KB of layer scaffolding
     * regardless, and `matched` carries a baseline of 24 entries from the `i-bolt:*` icon safelist. A
     * deliberately invented utility passed under each of them. Only asking whether UnoCSS recognised
     * THIS token can fail.
     */
    const missing: string[] = [];

    for (const token of classes.split(/\s+/).filter(Boolean)) {
      if (INERT_BY_DESIGN.has(token)) {
        continue;
      }

      const { matched } = await uno.generate(token, { preflights: false });

      if (!matched.has(token)) {
        missing.push(token);
      }
    }

    expect(missing, `${name} names utilities that generate no CSS`).toEqual([]);
  });
});

describe('the shapes the row depends on', () => {
  it('gives icon-only buttons a FIXED width that is wider than a square', async () => {
    const uno = await createGenerator(config);
    const { css } = await uno.generate(TOOLBAR_ICON_BUTTON, { preflights: false });

    // A width rule must exist at all — its absence is what collapsed ⋯ and the workbench toggle.
    expect(css).toMatch(/width:/);
    expect(TOOLBAR_ICON_BUTTON).toMatch(/\bshrink-0\b/);

    const width = Number(/\.w-(\d+)/.exec(TOOLBAR_ICON_BUTTON)?.[1] ?? /\bw-(\d+)\b/.exec(TOOLBAR_ICON_BUTTON)?.[1]);
    const height = Number(/\bh-(\d+)\b/.exec(TOOLBAR_ICON_BUTTON)![1]);
    expect(width).toBeGreaterThan(height);
  });

  it('puts menus above the workbench, which sits at z-index 3', async () => {
    const uno = await createGenerator(config);
    const { css } = await uno.generate(TOOLBAR_MENU_CONTENT, { preflights: false });

    const zIndex = Number(/z-index:\s*(\d+)/.exec(css)?.[1]);

    expect(zIndex, 'TOOLBAR_MENU_CONTENT must generate a z-index').toBeGreaterThan(3);
  });

  /**
   * 🔴 The filled ⋯ button must not be built by composing onto the quiet one.
   *
   * When two classes set the same property, the winner is rule ORDER IN THE GENERATED STYLESHEET, not
   * the order of the class string — and UnoCSS emits the accent hover BEFORE `.hover\:bg-white\/10`,
   * so `classNames(TOOLBAR_ICON_BUTTON, <accent fill>)` renders a filled button that goes translucent
   * grey the moment you point at it. Caught by measuring the emitted CSS, not by reading the code.
   */
  it('does not let the quiet hover override the filled one', async () => {
    const uno = await createGenerator(config);
    const { css } = await uno.generate(TOOLBAR_ICON_BUTTON_FILLED, { preflights: false });

    const hovers = [...css.matchAll(/\.hover\\:bg-([\w\\/.-]+):hover/g)].map((m) => m[1]);

    expect(hovers, 'the filled button must declare exactly one hover background').toHaveLength(1);
    expect(hovers[0]).not.toMatch(/white/);
    expect(TOOLBAR_ICON_BUTTON_FILLED).not.toContain('hover:bg-white/10');
  });

  it('fills the ⋯ with the accent, matching the pre-rebuild Share button', () => {
    expect(TOOLBAR_ICON_BUTTON_FILLED).toContain('bg-accent-500');
    expect(TOOLBAR_ICON_BUTTON_FILLED).toContain('text-white');
  });

  it('gives the filled button the SAME shape as the quiet one (fill is the only difference)', () => {
    const shapeOf = (style: string) =>
      style
        .split(/\s+/)
        .filter((token) =>
          /^(h-|w-|rounded|border|shrink|flex|items-|justify-|transition|outline|disabled:)/.test(token),
        )
        .sort()
        .join(' ');

    expect(shapeOf(TOOLBAR_ICON_BUTTON_FILLED)).toBe(shapeOf(TOOLBAR_ICON_BUTTON));
  });

  it('keeps every action in the row the same height (§4.1a: one look, no tiering)', () => {
    const heightOf = (style: string) => /\bh-(\d+)\b/.exec(style)?.[1];

    expect(heightOf(TOOLBAR_ICON_BUTTON)).toBe(heightOf(TOOLBAR_BUTTON));
  });
});
