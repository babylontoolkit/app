/**
 * A folder import lands as BYTES and is CHECKPOINTED — it does not ride in the chat (T3b, SPEC §4.5.4b,
 * §4.5.4c, §4.2.8).
 *
 * 🔴 The shape this file pins is the one the git door already had and this one did not. `importChat`
 * ends in `window.location.href` — a full page load — and the only enabled sandbox provider is
 * session-scoped (`SANDBOX_PROVIDER_TRAITS.nodepod.outlivesSession === false`), so the runtime holding
 * the imported bytes is destroyed on the way out. Two silent consequences followed, in opposite
 * directions:
 *
 *   - binaries were written straight into that doomed sandbox and nothing captured them, so an imported
 *     game came back with no textures, models or sounds — the exact failure the binary write path was
 *     added to fix;
 *   - text survived only because it rode in the chat as a `<boltArtifact>` of file bodies, i.e. the
 *     replay design the git door removed for corrupting binaries and for buying a permanent per-turn
 *     context bill (§4.2.8).
 *
 * Neither throws. So the assertions below are about the ORDER and the ARGUMENTS — write, settle,
 * checkpoint, hand off a DESCRIPTION — with collaborators mocked at the LEAF so the module under test
 * is real.
 *
 * The other half is the pointer. The import ends in a reload of `/chat/<id>`, and `projectId` is the
 * only thing that boots THIS sandbox again rather than stranding the imported files on a VM nothing
 * names — so it must travel out of here to the caller's chat metadata.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const openImportWorkspace = vi.hoisted(() => vi.fn());
const rollback = vi.hoisted(() => vi.fn());
const checkpointImportedProject = vi.hoisted(() => vi.fn());
const settle = vi.hoisted(() => ({ settleAfterCreation: vi.fn() }));
const workbench = vi.hoisted(() => ({ files: { get: vi.fn(() => ({})) } }));

vi.mock('~/lib/registry/import-project', () => ({ openImportWorkspace }));

/*
 * The checkpoint is a collaborator with its own subject (`import-checkpoint.spec.ts`) — and importing
 * it for real would pull `useChatHistory`, a database and a workbench store into a node runner.
 */
vi.mock('~/lib/persistence/import-checkpoint', () => ({ checkpointImportedProject }));

vi.mock('~/lib/stores/workbench', () => ({ workbenchStore: workbench }));

/*
 * `settleAfterCreation` is mocked (it is a real clock loop and would add seconds of dead time per test)
 * but `IMPORT_SETTLE_OPTIONS` is kept REAL via `importActual`. Stubbing the constant too would let the
 * module pass any object at all and still satisfy the assertion — the test would be checking that two
 * mocks agree with each other rather than that the import uses the import profile.
 */
vi.mock('~/lib/registry/settle', async (importOriginal) => ({
  ...(await importOriginal<typeof import('~/lib/registry/settle')>()),
  settleAfterCreation: settle.settleAfterCreation,
}));

/* Command detection is `projectCommands`' own subject; stubbed so this file only asserts the seam. */
vi.mock('./projectCommands', () => ({
  detectProjectCommands: vi.fn(async () => ({ type: undefined, setupCommand: undefined, followupMessage: '' })),
  createCommandsMessage: vi.fn(() => null),
  escapeBoltTags: (input: string) => input,
}));

import { createChatFromFolder } from './folderImport';
import { IMPORT_SETTLE_OPTIONS } from '~/lib/registry/settle';

const writeFile = vi.fn();
const mkdir = vi.fn();
const SANDBOX = { workdir: '/project/workspace', fs: { writeFile, mkdir } };

/**
 * A `File` stand-in. The runner is node, so there is no `FileReader` and no real `File` — but the
 * module only ever reads `webkitRelativePath`, `arrayBuffer()` and the reader's text result.
 */
function fakeFile(path: string, text = 'hello'): File {
  return {
    webkitRelativePath: path,
    text,
    arrayBuffer: async () => new TextEncoder().encode(text).buffer,
  } as unknown as File;
}

class FakeFileReader {
  result: string | null = null;
  onload: (() => void) | null = null;
  onerror: ((error: unknown) => void) | null = null;

  readAsText(file: { text?: string }) {
    this.result = file.text ?? '';
    queueMicrotask(() => this.onload?.());
  }
}

/** Everything the hand-off carries to the next page load, as one string. */
const transcriptOf = (messages: Array<{ content: string }>) => messages.map((message) => message.content).join('\n');

