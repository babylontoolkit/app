/**
 * Is the current/next turn a FIRST BUILD? — the client half of `carriesCreationBrief` (§4.4a, §4.6.1).
 *
 * The server derives its own answer from the request it receives (`proxy.ts`); this one decides what
 * the USER is shown before anything is sent, and its single consumer is the premium pill's lock
 * (`ModelTierPill` — every paid rung is EDIT-ONLY, because a first build on a buffered model dies at the
 * gateway timeout before its artifact can flush). Authority stays server-side: `decidePremium`
 * re-derives eligibility on every generation, so a wrong answer here only ever offers a toggle the
 * server declines — it can never buy premium.
 *
 * Pure and separate from the component for one reason: it was an inline `useEffect` body, which meant
 * the rule "premium locks during a creation" was only assertable by reading React. Both failure
 * directions are silent — leak premium onto a first build and the generation dies at the gateway;
 * lock it forever and a paying user simply never gets the model they were sold.
 */
import type { Message } from 'ai';
import { CREATION_BRIEF_MARKER } from '~/types/creation';

export interface CreationTurnInput {
  /** The mounted project, if any. Absent means the next send CREATES one. */
  activeProjectId?: string;
  messages: Pick<Message, 'role' | 'content'>[];

  /**
   * NEW PROJECT MODE for the open project, if any (`newProjectModeStore`).
   *
   * 🔴 The window this closes (§4.4a, T13). Under project-first creation the brief is appended at SEND,
   * so while the user sits editing the carried prompt there is NO message carrying
   * `CREATION_BRIEF_MARKER` yet — and that window is the WHOLE of New Project mode, which is exactly
   * when the next send is the first build. Keying only on the marker unlocked the premium pill for the
   * entire time the user was looking at it, then locked it again the instant they pressed send.
   *
   * Scoped to the open project here rather than at the call site: a mode belonging to another project
   * must never lock this one, and a scoping rule inlined in a `useEffect` is a rule nothing can test.
   */
  newProjectMode?: { projectId: string } | null;
}

export function isCreationTurn({ activeProjectId, messages, newProjectMode }: CreationTurnInput): boolean {
  /*
   * The project exists and runs, and nothing has been built in it yet: the next send IS the first build,
   * whatever is in the box. The empty `projectId` case is the unregistered-project fallback — that mode
   * has no id to scope by and belongs to whatever is open (`enterNewProjectMode`).
   */
  if (newProjectMode && (!newProjectMode.projectId || newProjectMode.projectId === activeProjectId)) {
    return true;
  }

  /*
   * The landing page, or a chat with no project: the next message creates the project, so the turn
   * the user is about to send IS the first build even though nothing carries a brief yet.
   */
  if (!activeProjectId && messages.length === 0) {
    return true;
  }

  /*
   * Otherwise it is the LAST user turn that decides — the hidden brief covers creation streaming, a
   * failed creation awaiting retry, and a fresh project before the user's first edit. A new chat on an
   * EXISTING project has a project id and no brief, so premium stays available: its first message is
   * an edit.
   */
  const lastUser = [...messages].reverse().find((message) => message.role === 'user');

  return typeof lastUser?.content === 'string' && lastUser.content.includes(CREATION_BRIEF_MARKER);
}
