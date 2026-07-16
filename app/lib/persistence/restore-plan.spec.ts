/**
 * What a restore deletes (SPEC §4.12, §4.13, §4.5.4b).
 *
 * This function decides which of the user's files to destroy, so the tests are weighted accordingly:
 * the interesting ones are not "does it delete the right file" but "can it ever delete the wrong
 * one" — and the two ways it can are a path-shape mismatch (wipe everything) and a map that was never
 * authoritative about a file (delete the user's keys).
 */
import { describe, expect, it } from 'vitest';
import { planRestore, protectForRepoRestore, protectNothing } from './restore-plan';

const STORE = '/home/project/';

describe('the point: a restore restores', () => {
  /** The §4.12 bug. Undo that leaves the file you added is not undo. */
  it('deletes a file the checkpoint did not have', () => {
    const plan = planRestore({
      current: [`${STORE}src/main.ts`, `${STORE}src/scripts/Boss.ts`],
      incoming: [`${STORE}src/main.ts`],
      protect: protectNothing,
    });

    expect(plan.toDelete).toEqual([`${STORE}src/scripts/Boss.ts`]);
  });

  it('leaves alone everything the incoming map still has', () => {
    const plan = planRestore({
      current: [`${STORE}a.ts`, `${STORE}b.ts`],
      incoming: [`${STORE}a.ts`, `${STORE}b.ts`],
      protect: protectNothing,
    });

    expect(plan.toDelete).toEqual([]);
  });

  it('does not ask to delete a file that was never there', () => {
    const plan = planRestore({
      current: [`${STORE}a.ts`],
      incoming: [`${STORE}a.ts`, `${STORE}new.ts`],
      protect: protectNothing,
    });

    expect(plan.toDelete).toEqual([]);
  });
});

/**
 * 🔴 CATASTROPHE 1: the store holds `/home/project/src/main.ts`; a repo tree returns `src/main.ts`.
 * Compare them raw and nothing matches, so every file is "missing" and the restore wipes the project.
 */
describe('path shapes must not be able to wipe the project', () => {
  it('matches a repo-relative incoming map against absolute store paths', () => {
    const plan = planRestore({
      current: [`${STORE}src/main.ts`, `${STORE}package.json`],

      // Exactly what `fetchTree` returns.
      incoming: ['src/main.ts', 'package.json'],
      protect: protectForRepoRestore,
    });

    expect(plan.toDelete).toEqual([]);
  });

  it('matches an absolute incoming map against repo-relative store paths', () => {
    const plan = planRestore({
      current: ['src/main.ts'],
      incoming: [`${STORE}src/main.ts`],
      protect: protectNothing,
    });

    expect(plan.toDelete).toEqual([]);
  });

  it('is not fooled by a leading slash on either side', () => {
    const plan = planRestore({
      current: ['/home/project/a.ts', 'home/project/b.ts', '/c.ts'],
      incoming: ['a.ts', 'b.ts', 'c.ts'],
      protect: protectNothing,
    });

    expect(plan.toDelete).toEqual([]);
  });

  /** The deletion has to be executable: `deleteFile` wants the path the STORE knows it by. */
  it('returns paths in the shape the caller gave, not the normalised shape', () => {
    const plan = planRestore({
      current: [`${STORE}src/gone.ts`],
      incoming: ['src/main.ts'],
      protect: protectNothing,
    });

    expect(plan.toDelete).toEqual([`${STORE}src/gone.ts`]);
  });
});

/**
 * 🔴 CATASTROPHE 2: `isSecretPath` keeps `.env` out of every push, so a map fetched FROM a repo never
 * contains it. Treat that map as the whole truth and a pull deletes the user's API keys — the one file
 * in the project that exists nowhere else.
 */
describe('a repo restore must not delete the secrets the repo never had', () => {
  it('keeps the .env family on a pull', () => {
    const plan = planRestore({
      current: [`${STORE}.env`, `${STORE}.env.local`, `${STORE}.env.production`, `${STORE}src/main.ts`],
      incoming: ['src/main.ts'],
      protect: protectForRepoRestore,
    });

    expect(plan.toDelete).toEqual([]);
  });

  it('keeps .npmrc, which carries a registry token and is equally never pushed', () => {
    const plan = planRestore({
      current: [`${STORE}.npmrc`],
      incoming: ['src/main.ts'],
      protect: protectForRepoRestore,
    });

    expect(plan.toDelete).toEqual([]);
  });

  /** `.env.example` IS pushed. Its absence from the repo is real, so removing it is real. */
  it('still deletes .env.example, which the repo genuinely does carry', () => {
    const plan = planRestore({
      current: [`${STORE}.env.example`],
      incoming: ['src/main.ts'],
      protect: protectForRepoRestore,
    });

    expect(plan.toDelete).toEqual([`${STORE}.env.example`]);
  });

  /**
   * The mirror image, and the reason `protect` is a required parameter rather than a default: a local
   * checkpoint IS the whole truth. If it has no `.env`, the project had no `.env` at that moment, and
   * restoring to that moment means not having one. Protecting here would make undo lie the other way.
   */
  it('DOES delete .env when restoring a local checkpoint that did not have one', () => {
    const plan = planRestore({
      current: [`${STORE}.env`],
      incoming: [`${STORE}src/main.ts`],
      protect: protectNothing,
    });

    expect(plan.toDelete).toEqual([`${STORE}.env`]);
  });
});

describe('a restore is never a wipe', () => {
  /**
   * 🔴 An empty incoming map means every live file is "missing". Every situation that produces one — a
   * fetch that failed into `{}`, the wrong variable passed, a branch with no commits — is a situation
   * where deleting the whole project is obviously wrong.
   */
  it('refuses to delete anything when the incoming map is empty', () => {
    const plan = planRestore({
      current: [`${STORE}a.ts`, `${STORE}b.ts`, `${STORE}c.ts`],
      incoming: [],
      protect: protectNothing,
    });

    expect(plan.toDelete).toEqual([]);
  });

  it('handles an empty project without throwing', () => {
    expect(planRestore({ current: [], incoming: ['a.ts'], protect: protectNothing }).toDelete).toEqual([]);
  });

  it('ignores a path that normalises to nothing rather than trying to delete the workdir', () => {
    const plan = planRestore({
      current: [`${STORE}`, '/home/project', ''],
      incoming: ['src/main.ts'],
      protect: protectNothing,
    });

    expect(plan.toDelete).toEqual([]);
  });
});

describe('realistic shapes', () => {
  /** The §4.13 case: someone deleted a file in VS Code and committed. The pull must reflect that. */
  it('reflects a deletion made in the user’s own editor', () => {
    const plan = planRestore({
      current: [`${STORE}src/scripts/RacerMode.ts`, `${STORE}src/scripts/OldMode.ts`, `${STORE}.env`],
      incoming: ['src/scripts/RacerMode.ts'],
      protect: protectForRepoRestore,
    });

    expect(plan.toDelete).toEqual([`${STORE}src/scripts/OldMode.ts`]);
  });

  it('deletes many files at once without losing any', () => {
    const current = Array.from({ length: 50 }, (_, i) => `${STORE}src/f${i}.ts`);
    const plan = planRestore({ current, incoming: ['src/f0.ts'], protect: protectNothing });

    expect(plan.toDelete).toHaveLength(49);
    expect(plan.toDelete).not.toContain(`${STORE}src/f0.ts`);
  });
});
