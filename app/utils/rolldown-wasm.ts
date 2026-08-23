/**
 * An imported project that bundles with rolldown needs a WASM binding on a browser-hosted runtime.
 *
 * ## The failure this exists to end
 *
 * Vite 8 bundles with **rolldown**, which is Rust reached through a napi binding — a compiled
 * `.node` file. Nodepod runs Node in the browser and cannot load one. So a cloned Vite 8 repo
 * installs cleanly, `npm run dev` starts cleanly, and then Vite dies with:
 *
 *     Error: Cannot find native binding. npm has a bug related to optional dependencies…
 *
 * The message is doubly misleading: nothing about the project is wrong, and the npm bug it names is
 * not what happened. The user gets a stack trace and no preview.
 *
 * ## Why an explicit install is the only fix
 *
 * Read from `rolldown@1.2.2/dist/shared/binding-*.mjs`, the loader tries in order:
 *
 *   1. the platform's native `.node` — fails here, by construction;
 *   2. a local `./rolldown-binding.wasi.cjs` artifact — not shipped in the npm package;
 *   3. **`require('@rolldown/binding-wasm32-wasi')` as a plain dependency** ← the door;
 *   4. a WebContainer-only auto-downloader, gated on `process.versions.webcontainer`, which
 *      pnpm-installs the same package into `/tmp`.
 *
 * ⚠️ **This said "Nodepod does not set that, so it never fires" until 2026-08-22, and both halves
 * were wrong.** Nodepod sets `process.versions.webcontainer = '1.0.0'` deliberately
 * (`src/constants/config.ts` `NODE_SUB_VERSIONS`) — it presents as a WebContainer so packages that
 * special-case one take the same path — so step 4 DOES fire, and it announces itself in rolldown's
 * own words: `[rolldown] Downloading @rolldown/binding-wasm32-wasi@<v> on WebContainer...`. It then
 * **fails**: measured in-pod on the AppTemplate, the loader threw `Cannot find native binding`
 * while the spawned `pnpm i` was still fetching, and the install only reported `Done in 121.8s`
 * afterwards — i.e. two minutes of dead time bought a dev server that had already given up. So step
 * 4 is not a fallback we can lean on; it is a slow way to reach the same failure.
 *
 * Step 3 is gated on nothing. And the package is **NOT** among rolldown's `optionalDependencies`
 * (verified against the published manifest — the 15 entries at 1.2.5 are all native triples, none
 * of them wasm), so no amount of `npm install`, cache clearing or lockfile deleting will ever bring
 * it in. It has to be named. That is the whole fix — and it is what Nodepod itself asks for: its
 * resolver lets `wasm32-wasi` through and throws `MODULE_NOT_FOUND` for every platform-native
 * sibling with the message `install @rolldown/binding-wasm32-wasi` (`src/script-engine.ts`).
 *
 * ## Why the version is resolved rather than guessed
 *
 * The binding is napi glue generated per release; rolldown's JS calls exports it expects to exist.
 * Installing `@latest` against a pinned older rolldown is a version skew whose symptom is a missing
 * export deep inside a bundle, and the loader only *checks* the version when
 * `NAPI_RS_ENFORCE_VERSION_CHECK` is set — so by default a mismatch loads and misbehaves quietly.
 *
 * So this follows `lookupMediaPrice`'s rule: **resolve exactly, or refuse and say so.** An
 * unresolvable version yields a `note` naming the manual command instead of a pinned guess. A wrong
 * pin is worse than no pin, because no pin is the situation the user is already in and can see.
 *
 * ## Allow-list legality is a construction property, not a hope
 *
 * Whatever this returns is chained onto the import's setup command and therefore passes through
 * `isAllowedShellCommand` (SPEC §4.2.5, §5), which refuses an `&&` chain unless EVERY segment
 * passes — the exact gate that silently killed `npm install` on every import for the life of the
 * fork. Hence {@link SAFE_VERSION}: a version that is not a plain semver is treated as
 * unresolvable, so the emitted string cannot contain anything the allow-list would reject.
 * `rolldown-wasm.spec.ts` runs the real allow-list over everything this module can produce.
 */

/** A file the importer could read as text. Same shape `detectProjectCommands` works with. */
export interface TextFile {
  path: string;
  content: string;
}

