/**
 * Which skills the CURRENT turn loaded, known before the model writes a token (SPEC §4.11).
 *
 * The server resolves `/slash` invocations and pre-loads skills BEFORE the stream opens, so it can
 * say what is running immediately. It already reported this on the `agentMeta` annotation — but that
 * is written at the END with the token counts, so the badge only appeared once everything was over,
 * which is precisely when it is least useful. This store holds the early `skills-loaded` data part
 * so the badge is on screen while the turn runs.
 *
 * The `agentMeta` badge on the finished message STAYS. They answer different questions — "what is
 * happening right now" vs "what did this turn use" — and the second has to survive a reload, which a
 * stream-only signal cannot.
 *
 * ⚠️ THE REPLAY RULE, same as `agent-status.ts`: `useChat` re-scans its whole data array on every
 * stream chunk, so this part is presented over and over. Ingest is therefore idempotent — a repeat
 * of the generation we already hold is ignored, and a NEW generation id replaces it outright (never
 * merges, or a turn would inherit the previous turn's skills).
 */
import { atom } from 'nanostores';

export interface ActiveSkills {
  generationId: string;
  skills: string[];
}

export const activeSkillsStore = atom<ActiveSkills | null>(null);

/**
 * Ingest one data part if it is a `skills-loaded`. Safe to call with every part on every re-scan;
 * anything else is ignored.
 */
export function updateActiveSkills(part: unknown): void {
  if (!part || typeof part !== 'object') {
    return;
  }

  const p = part as { type?: unknown; generationId?: unknown; skills?: unknown };

  if (p.type !== 'skills-loaded' || typeof p.generationId !== 'string' || !Array.isArray(p.skills)) {
    return;
  }

  const current = activeSkillsStore.get();

  // Already holding this generation's list — a replayed part, not new information.
  if (current?.generationId === p.generationId) {
    return;
  }

  activeSkillsStore.set({
    generationId: p.generationId,
    skills: p.skills.filter((s): s is string => typeof s === 'string'),
  });
}

/** Clear at the start of a turn, so a new turn never shows the previous turn's skills. */
export function resetActiveSkills(): void {
  activeSkillsStore.set(null);
}
