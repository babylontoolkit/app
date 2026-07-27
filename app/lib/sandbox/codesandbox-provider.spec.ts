/**
 * The CodeSandbox adapter's translation layer (SPEC §8, `spec/sandbox-codesandbox.md`).
 *
 * Every assertion here corresponds to something that fails SILENTLY in production:
 *
 *   - a path that escapes the workdir writes outside the project and throws nothing;
 *   - `batchWrite` given an absolute path fails at EXTRACTION time with "Unzip command failed with
 *     exit code 1" — a message that names neither the path nor the cause (MEASURED live);
 *   - a mount that stringifies `Uint8Array` contents corrupts every PNG and `.wasm` (this is the
 *     exact defect the WebContainer provider has, `spec/binary-files.md`);
 *   - crossing `onServerReady` with `onPort` gives a preview that never appears;
 *   - a `change` event delivered without a `buffer` makes `FilesStore` record the file as EMPTY,
 *     so a generation's output shows up as a tree full of blank files.
 */
/*
 * The client double is deliberately inert — the claim under test is that the ADAPTER routes calls
 * correctly, so its collaborators do nothing on purpose rather than by omission.
 */
/* eslint-disable @typescript-eslint/no-empty-function */
import { describe, expect, it, vi } from 'vitest';
import {
  bootupPreservedFilesystem,
  clearPortScript,
  flattenMountTree,
  needsContent,
  resolveInWorkdir,
  SandboxPathError,
  toShellCommand,
  toWorkspaceRelative,
  translateWatchEvent,
} from './codesandbox-translate';
import { CODESANDBOX_CAPABILITIES, createCodeSandboxProvider } from './codesandbox-provider';

const WD = '/project/workspace';

describe('bootupPreservedFilesystem — the fact that gates restore-over-sandbox', () => {
  /*
   * 🔴 Both wrong answers are silent data movers. Claiming `true` for FORK/CLEAN makes the mount
   * trust a disk holding TEMPLATE state — the user opens an empty project with no error. Claiming
   * `false` for RESUME/RUNNING makes the mount restore a client-held copy over the live disk — the
   * MEASURED bug where a stale working copy reverted a generated Home.css to the starter's.
   */
  it('trusts a disk that resumed warm or never slept', () => {
    expect(bootupPreservedFilesystem('RESUME')).toBe(true);
    expect(bootupPreservedFilesystem('RUNNING')).toBe(true);
  });

  it('does NOT trust a fresh fork, a wiped snapshot, or anything unknown', () => {
    expect(bootupPreservedFilesystem('FORK')).toBe(false);
    expect(bootupPreservedFilesystem('CLEAN')).toBe(false);
    expect(bootupPreservedFilesystem('')).toBe(false);
    expect(bootupPreservedFilesystem('resume')).toBe(false); // the SDK reports upper-case; no coercion
  });
});

describe('path rebasing', () => {
  it('makes a seam-relative path absolute inside the workdir', () => {
    expect(resolveInWorkdir(WD, 'src/main.ts')).toBe('/project/workspace/src/main.ts');
  });

  it('treats "." and "" as the workdir itself', () => {
    // `FilesStore.refreshFiles` walks with `readdir(relDir || '.')` — both forms reach this.
    expect(resolveInWorkdir(WD, '.')).toBe(WD);
    expect(resolveInWorkdir(WD, '')).toBe(WD);
  });

  it('does not double up when the caller already passed a leading slash', () => {
    expect(resolveInWorkdir(WD, '/src/main.ts')).toBe('/project/workspace/src/main.ts');
  });

  it('REFUSES traversal rather than normalising it away', () => {
    /*
     * The failure this prevents: `join()` would happily produce `/etc/passwd` and every fs method in
     * the seam takes a path that ultimately comes from a file map the model can write to.
     */
    expect(() => resolveInWorkdir(WD, '../../etc/passwd')).toThrow(SandboxPathError);
    expect(() => resolveInWorkdir(WD, 'src/../../../etc/passwd')).toThrow(SandboxPathError);
  });

  it('allows a filename that merely CONTAINS dots', () => {
    // A segment-wise check, not a substring one — `..foo` and `a..b` are ordinary names.
    expect(resolveInWorkdir(WD, 'src/..foo/a..b.ts')).toBe('/project/workspace/src/..foo/a..b.ts');
  });
});

