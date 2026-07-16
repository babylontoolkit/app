/**
 * Git sync decision core (SPEC §4.5.4b, §4.13).
 *
 * The dangerous half of sync is pure and lives here: whether a push may fast-forward, what gets
 * excluded from a push, and what the divergence choices are. The failure mode if this is wrong is the
 * same as a bad restore — silently destroy the user's work in the wrong direction (force-push over a
 * teammate's commits, or leak a secret into a repo) — so every branch is asserted.
 *
 * Under §4.5.4b these rules are load-bearing for SAVING, not just syncing: the repo is the only
 * permanent home for the user's game, so a wrong answer here loses the code rather than degrading an
 * optional feature.
 */
import { describe, expect, it } from 'vitest';
import {
  buildCommitMessage,
  detectPushDivergence,
  divergenceBranchName,
  isSecretPath,
  isValidDivergenceChoice,
  mapToTreeBlobs,
  toRepoRelativePath,
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
    /*
     * Brand-agnostic: assert the fallback SHAPE, not a specific product name (which lives in brand.ts
     * and changes on a rebrand). The default is "Update from <product name>".
     */
    expect(buildCommitMessage(undefined)).toMatch(/^Update from \S/);
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

  it('normalises a workdir path to repo-relative', () => {
    expect(toRepoRelativePath('/home/project/src/Game.ts')).toBe('src/Game.ts');
    expect(toRepoRelativePath('home/project/src/Game.ts')).toBe('src/Game.ts');
    expect(toRepoRelativePath('/src/Game.ts')).toBe('src/Game.ts');
  });
});

describe('secret paths — the whole .env family, not just *local', () => {
  it.each(['.env', 'sub/.env.local', '.npmrc', 'packages/app/.npmrc'])('treats %s as a secret path', (p) => {
    expect(isSecretPath(p)).toBe(true);
  });

  /**
   * The regression this suite exists for.
   *
   * The original rule was `/(^|\/)\.env\.[^/]*local$/`, which mirrors the gitignore convention and
   * therefore did NOT match `.env.production` — the most dangerous file in the family. It was pushed to
   * the user's repo, silently, with nothing failing. Under §4.5.4b every save is a push, so this would
   * have fired on every generation of every linked project rather than on an occasional manual sync.
   */
  it.each(['.env.production', '.env.development', '.env.staging', 'sub/.env.production.local', '.env.anything'])(
    'treats %s as a secret path — the ORIGINAL rule only caught *local and leaked this',
    (p) => {
      expect(isSecretPath(p)).toBe(true);
    },
  );

  it.each(['.env.example', '.env.sample', '.env.template', '.ENV.EXAMPLE'])(
    'does NOT treat %s as a secret — placeholder files are meant to be committed',
    (p) => {
      expect(isSecretPath(p)).toBe(false);
    },
  );

  it.each(['src/environment.ts', 'docs/.environment.md', 'src/.npmrc.md'])('does not over-match %s', (p) => {
    expect(isSecretPath(p)).toBe(false);
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
