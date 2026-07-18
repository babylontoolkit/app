/**
 * Reinstalling dependencies after a mount (SPEC §4.5.4b).
 *
 * When a project arrives from a repo — a new device, a cleared browser, a pull — the files are there
 * and `node_modules` is not. Nothing in the mount path installs anything, and until now nothing needed
 * to: a resumed project replayed its chat artifact, which carried `npm install` as a shell action. A
 * project mounted from a repository on a fresh device has no chat to replay, so without this it mounts
 * a complete, correct, entirely non-running game — and the failure looks like a broken product rather
 * than a missing install.
 *
 * The decision is separated from the doing because the decision is the part that can be wrong in a way
 * nobody notices: reinstalling every mount wastes 30+ seconds of a user's time on every reload, and
 * never reinstalling leaves them stuck.
 */

/** Files whose contents decide whether `node_modules` is still valid. */
const LOCKFILES = ['package-lock.json', 'pnpm-lock.yaml', 'yarn.lock'];
const MANIFEST = 'package.json';

export interface DependencyFacts {
  /** Does the mounted project have a `node_modules` directory with something in it? */
  hasNodeModules: boolean;

  /** The lockfile content mounted now, if any. */
  lockfile?: string;

  /** The lockfile content that was present when dependencies were last installed. */
  installedLockfile?: string;

  /** Does the project declare dependencies at all? A project with no package.json needs nothing. */
  hasManifest: boolean;
}

export type DependencyDecision =
  | { install: true; reason: 'no-node-modules' | 'lockfile-changed' }
  | { install: false; reason: 'up-to-date' | 'no-manifest' };

/**
 * Should we run `npm install`?
 *
 * The lockfile comparison is on CONTENT, not on a timestamp or a hash we store separately. Content is
 * the only thing that actually determines what `npm install` would produce, and it is already in the
 * file map — a parallel "deps version" record would be one more thing to keep in sync and to be wrong.
 */
export function decideDependencyInstall(facts: DependencyFacts): DependencyDecision {
  if (!facts.hasManifest) {
    return { install: false, reason: 'no-manifest' };
  }

  /*
   * No `node_modules` is the common case for a repo mount, and it does not depend on the lockfile at
   * all: nothing is installed, so something must be. Checked FIRST, because a project whose lockfile
   * happens to match a previous install still cannot run without the directory.
   */
  if (!facts.hasNodeModules) {
    return { install: true, reason: 'no-node-modules' };
  }

  if (facts.lockfile !== facts.installedLockfile) {
    return { install: true, reason: 'lockfile-changed' };
  }

  return { install: false, reason: 'up-to-date' };
}

/** The lockfile in a mounted file map, whichever package manager produced it. */
export function findLockfile(paths: string[]): string | undefined {
  return paths.find((path) => LOCKFILES.includes(basename(path)));
}

/** The root manifest path in a mounted file map, if the project has one. */
export function findManifest(paths: string[]): string | undefined {
  return paths.find((path) => basename(path) === MANIFEST && depth(path) <= rootDepth(paths));
}

/**
 * The npm script that launches the dev server for a mounted project, or undefined if it has none.
 *
 * Creation gets its dev server started for free — its artifact carries a `start` action running
 * `npm run dev`. A project mounted from a repo (a new device, a cleared browser, a pull) has no
 * artifact to replay, so the mount path must start it explicitly, and it can only run a script the
 * project actually declares. The shell allow-list (SPEC §4.2.5) permits `npm run <script>`, so the
 * result is always used as `npm run <name>`.
 *
 * `dev` is the Vite/Toolkit-starter convention; `start` is the fallback for a mounted repo that used
 * it instead. An unparseable or script-less manifest returns undefined rather than throwing — a mount
 * must never fail because someone's `package.json` is malformed.
 */
export function devScriptFromManifest(manifest: string | undefined): string | undefined {
  if (!manifest) {
    return undefined;
  }

  try {
    const scripts = (JSON.parse(manifest) as { scripts?: Record<string, unknown> })?.scripts ?? {};

    if (typeof scripts.dev === 'string') {
      return 'dev';
    }

    if (typeof scripts.start === 'string') {
      return 'start';
    }

    return undefined;
  } catch {
    return undefined;
  }
}

/**
 * Should the mount path start a dev server?
 *
 * Pure because the wrong answer is a silent footgun. The WebContainer is a page-level singleton that
 * survives SPA navigation, so its dev server keeps running when the user moves between projects
 * (dashboard → builder → dashboard → another game) or opens a project right after creating one — where
 * the creation artifact already started `npm run dev`. Firing a second `npm run dev` into a container
 * that already has one bound to the port is a conflict the user never asked for and cannot see coming.
 *
 * `runningPreviews` is the universal signal: once ANY dev server's `server-ready` fires, a preview is
 * registered, no matter who started it (an artifact or a previous mount). If one is already serving,
 * the newly-mounted files reach the browser through it — no second server needed.
 */
export function shouldStartDevServer(facts: { script: string | undefined; runningPreviews: number }): boolean {
  if (!facts.script) {
    // Nothing to run — the project declares no dev/start script.
    return false;
  }

  if (facts.runningPreviews > 0) {
    // A dev server is already serving this container; a second one would just fight for the port.
    return false;
  }

  return true;
}

export function hasManifest(paths: string[]): boolean {
  /*
   * The ROOT manifest only. A `package.json` inside `node_modules` — or in some vendored example
   * folder — is not this project's manifest, and matching one would make every project look installable
   * whether or not it really is.
   */
  return paths.some((path) => basename(path) === MANIFEST && depth(path) <= rootDepth(paths));
}

function basename(path: string): string {
  return path.split('/').pop() ?? '';
}

function depth(path: string): number {
  return path.replace(/^\/+|\/+$/g, '').split('/').length;
}

/** The shallowest depth any file sits at — the mount root, whatever prefix it carries. */
function rootDepth(paths: string[]): number {
  return paths.reduce((min, path) => Math.min(min, depth(path)), Number.POSITIVE_INFINITY);
}
