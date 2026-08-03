/**
 * Every command an import emits must survive the shell allow-list (SPEC §4.2.5, §5).
 *
 * 🔴 THIS IS A TWO-WRITERS TEST, AND IT EXISTS BECAUSE THE TWO WRITERS DISAGREED FOR THE WHOLE LIFE
 * OF THE FORK. `projectCommands.ts` decides what an imported project runs; `shell-allowlist.ts`
 * decides what is allowed to run. Upstream's setup command began `export CI=true … &&`, and
 * `isAllowedShellCommand` refuses a chain unless EVERY `&&` segment passes — so **every repository
 * and folder import ever performed in this fork ran zero `npm install`s.**
 *
 * The shape of the failure is the reason a unit test on either module alone could never catch it:
 *
 *   • the install action was refused, but the `start` action was NOT (`npm run dev` is allow-listed),
 *   • so the dev server launched into an empty `node_modules`, Vite exited immediately,
 *   • and the user saw a terminal reading `> vite` and a fresh prompt, with no preview and no cause.
 *
 * Both modules were individually correct and individually tested. Nothing ran one against the other.
 * So these tests do exactly that: drive the REAL detector over realistic repos and feed everything it
 * produces to the REAL allow-list. No mocks on either side — a mock here would be a third opinion
 * about the very disagreement under test.
 */
import { describe, it, expect } from 'vitest';
import { detectProjectCommands, createCommandsMessage, type ProjectCommands } from './projectCommands';
import { isAllowedShellCommand } from '~/lib/runtime/shell-allowlist';

const pkg = (scripts: Record<string, string>, extra: Record<string, unknown> = {}) => ({
  path: 'package.json',
  content: JSON.stringify({ name: 'imported', ...extra, scripts }),
});

/**
 * The runtime these commands are written for.
 *
 * `nativeAddons: true` is the plain case — nothing extra is added, so these tests keep asserting
 * about the install itself rather than about rolldown. The browser-runtime case has its own block
 * at the bottom, and the decision behind it is exhaustively covered in `rolldown-wasm.spec.ts`.
 */
const NATIVE = { nativeAddons: true };
const BROWSER = { nativeAddons: false };

/** Every command a `ProjectCommands` can put in front of the shell. */
const commandsOf = (c: ProjectCommands) => [c.setupCommand, c.startCommand].filter((x): x is string => Boolean(x));

describe('detected commands are allow-list legal by construction', () => {
  it('control: the allow-list under test really does refuse upstream’s original setup command', () => {
    /*
     * Without this, every assertion below would still pass if the allow-list were accidentally
     * loosened to permit anything — the suite would report agreement between two broken modules.
     */
    const upstream =
      'export CI=true DEBIAN_FRONTEND=noninteractive FORCE_COLOR=0 && ' +
      'npx update-browserslist-db@latest && npm install --yes --no-audit --no-fund --silent';

    const verdict = isAllowedShellCommand(upstream);
    expect(verdict.allowed).toBe(false);
    expect(verdict.reason).toMatch(/export/);
  });

  it('control: the allow-list refuses `npx`, which is what the static-site branch used to emit', () => {
    expect(isAllowedShellCommand('npx --yes serve').allowed).toBe(false);
  });

  it.each([
    ['a Vite app', [pkg({ dev: 'vite', build: 'vite build' })]],
    ['a `start`-only app', [pkg({ start: 'node server.js' })]],
    ['a `preview`-only app', [pkg({ preview: 'vite preview' })]],
    ['an app with no runnable script', [pkg({ build: 'tsc' })]],
    ['a shadcn project', [pkg({ dev: 'next dev' }, { dependencies: { 'shadcn-ui': '^0.8.0' } })]],
    ['a shadcn project by components.json', [pkg({ dev: 'next dev' }), { path: 'components.json', content: '{}' }]],
  ])('%s: every emitted command passes the allow-list', async (_label, files) => {
    const commands = await detectProjectCommands(files, NATIVE);
    const emitted = commandsOf(commands);

    // The detector must actually have produced something, or this asserts nothing.
    expect(emitted.length).toBeGreaterThan(0);

    for (const command of emitted) {
      const verdict = isAllowedShellCommand(command);
      expect(verdict.allowed, `"${command}" would be blocked: ${verdict.reason}`).toBe(true);
    }
  });

  it('installs dependencies for any package.json project — the whole point', () => {
    /*
     * The regression was silent precisely because a project still *started*. Assert the install
     * exists and is real, not merely that nothing was blocked.
     */
    return detectProjectCommands([pkg({ dev: 'vite' })], NATIVE).then((commands) => {
      expect(commands.setupCommand).toBeTruthy();
      expect(commands.setupCommand).toMatch(/^npm install\b/);
      expect(commands.startCommand).toBe('npm run dev');
    });
  });

  it('does not silence the install — its output is the user’s only view of a slow or failing one', () => {
    return detectProjectCommands([pkg({ dev: 'vite' })], NATIVE).then((commands) => {
      expect(commands.setupCommand).not.toMatch(/--silent/);
    });
  });

  it('a static site emits NO command rather than one guaranteed to be refused', async () => {
    const commands = await detectProjectCommands([{ path: 'index.html', content: '<html></html>' }], NATIVE);

    expect(commandsOf(commands)).toEqual([]);

    // …and it must explain itself, or the user just gets an import that does nothing.
    expect(commands.followupMessage).toMatch(/package\.json/);
  });
});

