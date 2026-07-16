/**
 * The remix seed — how a stranger's remix gets any files at all (SPEC §4.8, §4.5.4b).
 *
 * ## Why this exists (it did not need to, before repo-primary persistence)
 *
 * Remix clones a shared game's SOURCE into a new project. That used to be free: the platform kept a
 * server-side snapshot of every project after every generation, so `api.remix` just read the source's
 * `currentSnapshotId` and copied it.
 *
 * §4.5.4b deleted those snapshots — the platform no longer holds anyone's code. Which quietly broke
 * remix for every project built after the change: `currentSnapshotId` is now `undefined` for a normal
 * project, so the clone found no files and produced an EMPTY project. Nothing threw. The visitor just
 * got a blank editor where a game should have been, and the remix route's own comment ("a source with
 * no snapshot yet clones as an empty project — still valid, just nothing to copy") described what was
 * meant to be a rare edge case while it was in fact the universal one.
 *
 * The owner's repo cannot fill the gap: it is PRIVATE, and it belongs to them. A stranger's remix
 * cannot read it, and the platform must not use the owner's token to serve someone else's request.
 *
 * So the seed is deposited at PUBLISH time, by the one party who can: the owner, from their browser,
 * at the moment they choose to make the game public. That is the honest boundary — §4.5.4b's promise
 * is that we do not keep your working project, not that a game you deliberately published for others
 * to play and remix keeps its source a secret from them.
 *
 * ## What this module decides
 *
 * What may go IN the seed. It is the same question the push path answers (`git/sync-logic.ts`) and it
 * has the same answer, for a much sharper reason: a seed is handed to STRANGERS. `.env` is gitignored,
 * so it never reaches a repo by accident — but it is sitting right there in the project tree, and a
 * naive "upload the source" would put the user's API keys in every remixer's editor.
 *
 * Pure, so it can be tested exhaustively. The checklist still runs on top of this as the blocking
 * refusal; this is the exclusion that means the checklist should never have to fire.
 */
import type { SerializedFileMap } from '~/lib/binary/binary-files';
import { isSecretPath } from '~/lib/.server/git/sync-logic';

/** Paths that never belong in a seed even though they are not secret — noise, or many megabytes of it. */
function isNoise(path: string): boolean {
  const normalized = path.replace(/^\/+/, '');

  return (
    normalized.startsWith('node_modules/') ||
    normalized.includes('/node_modules/') ||
    normalized.startsWith('dist/') ||
    normalized.includes('/dist/') ||
    normalized.startsWith('.git/') ||
    normalized.includes('/.git/')
  );
}

export interface SeedResult {
  files: SerializedFileMap;

  /** Paths withheld because they are secret. The publisher is told; a silent drop teaches nothing. */
  excludedSecrets: string[];
}

/**
 * Build the seed a remix will be cloned from.
 *
 * Excludes the `.env` family (`isSecretPath` — the SAME rule the push path uses, deliberately shared:
 * two copies of "what counts as a secret" is how `.env.production` got pushed once already, because
 * one of the copies said `local`) and the generated/vendored bulk nobody needs a copy of.
 *
 * Binary bytes pass through untouched. The seed is a `SerializedFileMap` on both sides — base64 stays
 * a wire format and is never decoded here (`spec/binary-files.md`).
 */
export function buildRemixSeed(source: SerializedFileMap): SeedResult {
  const files: SerializedFileMap = {};
  const excludedSecrets: string[] = [];

  for (const [path, dirent] of Object.entries(source)) {
    if (isSecretPath(path)) {
      excludedSecrets.push(path);
      continue;
    }

    if (isNoise(path)) {
      continue;
    }

    files[path] = dirent;
  }

  return { files, excludedSecrets };
}
