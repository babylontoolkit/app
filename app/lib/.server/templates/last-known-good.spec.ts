import { describe, expect, it } from 'vitest';
import type { ObjectStore, StoredObject } from '~/lib/.server/storage';
import type { TemplateFile } from '~/types/template';
import { lastKnownGoodKey, loadLastKnownGood, saveLastKnownGood, validateTemplateFiles } from './last-known-good';

/** A minimal in-memory ObjectStore — the helper only needs put/get; list/delete are unused here. */
function fakeStore(): ObjectStore & { map: Map<string, Uint8Array> } {
  const map = new Map<string, Uint8Array>();
  return {
    map,
    backend: 'filesystem',
    async put(key, bytes) {
      map.set(key, bytes);
    },
    async get(key) {
      return map.get(key) ?? null;
    },
    async delete(key) {
      map.delete(key);
    },
    async list(prefix): Promise<StoredObject[]> {
      return [...map.keys()].filter((k) => k.startsWith(prefix)).map((key) => ({ key, size: map.get(key)!.length }));
    },
  };
}

const goodTemplate: TemplateFile[] = [
  { name: 'package.json', path: 'package.json', content: '{"name":"x"}', isBinary: false },
  { name: 'globals.ts', path: 'src/babylon/globals.ts', content: 'export {}', isBinary: false },

  // a binary carried as base64 — proves the wire format survives the round-trip
  { name: 'babylon.png', path: 'public/babylon.png', content: 'iVBORw0KGgo=', isBinary: true },
];

describe('validateTemplateFiles (§4.4 unmountable-result guard)', () => {
  it('accepts a template with package.json and a vendored framework', () => {
    expect(validateTemplateFiles(goodTemplate)).toEqual({ ok: true });
  });

  it('rejects an empty or non-array file list', () => {
    expect(validateTemplateFiles([]).ok).toBe(false);
    expect(validateTemplateFiles(null).ok).toBe(false);
    expect(validateTemplateFiles(undefined).ok).toBe(false);
  });

  it('rejects a truncated fetch missing package.json', () => {
    const files = goodTemplate.filter((f) => f.path !== 'package.json');
    expect(validateTemplateFiles(files)).toEqual({ ok: false, reason: 'missing package.json' });
  });

  it('rejects a fetch where submodule vendoring failed (no src/babylon)', () => {
    const files = goodTemplate.filter((f) => !f.path.startsWith('src/babylon/'));
    expect(validateTemplateFiles(files)).toEqual({ ok: false, reason: 'missing vendored framework (src/babylon)' });
  });
});

describe('last-known-good snapshot round-trip', () => {
  it('saves and loads a byte-faithful copy (binary base64 preserved)', async () => {
    const store = fakeStore();
    await saveLastKnownGood(store, 'babylontoolkit/AppTemplate', goodTemplate);

    const loaded = await loadLastKnownGood(store, 'babylontoolkit/AppTemplate');
    expect(loaded).toEqual(goodTemplate);
  });

  it('returns null when nothing was ever stored', async () => {
    expect(await loadLastKnownGood(fakeStore(), 'babylontoolkit/AppTemplate')).toBeNull();
  });

  it('returns null (not a throw) on a corrupt snapshot', async () => {
    const store = fakeStore();
    store.map.set(lastKnownGoodKey('babylontoolkit/AppTemplate'), new TextEncoder().encode('{ not json'));
    expect(await loadLastKnownGood(store, 'babylontoolkit/AppTemplate')).toBeNull();
  });

  it('derives a filesystem- and S3-safe key from owner/repo', () => {
    expect(lastKnownGoodKey('babylontoolkit/AppTemplate')).toBe(
      'templates/last-known-good/babylontoolkit__AppTemplate.json',
    );
  });
});
