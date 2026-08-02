/**
 * Guard: every `react-icons` symbol the app imports must actually EXIST in the installed package.
 *
 * WHY THIS FILE EXISTS (2026-08-01, `_specs/nodepod-util-parity_plan.md` "THIRD DEFECT").
 * A bare `pnpm install` while adopting one unrelated dependency re-resolved every caret range in the
 * project — 590 resolutions — which carried `react-icons` 5.5.0 → 5.7.0. That release DROPPED the
 * `SiAmazon` export. `CloudProvidersTab.tsx` imports it by name, so the module failed at EVAL time:
 *
 *   Uncaught SyntaxError: The requested module '/node_modules/.vite/deps/react-icons_si.js'
 *   does not provide an export named 'SiAmazon'
 *
 * An eval-time failure takes down the WHOLE React tree, so the symptom was a total white screen with
 * no partial render and a stack pointing at nothing useful — and it read as "the new sandbox runtime
 * broke the app", blaming the one package that was supposed to change. Nothing in the gates caught it:
 * typecheck passes (the icon packages ship broad `.d.ts` that still declare the symbol), lint passes,
 * and 4,589 tests passed because none of them imported this module.
 *
 * This is the cheapest possible check for that class of failure: a missing icon export becomes ONE red
 * test naming the symbol, instead of a blank page.
 *
 * ⚠️ The import below must stay STATIC and must name every symbol individually. A dynamic
 * `import(pkg)` or a namespace import resolves lazily and/or tolerates missing names, which is exactly
 * the tolerance that let this reach a browser — the test would pass while the app still white-screens.
 */
import { describe, expect, it } from 'vitest';
import { BiChip, BiCodeBlock } from 'react-icons/bi';
import { BsCloud, BsRobot } from 'react-icons/bs';
import { FaBrain, FaCloud } from 'react-icons/fa';
import { SiAmazon, SiGithub, SiGoogle, SiHuggingface, SiOpenai, SiPerplexity } from 'react-icons/si';
import { TbBrain, TbCloudComputing } from 'react-icons/tb';

/*
 * Keyed by the symbol's source name so a failure reads as the missing EXPORT rather than as an
 * anonymous index. These are exactly the names `CloudProvidersTab.tsx` imports — when that file gains
 * or drops an icon, this list moves with it.
 */
const IMPORTED_ICONS: Record<string, unknown> = {
  // react-icons/si — the family that actually regressed
  SiAmazon,
  SiGoogle,
  SiGithub,
  SiHuggingface,
  SiPerplexity,
  SiOpenai,

  // react-icons/bs
  BsRobot,
  BsCloud,

  // react-icons/tb
  TbBrain,
  TbCloudComputing,

  // react-icons/bi
  BiCodeBlock,
  BiChip,

  // react-icons/fa
  FaCloud,
  FaBrain,
};

describe('react-icons exports the app depends on', () => {
  it.each(Object.keys(IMPORTED_ICONS))('%s is exported by the installed react-icons', (name) => {
    /*
     * `undefined` is the shape a dropped export takes once a bundler tolerates it. Asserting
     * "is a function" rather than merely "is defined" also rejects a symbol that survived as a
     * non-component value, which would still crash on render.
     */
    expect(IMPORTED_ICONS[name], `react-icons no longer exports ${name}`).toBeDefined();
    expect(typeof IMPORTED_ICONS[name], `${name} is not a renderable component`).toBe('function');
  });

  /*
   * CONTROL. Without this, a refactor that emptied IMPORTED_ICONS would leave `it.each([])` running
   * zero assertions and reporting green forever — the "a filter that matches nothing reports a clean
   * bill of health" trap this plan hit twice while grepping.
   */
  it('covers every icon the cloud providers tab imports', () => {
    expect(Object.keys(IMPORTED_ICONS)).toHaveLength(14);
  });
});
