/**
 * Importing a local folder acquires its workspace FIRST, and unconditionally (T3b).
 *
 * 🔴 The tempting shape is to open the workspace lazily, inside `writeBinaryFiles`, because that is
 * the only place bytes are written synchronously. It is wrong, and it is wrong SILENTLY: the text
 * files ride in as a `boltArtifact` that is replayed after a full page load, so a text-only folder
 * would be registered against no project at all — the actions would replay with nowhere to write and
 * the import would land nowhere with no error anywhere.
 *
 * The other half is the pointer. The import ends in a reload of `/chat/<id>`, and `projectId` is the
 * only thing that boots THIS sandbox again rather than stranding the imported files on a VM nothing
 * names — so it must travel out of here to the caller's chat metadata.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const openImportWorkspace = vi.hoisted(() => vi.fn());
const rollback = vi.hoisted(() => vi.fn());

vi.mock('~/lib/registry/import-project', () => ({ openImportWorkspace }));

/* Command detection is `projectCommands`' own subject; stubbed so this file only asserts the seam. */
vi.mock('./projectCommands', () => ({
  detectProjectCommands: vi.fn(async () => ({ type: undefined, setupCommand: undefined, followupMessage: '' })),
  createCommandsMessage: vi.fn(() => null),
  escapeBoltTags: (input: string) => input,
}));

import { createChatFromFolder } from './folderImport';

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

beforeEach(() => {
  vi.clearAllMocks();
  rollback.mockResolvedValue(undefined);
  openImportWorkspace.mockResolvedValue({ sandbox: SANDBOX, projectId: 'prj_import', rollback });
  writeFile.mockResolvedValue(undefined);
  mkdir.mockResolvedValue(undefined);
  vi.stubGlobal('FileReader', FakeFileReader);
});

describe('createChatFromFolder', () => {
  /* The regression this task exists to prevent: no binaries must NOT mean no workspace. */
  it('opens the workspace even when the folder contains ZERO binary files', async () => {
    const result = await createChatFromFolder([fakeFile('my-game/src/main.ts', 'export {}')], [], 'my-game');

    expect(openImportWorkspace).toHaveBeenCalledTimes(1);
    expect(openImportWorkspace).toHaveBeenCalledWith({ name: 'my-game' });
    expect(writeFile).not.toHaveBeenCalled();
    expect(result.projectId).toBe('prj_import');
  });

  it('opens the workspace for an empty folder too', async () => {
    await createChatFromFolder([], [], 'my-game');

    expect(openImportWorkspace).toHaveBeenCalledTimes(1);
  });

  /*
   * A control: without it every assertion above passes just as well if the whole binary path stopped
   * working, which is the §1.3 principle-10 failure (an imported game with no textures) wearing a
   * green suite.
   */
  it('writes binary bytes into the workspace it opened', async () => {
    await createChatFromFolder([], [fakeFile('my-game/public/player.png', 'PNGBYTES')], 'my-game');

    expect(mkdir).toHaveBeenCalledWith('public', { recursive: true });
    expect(writeFile).toHaveBeenCalledTimes(1);
    expect(writeFile.mock.calls[0][0]).toBe('public/player.png');
    expect(writeFile.mock.calls[0][1]).toBeInstanceOf(Uint8Array);
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

  /* WebContainer imports carry no project, and that must not become an invented one. */
  it('carries no project id when the runtime needs none', async () => {
    openImportWorkspace.mockResolvedValue({ sandbox: SANDBOX, projectId: undefined, rollback });

    const result = await createChatFromFolder([], [], 'my-game');

    expect(result.projectId).toBeUndefined();
  });
});