describe('batchWrite paths are RELATIVE — the one SDK method that disagrees with the others', () => {
  it('strips the workdir prefix when it is present', () => {
    expect(toWorkspaceRelative(WD, '/project/workspace/src/main.ts')).toBe('src/main.ts');
  });

  it('leaves an already-relative path alone', () => {
    expect(toWorkspaceRelative(WD, 'src/main.ts')).toBe('src/main.ts');
  });

  it('never returns a leading slash, which is what breaks the unzip', () => {
    for (const input of ['/src/a.ts', 'src/a.ts', '/project/workspace/src/a.ts']) {
      expect(toWorkspaceRelative(WD, input).startsWith('/')).toBe(false);
    }
  });

  it('refuses traversal here too', () => {
    expect(() => toWorkspaceRelative(WD, '../outside.ts')).toThrow(SandboxPathError);
  });
});

describe('flattening a mount tree', () => {
  it('produces relative paths for nested files', () => {
    const files = flattenMountTree({
      'package.json': { file: { contents: '{}' } },
      src: { directory: { 'main.ts': { file: { contents: 'x' } } } },
    });

    expect(files).toEqual([
      { path: 'package.json', content: '{}' },
      { path: 'src/main.ts', content: 'x' },
    ]);
  });

  it('passes Uint8Array contents through UNTOUCHED', () => {
    /*
     * The whole binary contract. WebContainer's `mount` decodes these through a `TextDecoder('latin1')`
     * and destroys them; a `String(content)` here would silently reintroduce that defect on a
     * provider that does not have it.
     */
    const wasm = new Uint8Array([0x00, 0x61, 0x73, 0x6d, 0xff, 0xfe]);
    const files = flattenMountTree({ public: { directory: { 'havok.wasm': { file: { contents: wasm } } } } });

    expect(files[0].content).toBe(wasm);
    expect(files[0].content).toBeInstanceOf(Uint8Array);
  });

  it('drops empty directories, because batchWrite has no entry shape for one', () => {
    expect(flattenMountTree({ empty: { directory: {} } })).toEqual([]);
  });
});

describe('watch event translation', () => {
  const classifyAsFile = (buffer?: Uint8Array) => () => ({ isDirectory: false, buffer });

  it('maps add/change to the file events FilesStore understands', () => {
    const bytes = new Uint8Array([1, 2, 3]);

    expect(translateWatchEvent({ type: 'add', paths: ['a.ts'] }, classifyAsFile(bytes))).toEqual([
      { type: 'add_file', path: 'a.ts', buffer: bytes },
    ]);
    expect(translateWatchEvent({ type: 'change', paths: ['a.ts'] }, classifyAsFile(bytes))).toEqual([
      { type: 'change', path: 'a.ts', buffer: bytes },
    ]);
  });

  it('carries the buffer through, because FilesStore builds its entry from it', () => {
    /*
     * Mutation check: dropping `buffer` here makes every changed file record as empty content, with
     * no error anywhere. That is the failure mode this adapter fetches content to avoid.
     */
    const bytes = new Uint8Array([9, 9]);
    const [event] = translateWatchEvent({ type: 'change', paths: ['x'] }, classifyAsFile(bytes));

    expect(event.buffer).toBe(bytes);
  });

  it('maps a directory add to add_dir rather than inventing an empty file', () => {
    expect(translateWatchEvent({ type: 'add', paths: ['src'] }, () => ({ isDirectory: true }))).toEqual([
      { type: 'add_dir', path: 'src' },
    ]);
  });

  it('reports every removal as remove_file — the documented limitation', () => {
    /*
     * A removed path cannot be classified: it is already gone, so nothing can be read. `remove_file`
     * is right for the overwhelming majority of removals and wrong for a deleted DIRECTORY, whose
     * children linger until the next refreshFiles(). Pinned so the trade-off is a decision rather
     * than an accident — the alternative (`remove_dir` for everything) corrupts FilesStore's #size.
     */
    expect(translateWatchEvent({ type: 'remove', paths: ['gone.ts'] }, () => ({ isDirectory: true }))).toEqual([
      { type: 'remove_file', path: 'gone.ts' },
    ]);
  });

  it('expands a multi-path event into one seam event per path', () => {
    expect(translateWatchEvent({ type: 'change', paths: ['a', 'b'] }, classifyAsFile()).map((e) => e.path)).toEqual([
      'a',
      'b',
    ]);
  });

  it('only asks for content on add/change, never on remove', () => {
    // One wasted round trip per deleted file, against a MEASURED 3,600 requests/hour budget.
    expect(needsContent({ type: 'add', paths: [] })).toBe(true);
    expect(needsContent({ type: 'change', paths: [] })).toBe(true);
    expect(needsContent({ type: 'remove', paths: [] })).toBe(false);
  });
});

