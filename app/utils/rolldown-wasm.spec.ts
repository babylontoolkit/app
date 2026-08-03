/**
 * The rolldown WASM-binding decision (`rolldown-wasm.ts`).
 *
 * Two things are under test, and they fail in opposite directions:
 *
 *   • **Emitting nothing when it is needed** — the status quo: a cloned Vite 8 repo installs, starts,
 *     and dies with `Cannot find native binding`. Loud, but blamed on the project.
 *   • **Emitting a WRONG PIN** — silent. A mismatched napi binding loads (the version check only runs
 *     under `NAPI_RS_ENFORCE_VERSION_CHECK`) and misbehaves somewhere inside a bundle.
 *
 * So the refusal path gets as much coverage as the success path, and the allow-list runs for real —
 * a version read out of somebody's lockfile is untrusted input that ends up inside a shell command.
 */
import { describe, it, expect } from 'vitest';
import { decideRolldownWasm, WASM_BINDING, type TextFile } from './rolldown-wasm';
import { isAllowedShellCommand } from '~/lib/runtime/shell-allowlist';

const BROWSER = { nativeAddons: false };
const NATIVE = { nativeAddons: true };

const pkg = (deps: Record<string, unknown>, field = 'devDependencies'): TextFile => ({
  path: 'package.json',
  content: JSON.stringify({ name: 'imported', [field]: deps }),
});

const npmLock = (packages: Record<string, unknown>): TextFile => ({
  path: 'package-lock.json',
  content: JSON.stringify({ name: 'imported', lockfileVersion: 3, packages }),
});

const VITE_8 = pkg({ vite: '^8.0.10' });
const LOCK_122 = npmLock({ 'node_modules/rolldown': { version: '1.2.2' } });

describe('when the binding is not needed', () => {
  it('does nothing on a runtime that loads native addons — even for a Vite 8 project', () => {
    /*
     * The install is a ~10MB WASM download. On CodeSandbox rolldown finds its own `.node` binding
     * and this would be spent on every import for nothing.
     */
    expect(decideRolldownWasm([VITE_8, LOCK_122], NATIVE)).toEqual({ needed: false });
  });

  it('does nothing when the project already declares the binding (the starter template’s case)', () => {
    const declared = pkg({ vite: '^8.0.10', [WASM_BINDING]: '1.2.2' });
    expect(decideRolldownWasm([declared, LOCK_122], BROWSER)).toEqual({ needed: false });
  });

  it('does nothing for a Vite 7 project — rolldown landed in the 8 major', () => {
    expect(decideRolldownWasm([pkg({ vite: '^7.1.0' })], BROWSER)).toEqual({ needed: false });
  });

  it.each([
    ['no package.json at all', [{ path: 'index.html', content: '<html></html>' }]],
    ['a project with no bundler', [pkg({ typescript: '^5.0.0' })]],
    ['an unparseable package.json', [{ path: 'package.json', content: '{ not json' }]],
  ])('does nothing for %s', (_label, files) => {
    expect(decideRolldownWasm(files as TextFile[], BROWSER).needed).toBe(false);
  });
});

describe('when the binding is needed and the version is pinnable', () => {
  it('resolves rolldown from package-lock.json and pins the binding to it', () => {
    const decision = decideRolldownWasm([VITE_8, LOCK_122], BROWSER);

    expect(decision.needed).toBe(true);
    expect(decision.version).toBe('1.2.2');
    expect(decision.install).toBe(`npm install ${WASM_BINDING}@1.2.2 --no-audit --no-fund`);
  });

  it('reads a lockfileVersion 1 flat dependency map too', () => {
    const legacy: TextFile = {
      path: 'package-lock.json',
      content: JSON.stringify({ lockfileVersion: 1, dependencies: { rolldown: { version: '1.1.5' } } }),
    };

    expect(decideRolldownWasm([VITE_8, legacy], BROWSER).version).toBe('1.1.5');
  });

  it('finds rolldown nested under another package', () => {
    const nested = npmLock({ 'node_modules/vite/node_modules/rolldown': { version: '1.2.0' } });
    expect(decideRolldownWasm([VITE_8, nested], BROWSER).version).toBe('1.2.0');
  });

  it('reads pnpm-lock.yaml when an import happens to carry one', () => {
    /*
     * Usually absent — `importable-files.ts` ignores `**\/*lock.yaml` so a large lock never reaches
     * the model (§4.2.8). A bonus path, never the one to rely on.
     */
    const lock: TextFile = {
      path: 'pnpm-lock.yaml',
      content: ['packages:', '  rolldown@1.2.2:', '    resolution: {integrity: sha512-abc}', '  vite@8.0.10:'].join(
        '\n',
      ),
    };

    expect(decideRolldownWasm([VITE_8, lock], BROWSER).version).toBe('1.2.2');
  });

  it('accepts an exact rolldown version declared directly in package.json', () => {
    expect(decideRolldownWasm([pkg({ rolldown: '1.2.2' })], BROWSER).version).toBe('1.2.2');
  });

  it('treats `rolldown-vite` as a rolldown project', () => {
    expect(decideRolldownWasm([pkg({ 'rolldown-vite': '^7.1.0' })], BROWSER).needed).toBe(true);
  });

  it('explains itself — the note names the package, so the extra install is not a mystery', () => {
    const note = decideRolldownWasm([VITE_8, LOCK_122], BROWSER).note!;

    expect(note).toContain(WASM_BINDING);
    expect(note).toContain('1.2.2');
  });
});

