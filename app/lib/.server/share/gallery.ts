/**
 * The gallery's public projection (SPEC §4.8, §5).
 *
 * The gallery is unauthenticated, so this is the seam that decides EXACTLY which fields of an approved
 * project a stranger may see. It is an allow-list, not a redaction: we build a fresh object with the
 * three public fields, rather than deleting private ones off the row — because "delete the private
 * fields" is one forgotten field away from leaking `userId` or a snapshot key, and an allow-list can
 * only ever leak what it explicitly names.
 */
import type { ProjectStore, Project } from '~/lib/.server/projects/types';

export interface GalleryEntry {
  /** The public key — enough to play (`/play/:shareId`) and remix. Never the project id or owner. */
  shareId: string;
  title: string;
  description?: string;
  sharedAt: string;
}

function toEntry(project: Project): GalleryEntry | null {
  // Defensive: only a live, approved share is ever an entry, whatever the store returned.
  if (!project.shareId || !project.sharedAt || project.galleryStatus !== 'approved') {
    return null;
  }

  return {
    shareId: project.shareId,
    title: project.shareTitle || project.name,
    description: project.shareDescription,
    sharedAt: project.sharedAt,
  };
}

export async function listGallery(store: ProjectStore, limit: number): Promise<GalleryEntry[]> {
  const projects = await store.listGallery(limit);

  return projects.map(toEntry).filter((e): e is GalleryEntry => e !== null);
}
