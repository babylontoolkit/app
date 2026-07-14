/**
 * GitHub Sync decision core (SPEC §4.13).
 *
 * The dangerous half of sync is pure and lives here: whether a push may fast-forward, what gets
 * excluded from a push, and what the divergence choices are. The failure mode if this is wrong is the
 * same as a bad restore — silently destroy the user's work in the wrong direction (force-push over a
 * teammate's commits, or leak a secret into a repo) — so every branch is asserted.
 */
import { describe, expect, it } from 'vitest';
import {
  buildCommitMessage,
  detectPushDivergence,
  divergenceBranchName,
  isSecretPath,
  isValidDivergenceChoice,
  mapToTreeBlobs,
} from './sync-logic';
import type { SerializedFileMap } from '~/lib/binary/binary-files';

describe('push divergence — the fast-forward wall', () => {
  it('is a first-push when the branch does not exist', () => {
    expect(detectPushDivergence(null, undefined).kind).toBe('first-push');
    expect(detectPushDivergence(null, 'abc').kind).toBe('first-push');
  });

  it('is a first-push when the repo exists but this project never synced', () => {
    expect(detectPushDivergence('remotehead', undefined).kind).toBe('first-push');
  });

  it('is in-sync when the remote head is exactly what we last synced', () => {
    expect(detectPushDivergence('abc123', 'abc123').kind).toBe('in-sync');
  });

  it('DIVERGES when the remote moved since our last sync — never auto-overwrite', () => {
    const d = detectPushDivergence('newhead', 'oldhead');

    expect(d.kind).toBe('diverged');
    expect(d).toMatchObject({ remoteHead: 'newhead' });
  });
});

describe('commit messages', () => {
  it('uses the generation summary with an AI: prefix', () => {
    expect(buildCommitMessage('add boost pads to RaceMode')).toBe('AI: add boost pads to RaceMode');
  });

  it('keeps an existing AI: prefix rather than doubling it', () => {
    expect(buildCommitMessage('AI: fix lap timer')).toBe('AI: fix lap timer');
  });

  it('falls back to a default and stays a single bounded line', () => {
    expect(buildCommitMessage(undefined)).toMatch(/Babylon Toolkit/);
    expect(buildCommitMessage('x'.repeat(200)).length).toBeLessThanOrEqual(76);
    expect(buildCommitMessage('line one\nline two')).toBe('AI: line one');
  });
});

describe('tree blobs — byte-faithful, secret-free', () => {
  const files: SerializedFileMap = {
    '/home/project/src/Game.ts': { type: 'file', content: 'export const x = 1;', isBinary: false },
    '/home/project/public/car.glb': { type: 'file', content: 'AAAA', isBinary: true },
    '/home/project/.env': { type: 'file', content: 'SECRET=1', isBinary: false },
    '/home/project/src': { type: 'folder' },
  };

  it('strips the workdir prefix and sorts by path', () => {
    const blobs = mapToTreeBlobs(files);

    expect(blobs.map((b) => b.path)).toEqual(['public/car.glb', 'src/Game.ts']);
  });

  it('sends binaries as base64 and text as utf-8', () => {
    const blobs = mapToTreeBlobs(files);

    expect(blobs.find((b) => b.path === 'public/car.glb')?.encoding).toBe('base64');
    expect(blobs.find((b) => b.path === 'src/Game.ts')?.encoding).toBe('utf-8');
  });

  it('EXCLUDES .env — a secret must never be pushed to a repo', () => {
    expect(mapToTreeBlobs(files).some((b) => b.path === '.env')).toBe(false);
  });

  it.each(['.env', 'sub/.env.local', '.npmrc'])('treats %s as a secret path', (p) => {
    expect(isSecretPath(p)).toBe(true);
  });

  it('does not treat .env.example as a secret', () => {
    expect(isSecretPath('.env.example')).toBe(false);
  });
});

describe('divergence resolution', () => {
  it('accepts only the two non-merge choices', () => {
    expect(isValidDivergenceChoice('pull-overwrite')).toBe(true);
    expect(isValidDivergenceChoice('push-to-new-branch')).toBe(true);
    expect(isValidDivergenceChoice('merge')).toBe(false);
  });

  it('names the escape-hatch branch from the date', () => {
    expect(divergenceBranchName('2026-07-14T03:00:00Z')).toBe('platform/2026-07-14');
  });
});
