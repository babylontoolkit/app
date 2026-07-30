/**
 * The empty state for "New chat, same game" (SPEC §4.5.6).
 *
 * ## Why this exists
 *
 * A new chat on an existing project has no landing intro (the game is already built — the intro is for
 * people who have not started one) and no messages. So the chat column rendered as an empty void with a
 * prompt box in it, identical to a dead screen and identical to a chat that failed to load. Reported as
 * "the screen is so plain i don't know that i am at a new chat".
 *
 * The state is genuinely unusual and worth naming: the workbench is full of a game, and the assistant
 * remembers none of the conversation that built it. That is the FEATURE — the conversation is uncached
 * and re-sent in full every turn, so dropping it is the saving (`spec/context-budget.md`) — but a user
 * who does not know it happened will read the first "what are we building?" answer as amnesia.
 *
 * So this says the two things that are true and non-obvious: the files are untouched, the talking is
 * gone. And it states what the agent still knows, because "fresh context" sounds like "starts from
 * nothing" and that is not what happens — it is re-grounded from the FS, `CLAUDE.md`, and the skills
 * index on every single turn (§4.2.8).
 */
import { useStore } from '@nanostores/react';
import { projectId } from '~/lib/persistence/useChatHistory';
import { newProjectModeStore } from '~/lib/stores/new-project-mode';

export function NewChatIntro() {
  const pid = useStore(projectId);
  const newProjectMode = useStore(newProjectModeStore);

  /*
   * No project means this is the landing page, which has its own intro. This component is only ever the
   * answer to "you are in a game, and this conversation is new".
   */
  if (!pid) {
    return null;
  }

  /*
   * A project that has never been built has `CreationHandoffCard` instead, and the two must not stack.
   * Reachable: create a project, don't send, then ⋯ "New chat" — the conversation empties (so this
   * fires) while the mode is still set (§4.4a). Both panels would then explain the same screen in
   * contradictory terms — this one promises "your files are untouched, the game is already built",
   * which is exactly what a project in New Project mode is not.
   */
  if (newProjectMode?.projectId === pid) {
    return null;
  }

  return (
    <div className="max-w-chat mx-auto w-full px-1 py-4">
      <div className="rounded-lg border border-bolt-elements-borderColor bg-bolt-elements-background-depth-2 p-4">
        <div className="flex items-center gap-2 mb-2">
          <div className="i-ph:chat-teardrop-dots text-lg text-accent" />
          <h2 className="text-sm font-semibold text-bolt-elements-textPrimary">New chat</h2>
        </div>

        <p className="text-sm text-bolt-elements-textSecondary mb-3">
          A fresh conversation on the same game. Your files are untouched — this chat just starts with no history.
        </p>

        <ul className="flex flex-col gap-1.5 text-xs text-bolt-elements-textSecondary">
          <li className="flex items-start gap-2">
            <div className="i-ph:check-circle-duotone text-sm text-bolt-elements-icon-success shrink-0 mt-px" />
            <span>
              Your project is loaded and unchanged — everything in the workbench is exactly where you left it.
            </span>
          </li>
          <li className="flex items-start gap-2">
            <div className="i-ph:check-circle-duotone text-sm text-bolt-elements-icon-success shrink-0 mt-px" />
            <span>
              The assistant still reads your code, your{' '}
              <code className="text-bolt-elements-textPrimary">CLAUDE.md</code> and your skills on every message.
            </span>
          </li>
          <li className="flex items-start gap-2">
            <div className="i-ph:eraser-duotone text-sm text-bolt-elements-textTertiary shrink-0 mt-px" />
            <span>It does not remember the earlier conversation. Your other chats are in the sidebar.</span>
          </li>
        </ul>
      </div>
    </div>
  );
}
