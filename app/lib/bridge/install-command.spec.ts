/**
 * The Unity Bridge install command (SPEC §4.17, D55 + D59): the projects folder is required, carried as
 * `--projects "<folder>"` after `--pair <code>` and before any `--server`; a path the quoted flag cannot carry
 * is refused with a sentence, never turned into a broken command.
 */
import { describe, expect, it } from 'vitest';
import { installCommand, PROJECTS_FOLDER_ERROR, projectsFolderPlaceholder, serverOriginFor } from './install-command';

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

  it('a plain path, trimmed, quoted, after --pair', () => {
    expect(installCommand({ code: 'K7QM-2XWD', projectsFolder: '  /Users/me/Unity  ', serverOrigin: null })).toEqual({
      command: `${BASE} --projects "/Users/me/Unity"`,
    });
  });

  it('a path with spaces stays one quoted argument', () => {
    expect(
      installCommand({ code: 'K7QM-2XWD', projectsFolder: '/Users/me/Unity Projects', serverOrigin: null }),
    ).toEqual({ command: `${BASE} --projects "/Users/me/Unity Projects"` });
  });

  it('a Windows path keeps its backslashes; a trailing one (which would escape the quote) is dropped', () => {
    expect(
      installCommand({ code: 'K7QM-2XWD', projectsFolder: 'C:\\Users\\me\\Unity Projects', serverOrigin: null }),
    ).toEqual({ command: `${BASE} --projects "C:\\Users\\me\\Unity Projects"` });
    expect(installCommand({ code: 'K7QM-2XWD', projectsFolder: 'C:\\Users\\me\\Unity\\', serverOrigin: null })).toEqual(
      { command: `${BASE} --projects "C:\\Users\\me\\Unity"` },
    );
    expect(installCommand({ code: 'K7QM-2XWD', projectsFolder: 'D:\\', serverOrigin: null })).toEqual({
      command: `${BASE} --projects "D:\\."`,
    });
  });

  it('--server comes after --projects when present, and is absent otherwise', () => {
    expect(
      installCommand({ code: 'K7QM-2XWD', projectsFolder: '/Users/me/Unity', serverOrigin: 'http://localhost:5173' }),
    ).toEqual({ command: `${BASE} --projects "/Users/me/Unity" --server http://localhost:5173` });

    const withoutServer = installCommand({ code: 'K7QM-2XWD', projectsFolder: '/Users/me/Unity', serverOrigin: null });
    expect(withoutServer && 'command' in withoutServer && withoutServer.command).not.toContain('--server');
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
      '/Users/you/Unity Projects',
    );
    expect(projectsFolderPlaceholder('Mozilla/5.0 (Windows NT 10.0; Win64; x64)', 'Win32')).toBe(
      'C:\\Users\\you\\Unity Projects',
    );
    expect(projectsFolderPlaceholder('Mozilla/5.0 (X11; Linux x86_64)', 'Linux x86_64')).toBe(
      '/home/you/Unity Projects',
    );
  });
});