beforeEach(() => {
  vi.clearAllMocks();
  rollback.mockResolvedValue(undefined);
  openImportWorkspace.mockResolvedValue({ sandbox: SANDBOX, projectId: 'prj_import', rollback });
  writeFile.mockResolvedValue(undefined);
  mkdir.mockResolvedValue(undefined);
  checkpointImportedProject.mockResolvedValue(true);
  settle.settleAfterCreation.mockResolvedValue({ quiesced: true, elapsedMs: 3000, finalCount: 3 });
  vi.stubGlobal('FileReader', FakeFileReader);
});

describe('the workspace comes first', () => {
  /* The regression T3b exists to prevent: no binaries must NOT mean no workspace. */
  it('opens the workspace even when the folder contains ZERO binary files', async () => {
    const result = await createChatFromFolder([fakeFile('my-game/src/main.ts', 'export {}')], [], 'my-game');

    expect(openImportWorkspace).toHaveBeenCalledTimes(1);
    expect(openImportWorkspace).toHaveBeenCalledWith({ name: 'my-game' });
    expect(result.projectId).toBe('prj_import');
  });

  it('opens the workspace for an empty folder too', async () => {
    await createChatFromFolder([], [], 'my-game');

    expect(openImportWorkspace).toHaveBeenCalledTimes(1);
  });

  /*
   * The workspace is acquired BEFORE any byte is written — the ordering is the whole point, since on
   * a project-backed runtime there is no filesystem until the project exists.
   */
  it('opens the workspace before it writes anything', async () => {
    await createChatFromFolder([], [fakeFile('my-game/public/player.png')], 'my-game');

    expect(openImportWorkspace.mock.invocationCallOrder[0]).toBeLessThan(writeFile.mock.invocationCallOrder[0]);
  });

  /*
   * A refusal must reach the caller with its words intact — a swallowed failure here is the
   * indefinite spinner T3b removes.
   */
  it('propagates the workspace refusal rather than importing into nowhere', async () => {
    openImportWorkspace.mockRejectedValueOnce(new Error('Sign in to create a project.'));

    await expect(createChatFromFolder([], [fakeFile('my-game/a.png')], 'my-game')).rejects.toThrow(
      'Sign in to create a project.',
    );
    expect(writeFile).not.toHaveBeenCalled();
  });

  /*
   * 🔴 The workspace is not the last thing that can fail. A file that will not read, or a write the
   * sandbox refuses, happens AFTER the project is registered — and without this the failed import
   * leaves an empty project on the dashboard and a VM billing by the second (the very orphan T3b
   * removes from creation, reintroduced through the import door).
   */
  it('rolls the registration back when a file fails to read after the workspace was opened', async () => {
    class FailingFileReader extends FakeFileReader {
      readAsText() {
        queueMicrotask(() => this.onerror?.(new Error('could not read the file')));
      }
    }

    vi.stubGlobal('FileReader', FailingFileReader);

    await expect(createChatFromFolder([fakeFile('my-game/src/main.ts')], [], 'my-game')).rejects.toThrow(
      'could not read the file',
    );
    expect(rollback).toHaveBeenCalledTimes(1);
  });

  it('does not roll back an import that succeeded', async () => {
    await createChatFromFolder([fakeFile('my-game/src/main.ts', 'export {}')], [], 'my-game');

    expect(rollback).not.toHaveBeenCalled();
  });
});

describe('every file lands on disk as itself', () => {
  it('writes binary bytes into the workspace it opened', async () => {
    await createChatFromFolder([], [fakeFile('my-game/public/player.png', 'PNGBYTES')], 'my-game');

    expect(mkdir).toHaveBeenCalledWith('public', { recursive: true });
    expect(writeFile).toHaveBeenCalledTimes(1);
    expect(writeFile.mock.calls[0][0]).toBe('public/player.png');
    expect(writeFile.mock.calls[0][1]).toBeInstanceOf(Uint8Array);
  });

  /*
   * 🔴 The half that used to be missing. Text rode in the chat as artifact bodies and was replayed by
   * the message parser after the reload — which is why the checkpoint below had nothing to capture and
   * why every byte of a foreign folder was paid for on every later turn (§4.2.8).
   */
  it('writes text files into the workspace too, rather than only into the chat', async () => {
    await createChatFromFolder([fakeFile('my-game/src/main.ts', 'export const x = 1;')], [], 'my-game');

    expect(writeFile).toHaveBeenCalledTimes(1);
    expect(writeFile.mock.calls[0][0]).toBe('src/main.ts');
    expect(writeFile.mock.calls[0][1]).toBe('export const x = 1;');
  });

  /* A file at the root has no directory to make, and asking for one is an error on some providers. */
  it('makes no directory for a root-level file', async () => {
    await createChatFromFolder([fakeFile('my-game/package.json', '{}')], [], 'my-game');

    expect(mkdir).not.toHaveBeenCalled();
  });

  /*
   * One unreadable file must not lose the other 200. The write path logs and carries on, and the
   * count the user is shown reflects what actually landed.
   */
  it('keeps importing when a single write is refused', async () => {
    writeFile.mockRejectedValueOnce(new Error('EACCES'));

    const { messages } = await createChatFromFolder(
      [fakeFile('my-game/a.ts', 'a'), fakeFile('my-game/b.ts', 'b')],
      [],
      'my-game',
    );

    expect(writeFile).toHaveBeenCalledTimes(2);
    expect(transcriptOf(messages)).toContain('1 file(s)');
  });
});

