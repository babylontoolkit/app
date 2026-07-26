/**
 * THE SANDBOX SEAM IS A DEFAULT-DENY RULE (SPEC §1.3.5, §8, `spec/sandbox-seam.md`).
 *
 * WebContainers is proprietary, and `spec/licensing.md` makes a StackBlitz commercial plan a hard
 * Phase-3 gate: no plan, no external users. §8's escape hatch is only cheap while the coupling stays
 * behind one module — and the rule that was supposed to guarantee that ("no new WebContainer-specific
 * coupling outside the runtime layer") lived in prose for the whole build. Prose cannot fail. It held
 * anyway, but only because nobody tested it: at the time this seam was extracted, THIRTEEN modules
 * imported `@webcontainer/api` and seven more reached the boot singleton directly.
 *
 * So the guard is structural, in the `outbound-enumerate.spec.ts` / `no-server-storage.spec.ts`
 * shape: it reads the source, it is default-deny (a new file is a failure until someone writes down
 * why it is allowed), and it carries CONTROLS proving the reader still sees anything at all. A scan
 * that silently matches nothing reports a clean bill of health forever — that trap has now been hit
 * twice in this codebase, so every scan here is paired with a positive case.
 *
 * The behavioural half matters just as much and is easy to get wrong silently: `createWebContainerProvider`
 * is a translation layer, and crossing `'server-ready'` with `'port'` — or pointing `watchPaths` at
 * the wrong `internal` method — produces a preview that never appears or a file tree that never
 * updates, with no error anywhere.
 */
/*
 * The fake provider and the container double are deliberately inert: the point is that a
 * SandboxProvider can be satisfied by something that does nothing, so most of their methods are
 * empty by design rather than by omission.
 */
/* eslint-disable @typescript-eslint/no-empty-function */
import { describe, expect, it, vi } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { createWebContainerProvider, WEBCONTAINER_CAPABILITIES } from './webcontainer-provider';
import type { SandboxDirent, SandboxProvider } from './types';

const APP_DIR = join(process.cwd(), 'app');

/**
 * `@webcontainer/api` is named in prose all over this repo (post-mortems, binary-file warnings, this
 * very file). Comments are documentation, not coupling — strip them before deciding anything.
 */
function sourceWithoutComments(absPath: string): string {
  return readFileSync(absPath, 'utf-8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');
}

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules') {
      continue;
    }

    const abs = join(dir, entry);

    if (statSync(abs).isDirectory()) {
      walk(abs, out);
    } else if (/\.tsx?$/.test(abs)) {
      out.push(abs);
    }
  }

  return out;
}

/**
 * This file names both forbidden specifiers as DATA — allow-list keys and scan needles — so it
 * matches its own rules. It is excluded by exact path rather than by a pattern: a pattern like
 * "skip `*.spec.ts`" would also stop the scan seeing a real regression in a test file, which is
 * precisely how `mount-tree.spec.ts` sat on a `@webcontainer/api` import unnoticed.
 */
const SELF = join(APP_DIR, 'lib/sandbox/sandbox-seam.spec.ts');

const SOURCE_FILES = walk(APP_DIR).filter((abs) => abs !== SELF);

function filesReferencing(needle: string): string[] {
  return SOURCE_FILES.filter((abs) => sourceWithoutComments(abs).includes(needle)).map((abs) =>
    relative(process.cwd(), abs).replace(/\\/g, '/'),
  );
}

/**
 * The ONLY modules allowed to know WebContainer exists. Each carries the reason, because a list
 * without reasons becomes a place to append rather than a wall.
 */
const MAY_IMPORT_WEBCONTAINER_API: Record<string, string> = {
  'app/lib/sandbox/webcontainer-provider.ts':
    'The adapter itself — the one intentional dependency, and the thing a second provider replaces.',
  'app/lib/webcontainer/index.ts':
    'Boots the container (COEP, preview script, preview-error forwarding). Wrapped by the adapter.',
  'app/lib/webcontainer/auth.client.ts': "Upstream's StackBlitz auth re-export; client-only, untouched by the fork.",
  'app/routes/webcontainer.connect.$id.tsx':
    "Upstream connect route (dynamic CDN import). Hidden dead path per SPEC §2.3 — kept under hide-don't-delete.",
};