describe('when it is needed but NOT pinnable, it refuses rather than guessing', () => {
  it('emits no install when no lockfile pins rolldown', () => {
    const decision = decideRolldownWasm([VITE_8], BROWSER);

    expect(decision.needed).toBe(true);
    expect(decision.install).toBeUndefined();
    expect(decision.version).toBeUndefined();

    // …but it must say what to do, or the user is back to an unexplained stack trace.
    expect(decision.note).toContain(WASM_BINDING);
    expect(decision.note).toMatch(/Cannot find native binding/);
  });

  it('emits no install when the tree pins TWO rolldown versions', () => {
    /*
     * One top-level binding cannot serve both, and picking whichever appeared first in the file is
     * exactly the silent wrong pin this module exists to avoid.
     */
    const twoCopies = npmLock({
      'node_modules/rolldown': { version: '1.2.2' },
      'node_modules/vite/node_modules/rolldown': { version: '1.1.5' },
    });

    expect(decideRolldownWasm([VITE_8, twoCopies], BROWSER).install).toBeUndefined();
  });

  it('emits no install when two lockfiles agree — because that is still one version', () => {
    // Control for the test above: deduplication must be by VALUE, not by occurrence count.
    const pnpm: TextFile = { path: 'pnpm-lock.yaml', content: 'packages:\n  rolldown@1.2.2:\n' };
    expect(decideRolldownWasm([VITE_8, LOCK_122, pnpm], BROWSER).version).toBe('1.2.2');
  });

  it.each([
    ['a range that survived a bad parse', '^1.2.2'],
    ['a workspace protocol', 'workspace:*'],
    ['a git URL', 'git+https://github.com/rolldown/rolldown.git#main'],
    ['a shell injection attempt', '1.2.2 && rm -rf /'],
    ['a command substitution attempt', '$(whoami)'],
  ])('refuses to pin %s', (_label, version) => {
    const lock = npmLock({ 'node_modules/rolldown': { version } });
    expect(decideRolldownWasm([VITE_8, lock], BROWSER).install).toBeUndefined();
  });
});

describe('everything it can emit is allow-list legal', () => {
  it('control: the allow-list really would refuse an unsanitised version', () => {
    /*
     * Without this, the sweep below would pass even if `SAFE_VERSION` were deleted and the allow-list
     * were the only thing standing — and it would pass for the wrong reason if the allow-list itself
     * were loosened. Assert the danger is real before asserting it is absent.
     */
    expect(isAllowedShellCommand(`npm install ${WASM_BINDING}@$(whoami)`).allowed).toBe(false);
    expect(isAllowedShellCommand(`npm install ${WASM_BINDING}@1.2.2 ; rm -rf /`).allowed).toBe(false);
  });

  it.each([
    ['a plain semver', '1.2.2'],
    ['a pre-release', '1.3.0-beta.4'],
    ['a wide major', '20.0.0'],
  ])('%s produces a command the allow-list accepts, alone and chained', (_label, version) => {
    const lock = npmLock({ 'node_modules/rolldown': { version } });
    const install = decideRolldownWasm([VITE_8, lock], BROWSER).install!;

    expect(install, 'a valid semver must actually produce an install').toBeTruthy();
    expect(isAllowedShellCommand(install).allowed, `"${install}" would be blocked`).toBe(true);

    /*
     * The chained form is what actually ships — `isAllowedShellCommand` refuses an `&&` chain unless
     * EVERY segment passes, which is precisely how upstream's setup command silently ran zero
     * installs on every import for the life of the fork.
     */
    const chained = `npm install --no-audit --no-fund && ${install}`;
    expect(isAllowedShellCommand(chained).allowed, `"${chained}" would be blocked`).toBe(true);
  });
});
