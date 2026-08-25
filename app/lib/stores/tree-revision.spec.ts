/**
 * A tree replacement must be ANNOUNCED (§4.12, §4.13a).
 *
 * Reported 2026-08-22: after "Discard all changes" the file tree still showed `+11 −8` on a file whose
 * changes had just been thrown away. `Workbench.client.tsx` holds `fileHistory` in a component-local
 * `useState` that nothing reset, so it outlived every restore — and the badge, the modified-files
 * dropdown and the diff view's *before* side were all stale together.
 *
 * ⚠️ The half worth testing is the SIGNAL AT THE CHOKE POINT, not the component. The bug was never that
 * a `useEffect` failed to run; it was that nothing told the workbench anything had happened. A test
 * that rendered the workbench and asserted an empty map would pass for a signal wired to only one of
 * the six restore doors — which is the version of this fix that leaves undo, a branch switch and a repo
 * pull each still showing a phantom diff.
 */
import { describe, expect, it, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { bumpTreeRevision, resetTreeRevision, treeRevision } from './tree-revision';

describe('the tree-replacement revision', () => {
  beforeEach(() => resetTreeRevision());

  it('starts at zero, so a reader that has not rendered has nothing stale to discard', () => {
    expect(treeRevision.get()).toBe(0);
  });

  /** Two replacements in a row must read as two — a boolean would collapse them into one. */
  it('advances on every replacement, never coalescing', () => {
    bumpTreeRevision();
    bumpTreeRevision();

    expect(treeRevision.get()).toBe(2);
  });

  it('notifies subscribers, or nothing re-renders', () => {
    const seen: number[] = [];
    const stop = treeRevision.subscribe((v) => seen.push(v));

    bumpTreeRevision();
    stop();

    expect(seen.at(-1)).toBe(1);
  });
});

/**
 * 🔴 THE SIGNAL IS RAISED AT THE ONE FUNCTION EVERY RESTORE DOOR PASSES THROUGH.
 *
 * A source scan, because the alternative is booting a sandbox: importing `files.ts` pulls in the
 * provider seam, the watcher and the editor store. The property is structural anyway — "the bump is
 * inside `restoreFiles`, beside the flag that is there for the same reason" — and a scan is what
 * catches the seventh door being added without it.
 */
describe('every restore door raises it', () => {
  const source = readFileSync(join(process.cwd(), 'app/lib/stores/files.ts'), 'utf8');

  it('bumps inside the public restoreFiles, not at a caller', () => {
    const from = source.indexOf('  async restoreFiles(');
    const to = source.indexOf('  async #restoreFiles(');

    expect(from, 'restoreFiles moved or was renamed').toBeGreaterThan(-1);
    expect(to).toBeGreaterThan(from);
    expect(source.slice(from, to)).toContain('bumpTreeRevision()');
  });

  /**
   * BEFORE the work. A restore that throws leaves the tree part-written, which is precisely the state
   * whose stale diff would be most wrong — so the announcement must not be contingent on success.
   */
  it('bumps before the restore runs, not after it resolves', () => {
    const from = source.indexOf('  async restoreFiles(');
    const body = source.slice(from, source.indexOf('  async #restoreFiles('));

    expect(body.indexOf('bumpTreeRevision()')).toBeLessThan(body.indexOf('withRestoreInFlight'));
  });

  /**
   * CONTROL. Without it the two scans above pass for a `source` that failed to load, matched nothing,
   * and reported a clean bill of health — the failure mode `no-server-storage.spec.ts` records.
   */
  it('CONTROL — the scanner can fail', () => {
    const from = source.indexOf('  async restoreFiles(');
    const body = source.slice(from, source.indexOf('  async #restoreFiles('));

    expect(body).not.toContain('bumpSomethingThatDoesNotExist()');
    expect(body.length, 'the slice is empty — the scan above proves nothing').toBeGreaterThan(200);
  });
});

/** The consumer half: the workbench must actually reset its map off this signal. */
describe('the workbench clears its diff state on it', () => {
  const source = readFileSync(join(process.cwd(), 'app/components/workbench/Workbench.client.tsx'), 'utf8');

  it('subscribes to the revision and empties fileHistory', () => {
    expect(source).toContain('useStore(treeRevision)');
    expect(source).toMatch(/setFileHistory\(\{\}\)/);
  });

  /**
   * ⚠️ Keyed on the revision. An effect with `[]` runs once on mount and never again, which is exactly
   * the pre-fix behaviour wearing the fix's clothes — it would pass a test that only looked for the
   * reset call.
   */
  it('keys the reset on the revision, not on mount', () => {
    const at = source.indexOf('setFileHistory({})');

    expect(at).toBeGreaterThan(-1);
    expect(source.slice(at, at + 120)).toMatch(/\}, \[treeRev\]\)/);
  });
});
