/**
 * A modal centres on the CONTENT COLUMN, not the viewport (owner, 2026-08-03).
 *
 * Every dialog is `position: fixed`, so — like `--workbench-left` and `.creation-splash` before it —
 * it does not move with the body padding that the docked sidebar applies. Viewport-centred, a dialog
 * sits `--sidebar-dock-width / 2` (170px) to the left of everything it belongs to.
 *
 * This is a source scan rather than a render test because the failure is textual and distributed:
 * seventeen overlays across ten files, each of which regresses by someone writing a new
 * `fixed inset-0 flex items-center justify-center` and not knowing the class exists. A render test
 * would cover one dialog; this covers the rule.
 *
 * Live-measured after the fix, sidebar docked at 1952px wide: provider picker and repo picker both
 * **0px** from the content centre (they were 162px left of it), the scrim still spanning 0→1952, and
 * undocked still 0px from the viewport centre.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

const CSS = readFileSync(join(process.cwd(), 'app/styles/index.scss'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const abs = join(dir, entry);

    if (statSync(abs).isDirectory()) {
      walk(abs, out);
    } else if (/\.tsx$/.test(abs)) {
      out.push(abs);
    }
  }

  return out;
}

/**
 * `BootScreen` is the ONE legitimate exception: it already carries `.creation-splash`, which has its
 * own `left` rule from the boot-surface unification. Adding `.overlay-centered` on top would shift it
 * twice. Listed by name with the reason, never pattern-matched away.
 */
const EXEMPT: Record<string, string> = {
  'app/components/chat/BootScreen.tsx': 'Uses .creation-splash, which is already offset by its own rule.',
};

describe('the docked-sidebar offset exists and is exact', () => {
  it('scanner control: it reads the stylesheet and comments are stripped', () => {
    expect(CSS).toContain('--sidebar-dock-width');
    expect(CSS).not.toContain('A MODAL CENTRES ON THE CONTENT COLUMN');
  });

  it('pads BOTH sides, or the centre is off by half the gutter', () => {
    /*
     * Overriding only `padding-left` leaves the box asymmetric (left `dock`, right `1rem`) and the
     * flex centre lands `gutter/2` short — MEASURED at 8px, small enough to read as "roughly centred"
     * and be left alone forever. Dropping `padding-right` here is that bug returning.
     */
    const rule = /\.overlay-centered\s*\{([^}]*)\}/.exec(CSS)?.[1];

    expect(rule, '.overlay-centered must be defined').toBeDefined();
    expect(rule).toMatch(/padding-left:\s*calc\(var\(--sidebar-dock-width[^)]*\)\s*\+\s*1rem\)/);
    expect(rule, 'both sides, or the centre is off by half the gutter').toMatch(/padding-right:\s*1rem/);
  });

  it('offsets the Radix dialog by HALF the dock — it has no box to pad', () => {
    const rule = /\.overlay-centered-x50\s*\{([^}]*)\}/.exec(CSS)?.[1];

    expect(rule, '.overlay-centered-x50 must be defined').toBeDefined();
    expect(rule, 'left:50% is the viewport, so the content centre is 50% + dock/2').toMatch(
      /left:\s*calc\(50%\s*\+\s*var\(--sidebar-dock-width[^)]*\)\s*\/\s*2\)/,
    );
  });

  it('is scoped to body.sidebar-docked, so undocked falls back to the viewport', () => {
    /*
     * Both rules must live inside the docked block — unconditionally applied, they break the
     * undocked layout by the same 170px in the other direction.
     */
    const docked = /body\.sidebar-docked\s*\{([\s\S]*?)\n\}/g;
    const blocks = [...CSS.matchAll(docked)].map((m) => m[1]).join('\n');

    expect(blocks).toContain('.overlay-centered');
    expect(blocks).toContain('.overlay-centered-x50');
  });
});

describe('every viewport-centred overlay opts in', () => {
  const offenders: string[] = [];
  const adopters: string[] = [];

  for (const abs of walk(join(process.cwd(), 'app/components'))) {
    const rel = abs.replace(`${process.cwd()}/`, '');
    const source = readFileSync(abs, 'utf8');

    for (const line of source.split('\n')) {
      if (!line.includes('fixed inset-0') || !line.includes('justify-center')) {
        continue;
      }

      if (line.includes('overlay-centered')) {
        adopters.push(rel);
      } else if (!EXEMPT[rel]) {
        offenders.push(`${rel}: ${line.trim().slice(0, 90)}`);
      }
    }
  }

  it('control: the scan actually finds overlays', () => {
    // Without this, a broken matcher reports a clean bill of health forever.
    expect(adopters.length, 'the scan must be seeing real overlays').toBeGreaterThan(10);
  });

  it('no centred overlay is left on the viewport centre', () => {
    expect(offenders, 'add `overlay-centered` to these, or exempt them with a written reason').toEqual([]);
  });

  it('the exemption is the boot splash, which is offset by its own rule', () => {
    const boot = readFileSync(join(process.cwd(), 'app/components/chat/BootScreen.tsx'), 'utf8');

    expect(boot, 'BootScreen must still carry the class its exemption rests on').toContain('creation-splash');
    expect(boot, 'and must NOT also carry overlay-centered, or it shifts twice').not.toContain('overlay-centered');
    expect(CSS).toMatch(/\.creation-splash\s*\{[^}]*left:/);
  });
});
