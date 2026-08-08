/**
 * `read_file` — the other half of Inversion 3 (`FRESH-START.md` §0.3, §2).
 *
 * The manifest (`~/lib/context/file-manifest.ts`) tells the model what exists; this hands over the
 * bodies it actually asks for. Measured on a real project: the dump cost 36,453 tokens per turn to
 * show 70 files, and the model reads about eight of them.
 *
 * ## The map is already here — this is not a sandbox round trip
 *
 * The file map arrives in the request body every turn (it is what `createFilesContext` used to
 * render), so a read is a lookup, not I/O. That matters: it means `read_file` cannot fail on a dead
 * sandbox connection, cannot hang (the failure mode that silently killed checkpointing for a whole
 * session), and costs nothing but the bytes it returns.
 *
 * ## Never regress
 *
 *  - **Validate in `execute`, never in the schema.** A zod violation is enforced by the AI SDK BEFORE
 *    `execute` runs and throws `InvalidToolArgumentsError`, which aborts the stream and kills the
 *    generation AFTER the tokens are spent. We watched a real edit turn die on a literal
 *    `load_skill({})`. Every argument here is `.optional()` and checked below.
 *  - **Non-throwing, always.** A wrong path is a recoverable model mistake — it gets a sentence back
 *    naming near-matches, and the same generation continues.
 *  - **Binaries never return content** (SPEC §1.3 principle 10). The map holds `isBinary` + a size and
 *    an EMPTY body; returning it would ship an empty string the model may then "helpfully" write back
 *    over a texture.
 *  - **Opaque files are refused with their reason** — a lockfile, a vendored runtime shim, an `.svg`.
 *    They are text for which no correct edit exists, and `public/scripts/` alone was half the
 *    starter's text payload.
 *  - **A budget, enforced here.** Reads are cheap individually and unbounded in aggregate: a model
 *    that reads all 70 files has reinvented the dump one tool call at a time, at WORSE cost (every
 *    read re-sends the growing conversation). `MAX_FILE_READS` caps the count and
 *    `MAX_READ_CHARS` the total bytes; past either, the tool refuses and names what it already has.
 *  - **The budget counts THIS TURN's reads only.** Charging for files carried from earlier turns
 *    means a long conversation can never read another file — "withdraw the tool" returning through
 *    the budget, the mistake `load_skill` had to unlearn.
 */
import { tool } from 'ai';
import { z } from 'zod';
import type { FileMap } from '~/lib/.server/llm/constants';
import { toProjectRelativePath } from '~/lib/common/sandbox-paths';
import { isOpaqueToModel } from '~/lib/context/opaque-files';
import { createScopedLogger } from '~/utils/logger';

const logger = createScopedLogger('file-tools');

/**
 * ⚠️ Arithmetic against `maxSteps`, not a preference — the pairing `gen_msixapaq_i871b6` cost 1,489
 * credits to learn. A turn must be able to spend its budget AND still have a step to answer in. Reads
 * are parallelisable in a single step, so this is far less step-hungry than `MAX_REFERENCE_LOADS`;
 * it is a bytes ceiling first and a count ceiling second.
 */
export const MAX_FILE_READS = 24;

/**
 * The real ceiling. 24 reads of ordinary source is a few thousand tokens; 24 reads that each happen
 * to be a 100KB generated file is the dump again. Whichever binds first, binds.
 */
export const MAX_READ_CHARS = 120_000;

export interface FileToolContext {
  /** The turn's file map, exactly as it arrived in the request body. */
  files: FileMap;

  /** Project-relative paths read on THIS turn — what the budget spends. */
  readThisTurn: Set<string>;

  /** Characters returned so far this turn. */
  charsThisTurn: { total: number };
}

/** Exported for testing: the lookup the tool performs, minus the AI SDK wrapper. */
export function resolveFile(files: FileMap, requested: string) {
  const wanted = toProjectRelativePath(requested.trim());

  for (const key of Object.keys(files).sort()) {
    const dirent = files[key];

    if (!dirent || dirent.type !== 'file') {
      continue;
    }

    if (toProjectRelativePath(key) === wanted) {
      return { path: wanted, dirent };
    }
  }

  return null;
}