export interface RolldownWasmDecision {
  /** The project bundles with rolldown and the runtime cannot load a native addon. */
  needed: boolean;

  /** The resolved rolldown version, when exactly one was found. */
  version?: string;

  /** `npm install @rolldown/binding-wasm32-wasi@<version>` — allow-list legal, or absent. */
  install?: string;

  /** User- and model-visible sentence. Present whenever `needed`, whether or not we could pin. */
  note?: string;
}

export const WASM_BINDING = '@rolldown/binding-wasm32-wasi';

/**
 * A plain semver, optionally pre-release.
 *
 * Deliberately narrower than the allow-list's own `INSTALL_ARG`: this is a version we READ out of
 * somebody's lockfile and paste into a command, so it is validated at the boundary rather than
 * trusted. Anything else — a `file:` link, a git URL, a range that survived a bad parse — is not a
 * version we can pin to, and the honest answer is to stop rather than to sanitise it into one.
 */
const SAFE_VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;

/** Read one JSON file by exact basename, tolerating a malformed one. */
function readJson(files: TextFile[], name: string): Record<string, any> | undefined {
  const file = files.find((f) => f.path === name || f.path.endsWith(`/${name}`));

  if (!file) {
    return undefined;
  }

  try {
    const parsed = JSON.parse(file.content);
    return parsed && typeof parsed === 'object' ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function findFile(files: TextFile[], name: string): TextFile | undefined {
  return files.find((f) => f.path === name || f.path.endsWith(`/${name}`));
}

/**
 * Every rolldown version the project's lockfiles pin, deduplicated.
 *
 * A Set rather than a first-match, because "which rolldown?" has to be an unambiguous question. A
 * tree with two of them (a nested copy under some other tool) cannot be served by one top-level
 * binding, and picking whichever appeared first in the file is exactly the silent wrong pin this
 * module refuses to make.
 */
function rolldownVersions(files: TextFile[]): Set<string> {
  const found = new Set<string>();

  const npmLock = readJson(files, 'package-lock.json');

  if (npmLock) {
    // lockfileVersion 2/3: keyed by install path, so nested copies appear as distinct keys.
    for (const [key, entry] of Object.entries(npmLock.packages ?? {})) {
      if (key === 'node_modules/rolldown' || key.endsWith('/node_modules/rolldown')) {
        const version = (entry as any)?.version;

        if (typeof version === 'string') {
          found.add(version);
        }
      }
    }

    // lockfileVersion 1 kept a flat `dependencies` map instead.
    const legacy = npmLock.dependencies?.rolldown?.version;

    if (typeof legacy === 'string') {
      found.add(legacy);
    }
  }

  /*
   * pnpm-lock.yaml is parsed by line rather than by a YAML dependency: `packages:` entries are
   * `rolldown@1.2.2:` at a fixed indent, which a regex reads exactly. Note this file is usually
   * ABSENT from an import — `importable-files.ts` ignores `**\/*lock.yaml` so a large lock never
   * reaches the model (§4.2.8) — so this is a bonus path, never the one to rely on.
   */
  const pnpmLock = findFile(files, 'pnpm-lock.yaml');

  if (pnpmLock) {
    for (const match of pnpmLock.content.matchAll(/^\s+rolldown@(\d[^\s:(]*)[:(]/gm)) {
      found.add(match[1]);
    }
  }

  // Last resort: the project depends on rolldown directly AND pinned it exactly (no range chars).
  const pkg = readJson(files, 'package.json');

  if (pkg && found.size === 0) {
    for (const field of ['dependencies', 'devDependencies', 'optionalDependencies'] as const) {
      const declared = pkg[field]?.rolldown;

      if (typeof declared === 'string' && SAFE_VERSION.test(declared)) {
        found.add(declared);
      }
    }
  }

  return found;
}

/** Does this project bundle with rolldown at all? Version-independent — a yes/no about the tool. */
function usesRolldown(files: TextFile[], versions: Set<string>): boolean {
  if (versions.size > 0) {
    return true;
  }

  const pkg = readJson(files, 'package.json');

  if (!pkg) {
    return false;
  }

  for (const field of ['dependencies', 'devDependencies', 'optionalDependencies'] as const) {
    const deps = pkg[field];

    if (!deps || typeof deps !== 'object') {
      continue;
    }

    if (deps.rolldown || deps['rolldown-vite']) {
      return true;
    }

    /*
     * Vite 8 IS rolldown — the merge landed in that major. Read only the leading integer of the
     * range so `^8.0.10`, `~8.1`, `>=8` and a bare `8.0.0` all answer the same; anything without a
     * leading number (`workspace:*`, a git URL, `latest`) answers no rather than guessing high.
     */
    const vite = deps.vite;

    if (typeof vite === 'string') {
      const major = Number(/(\d+)/.exec(vite)?.[1]);

      if (Number.isFinite(major) && major >= 8) {
        return true;
      }
    }
  }

  return false;
}

/**
 * Already declared as a dependency — nothing to add.
 *
 * The starter template declares it as of 2026-08-22 (`AppTemplate` devDependencies, pinned exactly
 * to the rolldown its lockfile resolves). It did NOT before that date, while this comment already
 * claimed it did — so every project made from the starter hit the step-4 failure above.
 */
function alreadyDeclared(files: TextFile[]): boolean {
  const pkg = readJson(files, 'package.json');

  if (!pkg) {
    return false;
  }

  return (['dependencies', 'devDependencies', 'optionalDependencies'] as const).some(
    (field) => pkg[field] && typeof pkg[field] === 'object' && Boolean(pkg[field][WASM_BINDING]),
  );
}

/**
 * Decide whether an import must install rolldown's WASM binding, and at exactly which version.
 *
 * `nativeAddons` comes from `SandboxProvider.capabilities` — a provider fact, never a probe. When
 * it is true the runtime loads rolldown's native binding normally and this is a ~10MB download
 * nobody uses.
 */
export function decideRolldownWasm(files: TextFile[], options: { nativeAddons: boolean }): RolldownWasmDecision {
  if (options.nativeAddons) {
    return { needed: false };
  }

  if (alreadyDeclared(files)) {
    return { needed: false };
  }

  const versions = rolldownVersions(files);

  if (!usesRolldown(files, versions)) {
    return { needed: false };
  }

  const pinnable = [...versions].filter((v) => SAFE_VERSION.test(v));

  if (pinnable.length !== 1) {
    /*
     * Known to be needed, not known to be pinnable — zero versions (no lockfile in the import), or
     * more than one (a nested copy no single top-level binding can serve). Say so: the user gets a
     * named command they can run in the terminal, which beats a stack trace, and beats a guess.
     */
    return {
      needed: true,
      note:
        `This project bundles with rolldown (Vite 8), whose native binding cannot load in a ` +
        `browser-based workspace. I could not determine which rolldown version it pins, so I have ` +
        `not added the WASM binding automatically — if the dev server reports "Cannot find native ` +
        `binding", run \`npm install ${WASM_BINDING}@<your rolldown version>\` in the terminal.`,
    };
  }

  const version = pinnable[0];

  return {
    needed: true,
    version,

    // `--no-audit --no-fund` mirror the main install; both are plain flags the allow-list accepts.
    /*
     * 🔴 `--no-save` — this install must not touch `package.json` or `package-lock.json`.
     *
     * The binding is a PLATFORM workaround (a browser sandbox cannot load rolldown's native addon),
     * not something the user chose, so writing it into their manifest puts our workaround into their
     * repository the next time they commit.
     *
     * It also closes the blast radius of a real defect found 2026-08-03: our importer chains this
     * onto the initial install, and Nodepod's `npm` wrote each invocation's tree as the WHOLE
     * lockfile — turning a 220,682-byte / 365-package `package-lock.json` into a 2,127-byte file
     * describing only this package. The versions then re-resolved off the caret ranges, a duplicate
     * `@babylonjs/core` appeared, and `tsc` failed with 33 errors on a project that builds fine.
     * Fixed properly in the fork (@babylonjs-toolkit/nodepod 1.9.18-btk.6); this keeps the platform
     * from writing to a file it has no business writing to, whatever the package manager does.
     */
    install: `npm install ${WASM_BINDING}@${version} --no-save --no-audit --no-fund`,
    note:
      `This project bundles with rolldown (Vite 8), whose native binding cannot load in a ` +
      `browser-based workspace, so I am also installing ${WASM_BINDING}@${version} — rolldown ` +
      `falls back to it automatically.`,
  };
}
