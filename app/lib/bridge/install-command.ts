/**
 * The one Unity Bridge install command the dialog shows (SPEC §4.17, D55 + D59).
 *
 *   npx @babylonjs-toolkit/agent bridge --install-service --pair <code> --projects "<folder>" [--server <origin>]
 *
 * D59: the Unity projects folder is REQUIRED — the helper runs as a start-at-login service, so "wherever the
 * command happened to run" is not a folder anyone chose. A browser folder picker cannot supply a full path, so
 * the dialog takes a typed one. Blank → no command at all; a path the quoted flag cannot carry (a `"`, a line
 * break, or a `$`/backtick that a shell would expand inside double quotes) → a sentence, never a broken command.
 *
 * Pure and client-safe.
 */

export const PROJECTS_FOLDER_ERROR = "That folder path can't contain quotes, $, backticks or line breaks.";

/** Where the dialog remembers the last typed folder (per browser; a convenience, never state). */
export const PROJECTS_FOLDER_STORAGE_KEY = 'btk.unityBridge.projectsFolder';

export type InstallCommandResult = { command: string } | { error: string } | null;

/**
 * `--server` only when this page is not the production origin (the helper's default); an unknown production
 * origin (null) always names the server.
 */
export function serverOriginFor(pageOrigin: string, productionOrigin: string | null): string | null {
  return productionOrigin === pageOrigin ? null : pageOrigin;
}

/**
 * A trailing BACKSLASH is dropped: on Windows one before the closing quote (`"C:\Unity\"`) escapes the quote in
 * the argument parser and swallows the rest of the line. A drive root keeps a usable form (`C:\.`). Forward
 * slashes are harmless and kept.
 */
function withoutTrailingBackslash(path: string): string {
  if (!path.endsWith('\\')) {
    return path;
  }

  const trimmed = path.replace(/\\+$/, '');

  return trimmed === '' || /^[A-Za-z]:$/.test(trimmed) ? `${trimmed}\\.` : trimmed;
}

/** Blank folder → null (no command); a `"`, `$`, backtick or line break → an error; otherwise the exact command. */
export function installCommand({
  code,
  projectsFolder,
  serverOrigin,
}: {
  code: string;
  projectsFolder: string;
  serverOrigin: string | null;
}): InstallCommandResult {
  const folder = projectsFolder.trim();

  if (!folder) {
    return null;
  }

  if (/["`$\r\n]/.test(folder)) {
    return { error: PROJECTS_FOLDER_ERROR };
  }

  const base = `npx @babylonjs-toolkit/agent bridge --install-service --pair ${code} --projects "${withoutTrailingBackslash(folder)}"`;

  return { command: serverOrigin ? `${base} --server ${serverOrigin}` : base };
}

/** The example path shown in the empty field, for the OS this browser runs on. */
export function projectsFolderPlaceholder(userAgent: string, platform: string): string {
  const text = `${platform} ${userAgent}`;

  if (/Win/i.test(text)) {
    return 'C:\\Users\\you\\Unity Projects';
  }

  if (/Mac|iPhone|iPad/i.test(text)) {
    return '/Users/you/Unity Projects';
  }

  return /Linux|X11|CrOS/i.test(text) ? '/home/you/Unity Projects' : '/Users/you/Unity Projects';
}