/**
 * Near-matches for a path that does not exist, so a typo costs one sentence rather than a tool round
 * of guessing. Basename first — the model usually has the file right and the directory wrong.
 */
export function suggestPaths(files: FileMap, requested: string, limit = 5): string[] {
  const wanted = toProjectRelativePath(requested.trim()).toLowerCase();
  const base = wanted.split('/').pop() ?? wanted;

  const all = Object.keys(files)
    .filter((k) => files[k]?.type === 'file')
    .map((k) => toProjectRelativePath(k));

  const byBasename = all.filter((p) => p.toLowerCase().endsWith(`/${base}`) || p.toLowerCase() === base);
  const bySubstring = all.filter((p) => !byBasename.includes(p) && p.toLowerCase().includes(base));

  return [...new Set([...byBasename, ...bySubstring])].sort().slice(0, limit);
}

export function createFileTools(context: FileToolContext) {
  return {
    read_file: tool({
      description:
        "Read one file from the project by its path, exactly as listed in the project's file manifest. " +
        'Call this for any file you need to understand or edit before you change it. Paths are ' +
        'project-relative (e.g. `src/scripts/GameMode.ts`). Files marked [binary] or [opaque] in the ' +
        'manifest cannot be read and never need to be. You can call this several times in one step — ' +
        'read everything you need up front rather than one file per round.',

      parameters: z.object({
        /*
         * `.optional()` and validated in `execute` — see the file header. A required field here kills
         * the generation after the tokens are spent.
         */
        path: z.string().optional().describe('Project-relative path from the manifest, e.g. src/pages/Home.tsx'),
      }),

      execute: async ({ path }) => {
        if (!path || !path.trim()) {
          return 'read_file needs a "path" — a project-relative path from the file manifest, e.g. src/pages/Home.tsx.';
        }

        const relative = toProjectRelativePath(path.trim());

        /* Re-reading is free and must stay free: it is how a model recovers after a long tool loop. */
        if (context.readThisTurn.has(relative)) {
          const hit = resolveFile(context.files, relative);

          if (hit && !hit.dirent.isBinary) {
            return hit.dirent.content;
          }
        }

        if (context.readThisTurn.size >= MAX_FILE_READS) {
          logger.warn(`read_file: count budget spent (${context.readThisTurn.size}/${MAX_FILE_READS}), refused`);

          return (
            `REFUSED — you have read ${MAX_FILE_READS} files this turn, which is the limit. You already ` +
            `have: ${[...context.readThisTurn].sort().join(', ')}. Work with those and write the code now.`
          );
        }

        if (context.charsThisTurn.total >= MAX_READ_CHARS) {
          logger.warn(`read_file: byte budget spent (${context.charsThisTurn.total}/${MAX_READ_CHARS}), refused`);

          return (
            `REFUSED — you have read about ${Math.round(context.charsThisTurn.total / 1000)}KB this turn, ` +
            `which is the limit. You already have: ${[...context.readThisTurn].sort().join(', ')}. ` +
            'Work with those and write the code now.'
          );
        }

        const hit = resolveFile(context.files, relative);

        if (!hit) {
          const near = suggestPaths(context.files, relative);

          return near.length
            ? `No file at "${relative}". Did you mean: ${near.join(', ')}?`
            : `No file at "${relative}". Check the project file manifest in your context for the exact path.`;
        }

        if (hit.dirent.isBinary) {
          return (
            `"${relative}" is a binary file (${hit.dirent.size ?? 0} bytes) and cannot be read as text. ` +
            'Reference it by path in your code; do not try to rewrite it.'
          );
        }

        if (isOpaqueToModel(relative)) {
          return (
            `"${relative}" is generated, vendored or minified (${hit.dirent.content.length} bytes) — there is ` +
            'no correct edit to it and it is deliberately not readable. Leave it alone.'
          );
        }

        context.readThisTurn.add(relative);
        context.charsThisTurn.total += hit.dirent.content.length;

        return hit.dirent.content;
      },
    }),
  };
}
