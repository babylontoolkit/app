/**
 * The one Unity Bridge install command the dialog shows (SPEC §4.17, D55 + D59 + D61).
 *
 *   npx @babylonjs-toolkit/agent bridge --install-service --pair <code> --projects "<folder>/Unity" [--server <origin>]
 *
 * D59: the helper's projects folder is REQUIRED — the helper runs as a start-at-login service, so "wherever the
 * command happened to run" is not a folder anyone chose. D61: the field holds the user's App Builder projects
 * folder (the one they picked in the App Builder, which holds `Web/` and `Unity/`), and the command points the
 * helper at its `Unity` subfolder (the helper creates it if missing). A browser folder picker cannot supply a full
 * path, so the dialog takes a typed one. Blank → no command at all; a path the quoted flag cannot carry (a `"`, a
 * line break, or a `$`/backtick that a shell would expand inside double quotes) → a sentence, never a broken
 * command.
 *
 * Pure and client-safe.
 */

export const PROJECTS_FOLDER_ERROR = "That folder path can't contain quotes, $, backticks or line breaks.";

/**
 * Where the dialog remembers the last typed folder (per browser; a convenience, never state). The key predates
 * D61, when the field held the Unity folder itself; kept so a stored value carries over.
 */
export const PROJECTS_FOLDER_STORAGE_KEY = 'btk.unityBridge.projectsFolder';

export type InstallCommandResult = { command: string } | { error: string } | null;

/**
 * `--server` only when this page is not the production origin (the helper's default); an unknown production
 * origin (null) always names the server.
 */
export function serverOriginFor(pageOrigin: string, productionOrigin: string | null): string | null {
  return productionOrigin === pageOrigin ? null : pageOrigin;
}

/** The subfolder of the App Builder projects folder that holds Unity projects (D61). */
export const UNITY_SUBFOLDER = 'Unity';

/**
 * `<folder>/Unity`, joined with the separator the typed path uses: a path containing `\` and no `/` is a Windows
 * path and gets `\Unity`; anything else gets `/Unity`. Trailing separators are trimmed first, so a trailing
 * BACKSLASH never reaches the closing quote (on Windows `"C:\Projects\"` escapes the quote in the argument
 * parser and swallows the rest of the line). A root (`/`, `C:\`) joins to `/Unity` / `C:\Unity`.
 */
export function unityFolderIn(appBuilderFolder: string): string {
  const separator = appBuilderFolder.includes('\\') && !appBuilderFolder.includes('/') ? '\\' : '/';
  const trimmed = appBuilderFolder.replace(/[\\/]+$/, '');

  return `${trimmed}${separator}${UNITY_SUBFOLDER}`;
}

/**
 * Blank folder → null (no command); a `"`, `$`, backtick or line break → an error; otherwise the exact command,
 * pointing the helper at the folder's `Unity` subfolder.
 */
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

  const base = `npx @babylonjs-toolkit/agent bridge --install-service --pair ${code} --projects "${unityFolderIn(folder)}"`;

  return { command: serverOrigin ? `${base} --server ${serverOrigin}` : base };
}

/** The example path shown in the empty field, for the OS this browser runs on. */
export function projectsFolderPlaceholder(userAgent: string, platform: string): string {
  const text = `${platform} ${userAgent}`;

  if (/Win/i.test(text)) {
    return 'C:\\Users\\you\\Projects';
  }

  if (/Mac|iPhone|iPad/i.test(text)) {
    return '/Users/you/Projects';
  }

  return /Linux|X11|CrOS/i.test(text) ? '/home/you/Projects' : '/Users/you/Projects';
}
