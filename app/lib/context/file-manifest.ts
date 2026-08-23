/**
 * 🔴 THE MODEL READS FILES; IT IS NOT SHOWN THEM (2026-08-08, `FRESH-START.md` §0.3, Inversion 3).
 *
 * ## The number this exists to delete
 *
 * Measured on a real "make me a mario kart clone" creation:
 *
 *   prompt 170,371 tokens  =  ~15k baked prompt  +  ~155k of dumped starter files (88 of them)
 *
 * A cold cache writes that at 2x — about a dollar of input before one token of the game exists, and
 * it is why this platform has a "cold start" at all. The same request costs ~133 credits on bolt.diy
 * and on any agent host driven by the owner's 150-token persona snippet, neither of which has a
 * cold-start concept, because neither has a prefix big enough for one to matter.
 *
 * **"Cold vs warm" was never a fact about caching. It is a symptom of prefix size.**
 *
 * ## Why a dump felt correct for so long
 *
 * `createFilesContext` is bolt.diy's, inherited unexamined, and it never *failed* — it just cost,
 * silently, on every turn, forever. It was survivable upstream because their templates are ~15 files
 * of Vite + React. The Babylon Toolkit starter is 88, including a read-only demo class library and a
 * whole framework system directory. Same mechanism, six times the payload.
 *
 * A year then went into making that dump cheaper rather than asking why it was large: sharedness-
 * ordered cache breakpoints, a stable-zone splitter, an opaque-file classifier, sticky block routing,
 * a duplicate-key fix worth 22.5k tokens/turn, and a cache warmer with a probe for its warmup curve.
 * All real savings — 1,100,188 to 111,659 input tokens — and all of it optimising a number that
 * should never have existed. An improving metric is not evidence you are on the right branch.
 *
 * ## What replaces it
 *
 * A manifest: every path, with a size and a one-word kind. ~15-25 bytes per file instead of the whole
 * body — an 88-file starter costs roughly **2k tokens instead of 155k**. The model calls `read_file`
 * for the handful it actually needs (measured: it reads about eight).
 *
 * ## Never regress
 *
 *  - **SORTED**, for the same reason the dump was: `Object.keys` is watcher-arrival order, which
 *    differs between a fresh mount, a reload and a device switch. Unsorted, the same project with the
 *    same bytes produces a different prefix and rewrites the cache entry at 2x for content that did
 *    not change. Nothing throws; the bill just goes up.
 *  - **De-duplicated on the project-relative path.** This map is CLIENT-SUPPLIED, so a stale bundle
 *    or a pre-fix working copy can still carry both `src/pages/Home.tsx` and its sandbox-absolute
 *    twin. Listing both shows the model two copies of one file it can edit independently.
 *  - **Sizes are bytes of source, never token estimates.** A wrong estimate teaches the model to
 *    avoid reading a file it needs.
 *  - The manifest is a LISTING, not a permission. Zone rules (§4.1 read-only paths) live in the
 *    prompt; this file must not encode them, or two places disagree about what is writable.
 */
import type { FileMap } from '~/lib/.server/llm/constants';
import { dedupeByProjectPath, toProjectRelativePath, type CollapsedPath } from '~/lib/common/sandbox-paths';
import { isOpaqueToModel } from './opaque-files';

export interface ManifestEntry {
  path: string;
  size: number;

  /**
   * `text` is readable with `read_file`. `binary` and `opaque` are not worth reading and never were:
   * a binary body cannot enter context at all (SPEC §1.3 principle 10), and an opaque file — a
   * lockfile, a vendored runtime shim, an `.svg` — is text for which no correct edit exists. Marking
   * them keeps the model from spending a tool round discovering that.
   */
  kind: 'text' | 'binary' | 'opaque';
}

/** Kept small on purpose: this is a listing, and every byte of it is paid for on every turn. */
export function buildFileManifest(files: FileMap): ManifestEntry[] {
  return buildFileManifestWithCollapses(files).entries;
}

/**
 * The same manifest, plus WHAT THE DE-DUP COLLAPSED.
 *
 * `spec/fail-loud.md` rule 3: a best-effort step that cannot fail the request must still REPORT. The
 * backstop below silently fixed a double-keyed map for weeks — 14 files, ~22.5k tokens a turn at the
 * 2x cache-write rate — and the reason nobody noticed is that it fixed it quietly. `request-invariants`
 * turns the collapse into a signal; `buildFileManifest` stays the one-line caller everyone else uses.
 */
export function buildFileManifestWithCollapses(files: FileMap): {
  entries: ManifestEntry[];
  collapsed: CollapsedPath[];
} {
  const candidates = Object.keys(files)
    .sort()
    .flatMap((rawPath) => {
      const dirent = files[rawPath];

      return dirent && dirent.type === 'file' ? [{ rawPath, dirent }] : [];
    });

  /*
   * ONE de-dup rule, shared with `createFilesContext` (`~/lib/common/sandbox-paths`). It used to live
   * here AND there, in two implementations, which is the `isSecretPath` rule broken: two copies of one
   * rule drift, and you find out when a file is collapsed on one path and listed twice on the other.
   */
  const { kept, collapsed } = dedupeByProjectPath(candidates, (candidate) => candidate.rawPath);

  const entries: ManifestEntry[] = kept.map(({ rawPath, dirent }) => {
    const path = toProjectRelativePath(rawPath);

    if (dirent.isBinary) {
      return { path, size: dirent.size ?? 0, kind: 'binary' as const };
    }

    return {
      path,
      size: dirent.content.length,
      kind: isOpaqueToModel(path) ? ('opaque' as const) : ('text' as const),
    };
  });

  return { entries, collapsed };
}

/**
 * The manifest as the model sees it.
 *
 * Deliberately terse — one line per file, no XML, no wrapper artifact. The old dump wrapped every
 * body in `<boltAction type="file">`, which was both the transport AND the instruction to write, and
 * that conflation is half of why the artifact protocol is being retired (`FRESH-START.md` §1.2).
 * A listing must not look like a set of pending writes.
 */
export function renderFileManifest(entries: ManifestEntry[]): string {
  const lines = entries.map((e) => {
    const suffix = e.kind === 'text' ? '' : `  [${e.kind}]`;
    return `${e.path}  (${e.size}${suffix})`;
  });

  return lines.join('\n');
}
