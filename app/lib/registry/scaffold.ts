/**
 * Copy-from-source scaffolding (SPEC §4.4b).
 *
 * `src/babylon/classes/` is a READ-ONLY library of demo sources. Creating a project COPIES one of
 * them into `src/scripts/<ProjectClassName>.ts`, renames the class and its `RegisterClass` string to
 * match, and leaves the library pristine — so every future copy still has a clean source, and the
 * agent keeps a working reference implementation to read.
 *
 * Three things must all agree or the project is subtly broken:
 *
 *  1. **Class name = file name = `RegisterClass` string.** The play contract resolves a GameMode by
 *     its REGISTERED STRING, so a rename that misses the string produces a project that compiles,
 *     boots, and then dead-ends at a blank `/play`.
 *  2. **Relative imports must be re-based.** The copy moves one directory deeper and one branch over
 *     (`src/babylon/classes/` → `src/scripts/`), so the demo's `import GameManager from "../globals"`
 *     silently becomes `src/globals` — a file that does not exist. Vite fails the build.
 *  3. **The class must be REGISTERED.** `src/babylon/globals.ts` imports each class explicitly for its
 *     `RegisterClass` side effect; nothing else imports them. A copied class that is not added there
 *     never registers, and `navigate('/play', { gameMode })` cannot resolve it. This is invisible
 *     until run time, which is exactly why it is done here and not left to the model.
 */

/** Where the demo library lives — the copy SOURCE, never a write target. */
export const CLASS_LIBRARY_DIR = 'src/babylon/classes';

/** The write zone (§4.4b): all project game code is authored here. */
export const SCRIPTS_DIR = 'src/scripts';

/** The file whose import list is what actually registers a GameMode class. */
export const GLOBALS_PATH = 'src/babylon/globals.ts';

/**
 * Class names already taken in a fresh starter — every demo the library registers. A project class
 * that collides with one of these would overwrite it in the `SceneManager` registry.
 */
export const RESERVED_CLASS_NAMES = [
  'DefaultGameMode',
  'FreeCameraMode',
  'PlayerControllerDemo',
  'PlaygroundDemoScene',
  'VehicleControllerDemo',
];

/**
 * Project title → GameMode class name (§4.4b, deterministic).
 *
 *   "Shopping Cart Racer"  → ShoppingCartRacerMode
 *   "my racer!"            → MyRacerMode
 *   "Neon Drift GameMode"  → NeonDriftGameMode   (suffix preserved, never doubled)
 *   "3D Test"              → Game3DTestMode      (a leading digit is not a legal identifier)
 */
export function deriveClassName(title: string, taken: string[] = RESERVED_CLASS_NAMES): string {
  const words = title.split(/[^a-zA-Z0-9]+/).filter(Boolean);

  /*
   * Uppercase the first character and PRESERVE the rest: "3D" must stay "3D", and an already-camel
   * "kartRacer" must not be flattened to "Kartracer".
   */
  let base = words.map((word) => word.charAt(0).toUpperCase() + word.slice(1)).join('');

  if (!base || /^[0-9]/.test(base)) {
    base = `Game${base}`;
  }

  if (!/(GameMode|Mode)$/.test(base)) {
    base = `${base}Mode`;
  }

  let candidate = base;

  for (let suffix = 2; taken.includes(candidate); suffix++) {
    candidate = `${base}${suffix}`;
  }

  return candidate;
}

/** Join a POSIX-ish path with a relative specifier, resolving `.` and `..`. Browser-safe (no `node:path`). */
function resolvePath(fromDir: string, specifier: string): string {
  const segments = fromDir.split('/').filter(Boolean);

  for (const part of specifier.split('/')) {
    if (part === '' || part === '.') {
      continue;
    }

    if (part === '..') {
      segments.pop();
    } else {
      segments.push(part);
    }
  }

  return segments.join('/');
}

