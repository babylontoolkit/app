/**
 * The Unity Bridge install command (SPEC §4.17, D55 + D59 + D61): the App Builder projects folder is required,
 * carried as `--projects "<folder>/Unity"` after `--pair <code>` and before any `--server`; a path the quoted flag cannot carry
 * is refused with a sentence, never turned into a broken command.
 */
import { describe, expect, it } from 'vitest';
import {
  installCommand,
  PROJECTS_FOLDER_ERROR,
  PROJECTS_FOLDER_STORAGE_KEY,
  projectsFolderPlaceholder,
  serverOriginFor,
  unityFolderIn,
} from './install-command';

const BASE = 'npx @babylonjs-toolkit/agent bridge --install-service --pair K7QM-2XWD';

describe('installCommand', () => {
  it('blank (or whitespace) folder → no command', () => {
    expect(installCommand({ code: 'K7QM-2XWD', projectsFolder: '', serverOrigin: null })).toBeNull();
    expect(installCommand({ code: 'K7QM-2XWD', projectsFolder: '   \t ', serverOrigin: null })).toBeNull();
  });

  it('a quote, $, backtick or line break → the error sentence, no command (each expands or breaks inside double quotes)', () => {
    for (const folder of [
      '/Users/me/"Unity"',
      '/Users/me\n/Unity',
      '/Users/me\r\nUnity',
      '/Users/$HOME/Unity',
      '/Users/me/`id`',
    ]) {
      expect(installCommand({ code: 'K7QM-2XWD', projectsFolder: folder, serverOrigin: null })).toEqual({
        error: PROJECTS_FOLDER_ERROR,
      });
    }
    expect(PROJECTS_FOLDER_ERROR).toBe("That folder path can't contain quotes, $, backticks or line breaks.");
  });

  it('a plain POSIX path, trimmed, quoted, after --pair, pointed at its Unity subfolder (D61)', () => {
    expect(installCommand({ code: 'K7QM-2XWD', projectsFolder: '  /Users/me/Projects  ', serverOrigin: null })).toEqual(
      {
        command: `${BASE} --projects "/Users/me/Projects/Unity"`,
      },
    );
  });

  it('a path with spaces stays one quoted argument', () => {
    expect(installCommand({ code: 'K7QM-2XWD', projectsFolder: '/Users/me/My Projects', serverOrigin: null })).toEqual({
      command: `${BASE} --projects "/Users/me/My Projects/Unity"`,
    });
  });

  it('a trailing slash is trimmed before joining', () => {
    expect(installCommand({ code: 'K7QM-2XWD', projectsFolder: '/Users/me/Projects/', serverOrigin: null })).toEqual({
      command: `${BASE} --projects "/Users/me/Projects/Unity"`,
    });
    expect(installCommand({ code: 'K7QM-2XWD', projectsFolder: '/', serverOrigin: null })).toEqual({
      command: `${BASE} --projects "/Unity"`,
    });
  });

  it('a Windows path joins with a backslash; a trailing one (which would escape the quote) is trimmed', () => {
    expect(
      installCommand({ code: 'K7QM-2XWD', projectsFolder: 'C:\\Users\\me\\My Projects', serverOrigin: null }),
    ).toEqual({ command: `${BASE} --projects "C:\\Users\\me\\My Projects\\Unity"` });
    expect(
      installCommand({ code: 'K7QM-2XWD', projectsFolder: 'C:\\Users\\me\\Projects\\', serverOrigin: null }),
    ).toEqual({ command: `${BASE} --projects "C:\\Users\\me\\Projects\\Unity"` });
    expect(installCommand({ code: 'K7QM-2XWD', projectsFolder: 'D:\\', serverOrigin: null })).toEqual({
      command: `${BASE} --projects "D:\\Unity"`,
    });
  });

  it('a path mixing separators (any /) joins with a forward slash', () => {
    expect(unityFolderIn('C:/Users/me/Projects')).toBe('C:/Users/me/Projects/Unity');
    expect(unityFolderIn('C:\\Users/me\\Projects')).toBe('C:\\Users/me\\Projects/Unity');
  });

  it('--server comes last, after --projects, when present, and is absent otherwise', () => {
    expect(
      installCommand({
        code: 'K7QM-2XWD',
        projectsFolder: '/Users/me/Projects',
        serverOrigin: 'http://localhost:5173',
      }),
    ).toEqual({ command: `${BASE} --projects "/Users/me/Projects/Unity" --server http://localhost:5173` });

    const withoutServer = installCommand({
      code: 'K7QM-2XWD',
      projectsFolder: '/Users/me/Projects',
      serverOrigin: null,
    });
    expect(withoutServer && 'command' in withoutServer && withoutServer.command).not.toContain('--server');
  });

  it('keeps the pre-D61 storage key so a stored value carries over', () => {
    expect(PROJECTS_FOLDER_STORAGE_KEY).toBe('btk.unityBridge.projectsFolder');
  });
});

describe('serverOriginFor', () => {
  it('null only on the production origin; an unknown production origin names this page', () => {
    expect(serverOriginFor('https://app.x.com', 'https://app.x.com')).toBeNull();
    expect(serverOriginFor('http://localhost:5173', 'https://app.x.com')).toBe('http://localhost:5173');
    expect(serverOriginFor('http://localhost:5173', null)).toBe('http://localhost:5173');
  });
});

describe('projectsFolderPlaceholder', () => {
  it('per OS', () => {
    expect(projectsFolderPlaceholder('Mozilla/5.0 (Macintosh; Intel Mac OS X 14_5)', 'MacIntel')).toBe(
      '/Users/you/Projects',
    );
    expect(projectsFolderPlaceholder('Mozilla/5.0 (Windows NT 10.0; Win64; x64)', 'Win32')).toBe(
      'C:\\Users\\you\\Projects',
    );
    expect(projectsFolderPlaceholder('Mozilla/5.0 (X11; Linux x86_64)', 'Linux x86_64')).toBe('/home/you/Projects');
  });
});
