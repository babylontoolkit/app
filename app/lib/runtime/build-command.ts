/**
 * The ONE decision about what a `<boltAction type="build">` actually spawns (T17b, SPEC §4.8).
 *
 * WHY THIS EXISTS. A published game is served under a PREFIX — `/play/<shareId>/` locally and behind
 * CloudFront on the play origin alike (`buildContentKey` resolves the share's object prefix in both
 * deployments; there is NO deployment that serves a share at an origin root). The starter template's
 * `vite.config.ts` ships `base: "/"`, so every built `index.html` asked for `/index.js` — which under
 * the prefix resolves to the BUILDER's own HTML shell as a 404 body. Every published game was broken,
 * silently, from the template's initial import (T17b, measured 2026-07-28).
 *
 * The share build therefore passes `--base=./` on the CLI — it overrides the config, so it repairs
 * EXISTING projects with no template rebuild or promote. Deploy builds (Netlify/Vercel/GitHub/GitLab)
 * stay on the plain command: those targets serve at an origin root where either base works, and
 * changing a shipped deploy path buys nothing.
 *
 * ALLOW-LIST POSTURE (§4.2.5 applied to build actions): the action's `content` is a SELECTOR between
 * the two known-safe commands, never a source of spawn args. A build action can reach this from the
 * model's output channel as well as from our own buttons, and parsing free text into `spawn` argv
 * would hand whoever writes the action a command line. Unknown content degrades to the plain build.
 */
export const PLAIN_BUILD_COMMAND = 'npm run build';

/**
 * `npm run build -- --base=./` — npm appends the args after the whole script string, so the template's
 * `tsc -b && vite build` becomes `tsc -b && vite build --base=./`: the flag lands on the LAST command,
 * which is the vite build. A relative base makes every emitted asset URL resolve against the document
 * that loaded it, i.e. correct under any serving prefix.
 */
export const SHARE_BUILD_COMMAND = 'npm run build -- --base=./';

/** Exact-match or the plain build — never caller-shaped argv. */
export function buildSpawnArgs(content: string | undefined): string[] {
  return (content ?? '').trim() === SHARE_BUILD_COMMAND ? ['run', 'build', '--', '--base=./'] : ['run', 'build'];
}
