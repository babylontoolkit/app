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
  isDirectoryPathError,
  isMissingPathError,
  needsContent,
  normalizeWatchEventPaths,
  resolveInWorkdir,
  SandboxPathError,
  toShellCommand,
  toWorkspaceRelative,
  translateWatchEvent,
} from './codesandbox-translate';
import type { CodeSandboxWatchEvent } from './codesandbox-translate';
import { CODESANDBOX_CAPABILITIES, createCodeSandboxProvider } from './codesandbox-provider';
import type { SandboxWatchEvent } from './types';
import { MAP_EXCLUDE_GLOBS } from '~/lib/stores/files';
import { BoltShell } from '~/utils/shell';

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

  it('🔴 returns an ALREADY-workdir-absolute path unchanged — the case the leading-slash test misses', () => {
    /*
     * `/src/main.ts` and `/project/workspace/dist` both "already have a slash", but only the second
     * one carries the workdir, and blindly prefixing it produced
     * `/project/workspace/project/workspace/dist`. Real callers hand this form in:
     * `action-runner`'s build-directory probe joins `sandbox.workdir` itself before calling
     * `fs.readdir`, so every candidate threw and the probe became DEAD CODE on this provider —
     * inside its own `try`, so it read as "that directory does not exist". Publish then worked only
     * because `useShareGame`'s fallback list happens to contain `dist`, and a project with a custom
     * `outDir` published nothing at all. Nothing errored, anywhere.
     */
    expect(resolveInWorkdir(WD, '/project/workspace/dist')).toBe('/project/workspace/dist');
    expect(resolveInWorkdir(WD, '/project/workspace/src/main.ts')).toBe('/project/workspace/src/main.ts');
  });

  it('rebases a path carrying a DIFFERENT provider root, rather than nesting it', () => {
    /*
     * `SANDBOX_ROOTS` is a list precisely because a file map outlives the provider that produced it
     * (a WebContainer-era working copy restored into a CodeSandbox project). Going through
     * `toProjectRelativePath` — the one definition of "strip the sandbox root" — is what keeps those
     * keys from landing under `/project/workspace/home/project/…`.
     */
    expect(resolveInWorkdir(WD, '/home/project/dist')).toBe('/project/workspace/dist');
  });

  it('treats the workdir itself as the workdir, not as a two-deep directory name', () => {
    /*
     * The `(\/|$)` in `toProjectRelativePath` is load-bearing; without it this becomes
     * `/project/workspace/project/workspace`, a path that looks like an ordinary directory.
     */
    expect(resolveInWorkdir(WD, WD)).toBe(WD);
  });

  it('still REFUSES traversal that arrives dressed as a workdir-absolute path', () => {
    // Rebasing must not become an escape hatch around the traversal wall.
    expect(() => resolveInWorkdir(WD, '/project/workspace/../../etc/passwd')).toThrow(SandboxPathError);
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

describe('watch event path normalization', () => {
  /*
   * The watch leg is the one path story with no normalization until now. The SDK is OBSERVED to emit
   * absolute paths, but nothing enforced it: a workspace-relative path would make the enrichment read
   * fail (classifying every added file as a DIRECTORY, so its content is silently dropped) and would
   * key `FilesStore` under a second, relative key for a file it already holds. Two entries, no error,
   * and a working copy that serializes both.
   */
  it('puts a workspace-relative path into workdir-absolute form', () => {
    expect(normalizeWatchEventPaths(WD, { type: 'change', paths: ['src/main.ts'] })).toEqual({
      type: 'change',
      paths: ['/project/workspace/src/main.ts'],
    });
  });

  it('leaves an already-absolute path exactly as it is — no doubling', () => {
    expect(normalizeWatchEventPaths(WD, { type: 'add', paths: ['/project/workspace/src/main.ts'] }).paths).toEqual([
      '/project/workspace/src/main.ts',
    ]);
  });

  it('preserves the event type and normalizes every path in a multi-path event', () => {
    expect(normalizeWatchEventPaths(WD, { type: 'remove', paths: ['a.ts', '/project/workspace/b.ts'] })).toEqual({
      type: 'remove',
      paths: ['/project/workspace/a.ts', '/project/workspace/b.ts'],
    });
  });

  it('passes an unnormalizable path THROUGH rather than dropping the event', () => {
    /*
     * A traversal is meaningless in an observation, and this leg only observes — it never opens a
     * write. Dropping the path would lose the event silently, which is the worse of the two failures:
     * a file the user can see on disk that the tree never shows.
     */
    expect(normalizeWatchEventPaths(WD, { type: 'change', paths: ['../escape.ts'] }).paths).toEqual(['../escape.ts']);
  });
});

describe('classifying "that path is not there"', () => {
  /*
   * `fs.rm({ force: true })` means "absent is fine" and NOTHING else. It shipped swallowing every
   * error, so a permission problem or a dropped connection resolved as a successful delete: the map
   * loses the entry, the disk keeps the file, and the divergence resurfaces later as an export or a
   * push containing a file the user deleted.
   */
  it('recognises the typed shapes first — including the Rust io error CodeSandbox surfaces', () => {
    expect(isMissingPathError({ code: 'ENOENT' })).toBe(true);
    expect(isMissingPathError({ code: 2 })).toBe(true);
    expect(isMissingPathError({ kind: 'NotFound' })).toBe(true);
  });

  it('falls back to the message, because CodeSandbox stringifies its io errors', () => {
    // MEASURED shape: `Os { code: 2, kind: NotFound, message: "No such file or directory" }`.
    expect(isMissingPathError(new Error('Os { code: 2, kind: NotFound, message: "No such file or directory" }'))).toBe(
      true,
    );
    expect(isMissingPathError(new Error('ENOENT: no such file or directory'))).toBe(true);
  });

  it('🔴 does NOT classify a permission or connection failure as absence', () => {
    // The whole point: these must reach the caller, not resolve as a delete that never happened.
    expect(isMissingPathError(new Error('EACCES: permission denied'))).toBe(false);
    expect(isMissingPathError(new Error('socket hang up'))).toBe(false);
    expect(isMissingPathError({ code: 'EPERM' })).toBe(false);
    expect(isMissingPathError({ code: 13 })).toBe(false);
  });

  it('🔴 a MISSING SANDBOX is not a missing path — the phrase list names paths only', () => {
    /*
     * `null: Sandbox not found` is what the SDK throws when the VM itself is gone (an HTTP 404
     * through its REST-backed client, where `errno` is null). A `not found` substring match swallows
     * it under `force: true`, which is the "dead connection reported as a successful delete" this
     * function exists to refuse — the widest error in the family classified as the narrowest.
     */
    expect(isMissingPathError(new Error('null: Sandbox not found'))).toBe(false);
    expect(isMissingPathError(new Error('Session not found'))).toBe(false);
    expect(isMissingPathError(new Error('bash: npm: command not found'))).toBe(false);

    // The errno prefix must not match a DIFFERENT errno that merely begins with the digit 2.
    expect(isMissingPathError(new Error('21: Os { code: 21, kind: IsADirectory }'))).toBe(false);
    expect(isMissingPathError(new Error('28: Os { code: 28, kind: StorageFull }'))).toBe(false);
  });

  it('survives non-error rejections without throwing', () => {
    expect(isMissingPathError(undefined)).toBe(false);
    expect(isMissingPathError(null)).toBe(false);
    expect(isMissingPathError('NotFound')).toBe(true);
  });
});

describe('classifying "that path is a directory" (T17a)', () => {
  /*
   * The sibling classification: a restore wrote a FILE entry over a path that is now a directory on
   * disk, and the SDK's raw `21: Os { … IsADirectory }` killed the whole primary open path, silently
   * degrading it to the legacy IndexedDB mount. `restoreFiles` uses this to name the skip loudly.
   */
  it('recognises the MEASURED live wire string', () => {
    // Exactly what the SDK threw during the T17a repro, verbatim.
    expect(isDirectoryPathError(new Error('21: Os { code: 21, kind: IsADirectory, message: "Is a directory" }'))).toBe(
      true,
    );
  });

  it('recognises the typed node-fs shapes as defense for wrappers', () => {
    expect(isDirectoryPathError({ code: 'EISDIR' })).toBe(true);
    expect(isDirectoryPathError({ code: 21 })).toBe(true);
    expect(isDirectoryPathError({ kind: 'IsADirectory' })).toBe(true);
    expect(isDirectoryPathError(new Error('EISDIR: illegal operation on a directory, read'))).toBe(true);
  });

  it('🔴 does NOT classify absence, permission, or a dead sandbox as "is a directory"', () => {
    // ENOENT in both its spellings — the OTHER classified answer, never this one.
    expect(
      isDirectoryPathError(new Error('2: Os { code: 2, kind: NotFound, message: "No such file or directory" }')),
    ).toBe(false);
    expect(isDirectoryPathError({ code: 'ENOENT' })).toBe(false);
    expect(isDirectoryPathError(new Error('ENOENT: no such file or directory'))).toBe(false);

    expect(isDirectoryPathError(new Error('EACCES: permission denied'))).toBe(false);
    expect(isDirectoryPathError(new Error('null: Sandbox not found'))).toBe(false);
    expect(isDirectoryPathError(new Error('socket hang up'))).toBe(false);

    // The errno prefix is exact — errno 2 must not match, nor an errno merely starting with 2.
    expect(isDirectoryPathError(new Error('28: Os { code: 28, kind: StorageFull }'))).toBe(false);
  });

  it('survives non-error rejections without throwing', () => {
    expect(isDirectoryPathError(undefined)).toBe(false);
    expect(isDirectoryPathError(null)).toBe(false);
    expect(isDirectoryPathError('IsADirectory')).toBe(true);
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

      /*
       * `run` answers the `$HOME` probe. It is on the DEFAULT double because an unresolved home now
       * declines to claim `beginOsc` (a write into a guessed home "succeeds" against a file bash may
       * never read), so a double without it exercises the DEGRADED path — which is a different test
       * from the armed one. The fallback pins delete it deliberately.
       */
      commands: { runBackground: vi.fn(), run: vi.fn(async () => '/root') },
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

    /*
     * The provider instance is passed in rather than minted inside: `beginOsc` is per-provider state
     * (a claim about THIS shell's rc file), so reading it off a second provider over the same client
     * answers a different question than the one the test is asking.
     */
    async function spawnShell(d: ReturnType<typeof createClientDouble>, provider = providerOver(d)) {
      d.client.terminals.create.mockResolvedValue(terminalDouble() as never);
      await provider.spawn('bash', [], { terminal: { cols: 80, rows: 24 } });

      return provider;
    }

    it('installs a block whose PS0 emits the begin marker the shell declares', async () => {
      const d = createClientDouble();
      d.fs.readTextFile.mockRejectedValue(new Error('ENOENT'));

      const provider = providerOver(d);

      // The declaration is a promise about a file on disk, so it cannot precede the write.
      expect(provider.shell.beginOsc).toBeUndefined();

      await spawnShell(d, provider);

      const [path, written] = d.fs.writeTextFile.mock.calls[0] as unknown as [string, string];
      expect(path).toBe('/root/.bashrc');
      expect(written).toContain('PROMPT_COMMAND=__bolt_osc');

      // The marker the rc EMITS must be the marker the shell DECLARES — one fact, two readers.
      const beginOsc = provider.shell.beginOsc!;
      expect(beginOsc).toBe('begin');
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

    it('declares beginOsc only once an install has SUCCEEDED — never before', async () => {
      /*
       * 🔴 Declaring a marker bash will never emit makes every `waitTillOscCode` wait forever: one
       * logged warning turning into "every shell action hangs", silently and permanently. So the
       * declaration follows the disk, and the rc install is the only thing that can turn it on.
       */
      const d = createClientDouble();
      d.fs.readTextFile.mockRejectedValue(new Error('ENOENT'));

      const provider = providerOver(d);
      expect(provider.shell.beginOsc).toBeUndefined();

      await spawnShell(d, provider);
      expect(provider.shell.beginOsc).toBe('begin');
    });

    it('declares beginOsc on a VM whose bashrc ALREADY carries the block (no write needed)', async () => {
      const d = createClientDouble();
      d.fs.readTextFile.mockResolvedValue("stuff\nPS0='\\e]654;begin\\a'\nmore");

      const provider = await spawnShell(d);

      expect(d.fs.writeTextFile).not.toHaveBeenCalled();
      expect(provider.shell.beginOsc).toBe('begin');
    });

    it('a FAILED rc install yields a shell WITHOUT beginOsc — degrade, never hang', async () => {
      const d = createClientDouble();
      d.fs.readTextFile.mockRejectedValue(new Error('ENOENT'));
      d.fs.writeTextFile.mockRejectedValue(new Error('EROFS: read-only file system'));

      const provider = await spawnShell(d);

      // The terminal still opened — a failed hook costs the protocol, never the shell.
      expect(d.client.terminals.create).toHaveBeenCalled();
      expect(provider.shell.beginOsc).toBeUndefined();
    });

    it('one success is enough — a later transient failure must not un-arm an installed hook', async () => {
      const d = createClientDouble();
      d.fs.readTextFile.mockRejectedValue(new Error('ENOENT'));

      const provider = await spawnShell(d);
      expect(provider.shell.beginOsc).toBe('begin');

      d.fs.writeTextFile.mockRejectedValue(new Error('transient'));
      await spawnShell(d, provider);

      expect(provider.shell.beginOsc).toBe('begin');
    });
  });

  /**
   * The rc path follows `$HOME`.
   *
   * Hardcoding `/root/.bashrc` is right for today's image and silently wrong for any image whose
   * terminal user is not root: the append lands in a file bash never reads, so the hook is never
   * installed. Every failure mode falls back to `/root` — asking where HOME is must never be the
   * thing that stops a terminal from opening.
   */
  describe('shellHomeDir — the rc path follows $HOME', () => {
    function terminalDouble() {
      return {
        onOutput: vi.fn(),
        open: vi.fn(async () => ''),
        run: vi.fn(async () => {}),
        write: vi.fn(async () => {}),
        kill: vi.fn(),
      };
    }

    async function spawnOver(d: ReturnType<typeof createClientDouble>, provider = providerOver(d)) {
      d.client.terminals.create.mockResolvedValue(terminalDouble() as never);
      d.fs.readTextFile.mockRejectedValue(new Error('ENOENT'));
      await provider.spawn('bash', [], { terminal: { cols: 80, rows: 24 } });

      return provider;
    }

    const rcPath = (d: ReturnType<typeof createClientDouble>) =>
      (d.fs.writeTextFile.mock.calls[0] as unknown as [string, string])[0];

    it('writes to $HOME/.bashrc on a non-root image', async () => {
      const d = createClientDouble();
      (d.client.commands as any).run = vi.fn(async () => '/home/user\n');

      await spawnOver(d);

      expect(rcPath(d)).toBe('/home/user/.bashrc');
    });

    it('asks ONCE per client, however many terminals open', async () => {
      const d = createClientDouble();
      const run = vi.fn(async () => '/home/user');
      (d.client.commands as any).run = run;

      const provider = await spawnOver(d);
      d.fs.writeTextFile.mockClear();
      await spawnOver(d, provider);

      // Second spawn re-checks the (idempotent) rc, but must not re-ask where HOME is.
      expect(run).toHaveBeenCalledTimes(1);
    });

    /**
     * 🔴 An UNRESOLVED home still installs — and still declines to claim `beginOsc`.
     *
     * `/root` is a guess, not an answer. On an image whose shell user is not root the append
     * "succeeds" into a file bash never reads, so declaring the marker off that success is the
     * promise-a-marker hang wearing a successful write. Install anyway (harmless, possibly right),
     * claim nothing.
     */
    it('falls back to /root when the command REJECTS — installs, but declares no beginOsc', async () => {
      const d = createClientDouble();
      (d.client.commands as any).run = vi.fn(async () => {
        throw new Error('command failed');
      });

      const provider = await spawnOver(d);

      expect(rcPath(d)).toBe('/root/.bashrc');
      expect(provider.shell.beginOsc).toBeUndefined();
    });

    it('falls back to /root on an EMPTY answer — installs, but declares no beginOsc', async () => {
      const d = createClientDouble();
      (d.client.commands as any).run = vi.fn(async () => '  \n');

      const provider = await spawnOver(d);

      expect(rcPath(d)).toBe('/root/.bashrc');
      expect(provider.shell.beginOsc).toBeUndefined();
    });

    it('falls back to /root when the client has no `commands.run` at all — a SYNCHRONOUS throw', async () => {
      // An SDK version (or a double) without the method throws a TypeError that `.catch()` cannot see.
      const d = createClientDouble();
      delete (d.client.commands as any).run;

      const provider = await spawnOver(d);

      // Asking where HOME is must never be the thing that stops a terminal from opening.
      expect(rcPath(d)).toBe('/root/.bashrc');
      expect(d.client.terminals.create).toHaveBeenCalled();
      expect(provider.shell.beginOsc).toBeUndefined();
    });

    it('a RESOLVED home is what earns the claim — same write, different answer', async () => {
      // The control for the three above: only the resolution differs, and only it flips the claim.
      const d = createClientDouble();
      (d.client.commands as any).run = vi.fn(async () => '/home/user');

      const provider = await spawnOver(d);

      expect(rcPath(d)).toBe('/home/user/.bashrc');
      expect(provider.shell.beginOsc).toBe('begin');
    });
  });

  /**
   * The degraded shell must still WORK. A provider whose rc install failed declares no `beginOsc`,
   * which is the pre-hook (jsh) semantics — stale markers are possible again, and a command that
   * finishes is still seen to finish. The failure this pins against is the other one: a shell that
   * waits forever for a `begin` marker bash was never taught to emit.
   */
  describe('a shell over a provider whose rc install failed still completes commands', () => {
    /** A PTY double that answers like bash: Ctrl-C draws a prompt, a command line reports an exit. */
    function bashPtyDouble({ emitsBegin }: { emitsBegin: boolean }) {
      let emit: (chunk: string) => void = () => {};

      const terminal = {
        onOutput: vi.fn((cb: (chunk: string) => void) => {
          emit = cb;
        }),

        // The attach-time prompt draw, which is exactly the stale pair the arming rules exist for.
        open: vi.fn(async () => '\x1b]654;exit=0:0\x07\x1b]654;prompt\x07root@sbx:/project/workspace# '),
        run: vi.fn(async () => {}),
        write: vi.fn(async (chunk: string) => {
          if (chunk === '\x03') {
            emit('^C\r\n\x1b]654;exit=0:130\x07\x1b]654;prompt\x07');
            return;
          }

          if (chunk.endsWith('\n')) {
            emit(`${emitsBegin ? '\x1b]654;begin\x07' : ''}hi\r\n\x1b]654;exit=0:3\x07\x1b]654;prompt\x07`);
          }
        }),
        kill: vi.fn(),
      };

      return terminal;
    }

    function itermDouble() {
      let onData: (data: string) => void = () => {};

      return {
        cols: 80,
        rows: 24,
        onData: (cb: (data: string) => void) => {
          onData = cb;
        },
        input: (data: string) => onData(data),
        write: vi.fn(),
      };
    }

    /** Bounded, so a regression FAILS the suite instead of hanging it. */
    function bounded<T>(promise: Promise<T>, label: string): Promise<T> {
      let timer: ReturnType<typeof setTimeout>;

      return Promise.race([
        promise,
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error(`${label} never completed — the shell hung`)), 1000);
        }),
      ]).finally(() => clearTimeout(timer)) as Promise<T>;
    }

    /**
     * A sandbox whose `.bashrc` state can CHANGE between terminals.
     *
     * A PTY emits `begin` only if the hook was on disk when THAT shell started — `.bashrc` is read at
     * shell startup — which is the whole reason the claim has to be frozen. Each `terminals.create`
     * therefore mints its own double and captures the flag as it stands at that moment.
     */
    function sandboxDouble({ hookInstalls }: { hookInstalls: boolean }) {
      const d = createClientDouble();
      d.fs.readTextFile.mockRejectedValue(new Error('ENOENT'));

      let onDisk = false;

      const setInstallable = (ok: boolean) => {
        if (ok) {
          d.fs.writeTextFile.mockImplementation(async () => {
            onDisk = true;
          });
        } else {
          d.fs.writeTextFile.mockRejectedValue(new Error('EROFS'));
        }
      };

      setInstallable(hookInstalls);

      const ptys: ReturnType<typeof bashPtyDouble>[] = [];
      d.client.terminals.create.mockImplementation(async () => {
        const pty = bashPtyDouble({ emitsBegin: onDisk });
        ptys.push(pty);

        return pty as never;
      });

      return { d, ptys, setInstallable, provider: providerOver(d) };
    }

    async function bootShell(provider: ReturnType<typeof providerOver>) {
      const shell = new BoltShell();
      await bounded(shell.init(provider as never, itermDouble() as never), 'init');

      return shell;
    }

    async function driveCommand(installSucceeds: boolean) {
      const { provider } = sandboxDouble({ hookInstalls: installSucceeds });
      const shell = await bootShell(provider);

      const result = await bounded(shell.executeCommand('session-1', 'echo hi'), 'executeCommand');

      return { provider, result };
    }

    it('COMPLETES when the hook failed to install (no beginOsc) — degraded, never hung', async () => {
      const { provider, result } = await driveCommand(false);

      expect(provider.shell.beginOsc).toBeUndefined();
      expect(result).toBeDefined();

      /*
       * 130, not 3 — and that is the DOCUMENTED cost of degrading. With no begin marker the
       * exit-wait starts armed, so it resolves off the Ctrl-C pair still buffered from the
       * interrupt (the pre-hook jsh semantics). A stale status is bad; waiting forever for a
       * marker bash was never taught to emit is worse, and it is what the old unconditional
       * `beginOsc` produced. The control below shows an installed hook reporting the real code.
       */
      expect(result?.exitCode).toBe(130);
    });

    it('control: completes the same way when the hook DID install and bash emits `begin`', async () => {
      const { provider, result } = await driveCommand(true);

      expect(provider.shell.beginOsc).toBe('begin');
      expect(result?.exitCode).toBe(3);
    });

    /**
     * 🔴 The FIRST spawn decides for the session, and a later success must NOT un-degrade it.
     *
     * `.bashrc` is read when a shell STARTS, so the hook is a fact about a running process, not about
     * the disk. A later terminal's install flipping the claim to `true` re-arms the waits of the bash
     * ALREADY running without one: every shell action on it then waits forever for a marker that
     * process will never emit — the silent permanent hang this whole degrade exists to prevent,
     * walking back in through the door marked recovery.
     */
    it('a LATER successful install must not re-arm the shell already running unhooked', async () => {
      const { provider, setInstallable, ptys } = sandboxDouble({ hookInstalls: false });

      const shell = await bootShell(provider);
      expect(provider.shell.beginOsc).toBeUndefined();

      // The fs recovers, and a second terminal (a new tab) installs the hook successfully.
      setInstallable(true);
      await provider.spawn('bash', [], { terminal: { cols: 80, rows: 24 } });

      /*
       * The user-visible half FIRST: under the old `||=` this wait never returned, because the
       * exit-wait was armed for a `begin` marker the already-running bash cannot emit.
       */
      const result = await bounded(shell.executeCommand('session-1', 'echo hi'), 'executeCommand');
      expect(result).toBeDefined();

      // The claim is frozen: the first shell is still the one `shell.ts` is talking to.
      expect(provider.shell.beginOsc).toBeUndefined();

      // The write DID run for the second terminal — only the claim is frozen, not the install.
      expect(ptys).toHaveLength(2);
    });

    it('the rc install still RUNS for later terminals — freezing the claim is not skipping the work', async () => {
      const { d, provider, setInstallable } = sandboxDouble({ hookInstalls: false });

      await bootShell(provider);

      const writesAfterFirstShell = d.fs.writeTextFile.mock.calls.length;
      setInstallable(true);
      await provider.spawn('bash', [], { terminal: { cols: 80, rows: 24 } });

      expect(d.fs.writeTextFile.mock.calls.length).toBeGreaterThan(writesAfterFirstShell);
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

  it('🔴 rm({force:true}) REJECTS a failure that is not absence — force is not "any error is fine"', async () => {
    /*
     * The silent version of this: a permission error or a dropped connection resolved as a
     * successful delete, so the file map dropped the entry while the disk kept the file. Nobody
     * finds out until an export or a git push ships a file the user deleted.
     */
    const d = createClientDouble();
    d.fs.remove.mockRejectedValue(new Error('EACCES: permission denied'));

    await expect(providerOver(d).fs.rm('locked.ts', { force: true })).rejects.toThrow('EACCES');
  });

  it('rm({force:true}) still resolves for the Rust io shape CodeSandbox actually emits', async () => {
    const d = createClientDouble();
    d.fs.remove.mockRejectedValue(new Error('Os { code: 2, kind: NotFound, message: "No such file or directory" }'));

    await expect(providerOver(d).fs.rm('gone.ts', { force: true })).resolves.toBeUndefined();
  });

  describe('the watch leg: one path string for the read AND the map key', () => {
    /** Register a watcher and hand back the `onEvent` callback the provider installed. */
    async function watchWith(d: ReturnType<typeof createClientDouble>, seen: SandboxWatchEvent[][]) {
      const onEvent = vi.fn();
      d.fs.watch.mockResolvedValue({ dispose: vi.fn(), onEvent } as never);

      const unsubscribe = providerOver(d).watchPaths({ includeContent: true }, (events) => seen.push(events));
      await vi.waitFor(() => expect(onEvent).toHaveBeenCalled());

      return { fire: onEvent.mock.calls[0][0] as (raw: CodeSandboxWatchEvent) => Promise<void>, unsubscribe };
    }

    it('🔴 normalizes a workspace-relative event so it lands under the WORK_DIR-prefixed key', async () => {
      /*
       * The two halves must agree by construction: the enrichment read and the key `FilesStore` maps
       * the entry under are the SAME string. If a relative path reached the read, it would fail, the
       * file would be classified as a directory (content dropped), and the map would gain a second
       * key for a file it already holds.
       */
      const d = createClientDouble();
      const seen: SandboxWatchEvent[][] = [];
      const bytes = new Uint8Array([7, 7]);
      d.fs.readFile.mockResolvedValue(bytes);

      const { fire } = await watchWith(d, seen);
      await fire({ type: 'change', paths: ['src/main.ts'] });

      expect(d.fs.readFile).toHaveBeenCalledWith('/project/workspace/src/main.ts');
      expect(seen).toEqual([[{ type: 'change', path: '/project/workspace/src/main.ts', buffer: bytes }]]);
    });

    it('leaves an already-absolute event path alone rather than doubling the workdir onto it', async () => {
      const d = createClientDouble();
      const seen: SandboxWatchEvent[][] = [];
      d.fs.readFile.mockResolvedValue(new Uint8Array([1]));

      const { fire } = await watchWith(d, seen);
      await fire({ type: 'add', paths: ['/project/workspace/src/new.ts'] });

      expect(d.fs.readFile).toHaveBeenCalledWith('/project/workspace/src/new.ts');
      expect(seen[0][0].path).toBe('/project/workspace/src/new.ts');
    });

    it('classifies a path it cannot read as a DIRECTORY rather than an empty file', async () => {
      /*
       * A read fails for a directory and for a file deleted between the event and the read. Reporting
       * a directory is structural; reporting an empty file WRITES emptiness over real content.
       */
      const d = createClientDouble();
      const seen: SandboxWatchEvent[][] = [];
      d.fs.readFile.mockRejectedValue(new Error('is a directory'));

      const { fire } = await watchWith(d, seen);
      await fire({ type: 'add', paths: ['src'] });

      expect(seen).toEqual([[{ type: 'add_dir', path: '/project/workspace/src' }]]);
    });

    it('never reads on a removal — one wasted round trip per deleted file against a 3,600/hr budget', async () => {
      const d = createClientDouble();
      const seen: SandboxWatchEvent[][] = [];

      const { fire } = await watchWith(d, seen);
      await fire({ type: 'remove', paths: ['src/gone.ts'] });

      expect(d.fs.readFile).not.toHaveBeenCalled();
      expect(seen).toEqual([[{ type: 'remove_file', path: '/project/workspace/src/gone.ts' }]]);
    });

    /*
     * 🔴 THE EXCLUDE LIST IS THE ONLY THING BETWEEN `npm install` AND THE REQUEST CAP.
     *
     * Every `add`/`change` event costs one `client.fs.readFile` — an RTT — and an install writes
     * thousands of files under `node_modules`. Against the 3,600 req/hr API limit an ignored exclude
     * is not a slow watcher, it is a dead session. The SDK spells it `excludes` (plural) inside the
     * options object of `fs.watch(path, …)`, while the seam spells it `exclude`; a rename on either
     * side leaves `excludes: undefined`, which the SDK reads as "watch everything" — no error, no
     * warning, just a flood. So the wire shape is pinned literally, with the REAL glob list, which is
     * the same list T17 scenario 2 counts requests against live.
     */
    it('forwards the seam’s excludes to the SDK in the shape it documents', async () => {
      const d = createClientDouble();
      const seen: SandboxWatchEvent[][] = [];
      const onEvent = vi.fn();
      d.fs.watch.mockResolvedValue({ dispose: vi.fn(), onEvent } as never);

      providerOver(d).watchPaths({ includeContent: true, exclude: MAP_EXCLUDE_GLOBS }, (events) => seen.push(events));
      await vi.waitFor(() => expect(onEvent).toHaveBeenCalled());

      expect(d.fs.watch).toHaveBeenCalledWith(WD, {
        recursive: true,
        excludes: ['**/node_modules', '.git', '.codesandbox', 'dist'],
      });

      // And the list really is the map layer's, not a copy that can drift away from it.
      expect(MAP_EXCLUDE_GLOBS).toEqual(['**/node_modules', '.git', '.codesandbox', 'dist']);
    });

    it('does not enrich at all when the caller did not ask for content', async () => {
      /*
       * `includeContent` gates the read leg. A watcher registered for structure only must cost ZERO
       * reads — the same request-budget argument as the excludes above, one layer in.
       */
      const d = createClientDouble();
      const seen: SandboxWatchEvent[][] = [];
      const onEvent = vi.fn();
      d.fs.watch.mockResolvedValue({ dispose: vi.fn(), onEvent } as never);

      providerOver(d).watchPaths({ includeContent: false }, (events) => seen.push(events));
      await vi.waitFor(() => expect(onEvent).toHaveBeenCalled());

      await (onEvent.mock.calls[0][0] as (raw: CodeSandboxWatchEvent) => Promise<void>)({
        type: 'change',
        paths: ['src/main.ts'],
      });

      expect(d.fs.readFile).not.toHaveBeenCalled();

      // Unenriched, so it is reported as a content-less `change` — never as a directory.
      expect(seen).toEqual([[{ type: 'change', path: '/project/workspace/src/main.ts', buffer: undefined }]]);
    });

    it('reads EVERY path in a multi-path event, and each read is the enrichment for its own key', async () => {
      /*
       * One event can carry several paths. Enriching only the first would leave the rest recorded as
       * EMPTY files — content written over real content, the failure direction the read leg exists to
       * prevent — so the fan-out is pinned rather than assumed.
       */
      const d = createClientDouble();
      const seen: SandboxWatchEvent[][] = [];
      d.fs.readFile.mockImplementation((async (p: string) => new TextEncoder().encode(`bytes:${p}`)) as never);

      const { fire } = await watchWith(d, seen);
      await fire({ type: 'change', paths: ['src/a.ts', 'src/b.ts'] });

      expect(d.fs.readFile).toHaveBeenCalledTimes(2);
      expect(d.fs.readFile).toHaveBeenCalledWith('/project/workspace/src/a.ts');
      expect(d.fs.readFile).toHaveBeenCalledWith('/project/workspace/src/b.ts');
      expect(seen[0].map((e) => new TextDecoder().decode(e.buffer))).toEqual([
        'bytes:/project/workspace/src/a.ts',
        'bytes:/project/workspace/src/b.ts',
      ]);
    });

    it('classifies ONLY the path that failed to read — one bad read must not blank its siblings', async () => {
      const d = createClientDouble();
      const seen: SandboxWatchEvent[][] = [];
      d.fs.readFile.mockImplementation((async (p: string) => {
        if (p.endsWith('/src')) {
          throw new Error('is a directory');
        }

        return new Uint8Array([9]);
      }) as never);

      const { fire } = await watchWith(d, seen);
      await fire({ type: 'add', paths: ['src', 'src/main.ts'] });

      expect(seen).toEqual([
        [
          { type: 'add_dir', path: '/project/workspace/src' },
          { type: 'add_file', path: '/project/workspace/src/main.ts', buffer: new Uint8Array([9]) },
        ],
      ]);
    });

    it('drops events that arrive AFTER unsubscribe — a dead component must not be written into', async () => {
      const d = createClientDouble();
      const seen: SandboxWatchEvent[][] = [];
      d.fs.readFile.mockResolvedValue(new Uint8Array([1]));

      const { fire, unsubscribe } = await watchWith(d, seen);
      unsubscribe();
      await fire({ type: 'change', paths: ['src/main.ts'] });

      expect(seen).toEqual([]);
    });
  });

  it('reads workdir live rather than snapshotting it', () => {
    const d = createClientDouble();
    const provider = providerOver(d);

    d.client.workspacePath = '/somewhere/else';

    expect(provider.workdir).toBe('/somewhere/else');
  });

  it('teardown calls the injected server-side reaper', () => {
    // Reaping needs the API key, so this provider can only ever delegate it.
    const onTeardown = vi.fn();
    const d = createClientDouble();

    createCodeSandboxProvider(d.client as never, { onTeardown }).teardown();

    expect(onTeardown).toHaveBeenCalledTimes(1);
  });

  /**
   * The seam does not inject `onTeardown` today, so `teardown()` really is a no-op here — pinned so
   * the doc comment and the code agree. What keeps an abandoned VM from billing forever is
   * server-side (`hibernationTimeoutSeconds` at creation, `deleteSandbox` on project delete), not
   * this hook.
   */
  it('is a harmless no-op when no reaper is injected — which is the shipped composition', () => {
    const provider = createCodeSandboxProvider(createClientDouble().client as never, {});

    expect(() => provider.teardown()).not.toThrow();
  });

  /*
   * 🔴 The seam reads the PRESENCE of `refreshPreviewUrl` as "this provider's preview URLs expire"
   * (`SandboxProvider.refreshPreviewUrl`, T8). Declaring it unconditionally would tell `PreviewsStore`
   * to schedule re-mints against a provider that has no minter wired in — a timer firing forever
   * against a function that can only ever answer `undefined`. Absent is the honest shape, and it is
   * the same shape WebContainer has.
   */
  it('does NOT declare refreshPreviewUrl when no minter was wired in', () => {
    const provider = createCodeSandboxProvider(createClientDouble().client as never, {});

    expect(provider.refreshPreviewUrl).toBeUndefined();
    expect('refreshPreviewUrl' in provider).toBe(false);
  });

  it('declares refreshPreviewUrl and delegates to the boot’s minter when one is supplied', async () => {
    const previewUrlForPort = vi.fn(async () => ({ url: 'https://sb1-5173.csb.app/?preview_token=B', expiresAt: 42 }));
    const provider = createCodeSandboxProvider(createClientDouble().client as never, { previewUrlForPort });

    await expect(provider.refreshPreviewUrl!(5173)).resolves.toEqual({
      url: 'https://sb1-5173.csb.app/?preview_token=B',
      expiresAt: 42,
    });

    // The PORT is the whole argument: only the boot's minter knows the host it recorded.
    expect(previewUrlForPort).toHaveBeenCalledWith(5173);
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