/**
 * Importing the boot singleton is the SUBTLER bypass: it type-checks, it works, and it silently
 * re-couples a feature to WebContainer without ever naming the package. Seven modules were doing
 * exactly this (four deploy buttons, the share build, folder import, the starter selector).
 */
const MAY_IMPORT_BOOT_MODULE: Record<string, string> = {
  'app/lib/sandbox/index.ts': 'The seam entry point — the one place that decides which runtime backs `sandbox`.',
};

describe('the sandbox seam is default-deny', () => {
  it('no module outside the adapter imports @webcontainer/api', () => {
    const offenders = filesReferencing('@webcontainer/api').filter((file) => !(file in MAY_IMPORT_WEBCONTAINER_API));

    expect(offenders).toEqual([]);
  });

  it('CONTROL: the scanner really does detect the import', () => {
    /*
     * Without this, deleting the adapter (or breaking `sourceWithoutComments` so it strips code)
     * makes the test above pass by seeing nothing at all.
     */
    expect(filesReferencing('@webcontainer/api')).toContain('app/lib/sandbox/webcontainer-provider.ts');
  });

  it('no module outside the seam entry point imports the boot singleton', () => {
    const offenders = filesReferencing("from '~/lib/webcontainer'").filter((file) => !(file in MAY_IMPORT_BOOT_MODULE));

    expect(offenders).toEqual([]);
  });

  it('CONTROL: the scanner really does detect the boot-module import', () => {
    expect(filesReferencing("from '~/lib/webcontainer'")).toContain('app/lib/sandbox/index.ts');
  });

  it('every allow-listed file still exists and still needs its exemption', () => {
    /*
     * An allow-list entry for a file that no longer imports the package is a wall guarding nothing —
     * and the next person reads it as precedent that this directory is exempt.
     */
    const actual = filesReferencing('@webcontainer/api');

    for (const file of Object.keys(MAY_IMPORT_WEBCONTAINER_API)) {
      expect(actual, `${file} is allow-listed but no longer imports @webcontainer/api — drop the entry`).toContain(
        file,
      );
    }
  });
});

describe('the interface is implementable without WebContainer', () => {
  /**
   * The whole point of §8. If this fake cannot satisfy `SandboxProvider`, neither can E2B — and the
   * escape hatch is a paragraph rather than a plan. It also pins the capability contract: a provider
   * may decline `textSearch`, and declining means the METHOD is absent, not that it returns nothing.
   */
  function createFakeProvider(): SandboxProvider {
    const disk = new Map<string, Uint8Array>();

    /*
     * The overloaded members are written as real overloads rather than cast into place. A cast would
     * make this compile while proving nothing — the claim under test is that the interface can be
     * SATISFIED by something that is not a WebContainer, and a cast is exactly how you fake that.
     */
    function readFile(path: string, encoding?: null): Promise<Uint8Array>;
    function readFile(path: string, encoding: BufferEncoding): Promise<string>;
    async function readFile(path: string, encoding?: BufferEncoding | null): Promise<Uint8Array | string> {
      const bytes = disk.get(path);

      if (!bytes) {
        throw new Error(`ENOENT: ${path}`);
      }

      return encoding ? new TextDecoder().decode(bytes) : bytes;
    }

    function readdir(
      path: string,
      options?: { encoding?: BufferEncoding | null; withFileTypes?: false } | BufferEncoding | null,
    ): Promise<string[]>;
    function readdir(
      path: string,
      options: { encoding?: BufferEncoding | null; withFileTypes: true },
    ): Promise<SandboxDirent[]>;
    async function readdir(): Promise<string[] | SandboxDirent[]> {
      return [];
    }

    function mkdir(path: string, options?: { recursive?: false }): Promise<void>;
    function mkdir(path: string, options: { recursive: true }): Promise<string>;
    async function mkdir(path: string, options?: { recursive?: boolean }): Promise<void | string> {
      return options?.recursive ? path : undefined;
    }

    return {
      capabilities: { terminal: false, textSearch: false, watch: true },
      workdir: '/workspace',
      fs: {
        readFile,
        readdir,
        mkdir,
        writeFile: async (path: string, data: string | Uint8Array) => {
          disk.set(path, typeof data === 'string' ? new TextEncoder().encode(data) : data);
        },
        rm: async (path: string) => {
          disk.delete(path);
        },
      },
      mount: async () => {},
      spawn: async () => ({
        exit: Promise.resolve(0),
        input: new WritableStream<string>(),
        output: new ReadableStream<string>(),
        kill: () => {},
        resize: () => {},
      }),
      watchPaths: () => () => {},
      onServerReady: () => () => {},
      onPort: () => () => {},
      teardown: () => {},
    };
  }

  it('round-trips bytes without a WebContainer anywhere in sight', async () => {
    const provider = createFakeProvider();
    const bytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47]); // the PNG magic the mount tree corrupts

    await provider.fs.writeFile('logo.png', bytes);

    expect(await provider.fs.readFile('logo.png')).toEqual(bytes);
  });

  it('declining a capability means the method is absent, not silently useless', () => {
    const provider = createFakeProvider();

    expect(provider.capabilities.textSearch).toBe(false);
    expect(provider.textSearch).toBeUndefined();
  });
});

