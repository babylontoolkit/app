/**
 * The projects folder's layout (SPEC §4.5.4d, D61): the folder the user picks holds exactly two
 * subfolders the platform creates — `Apps/` (every App Builder web project, one `<slug>/` each) and
 * `Unity/` (the Unity projects the Unity Bridge helper works in). Nothing else at the folder's top
 * level is created, read or touched, and there is NO fallback lookup there: a project folder is only
 * ever found or created inside `Apps/`.
 *
 * ONE helper, used by every door that finds or creates a project folder and by the picker — a second
 * private copy is how one door ends up at the top level while the other looks in `Apps/`.
 */
import type { LocalDirectoryHandle } from './types';

/** Web apps live here, one `<slug>/` per project, found by marker. */
export const APPS_FOLDER = 'Apps';

/** Unity projects live here; the Unity Bridge dialog puts `<folder>/Unity` in the helper's command. */
export const UNITY_PROJECTS_FOLDER = 'Unity';

export interface ProjectsRoot {
  apps: LocalDirectoryHandle;
  unity: LocalDirectoryHandle;
}

/** Resolve (creating when missing) the chosen folder's `Apps/` and `Unity/` subfolders. */
export async function projectsRoot(parent: LocalDirectoryHandle): Promise<ProjectsRoot> {
  const apps = await parent.getDirectoryHandle(APPS_FOLDER, { create: true });
  const unity = await parent.getDirectoryHandle(UNITY_PROJECTS_FOLDER, { create: true });

  return { apps, unity };
}