describe('the message that carries those commands to the action runner', () => {
  it('wraps the install as `shell` and the start as `start`, both allow-list legal', async () => {
    const commands = await detectProjectCommands([pkg({ dev: 'vite' })], NATIVE);
    const message = createCommandsMessage(commands);

    expect(message).not.toBeNull();

    const content = message!.content;
    expect(content).toContain('<boltAction type="shell">npm install');
    expect(content).toContain('<boltAction type="start">npm run dev');

    /*
     * Re-extract from the rendered artifact rather than trusting the object: the action runner reads
     * these strings out of the message text, so the text is what has to be legal.
     */
    const emitted = [...content.matchAll(/<boltAction type="(?:shell|start)">([^<]+)<\/boltAction>/g)].map((m) =>
      m[1].trim(),
    );

    expect(emitted).toHaveLength(2);

    for (const command of emitted) {
      expect(isAllowedShellCommand(command).allowed, `"${command}" would be blocked`).toBe(true);
    }
  });

  it('emits nothing when there is nothing runnable', () => {
    expect(createCommandsMessage({ type: '', followupMessage: '' })).toBeNull();
  });
});

/**
 * A browser-hosted runtime cannot load rolldown's native binding, so a cloned Vite 8 repo installs,
 * starts, and dies with `Cannot find native binding` — no preview, and a stack trace that blames npm.
 *
 * The decision itself lives in `rolldown-wasm.spec.ts`. What is asserted here is the WIRING, which
 * is where this could still fail silently: the extra install has to reach the artifact the action
 * runner reads, and the chained command has to survive the same allow-list that killed upstream's.
 */
describe('rolldown’s WASM binding on a browser runtime', () => {
  const vite8 = pkg({ dev: 'vite' }, { devDependencies: { vite: '^8.0.10' } });
  const lock = {
    path: 'package-lock.json',
    content: JSON.stringify({ lockfileVersion: 3, packages: { 'node_modules/rolldown': { version: '1.2.2' } } }),
  };

  it('chains a pinned install onto the setup command, and the chain is allow-list legal', async () => {
    const commands = await detectProjectCommands([vite8, lock], BROWSER);

    expect(commands.setupCommand).toBe(
      'npm install --no-audit --no-fund && npm install @rolldown/binding-wasm32-wasi@1.2.2 --no-audit --no-fund',
    );

    const verdict = isAllowedShellCommand(commands.setupCommand!);
    expect(verdict.allowed, `blocked: ${verdict.reason}`).toBe(true);

    // The project must still start — the binding is an addition, never a replacement.
    expect(commands.startCommand).toBe('npm run dev');
  });

  it('reaches the artifact the action runner actually parses', async () => {
    /*
     * The object being right is not the same as the string being right: the runner reads commands
     * out of the rendered message text, and `[^<]+` in its own extraction is why this is re-read
     * here rather than trusted.
     */
    const commands = await detectProjectCommands([vite8, lock], BROWSER);
    const content = createCommandsMessage(commands)!.content;

    const emitted = [...content.matchAll(/<boltAction type="(?:shell|start)">([^<]+)<\/boltAction>/g)].map((m) =>
      m[1].trim(),
    );

    expect(emitted[0]).toContain('@rolldown/binding-wasm32-wasi@1.2.2');

    for (const command of emitted) {
      expect(isAllowedShellCommand(command).allowed, `"${command}" would be blocked`).toBe(true);
    }
  });

  it('says why the extra install is there — in the followup, not silently', async () => {
    const commands = await detectProjectCommands([vite8, lock], BROWSER);

    expect(commands.followupMessage).toContain('npm run dev');
    expect(commands.followupMessage).toContain('@rolldown/binding-wasm32-wasi');
  });

  it('leaves the same project alone on a runtime with native addons', async () => {
    const commands = await detectProjectCommands([vite8, lock], NATIVE);

    expect(commands.setupCommand).toBe('npm install --no-audit --no-fund');
    expect(commands.followupMessage).not.toContain('rolldown');
  });
});
