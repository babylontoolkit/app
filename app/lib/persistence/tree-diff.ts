/**
 * What am I about to publish? (§4.13a — Review changes.)
 *
 * This is the code that tells a user what a commit will contain, and **every failure mode below
 * produces a confident wrong answer rather than an error** — which is why it is a pure function with
 * its own exhaustive suite rather than a loop inside a dialog.
 *
 * Three traps, each of which has already cost this codebase something:
 *
 *   1. 🔴 **Both sides must normalise through `toRepoRelativePath`.** The store keys
 *      `/home/project/src/main.ts`; a repo tree returns `src/main.ts`. Compared raw, NOTHING matches
 *      and the diff reports that the user rewrote their entire project. This is the identical trap
 *      `planRestore` documents, where the same mistake **wiped** projects — here it merely lies,
 *      which is precisely why it would survive longer.
 *
 *   2. 🔴 **`.env` and the map-excluded directories are not in the repository and never will be.**
 *      `isSecretPath` keeps the whole `.env` family out of every push, and `node_modules`/`.git`/
 *      `dist` never enter the map. An honest set-difference therefore reports `.env` as `added` on
 *      every diff forever, and a permanent false positive at the top of a list trains the user to
 *      skim past exactly the surface built to make them read carefully.
 *
 *   3. 🔴 **A binary is compared by size and a digest of its BYTES, never by `File.content`**, which
 *      is ALWAYS empty when `isBinary` (SPEC §1.3 principle 10 — the map holds `isBinary` + `size`
 *      only). A content comparison reports every binary as identical, silently, so the file class
 *      most likely to have changed after an asset generation is the one class the diff could never
 *      see.
 *
 * ⚠️ **The byte reads are SERIAL, and the cap does not bound them.** A same-size binary pair costs one
 * `readLocalBytes` round trip, the loop awaits them one at a time, and the cap is applied AFTER the
 * comparison — so an asset-heavy project on a server sandbox pays one RTT per same-size binary before
 * the list is trimmed. Fine at template scale (~90 files) and deliberately not optimised yet: the
 * size-first check already settles almost every real change without reading anything, and batching
 * these would trade a measured cost for an unmeasured one.
 *
 * ⚠️ **Async, where the plan wrote sync.** Local binary bytes live in the sandbox FS and are read
 * back over a provider round trip, so the byte-accurate comparison rule (3) cannot be honoured by a
 * synchronous function. The dependency is INJECTED (`readLocalBytes`) rather than imported, so this
 * module still has no store, no sandbox and no globals — the property that matters.
 */
import { isSecretPath, toRepoRelativePath } from '~/lib/git/paths';
import { isMapExcludedDir } from '~/lib/stores/files';
import { base64ToBytes, type SerializedFileMap } from '~/lib/binary/binary-files';
import type { FileMap } from '~/lib/stores/files';

/**
 * How many changed files the list renders.
 *
 * Open Question 3, decided: capped, honestly. Refusing to show a list is worse than a truncated one
 * that says it is truncated — so the overflow is REPORTED with real counts and the UI links to the
 * provider's own compare view for the rest. A cap with no report is the failure this number exists
 * to avoid: a short list that reads as "this is everything".
 */
export const DIFF_MAX_FILES = 500;

export type TreeChangeStatus = 'added' | 'modified' | 'deleted';

export interface TreeChange {
  /** Repo-relative, always. Both sides are normalised before they are compared. */
  path: string;

  /** `added` = in the sandbox, not in the branch. `deleted` = in the branch, not in the sandbox. */
  status: TreeChangeStatus;

  /** `from` is the branch's size, `to` is the sandbox's. Absent on the side the file is missing. */
  bytes?: { from?: number; to?: number };

  /** True when EITHER side is binary — the UI must not offer to render a diff for one. */
  isBinary: boolean;
}

export interface TreeDiff {
  changes: TreeChange[];

  /** Present only when the cap bit. `shown` is what `changes` holds; `total` is the real count. */
  truncated?: { shown: number; total: number };
}

