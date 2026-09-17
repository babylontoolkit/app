/**
 * Folder naming + the project marker (SPEC §4.5.4d). Pure.
 */
import { PROJECT_MARKER_FILE, type ProjectMarker } from './types';

/**
 * `"Kart Racer!"` → `kart-racer`. Same rule as `slugForChat`, minus the chat fallback: a project folder
 * with no usable title falls back to a fixed word, never to the raw id, because the folder name is the
 * one thing here the user will read in Finder/Explorer.
 */
export function slugForFolder(name: string | undefined): string {
  const slug = (name ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
    .replace(/-+$/g, '');

  return slug || 'project';
}

/** `kart-racer`, `kart-racer-2`, `kart-racer-3` … — the same walk `deriveRepoName`'s callers use. */
export function candidateDirNames(slug: string, max = 50): string[] {
  const names = [slug];

  for (let i = 2; i <= max; i++) {
    names.push(`${slug}-${i}`);
  }

  return names;
}

export function buildProjectMarker(projectId: string, name: string, now = new Date()): ProjectMarker {
  return { projectId, name, createdAt: now.toISOString() };
}

/** Parse a marker file's bytes. `undefined` for anything that is not a marker — never a throw. */
export function parseProjectMarker(text: string): ProjectMarker | undefined {
  try {
    const parsed = JSON.parse(text) as Partial<ProjectMarker> | null;

    if (!parsed || typeof parsed.projectId !== 'string' || parsed.projectId.length === 0) {
      return undefined;
    }

    return {
      projectId: parsed.projectId,
      name: typeof parsed.name === 'string' ? parsed.name : '',
      createdAt: typeof parsed.createdAt === 'string' ? parsed.createdAt : '',
    };
  } catch {
    return undefined;
  }
}

/** The marker never enters the sandbox or the model's context — it is the folder's, not the game's. */
export function isProjectMarkerPath(rel: string): boolean {
  return rel === PROJECT_MARKER_FILE;
}
