/**
 * Share wire types (SPEC §4.8).
 *
 * The publishing checklist runs on the server (`app/lib/.server/share/checklist.ts`), but its findings
 * are rendered by the client share dialog. Remix forbids client code from importing `.server/**`
 * (correctly — that module can reach object storage), so the shared shape lives here, on the public
 * side of the seam, and the server checklist imports it. This is the same pattern as
 * `app/types/project.ts`.
 */

export type FindingLevel = 'blocking' | 'warning';

export interface ChecklistFinding {
  level: FindingLevel;

  /** Stable id so the UI can key a fix affordance per rule and tests can assert without matching prose. */
  code: string;

  /** Shown to the user. Plain language — the audience is a non-developer. */
  message: string;

  /** The file that triggered it, when there is one. */
  path?: string;
}