export interface TreeDiffOptions {
  /**
   * The sandbox bytes for one binary file, by its ORIGINAL (store) path.
   *
   * ⚠️ These bytes are ON LOAN — a provider may hand back a live view into its own storage
   * (`FilesStore.readBinaryFile`'s header). Nothing here takes ownership: the array is only read, by
   * `crypto.subtle.digest`, which copies internally and never transfers. A future change that wants
   * to keep or post these bytes must copy first.
   *
   * A read that throws is not fatal — see `digestOrNull`.
   */
  readLocalBytes?: (storePath: string) => Promise<Uint8Array>;

  /** Override for tests and for a caller that wants a shorter list. */
  maxFiles?: number;
}

/** One file on one side, already normalised. Folders never reach here. */
interface Side {
  isBinary: boolean;

  /** Text content, or the base64 of a binary's bytes when the map carries them (the REMOTE side). */
  content: string;
  size?: number;

  /** The key this entry had before normalisation — what `readLocalBytes` must be handed. */
  storePath: string;
}

/**
 * A path this diff must never mention, whichever side it is on.
 *
 * ⚠️ The two rules are imported, never re-derived. `isSecretPath` is one rule in one place for a
 * reason written into its own history (a second, narrower copy pushed `.env.production`), and
 * `MAP_EXCLUDED_DIRS` has two spellings already without this file inventing a third.
 */
function isExcluded(repoPath: string): boolean {
  if (isSecretPath(repoPath)) {
    return true;
  }

  return repoPath.split('/').some((segment) => isMapExcludedDir(segment));
}

/** The sandbox's files, keyed repo-relative. Folders, excluded paths and holes are dropped. */
function collectLocal(local: FileMap): Map<string, Side> {
  const out = new Map<string, Side>();

  for (const [storePath, dirent] of Object.entries(local)) {
    if (!dirent || dirent.type !== 'file') {
      continue;
    }

    const repoPath = toRepoRelativePath(storePath);

    if (!repoPath || isExcluded(repoPath)) {
      continue;
    }

    out.set(repoPath, {
      isBinary: dirent.isBinary,

      /*
       * Deliberately empty for a binary — see trap 3. It is carried rather than omitted so the two
       * sides have one shape, and `sameContent` refuses to use it for a binary at all.
       */
      content: dirent.content,
      size: dirent.size,
      storePath,
    });
  }

  return out;
}

/** The branch's files, keyed repo-relative. A repo tree is usually already relative; normalise anyway. */
function collectRemote(remote: SerializedFileMap): Map<string, Side> {
  const out = new Map<string, Side>();

  for (const [rawPath, dirent] of Object.entries(remote)) {
    if (!dirent || dirent.type !== 'file') {
      continue;
    }

    const repoPath = toRepoRelativePath(rawPath);

    if (!repoPath || isExcluded(repoPath)) {
      continue;
    }

    out.set(repoPath, {
      isBinary: dirent.isBinary,
      content: dirent.content,
      size: dirent.size,
      storePath: rawPath,
    });
  }

  return out;
}