describe('the copy that survives the hand-off', () => {
  it('checkpoints the imported project, and takes a server recovery copy', async () => {
    await createChatFromFolder([fakeFile('my-game/src/main.ts', 'export {}')], [], 'my-game');

    expect(checkpointImportedProject).toHaveBeenCalledTimes(1);
    expect(checkpointImportedProject).toHaveBeenCalledWith({
      projectId: 'prj_import',
      name: 'my-game',

      /*
       * 🔴 A folder import is born UNLINKED — there is no repository behind it — so this checkpoint
       * and the §4.5.4c recovery copy are the only places the project exists.
       */
      serverCopy: true,
    });
  });

  /*
   * 🔴 No `files`. This door ADDS to a workspace it does not necessarily own the whole of (an import
   * started from inside an open project writes into that project), so its own list is not the whole
   * truth — and a checkpoint that is not the whole truth is a DELETION on the next restore, which
   * runs with `protectNothing`.
   */
  it('hands the checkpoint no file map, so the whole store is captured instead', async () => {
    await createChatFromFolder([fakeFile('my-game/src/main.ts', 'export {}')], [], 'my-game');

    expect(checkpointImportedProject.mock.calls[0][0]).not.toHaveProperty('files');
  });

  /*
   * The write resolving is not the map having finished changing — the watcher's tail is still arriving,
   * and the checkpoint serializes that map. Settling AFTER the checkpoint would photograph a
   * half-arrived project.
   */
  it('settles the watcher before it checkpoints, on the import profile', async () => {
    await createChatFromFolder([fakeFile('my-game/src/main.ts', 'export {}')], [], 'my-game');

    expect(settle.settleAfterCreation).toHaveBeenCalledTimes(1);
    expect(settle.settleAfterCreation.mock.calls[0][0]).toMatchObject(IMPORT_SETTLE_OPTIONS);
    expect(settle.settleAfterCreation.mock.invocationCallOrder[0]).toBeLessThan(
      checkpointImportedProject.mock.invocationCallOrder[0],
    );
  });

  /* Best-effort: files already correct on disk must not be thrown away by a failed checkpoint. */
  it('still hands the import off when the checkpoint could not be written', async () => {
    checkpointImportedProject.mockResolvedValue(false);

    const { messages, projectId } = await createChatFromFolder([fakeFile('my-game/a.ts', 'a')], [], 'my-game');

    expect(projectId).toBe('prj_import');
    expect(messages.length).toBeGreaterThan(0);
  });
});

describe('the hand-off message carries no file bodies', () => {
  it('describes the import instead of embedding it', async () => {
    const { messages } = await createChatFromFolder(
      [fakeFile('my-game/src/main.ts', 'const SECRET_MARKER = 1;')],
      [fakeFile('my-game/public/player.png', 'PNGBYTES')],
      'my-game',
    );

    const transcript = transcriptOf(messages);

    expect(transcript).not.toContain('boltArtifact');
    expect(transcript).not.toContain('SECRET_MARKER');
    expect(transcript).toContain('2 file(s)');

    // The agent is told the assets EXIST — never their contents.
    expect(transcript).toContain('public/player.png');
    expect(transcript).not.toContain('PNGBYTES');
  });

  /*
   * 🔴 THE ONE EXCEPTION, and it is not an oversight. With no project there is no `sandbox_id` to boot
   * again, so the reload gets a brand-new empty runtime and the chat is the only thing that survives —
   * dropping the bodies there would delete the import rather than economise on it. Binaries are still
   * never carried (the artifact is a text protocol and would corrupt them).
   */
  it('falls back to artifact bodies when the import has no project to checkpoint', async () => {
    openImportWorkspace.mockResolvedValue({ sandbox: SANDBOX, projectId: undefined, rollback });

    const { messages, projectId } = await createChatFromFolder(
      [fakeFile('my-game/src/main.ts', 'const SECRET_MARKER = 1;')],
      [],
      'my-game',
    );

    expect(projectId).toBeUndefined();
    expect(checkpointImportedProject).not.toHaveBeenCalled();

    const transcript = transcriptOf(messages);

    expect(transcript).toContain('boltArtifact');
    expect(transcript).toContain('SECRET_MARKER');
  });
});