describe('argv → shell command line', () => {
  /*
   * Found by RUNNING it, not by reading it: the naive `[command, ...args].join(' ')` sent
   * `node -e console.log("x", 6*7)` to bash and got `syntax error near unexpected token '('`.
   * MEASURED against a real sandbox — and the SDK's array form fails too (exit 2), so quoting on
   * our side is the only correct option.
   */
  it('quotes every token so the shell cannot re-split an argument', () => {
    expect(toShellCommand('node', ['-e', 'console.log("x", 6*7)'])).toBe(`'node' '-e' 'console.log("x", 6*7)'`);
  });

  it('survives a path containing spaces', () => {
    expect(toShellCommand('npm', ['run', 'my script'])).toBe(`'npm' 'run' 'my script'`);
  });

  it('🔴 neutralises shell metacharacters instead of executing them', () => {
    /*
     * The serious half. Arguments here come from file paths and action-runner input, so an unquoted
     * join means `; rm -rf /` runs as a SEPARATE command — the injection shape the §4.2.5 shell
     * allow-list exists to prevent, arriving through a different door.
     */
    for (const nasty of ['; rm -rf /', '&& curl evil.sh', '`whoami`', '$(id)', '| tee /etc/passwd']) {
      const line = toShellCommand('echo', [nasty]);

      expect(line).toBe(`'echo' '${nasty}'`);
      expect(line.startsWith(`'echo' '`)).toBe(true);
    }
  });

  it('escapes an embedded single quote by closing and reopening', () => {
    /*
     * The one character single-quoting cannot contain, so it is closed, escaped, reopened:
     * `it's` becomes `'it'\''s'`, which bash reads back as the three pieces `it` + `'` + `s`.
     * Getting this wrong ends the quoted region early and hands the rest of the string to the shell.
     */
    expect(toShellCommand('echo', ["it's"])).toBe(`'echo' 'it'\\''s'`);
  });

  it('handles a bare command with no arguments', () => {
    expect(toShellCommand('npm')).toBe(`'npm'`);
  });
});

describe('the clear-port kill script', () => {
  /*
   * A resumed/forked VM wakes with the previous session's dev server still bound to 5173, and a
   * fresh `npm run dev` dies with "Port 5173 is already in use" (MEASURED live, 2026-07-27). The
   * script kills BY PORT first (exact), falls back to pkill-by-name, and always exits 0 — clearing
   * is best-effort by contract.
   */
  it('kills by port with fuser, with a pkill fallback for images without psmisc', () => {
    const script = clearPortScript(5173);

    expect(script).toContain('fuser -k -TERM 5173/tcp');
    expect(script).toContain('fuser -k -KILL 5173/tcp');
    expect(script).toContain('pkill -f vite');
    expect(script.trim().endsWith('exit 0')).toBe(true);
  });

  it('exits FAST when nothing is listening — a fresh VM must not pay the wait loop', () => {
    // `fuser -k` exits non-zero when no process holds the port; the `|| exit 0` is the fast path.
    expect(clearPortScript(5173)).toContain('fuser -k -TERM 5173/tcp 2>/dev/null || exit 0');
  });

  it('refuses a port it cannot safely interpolate into shell text', () => {
    for (const bad of [0, -1, 1.5, Number.NaN, 70000]) {
      expect(() => clearPortScript(bad)).toThrow(/real TCP port/);
    }
  });
});

