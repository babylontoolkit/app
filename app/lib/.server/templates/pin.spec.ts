/**
 * Template pin-and-cache (SPEC §4.4).
 *
 * `decideTemplateSource` is tested exhaustively — every combination, not a happy path — for the same
 * reason `restore-target.ts` is: it chooses which BYTES land in a user's brand-new project, and every
 * way it can be wrong is SILENT. Nobody ever sees "you were served last week's starter"; they see a
 * project that behaves oddly and blame the agent. The two failures that matter most are opposites:
 * serving live when a pin should hold (an unreviewed `main` reaches users — the thing pinning exists to
 * stop), and holding a pin when the user is telling us the mount is broken (they can never escape it).
 */
import { describe, expect, it } from 'vitest';
import { FsObjectStore } from '~/lib/.server/storage';
import type { TemplateFile } from '~/types/template';
import {
  decideTemplateSource,
  listSnapshots,
  loadSnapshot,
  pinKey,
  readPin,
  saveSnapshot,
  snapshotKey,
  writePin,
  type TemplatePin,
} from './pin';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const PIN: TemplatePin = {
  repo: 'babylontoolkit/AppTemplate',
  sha: 'a'.repeat(40),
  ref: 'main',
  pinnedAt: '2026-07-16T00:00:00.000Z',
  pinnedBy: 'promote',
  fileCount: 120,
};

const base = {
  pin: null as TemplatePin | null,
  pinnedSnapshotExists: false,
  preferFallback: false,
  pinningEnabled: true,
};

describe('decideTemplateSource', () => {
  it('serves the pinned snapshot when a pin exists and its bytes are present', () => {
    expect(decideTemplateSource({ ...base, pin: PIN, pinnedSnapshotExists: true })).toEqual({
      kind: 'pinned',
      sha: PIN.sha,
    });
  });

  it('bootstraps a pin on the very first fetch, so pinning is not inert until an admin acts', () => {
    expect(decideTemplateSource(base)).toEqual({ kind: 'live', pinAfter: true });
  });

  /*
   * The one that would quietly undo the whole feature. A pin whose object was deleted (a bucket
   * lifecycle rule, a botched cleanup) must not re-pin to today's `main`: that is precisely the
   * unreviewed jump to live the pin exists to prevent, performed automatically, at the moment nobody
   * is looking.
   */
  it('falls back to live WITHOUT re-pinning when the pinned snapshot is missing', () => {
    expect(decideTemplateSource({ ...base, pin: PIN, pinnedSnapshotExists: false })).toEqual({
      kind: 'live',
      pinAfter: false,
    });
  });

  it('honours the client-reported broken mount over a healthy pin', () => {
    // Otherwise the user is handed the same broken bytes forever — the pin becomes a trap.
    expect(decideTemplateSource({ ...base, pin: PIN, pinnedSnapshotExists: true, preferFallback: true })).toEqual({
      kind: 'last-known-good',
    });
  });

  it('honours a broken mount even with pinning disabled and no pin', () => {
    expect(decideTemplateSource({ ...base, preferFallback: true, pinningEnabled: false })).toEqual({
      kind: 'last-known-good',
    });
  });

  it('tracks live main when pinning is disabled, and never pins behind the operator’s back', () => {
    expect(decideTemplateSource({ ...base, pinningEnabled: false })).toEqual({ kind: 'live', pinAfter: false });
    expect(decideTemplateSource({ ...base, pinningEnabled: false, pin: PIN, pinnedSnapshotExists: true })).toEqual({
      kind: 'live',
      pinAfter: false,
    });
  });

  it('is exhaustive: every input combination resolves, and only a bootstrap ever auto-pins', () => {
    const bools = [true, false];
    const seen: string[] = [];

    for (const pin of [null, PIN]) {
      for (const pinnedSnapshotExists of bools) {
        for (const preferFallback of bools) {
          for (const pinningEnabled of bools) {
            const source = decideTemplateSource({ pin, pinnedSnapshotExists, preferFallback, pinningEnabled });
            expect(['pinned', 'live', 'last-known-good']).toContain(source.kind);

            // An automatic pin may ONLY happen on a clean bootstrap: enabled, no pin, not a fallback.
            if (source.kind === 'live' && source.pinAfter) {
              expect({ pin, preferFallback, pinningEnabled }).toEqual({
                pin: null,
                preferFallback: false,
                pinningEnabled: true,
              });
            }

            // A pinned answer must never be reachable without an existing pin AND its bytes.
            if (source.kind === 'pinned') {
              expect(pin).not.toBeNull();
              expect(pinnedSnapshotExists).toBe(true);
              expect(preferFallback).toBe(false);
              expect(pinningEnabled).toBe(true);
            }

            seen.push(source.kind);
          }
        }
      }
    }

    expect(seen).toHaveLength(16);
  });
});