/** Express `target` relative to `fromDir`, always prefixed (`./` or `../`) so it stays a relative specifier. */
function relativePath(fromDir: string, target: string): string {
  const from = fromDir.split('/').filter(Boolean);
  const to = target.split('/').filter(Boolean);

  let shared = 0;

  while (shared < from.length && shared < to.length && from[shared] === to[shared]) {
    shared++;
  }

  const up = from.length - shared;
  const parts = [...Array(up).fill('..'), ...to.slice(shared)];

  if (up === 0) {
    return `./${parts.join('/')}`;
  }

  return parts.join('/');
}

/**
 * Rewrite every relative import so it still points at the same file after the copy moves.
 *
 * Bare specifiers (`@babylonjs/core`) are left exactly as they are — only relative ones shift.
 */
export function rebaseRelativeImports(source: string, fromDir: string, toDir: string): string {
  return source.replace(
    /(\bfrom\s*|\bimport\s*\(\s*|\bimport\s+)(['"])(\.[^'"]*)\2/g,
    (_match, lead: string, quote: string, specifier: string) => {
      const absolute = resolvePath(fromDir, specifier);
      return `${lead}${quote}${relativePath(toDir, absolute)}${quote}`;
    },
  );
}

/**
 * Rename every occurrence of the source class identifier.
 *
 * A whole-word replace is deliberate and sufficient: it catches the class declaration, the
 * constructor's default `alias` string, the `RegisterClass("...", ...)` pair, and the demo's own
 * `console.warn("VehicleControllerDemo: ...")` self-references — all of which must move together.
 */
export function renameClass(source: string, fromClass: string, toClass: string): string {
  return source.replace(new RegExp(`\\b${fromClass}\\b`, 'g'), toClass);
}

export interface ScaffoldedGameMode {
  className: string;
  path: string;
  content: string;
}

/**
 * Produce the project's own GameMode from a library demo. Pure: takes the demo's text, returns the
 * copy's text. The library file itself is never touched (§4.4b step 5).
 */
export function scaffoldGameMode(options: {
  /** e.g. `VehicleControllerDemo.ts` — the registry entry's `source_class`. */
  sourceClassFile: string;
  sourceContent: string;
  className: string;
}): ScaffoldedGameMode {
  const { sourceClassFile, sourceContent, className } = options;
  const sourceClass = sourceClassFile.replace(/\.tsx?$/, '');

  const rebased = rebaseRelativeImports(sourceContent, CLASS_LIBRARY_DIR, SCRIPTS_DIR);
  const renamed = renameClass(rebased, sourceClass, className);

  return {
    className,
    path: `${SCRIPTS_DIR}/${className}.ts`,
    content: renamed,
  };
}

/** Matches the demo-registration lines in `globals.ts`: `await import("./classes/DefaultGameMode");` */
const CLASS_IMPORT_LINE = /^([ \t]*)await import\((['"])\.\/classes\/[^'"]+\2\);[ \t]*$/;

/**
 * Add the project's GameMode to `globals.ts`'s registration block, so `RegisterClass` actually runs.
 *
 * Inserted directly after the last demo import — inside `InitializeRuntime`, before physics comes up
 * and long before any scene resolves a mode by name. Idempotent.
 *
 * `globals.ts` sits in `src/babylon/` but is NOT in a read-only zone (§4.4b names `classes/**` and
 * `system/**`), which is precisely what makes it the sanctioned registration seam.
 */
export function registerGameModeInGlobals(globalsSource: string, className: string): string {
  const importPath = relativePath('src/babylon', `${SCRIPTS_DIR}/${className}`);
  const statement = `await import("${importPath}");`;

  if (globalsSource.includes(importPath)) {
    return globalsSource;
  }

  const lines = globalsSource.split('\n');

  let lastImport = -1;
  let indent = '        ';

  lines.forEach((line, index) => {
    const match = line.match(CLASS_IMPORT_LINE);

    if (match) {
      lastImport = index;
      indent = match[1];
    }
  });

  if (lastImport === -1) {
    throw new Error(
      'Could not find the GameMode registration block in globals.ts — the project would boot with an unregistered mode.',
    );
  }

  lines.splice(lastImport + 1, 0, `${indent}${statement}`);

  return lines.join('\n');
}
