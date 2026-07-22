/**
 * STRUCTURAL guard on the working copy (SPEC §4.5.4c).
 *
 * ## Why this file exists rather than trusting `no-server-storage.spec.ts`
 *
 * That spec was written to stop server-side project storage returning by accident, and it does its job
 * — but its job is narrower than its name. It pins the absence of the snapshot HISTORY: snapshot
 * routes, `SnapshotStore`, `currentSnapshotId`, client modules referencing a snapshots URL. §4.5.4c
 * reintroduces none of those, so the entire suite stayed green when a working-copy store was added.
 *
 * That is the finding worth keeping: **a guard written against one name cannot see the same idea
 * arriving under a different one.** The old rule (no version history) and the new rule (exactly one
 * bounded copy) are different rules and need different guards.
 *
 * ## What this pins, and why each line is here
 *
 * The working copy is safe because of two properties, and BOTH are the kind that erode silently under
 * a reasonable-sounding change ("let's keep yesterday's too", "let's let the client name it"):
 *
 *   - **Exactly one object per project, no retention.** Retention is what made the deleted `snapshots`
 *     table unbounded and expensive. A key carrying a seq/version/timestamp is that table returning.
 *   - **A key derived from the project id.** With no id for a caller to supply, `requireOwnedProject`
 *     alone is sufficient. The deleted snapshot route needed `assertSnapshotBelongsTo` precisely
 *     because it took a client-supplied id — that is how project A's owner could name project B's
 *     snapshot in A's URL. Re-introduce a caller-supplied storage id here and the second wall must come
 *     back with it.
 *
 * These are source-level assertions on purpose: the behavioural tests in `working-copy.spec.ts` prove
 * the store behaves today, while these fail on the CHANGE that would make it stop.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { workingCopyKey } from './working-copy';

const MODULE = path.join(process.cwd(), 'app/lib/.server/projects/working-copy.ts');

async function source(): Promise<string> {
  return fs.readFile(MODULE, 'utf8');
}

/** Strip comments — this file's own prose about seqs and versions must not satisfy its own scans. */
function stripComments(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
}

describe('the key is a pure function of the project id', () => {
  it('is stable across calls and contains nothing but the project id', () => {
    expect(workingCopyKey('prj_abc')).toBe(workingCopyKey('prj_abc'));
    expect(workingCopyKey('prj_abc')).toBe('working/prj_abc.json');
  });

  /*
   * A seq, version, timestamp or hash in the key means more than one object per project — the
   * retention this design exists without. Caught here rather than by a storage-size surprise later.
   */
  it('does not vary with anything else — no seq, version, or timestamp in the key', () => {
    const keys = new Set([workingCopyKey('prj_1'), workingCopyKey('prj_1'), workingCopyKey('prj_1')]);
    expect(keys.size).toBe(1);
    expect(workingCopyKey('prj_1')).not.toMatch(/\d{4}-\d{2}-\d{2}|v\d+|seq/i);
  });

  it('keeps distinct projects on distinct keys', () => {
    expect(workingCopyKey('prj_a')).not.toBe(workingCopyKey('prj_b'));
  });
});

describe('the module cannot grow a history', () => {
  it('builds its key from the project id and nothing else', async () => {
    const code = stripComments(await source());
    const fn = code.match(/export function workingCopyKey[\s\S]*?\n}/)?.[0] ?? '';

    expect(fn).toBeTruthy();
    expect(fn).toContain('projectId');

    /* A second interpolated value in the key is a second object per project. */
    const interpolations = fn.match(/\$\{[^}]+\}/g) ?? [];
    expect(interpolations).toEqual(['${projectId}']);
  });

  /*
   * `list` is how a history is READ. A store that only ever holds one object per project never needs
   * to enumerate them, so its presence here means retention arrived — the tell, before the storage bill.
   */
  it('never enumerates its own prefix', async () => {
    expect(stripComments(await source())).not.toMatch(/\.list\(/);
  });

  /* The scanner must be able to fail, or it reports a clean bill of health forever. */
  it('the scanners actually work (control)', async () => {
    const code = stripComments(await source());
    expect(code).toMatch(/getObjectStore/);
    expect(stripComments('const a = 1; /* .list( */ store.list("x")')).toMatch(/\.list\(/);
    expect(stripComments('/* ${version} */ const k = `working/${projectId}.json`')).not.toMatch(/\$\{version\}/);
  });
});