describe('pin + snapshot storage', () => {
  async function tempStore() {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'pin-spec-'));
    return new FsObjectStore(dir);
  }

  const files: TemplateFile[] = [
    { name: 'package.json', path: 'package.json', content: '{"name":"game"}', isBinary: false },

    // A binary rides as base64 — the snapshot must be byte-faithful (spec/binary-files.md).
    { name: 'babylon.png', path: 'public/babylon.png', content: 'iVBORw0KGgo=', isBinary: true },
  ];

  it('keys snapshots by commit and pins by repo', () => {
    expect(snapshotKey('babylontoolkit/AppTemplate', 'abc123')).toBe(
      'templates/snapshots/babylontoolkit__AppTemplate/abc123.json',
    );
    expect(pinKey('babylontoolkit/AppTemplate')).toBe('templates/pins/babylontoolkit__AppTemplate.json');
  });

  it('round-trips a snapshot byte-for-byte, base64 binaries included', async () => {
    const store = await tempStore();
    await saveSnapshot(store, PIN.repo, PIN.sha, files);

    expect(await loadSnapshot(store, PIN.repo, PIN.sha)).toEqual(files);
  });

  it('round-trips a pin', async () => {
    const store = await tempStore();
    await writePin(store, PIN);

    expect(await readPin(store, PIN.repo)).toEqual(PIN);
  });

  it('treats a missing or corrupt pin as no pin, never as an outage', async () => {
    const store = await tempStore();
    expect(await readPin(store, PIN.repo)).toBeNull();

    await store.put(pinKey(PIN.repo), new TextEncoder().encode('{ not json'));
    expect(await readPin(store, PIN.repo)).toBeNull();

    // A well-formed object that is not a pin is also not a pin.
    await store.put(pinKey(PIN.repo), new TextEncoder().encode('{"repo":"x"}'));
    expect(await readPin(store, PIN.repo)).toBeNull();
  });

  it('treats a missing snapshot as null — the decision core turns that into a live fetch', async () => {
    const store = await tempStore();
    expect(await loadSnapshot(store, PIN.repo, 'nope')).toBeNull();
  });

  it('lists every snapshot for a repo as the rollback menu, and no other repo’s', async () => {
    const store = await tempStore();
    await saveSnapshot(store, PIN.repo, 'a'.repeat(40), files);
    await saveSnapshot(store, PIN.repo, 'b'.repeat(40), files);
    await saveSnapshot(store, 'someone/else', 'c'.repeat(40), files);

    const listed = await listSnapshots(store, PIN.repo);

    expect(listed.map((s) => s.sha).sort()).toEqual(['a'.repeat(40), 'b'.repeat(40)]);
    expect(listed.every((s) => s.size > 0)).toBe(true);
  });

  /*
   * Immutability is what rollback rests on: "the bytes behind this SHA cannot change under me". If a
   * re-promote of the same commit could alter a snapshot, rolling back to it would not restore what was
   * there.
   */
  it('addresses snapshots by SHA, so different commits never collide', async () => {
    const store = await tempStore();
    const other: TemplateFile[] = [{ name: 'package.json', path: 'package.json', content: '{"name":"other"}' }];

    await saveSnapshot(store, PIN.repo, 'a'.repeat(40), files);
    await saveSnapshot(store, PIN.repo, 'b'.repeat(40), other);

    expect(await loadSnapshot(store, PIN.repo, 'a'.repeat(40))).toEqual(files);
    expect(await loadSnapshot(store, PIN.repo, 'b'.repeat(40))).toEqual(other);
  });
});