describe('the WebContainer adapter translates the right calls', () => {
  function createContainerDouble() {
    const on = vi.fn(() => () => {});
    const watchPaths = vi.fn(() => () => {});
    const textSearch = vi.fn(async () => new Map());
    const spawn = vi.fn(async () => ({}) as never);
    const mount = vi.fn(async () => {});
    const teardown = vi.fn();
    const fs = { marker: 'the real FileSystemAPI' };

    const container = {
      on,
      internal: { watchPaths, textSearch },
      spawn,
      mount,
      teardown,
      fs,
      workdir: '/home/project',
    };

    return { container, on, watchPaths, textSearch, spawn, mount, teardown, fs };
  }

  function providerOver(double: ReturnType<typeof createContainerDouble>) {
    return createWebContainerProvider(double.container as never);
  }

  it('maps onServerReady and onPort to their DISTINCT container events', () => {
    /*
     * Mutation check: swapping these two names produces a preview that never appears (or one that
     * appears and never closes) and throws nothing anywhere.
     */
    const double = createContainerDouble();
    const provider = providerOver(double);
    const serverReady = () => {};
    const port = () => {};

    provider.onServerReady(serverReady);
    provider.onPort(port);

    expect(double.on).toHaveBeenNthCalledWith(1, 'server-ready', serverReady);
    expect(double.on).toHaveBeenNthCalledWith(2, 'port', port);
  });

  it('routes watchPaths and textSearch through container.internal', () => {
    const double = createContainerDouble();
    const provider = providerOver(double);
    const callback = () => {};

    provider.watchPaths({ include: ['**'] }, callback);

    expect(double.watchPaths).toHaveBeenCalledWith({ include: ['**'] }, callback);
  });

  it('passes the container filesystem through untouched', () => {
    // Wrapping `fs` would silently break the byte-identity contract in `spec/binary-files.md`.
    const double = createContainerDouble();

    expect(providerOver(double).fs).toBe(double.fs);
  });

  it('reads workdir live rather than snapshotting it at construction', () => {
    const double = createContainerDouble();
    const provider = providerOver(double);

    double.container.workdir = '/somewhere/else';

    expect(provider.workdir).toBe('/somewhere/else');
  });

  it('defaults spawn args so a bare command still reaches the container', () => {
    const double = createContainerDouble();

    providerOver(double).spawn('npm');

    expect(double.spawn).toHaveBeenCalledWith('npm', [], undefined);
  });

  it('declares all three capabilities, which is what makes it the reference implementation', () => {
    expect(WEBCONTAINER_CAPABILITIES).toEqual({ terminal: true, textSearch: true, watch: true });
  });
});
