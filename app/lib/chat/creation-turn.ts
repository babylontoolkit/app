/**
 * Is the current/next turn a FIRST BUILD? — the client half of `carriesCreationBrief` (§4.4a, §4.6.1).
 *
 * The server derives its own answer from the request it receives (`proxy.ts`); this one decides what
 * the USER is shown before anything is sent, and its single consumer is the premium pill's lock
 * (`PremiumToggle` — premium is EDIT-ONLY, because a first build on KIE-buffered Fable 5 dies at the
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
}

export function isCreationTurn({ activeProjectId, messages }: CreationTurnInput): boolean {
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
