/**
 * Which directory holds a finished `npm run build`, best guess first.
 *
 * One rule, one place — the same reasoning `sandbox-paths.ts` and `isSecretPath` record. THREE
 * consumers ask this question (publish/§4.8, the Vercel deploy, the Netlify deploy) and all three had
 * their own copy of the list. The copies had already drifted: each stripped the build path with a
 * `'/home/project'` STRING LITERAL — a no-op under any other provider root, so the DETECTED directory
 * was silently discarded and every one of them fell through to guessing `dist`. That works for the
 * default template and publishes NOTHING for a project with a custom `outDir`, with no error anywhere.
 *
 * The order is the whole correctness: the detected path — what `action-runner`'s probe actually found
 * on disk — must be first, because it is the only candidate that can be right for a custom `outDir`.
 * Everything after it is defense in depth for a build whose probe found nothing.
 */
import { toProjectRelativePath } from '~/lib/common/sandbox-paths';

/** Conventional output directories, tried in order when the detected path does not resolve. */
const FALLBACK_BUILD_DIRS = ['dist', 'build', 'out', 'output'] as const;

/** The deploy paths also accept these two; publish deliberately does not (a game is not a `.next` app). */
const DEPLOY_ONLY_BUILD_DIRS = ['.next', 'public'] as const;

export interface BuildOutputCandidateOptions {
  /** Include `.next`/`public`, which the deploy flows have always tried and publish never has. */
  includeFrameworkDirs?: boolean;
}

export function buildOutputCandidates(
  detectedPath: string | undefined,
  options: BuildOutputCandidateOptions = {},
): string[] {
  const detected = detectedPath ? toProjectRelativePath(detectedPath) : '';
  const fallbacks = options.includeFrameworkDirs
    ? [...FALLBACK_BUILD_DIRS, ...DEPLOY_ONLY_BUILD_DIRS]
    : [...FALLBACK_BUILD_DIRS];

  /*
   * 🔴 An EMPTY detected path is dropped, never probed. It resolves to the workdir itself, where
   * `readdir` SUCCEEDS — so the flow would happily treat the whole project as its build output and
   * upload `node_modules`, `.env` and all, under keys stripped against an empty prefix. `action-runner`
   * initialises its `buildDir` to `''`, so this is one refactor away from being reachable rather than
   * hypothetical.
   */
  if (detected === '') {
    return fallbacks;
  }

  return [detected, ...fallbacks.filter((dir) => dir !== detected)];
}
