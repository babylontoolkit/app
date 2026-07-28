/**
 * What a project looks like on the wire (SPEC §4.5.3, §5).
 *
 * 🔴 **A TypeScript type strips nothing at runtime.** `app/types/project.ts` is deliberately a subset
 * of the server `Project`, and it is easy to read that omission as a guarantee — but both project
 * routes serialize the row they loaded, so every server-only field ships to the browser the moment it
 * exists. That is how `sandboxId` was about to reach every dashboard load while its own doc comment
 * said the browser never sees it. **A false claim in a comment is how a defect survives review.**
 *
 * So the omission is enforced HERE, in one place both routes call, rather than asserted in a type.
 *
 * ## Why `sandboxId` in particular
 *
 * It is not a credential — a preview still needs a server-minted `preview_token`, and a session is
 * minted only behind `requireOwnedProject` from the id on the ROW, never from anything the caller
 * sends. Leaking it would not by itself let anyone touch a VM.
 *
 * ⚠️ Nor is this a claim that the browser never learns the id: `/api/sandbox/session` returns it (the
 * client logs it, and it is genuinely useful in a bug report). What the strip buys is narrower and
 * still worth having — the id stops riding on every DASHBOARD load, for every project, to a page that
 * has no use for it. It keeps "which VM is this?" a question only the sandbox routes answer, and the
 * day someone proposes a route that ACCEPTS a sandbox id, the argument that "the project list already
 * hands it out" will not be sitting there waiting for them.
 *
 * ⚠️ `userId` is deliberately KEPT: the client already relies on it, and it identifies the caller to
 * themselves. This function is a considered list, not a blanket filter.
 */
import type { Project } from './types';

/** Fields the server holds that must not be serialized to the browser. */
const SERVER_ONLY_FIELDS = ['sandboxId'] as const;

export type WireProject<T> = Omit<T, (typeof SERVER_ONLY_FIELDS)[number]>;

/**
 * Strip the server-only fields from a project (or a project plus route-added extras like `chatCount`).
 *
 * Generic over the input so a caller that decorated the project keeps its decorations — the shape of
 * `api.projects.ts`'s listing, which spreads the project and adds a count.
 */
export function toWireProject<T extends Partial<Project>>(project: T): WireProject<T> {
  const copy = { ...project } as Record<string, unknown>;

  for (const field of SERVER_ONLY_FIELDS) {
    delete copy[field];
  }

  return copy as WireProject<T>;
}