describe('the adapter translates the right calls', () => {
  function createClientDouble() {
    const fs = {
      readFile: vi.fn(async () => new Uint8Array([1])),
      readTextFile: vi.fn(async () => 'text'),
      writeFile: vi.fn(async () => {}),
      writeTextFile: vi.fn(async () => {}),
      batchWrite: vi.fn(async () => {}),
      readdir: vi.fn(async () => [
        { name: 'src', type: 'directory' as const, isSymlink: false },
        { name: 'a.ts', type: 'file' as const, isSymlink: false },
      ]),
      mkdir: vi.fn(async () => {}),
      remove: vi.fn(async () => {}),
      watch: vi.fn(async () => ({ dispose: vi.fn(), onEvent: vi.fn() })),
    };

    const onDidPortOpen = vi.fn(() => ({ dispose: vi.fn() }));
    const onDidPortClose = vi.fn(() => ({ dispose: vi.fn() }));

    /*
     * Empty by default: most tests care about the TRANSITION events. The already-open replay has its
     * own test below, because a reload over a running dev server was invisible without it.
     */
    const getAll = vi.fn(async () => [] as Array<{ port: number; host: string }>);

    const client = {
      workspacePath: WD,
      fs,
      ports: { onDidPortOpen, onDidPortClose, getAll },
      commands: { runBackground: vi.fn() },
      terminals: { create: vi.fn() },
    };

    return { client, fs, onDidPortOpen, onDidPortClose, getAll };
  }

  const providerOver = (d: ReturnType<typeof createClientDouble>) => createCodeSandboxProvider(d.client as never);

  it('reads bytes with no encoding and text with one', async () => {
    // The overload pair IS the binary contract; collapsing it returns a mojibake string for a .wasm.
    const d = createClientDouble();
    const provider = providerOver(d);

    await provider.fs.readFile('public/havok.wasm');
    expect(d.fs.readFile).toHaveBeenCalledWith('/project/workspace/public/havok.wasm');

    await provider.fs.readFile('src/a.ts', 'utf-8');
    expect(d.fs.readTextFile).toHaveBeenCalledWith('/project/workspace/src/a.ts');
  });

  it('sends bytes through writeFile and strings through writeTextFile', async () => {
    const d = createClientDouble();
    const bytes = new Uint8Array([0x89, 0x50]);

    await providerOver(d).fs.writeFile('logo.png', bytes);
    expect(d.fs.writeFile).toHaveBeenCalledWith('/project/workspace/logo.png', bytes);

    await providerOver(d).fs.writeFile('a.ts', 'hello');
    expect(d.fs.writeTextFile).toHaveBeenCalledWith('/project/workspace/a.ts', 'hello');
  });

  it('returns dirents with working type predicates when asked', async () => {
    const entries = await providerOver(createClientDouble()).fs.readdir('.', { withFileTypes: true });

    expect(entries.map((e) => [e.name, e.isDirectory(), e.isFile()])).toEqual([
      ['src', true, false],
      ['a.ts', false, true],
    ]);
  });

  it('returns bare names when withFileTypes is not requested', async () => {
    expect(await providerOver(createClientDouble()).fs.readdir('.')).toEqual(['src', 'a.ts']);
  });

  it('mounts through batchWrite with RELATIVE paths', async () => {
    /*
     * MEASURED: absolute paths here fail with "Unzip command failed with exit code 1". Every other
     * fs method above takes an absolute path, which is exactly what makes this easy to get wrong.
     */
    const d = createClientDouble();

    await providerOver(d).mount({
      'package.json': { file: { contents: '{}' } },
      src: { directory: { 'main.ts': { file: { contents: 'x' } } } },
    });

    expect(d.fs.batchWrite).toHaveBeenCalledWith([
      { path: 'package.json', content: '{}' },
      { path: 'src/main.ts', content: 'x' },
    ]);
  });

  it('does not call batchWrite at all for a tree with no files', async () => {
    const d = createClientDouble();
    await providerOver(d).mount({ empty: { directory: {} } });

    expect(d.fs.batchWrite).not.toHaveBeenCalled();
  });

  /*
   * The v2 OSC rc block (MEASURED kill, 2026-07-27): without the PS0 begin marker, bash's
   * attach-time exit/prompt markers satisfied the NEXT command's wait — `npm install` "completed"
   * instantly with a stale 0 and was then killed by `npm run dev`'s leading interrupt. These pins
   * hold the three parts together: the rc emits `begin`, the shell DECLARES `begin`, and an old
   * VM carrying only the v1 block still gets the upgrade appended.
   */
  describe('the OSC bashrc hook (v2)', () => {
    function terminalDouble() {
      return {
        onOutput: vi.fn(),
        open: vi.fn(async () => ''),
        run: vi.fn(async () => {}),
        write: vi.fn(async () => {}),
        kill: vi.fn(),
      };
    }

    async function spawnShell(d: ReturnType<typeof createClientDouble>) {
      d.client.terminals.create.mockResolvedValue(terminalDouble() as never);
      await providerOver(d).spawn('bash', [], { terminal: { cols: 80, rows: 24 } });
    }

    it('installs a block whose PS0 emits the begin marker the shell declares', async () => {
      const d = createClientDouble();
      d.fs.readTextFile.mockRejectedValue(new Error('ENOENT'));

      await spawnShell(d);

      const [path, written] = d.fs.writeTextFile.mock.calls[0] as unknown as [string, string];
      expect(path).toBe('/root/.bashrc');
      expect(written).toContain('PROMPT_COMMAND=__bolt_osc');

      // The marker the rc EMITS must be the marker the shell DECLARES — one fact, two readers.
      const beginOsc = providerOver(d).shell.beginOsc!;
      expect(written).toContain(`]654;${beginOsc}\\a`);

      // vite's --open spawns xdg-open in a headless VM without one; BROWSER=true silences it.
      expect(written).toContain('export BROWSER=true');
    });

    it('UPGRADES a bashrc that carries only the v1 block — the VMs that need the fix most', async () => {
      const d = createClientDouble();
      const v1 = '# --- OSC v1 ---\n__bolt_osc() { :; }\nPROMPT_COMMAND=__bolt_osc\n# --- end ---\n';
      d.fs.readTextFile.mockResolvedValue(v1);

      await spawnShell(d);

      const [, written] = d.fs.writeTextFile.mock.calls[0] as unknown as [string, string];
      expect(written.startsWith(v1)).toBe(true); // append, never clobber the image's own setup
      expect(written).toContain("PS0='\\e]654;begin\\a'");
    });

    it('does not grow a bashrc that already carries the v2 block', async () => {
      const d = createClientDouble();
      d.fs.readTextFile.mockResolvedValue("stuff\nPS0='\\e]654;begin\\a'\nmore");

      await spawnShell(d);

      expect(d.fs.writeTextFile).not.toHaveBeenCalled();
    });

    it('declares beginOsc, and it is the marker the rc emits', () => {
      const provider = providerOver(createClientDouble());

      expect(provider.shell.beginOsc).toBe('begin');
    });
  });

  it('clearPort runs the kill script in the sandbox and waits for it to finish', async () => {
    const d = createClientDouble();
    const command = { onOutput: vi.fn(), waitUntilComplete: vi.fn(async () => {}), kill: vi.fn() };
    d.client.commands.runBackground.mockResolvedValue(command as never);

    await providerOver(d).clearPort!(5173);

    const [line, opts] = d.client.commands.runBackground.mock.calls[0] as [string, { cwd: string }];
    expect(line).toContain('fuser -k -TERM 5173/tcp');
    expect(opts.cwd).toBe(WD);
    expect(command.waitUntilComplete).toHaveBeenCalled();
  });

  it('clearPort is BOUNDED — a wire that never answers cannot hang project creation', async () => {
    /*
     * The script self-bounds at ~6s; this covers the transport hanging UNDER it. Without the
     * deadline, creation awaits this forever and the New Project button never returns — strictly
     * worse than the port collision it was clearing.
     */
    vi.useFakeTimers();

    try {
      const d = createClientDouble();
      const command = { onOutput: vi.fn(), waitUntilComplete: vi.fn(() => new Promise(() => {})), kill: vi.fn() };
      d.client.commands.runBackground.mockResolvedValue(command as never);

      const done = providerOver(d).clearPort!(5173);
      await vi.advanceTimersByTimeAsync(10_000);

      await expect(done).resolves.toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });

  it('maps onServerReady and onPort to DISTINCT port events', () => {
    /*
     * Mutation check, mirroring the WebContainer adapter's: crossing these produces a preview that
     * never appears, or one that appears and never closes, and throws nothing.
     */
    const d = createClientDouble();
    const provider = providerOver(d);

    provider.onServerReady(() => {});
    expect(d.onDidPortOpen).toHaveBeenCalledTimes(1);
    expect(d.onDidPortClose).not.toHaveBeenCalled();

    provider.onPort(() => {});
    expect(d.onDidPortOpen).toHaveBeenCalledTimes(2);
    expect(d.onDidPortClose).toHaveBeenCalledTimes(1);
  });

  it('builds an https preview URL from the port host', async () => {
    const d = createClientDouble();
    const seen: Array<[number, string]> = [];

    d.onDidPortOpen.mockImplementation(((cb: (p: { port: number; host: string }) => void) => {
      cb({ port: 3000, host: 'abc123-3000.csb.app' });
      return { dispose: vi.fn() };
    }) as never);

    providerOver(d).onServerReady((port, url) => seen.push([port, url]));
    await vi.waitFor(() => expect(seen.length).toBe(1));

    expect(seen).toEqual([[3000, 'https://abc123-3000.csb.app']]);
  });

  it('routes the preview URL through the injected minter — a private sandbox 401s without it', async () => {
    const d = createClientDouble();
    const seen: Array<[number, string]> = [];

    d.onDidPortOpen.mockImplementation(((cb: (p: { port: number; host: string }) => void) => {
      cb({ port: 5173, host: 'abc123-5173.csb.app' });
      return { dispose: vi.fn() };
    }) as never);

    createCodeSandboxProvider(d.client as never, {
      previewUrl: async (port, host) => `https://${host}?preview_token=tok-${port}`,
    }).onServerReady((port, url) => seen.push([port, url]));

    await vi.waitFor(() => expect(seen.length).toBe(1));
    expect(seen).toEqual([[5173, 'https://abc123-5173.csb.app?preview_token=tok-5173']]);
  });

  it('falls back to the bare host URL when minting fails, rather than dropping the event', async () => {
    const d = createClientDouble();
    const seen: Array<[number, string]> = [];

    d.onDidPortOpen.mockImplementation(((cb: (p: { port: number; host: string }) => void) => {
      cb({ port: 5173, host: 'abc123-5173.csb.app' });
      return { dispose: vi.fn() };
    }) as never);

    createCodeSandboxProvider(d.client as never, {
      previewUrl: async () => {
        throw new Error('mint failed');
      },
    }).onServerReady((port, url) => seen.push([port, url]));

    await vi.waitFor(() => expect(seen.length).toBe(1));
    expect(seen).toEqual([[5173, 'https://abc123-5173.csb.app']]);
  });

  it('replays ports that were ALREADY open when the listener registered', async () => {
    /*
     * 🔴 `onDidPortOpen` only reports transitions. A reload while the dev server is still running
     * registers the listener AFTER the only open event it will ever get — without the replay the
     * workbench says "No preview available" over a healthy server, silently and forever.
     */
    const d = createClientDouble();
    const seen: Array<[number, string]> = [];

    d.getAll.mockResolvedValue([{ port: 5173, host: 'abc123-5173.csb.app' }]);

    providerOver(d).onServerReady((port, url) => seen.push([port, url]));

    await vi.waitFor(() => expect(seen.length).toBe(1));
    expect(seen).toEqual([[5173, 'https://abc123-5173.csb.app']]);
  });

  it('sweeps the port list a SECOND time — right after connect it answers empty (measured live)', async () => {
    /*
     * 🔴 MEASURED: immediately after `connectToSandbox` resolves, `getAll()` returns `[]` while the
     * VM has a dev server listening — the SDK syncs port state asynchronously. `PreviewsStore`
     * registers in exactly that window, so a single sweep silently missed the running server.
     */
    vi.useFakeTimers();

    try {
      const d = createClientDouble();
      const seen: Array<[number, string]> = [];

      d.getAll
        .mockResolvedValueOnce([]) // the registration-time answer, before the state sync
        .mockResolvedValue([{ port: 5173, host: 'abc123-5173.csb.app' }]);

      providerOver(d).onServerReady((port, url) => seen.push([port, url]));

      await vi.advanceTimersByTimeAsync(4_000);

      expect(seen).toEqual([[5173, 'https://abc123-5173.csb.app']]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('replays already-open ports into onPort too — that is the listener that fills the preview list', async () => {
    /*
     * 🔴 `PreviewsStore.onPort` is what pushes entries into `previews`; `onServerReady` only
     * broadcasts. A replay wired into one and not the other left the preview pane empty after a
     * reload over a running dev server (MEASURED live) — this is the regression test for that.
     */
    const d = createClientDouble();
    const seen: Array<[number, string, string]> = [];

    d.getAll.mockResolvedValue([{ port: 5173, host: 'abc123-5173.csb.app' }]);

    providerOver(d).onPort((port, type, url) => seen.push([port, type, url]));

    await vi.waitFor(() => expect(seen.length).toBe(1));
    expect(seen).toEqual([[5173, 'open', 'https://abc123-5173.csb.app']]);
  });

  it('announces a port only once across both sweeps', async () => {
    vi.useFakeTimers();

    try {
      const d = createClientDouble();
      const seen: Array<[number, string]> = [];

      d.getAll.mockResolvedValue([{ port: 5173, host: 'abc123-5173.csb.app' }]);

      providerOver(d).onServerReady((port, url) => seen.push([port, url]));

      await vi.advanceTimersByTimeAsync(4_000);

      expect(seen).toEqual([[5173, 'https://abc123-5173.csb.app']]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('swallows rm failures only when force is set', async () => {
    const d = createClientDouble();
    d.fs.remove.mockRejectedValue(new Error('ENOENT'));

    await expect(providerOver(d).fs.rm('gone.ts', { force: true })).resolves.toBeUndefined();
    await expect(providerOver(d).fs.rm('gone.ts')).rejects.toThrow('ENOENT');
  });

  it('reads workdir live rather than snapshotting it', () => {
    const d = createClientDouble();
    const provider = providerOver(d);

    d.client.workspacePath = '/somewhere/else';

    expect(provider.workdir).toBe('/somewhere/else');
  });

  it('teardown calls the server-side reaper, and never silently no-ops it away', () => {
    // A provider that swallowed teardown would leak a billing VM per builder session.
    const onTeardown = vi.fn();
    const d = createClientDouble();

    createCodeSandboxProvider(d.client as never, { onTeardown }).teardown();

    expect(onTeardown).toHaveBeenCalledTimes(1);
  });

  it('declares textSearch absent rather than shimming it with grep — and clearPort PRESENT', () => {
    const provider = providerOver(createClientDouble());

    /*
     * `clearPort: true` because this provider is the one that NEEDS it: a resumed/forked VM wakes
     * with the previous session's dev server still bound to its port.
     */
    expect(CODESANDBOX_CAPABILITIES).toEqual({ terminal: true, textSearch: false, watch: true, clearPort: true });
    expect(provider.textSearch).toBeUndefined();
    expect(typeof provider.clearPort).toBe('function');
  });

  it('cancels a watcher that is unsubscribed before it finishes being created', async () => {
    /*
     * The seam returns an unsubscribe SYNCHRONOUSLY while `fs.watch` is a promise. Without the
     * latch, a caller that unmounts immediately leaves a live watcher pushing events into a dead
     * component — invisible until it is a leak.
     */
    const d = createClientDouble();
    const dispose = vi.fn();
    let resolveWatch: (w: unknown) => void = () => {};

    d.fs.watch.mockImplementation((() => new Promise((r) => (resolveWatch = r))) as never);

    const unsubscribe = providerOver(d).watchPaths({ includeContent: true }, () => {});
    unsubscribe();

    resolveWatch({ dispose, onEvent: vi.fn() });
    await new Promise((r) => setTimeout(r, 0));

    expect(dispose).toHaveBeenCalledTimes(1);
  });
});
