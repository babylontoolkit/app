/**
 * Which cloned files may be quoted into the import artifact — and, far more importantly, which may NOT.
 *
 * 🔴 **THE CLONE'S BYTES ARE ALREADY ON DISK. THIS DECIDES WHAT THE ARTIFACT SAYS, NOT WHAT THE PROJECT
 * CONTAINS.** `gitClone` writes every file — binaries included — into the sandbox as real bytes before
 * this runs. The artifact exists so the conversation shows what arrived and so `detectProjectCommands`
 * can read a `package.json`; it is NOT the delivery mechanism. Anything excluded here is still present
 * and correct in the project.
 *
 * That distinction is the whole reason this module exists, because getting it backwards corrupts files:
 *
 * ## The defect this was extracted to fix (T1)
 *
 * `GitCloneButton` decoded with a **non-fatal** `new TextDecoder('utf-8')` and gated only on a
 * text-EXTENSION allow-list that included `.svg`, `.json`, `.xml` and `.md`. An `.svg` that is actually
 * gzipped, or a `.json` carrying invalid UTF-8, therefore reached the decoder, which silently replaced
 * every invalid byte with U+FFFD — and the action runner then wrote that garbage back **over the correct
 * bytes on disk**. A lossy decode of a file we already had perfectly.
 *
 * Its sibling `GitUrlImport.client.tsx` had already been fixed and carried a comment describing exactly
 * this failure. One door was repaired and the other was not, for want of a shared function — so the fix
 * is a single implementation both can call, not a second copy of the same three rules.
 *
 * ⚠️ **`GitUrlImport` does NOT call this yet** (it is T8's job) and still holds its own inline copy,
 * with an `IGNORE_PATTERNS` list that already disagrees with this one — it additionally ignores PNG and
 * JPG globs. So the drift this module exists to end is real and still open; do not read
 * the paragraph above as a description of today. When T8 lands, delete that copy rather than syncing it.
 *
 * ## The rules, and why each one is safe
 *
 *   - **An ignored path is excluded.** `node_modules`, `.git`, build output: noise in the artifact and
 *     tokens on every later turn (§4.2.8).
 *   - **A known-binary path is excluded outright**, before any decode is attempted (`isBinaryPath`).
 *   - **A byte array that is not valid UTF-8 is excluded**, via a `fatal: true` decoder. This is the
 *     load-bearing one: "is this text?" is a question about the BYTES, and an extension is a guess about
 *     them. Failing the decode is the only honest answer, and the cost of being wrong is zero — the file
 *     stays on disk exactly as cloned.
 *
 * ## What is deliberately NOT here
 *
 * There are **no size caps**. `GitCloneButton` used to drop any file over 100KB and stop entirely at
 * 500KB total, reporting it only as a line in a "skipped files" list nobody reads. Since the artifact
 * never delivered the bytes, a cap here bought nothing and cost a truthful record of the import. The
 * §4.2.8-correct shape for a large or opaque file is to not quote its body — which is what excluding it
 * already does.
 */
import ignore from 'ignore';
import { isBinaryPath } from '~/lib/binary/binary-files';

/**
 * Paths never worth quoting into the artifact.
 *
 * Note `**\/*lock.json` is deliberately absent (upstream's own comment: keeping the lockfile makes
 * `npm install` much faster). It is opaque rather than ignored — see `~/lib/context/opaque-files`.
 */
const IGNORE_PATTERNS = [
  'node_modules/**',
  '.git/**',
  '.github/**',
  '.vscode/**',
  'dist/**',
  'build/**',
  '.next/**',
  'coverage/**',
  '.cache/**',
  '.idea/**',
  '**/*.log',
  '**/.DS_Store',
  '**/npm-debug.log*',
  '**/yarn-debug.log*',
  '**/yarn-error.log*',
  '**/*lock.yaml',
];

const ig = ignore().add(IGNORE_PATTERNS);

/** One entry of the map `gitClone` returns — a string when it was written as text, bytes otherwise. */
export interface ClonedFileEntry {
  data: string | Uint8Array;
  encoding?: string;
}

/** A file whose text may be quoted into the artifact. */
export interface ImportableFile {
  path: string;
  content: string;
}

export interface ImportableSelection {
  /** Safe to quote — valid UTF-8 text, not ignored, not binary. */
  files: ImportableFile[];

  /**
   * Present on disk, absent from the artifact **because its bytes are not text** — binary by path, or
   * not decodable as UTF-8.
   *
   * Reported so the import can say so honestly. This is NOT a list of failures: every path here is a
   * file the project HAS. Never describe it to the user as "skipped" or "dropped".
   *
   * ⚠️ **Ignored paths are deliberately NOT here** — they are in `ignored`. Folding the two together
   * put `.git/index` and `.git/objects/pack/*.pack` into the user-visible import message (the old
   * inline code filtered ignored paths out BEFORE building its list, so they were never named), and
   * that message is also model-visible text (§4.2.8). Two different facts — "we could not quote this"
   * and "this was never interesting" — deserve two different lists.
   */
  excluded: string[];

  /** Filtered by `IGNORE_PATTERNS` — noise, not content. Returned for tests and diagnostics only. */
  ignored: string[];
}

/**
 * Split a cloned file map into "quotable text" and "on disk only".
 *
 * Pure: no sandbox, no network, no React. That is the point — the component that used to hold these
 * three rules boots a git client and renders three dialogs, so its behaviour could not be reached by a
 * test, which is how a lossy decoder survived in it.
 */
export function selectImportableFiles(data: Record<string, ClonedFileEntry>): ImportableSelection {
  const files: ImportableFile[] = [];
  const excluded: string[] = [];
  const ignored: string[] = [];

  /*
   * A FATAL decoder, re-created per call rather than shared at module scope: a fatal `TextDecoder` is
   * stateless across `decode()` calls, but keeping it local means nothing can later make it streaming
   * (`{ stream: true }`), where state DOES carry between calls and one bad file would poison the next.
   */
  const decoder = new TextDecoder('utf-8', { fatal: true });

  for (const path of Object.keys(data).sort()) {
    if (ig.ignores(path)) {
      ignored.push(path);
      continue;
    }

    /*
     * Extension first, bytes second. This is a fast path, never the decision: a `.png` is excluded
     * without decoding, but a `.svg` is NOT admitted on the strength of its name — it still has to
     * survive the decode below, which is precisely what the old allow-list skipped.
     */
    if (isBinaryPath(path)) {
      excluded.push(path);
      continue;
    }

    const entry = data[path];

    if (typeof entry.data === 'string') {
      files.push({ path, content: entry.data });
      continue;
    }

    if (!(entry.data instanceof Uint8Array)) {
      excluded.push(path);
      continue;
    }

    try {
      files.push({ path, content: decoder.decode(entry.data) });
    } catch {
      // Not UTF-8, whatever the extension claims. It is binary, and it is already correct on disk.
      excluded.push(path);
    }
  }

  return { files, excluded, ignored };
}