/** SHA-256 of some bytes, hex. Used only to answer "are these two same-sized binaries the same?". */
async function digest(bytes: Uint8Array): Promise<string> {
  const buffer = await crypto.subtle.digest('SHA-256', bytes as unknown as BufferSource);

  return Array.from(new Uint8Array(buffer), (b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * A digest, or `null` when the bytes could not be read.
 *
 * ⚠️ **`null` means UNKNOWN and is never treated as a match.** A sandbox read can fail transiently,
 * and the two wrong answers are not symmetrical: reporting an unreadable file as unchanged hides a
 * real change from a review screen, while reporting it as changed shows the user one extra row they
 * can look at. The honest answer is `modified` — see `sameBinary`.
 */
async function digestOrNull(read: () => Promise<Uint8Array>): Promise<string | null> {
  try {
    return await digest(await read());
  } catch {
    return null;
  }
}

/**
 * Are these two binaries the same file?
 *
 * Size first, because it is free and settles almost every case without reading a byte — an asset
 * regeneration virtually never lands on the identical length. Only a size TIE needs the bytes.
 */
async function sameBinary(local: Side, remote: Side, options: TreeDiffOptions): Promise<boolean> {
  if (local.size !== remote.size) {
    return false;
  }

  const read = options.readLocalBytes;

  if (!read) {
    /*
     * No reader was supplied, so the bytes are genuinely unknown. Same-sized binaries are reported
     * as UNCHANGED here — the size comparison is all this call can honestly do, and inventing a
     * `modified` row for every binary in the project would make the list useless. The caller that
     * cares (the review dialog) passes a reader.
     */
    return true;
  }

  const [localDigest, remoteDigest] = await Promise.all([
    digestOrNull(() => read(local.storePath)),
    digestOrNull(async () => base64ToBytes(remote.content)),
  ]);

  // Unknown on either side → report the change. See `digestOrNull`.
  return localDigest !== null && remoteDigest !== null && localDigest === remoteDigest;
}

/** Text is compared verbatim. A binary NEVER reaches here — `content` is empty on the sandbox side. */
function sameText(local: Side, remote: Side): boolean {
  return local.content === remote.content;
}

/**
 * Compare the sandbox's tree against a branch's tree.
 *
 * `local` is `workbenchStore.files` (store-keyed, binaries as metadata only); `remote` is the
 * `SerializedFileMap` a `tree` read returned (repo-keyed, binaries as base64).
 */
export async function compareTrees(
  local: FileMap,
  remote: SerializedFileMap,
  options: TreeDiffOptions = {},
): Promise<TreeDiff> {
  const localFiles = collectLocal(local);
  const remoteFiles = collectRemote(remote);
  const changes: TreeChange[] = [];

  for (const [path, side] of localFiles) {
    const counterpart = remoteFiles.get(path);

    if (!counterpart) {
      changes.push({ path, status: 'added', bytes: { to: side.size }, isBinary: side.isBinary });
      continue;
    }

    const isBinary = side.isBinary || counterpart.isBinary;

    /*
     * A file that changed KIND (text became binary, or the reverse) is a change by definition, and
     * neither comparison below can be trusted across that boundary: the sandbox side of a binary
     * carries no content, so a text-vs-binary `sameText` would compare a real string against `''`
     * and call it modified for the right answer by accident — and the reverse case would not.
     */
    const unchanged =
      side.isBinary !== counterpart.isBinary
        ? false
        : isBinary
          ? await sameBinary(side, counterpart, options)
          : sameText(side, counterpart);

    if (!unchanged) {
      changes.push({
        path,
        status: 'modified',
        bytes: { from: counterpart.size, to: side.size },
        isBinary,
      });
    }
  }

  for (const [path, side] of remoteFiles) {
    if (!localFiles.has(path)) {
      changes.push({ path, status: 'deleted', bytes: { from: side.size }, isBinary: side.isBinary });
    }
  }

  /*
   * Sorted before the cap, so a truncated list is STABLE: the same tree always shows the same rows,
   * and re-opening the dialog does not shuffle them. `Object.entries` order is watcher-arrival order
   * on the sandbox side — the same reason `createFilesContext` sorts.
   *
   * ⚠️ **CODEPOINT ORDER, deliberately not `localeCompare`.** Collation is locale- and ICU-dependent
   * (`localeCompare` puts `package.json` before `README.md` at primary strength), and because the cap
   * above keeps the FIRST N rows, a locale-dependent order means two users looking at the same
   * over-cap tree are shown different subsets of it. That is the one place an ordering choice stops
   * being cosmetic. `file-manifest.ts` takes the same bare sort for the same reason.
   */
  changes.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));

  const cap = options.maxFiles ?? DIFF_MAX_FILES;

  if (changes.length > cap) {
    return { changes: changes.slice(0, cap), truncated: { shown: cap, total: changes.length } };
  }

  return { changes };
}
