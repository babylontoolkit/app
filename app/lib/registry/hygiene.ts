/**
 * Template snapshot hygiene (SPEC §4.4) — the setup `project-installer.md` mandates, applied to the
 * starter's files on their way into the WebContainer.
 *
 * These are not cosmetic tidy-ups. Each one corresponds to a failure we have already seen or that
 * SPEC calls out as a launch blocker, so the pipeline BAKES them in rather than trusting the starter
 * repo to stay correct:
 *
 *  - **Exact `@babylonjs/*` pins.** The starter declares `^9.15.0` and ships NO lockfile, so a fresh
 *    `npm install` floats every Babylon package to the newest minor. `@babylonjs-toolkit/next` pins
 *    its peers EXACTLY, so the moment one floats (e.g. `@babylonjs/serializers@9.16.1` importing
 *    `__esDecorate` from `@babylonjs/core@9.15.0`'s tslib, which does not export it) `npm run build`
 *    dies with MISSING_EXPORT. `npm run dev` still boots — so this hides until Share (§4.8), where a
 *    user's published game silently fails to build. Pinning is our compensation for the absent
 *    lockfile; when the starter commits one, this becomes belt-and-braces.
 *  - **No `.git`, no `node_modules`.** A project must never be wired to our starter's remote origin.
 *    A zipball carries no `.git` at all, which satisfies "remove the remote origin" structurally —
 *    the filter keeps it that way for any future ingest path that does carry one.
 *  - **`.gitignore` with `node_modules` + `.env`.**
 *  - **No React `StrictMode`** — it double-invokes effects and double-inits the Babylon window.
 *  - **`public/babylon.png` + `public/spinner.png`** — framework-required, and the canonical smoke
 *    test that the binary file layer is honest (`spec/binary-files.md`).
 */
import type { TemplateFile } from '~/types/template';

/**
 * Files that belong to the template REPO rather than to a project made from it.
 *
 * `Screenshot.png` is a 2.9MB image for the starter's own README — documentation about the template,
 * not an asset of the game, and nothing imports it. (This is not the "never delete image files" rule,
 * which governs the AGENT editing a live project: this file never becomes part of one.)
 */
const JUNK_FILES = new Set(['.gitmodules', 'Screenshot.png']);
const JUNK_DIRS = ['.git/', 'node_modules/', '.bolt/'];

/** Files we never mount into a user's project. */
export function isTemplateJunk(path: string): boolean {
  return JUNK_FILES.has(path) || path.endsWith('.tsbuildinfo') || JUNK_DIRS.some((dir) => path.startsWith(dir));
}

/**
 * Files a project may already own and that creation must NEVER clobber (`project-installer.md`).
 * The starter ships none of them; this guard exists for the import paths that do.
 */
export const NEVER_OVERWRITE = ['CLAUDE.md', 'AGENTS.md', '.github/copilot-instructions.md'];

const REQUIRED_GITIGNORE = ['node_modules', '.env'];

export function ensureGitignore(existing: string | undefined): string {
  const lines = (existing ?? '').split('\n');
  const has = (entry: string) => lines.some((line) => line.trim().replace(/\/$/, '') === entry);

  const missing = REQUIRED_GITIGNORE.filter((entry) => !has(entry));

  if (missing.length === 0) {
    return existing ?? '';
  }

  return (
    [...lines.filter((line, index) => line.trim() || index < lines.length - 1), ...missing].join('\n').trim() + '\n'
  );
}

/**
 * Strip React `StrictMode` from the app entry.
 *
 * StrictMode double-invokes effects in development, which initializes the Babylon window twice — the
 * framework's own sources carry `// Note: Strict mode safety` guards precisely because this bites.
 */
export function removeStrictMode(source: string): string {
  if (!source.includes('StrictMode')) {
    return source;
  }

  return source
    .replace(/^\s*import\s*\{\s*StrictMode\s*\}\s*from\s*['"]react['"];?\s*$/gm, '')
    .replace(/\{?\s*<StrictMode>\s*\}?/g, '')
    .replace(/\{?\s*<\/StrictMode>\s*\}?/g, '')
    .replace(/\bStrictMode\s*,\s*/g, '')
    .replace(/\n{3,}/g, '\n\n');
}

/** Any package whose version the toolkit pins exactly for its peers. */
function mustPinExactly(name: string): boolean {
  return name.startsWith('@babylonjs/') || name.startsWith('@babylonjs-toolkit/');
}

/**
 * Rewrite Babylon dependency ranges to exact versions, and name the package after the project.
 *
 * The declared minor IS the toolkit's peer version at authoring time, so dropping the range operator
 * pins the set that is known to work together. Anything else is a guess about a version that has not
 * shipped yet.
 */
export function pinBabylonDependencies(packageJsonText: string, projectName?: string): string {
  const pkg = JSON.parse(packageJsonText);

  for (const field of ['dependencies', 'devDependencies'] as const) {
    const deps = pkg[field] as Record<string, string> | undefined;

    if (!deps) {
      continue;
    }

    for (const [name, range] of Object.entries(deps)) {
      if (mustPinExactly(name)) {
        deps[name] = range.replace(/^[\^~>=<\s]+/, '');
      }
    }
  }

  if (projectName) {
    pkg.name = projectName;
  }

  return JSON.stringify(pkg, null, 2) + '\n';
}

/** `"Shopping Cart Racer!"` → `shopping-cart-racer` (a legal npm package name). */
export function toPackageName(title: string): string {
  const slug = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);

  return slug || 'babylon-game';
}

/**
 * Apply every hygiene rule to the mounted file set. Pure — returns a new list.
 *
 * Framework asset copying (`src/babylon/assets/*.png` → `public/`) is NOT done here: those are
 * binaries, and binaries never travel as `TemplateFile.content` into an artifact. They are written
 * straight to the WebContainer as bytes by the caller (`spec/binary-files.md`).
 */
export function applyProjectHygiene(files: TemplateFile[], options: { projectTitle?: string } = {}): TemplateFile[] {
  const kept = files.filter((file) => !isTemplateJunk(file.path));

  const gitignore = kept.find((file) => file.path === '.gitignore');
  const result = kept.map((file) => {
    if (file.isBinary) {
      return file;
    }

    if (file.path === 'package.json') {
      const name = options.projectTitle ? toPackageName(options.projectTitle) : undefined;
      return { ...file, content: pinBabylonDependencies(file.content, name) };
    }

    if (file.path === 'src/main.tsx' || file.path === 'src/main.jsx') {
      return { ...file, content: removeStrictMode(file.content) };
    }

    if (file.path === '.gitignore') {
      return { ...file, content: ensureGitignore(file.content) };
    }

    return file;
  });

  if (!gitignore) {
    result.push({
      name: '.gitignore',
      path: '.gitignore',
      content: ensureGitignore(undefined),
      isBinary: false,
    });
  }

  return result;
}
