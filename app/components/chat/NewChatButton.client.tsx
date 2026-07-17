/**
 * "New chat, same game" (SPEC §4.5.6).
 *
 * A project holds many conversations. This starts another one on the game you are already in: the files
 * stay exactly where they are, the chat history does not come along.
 *
 * ## Why this exists at all
 *
 * A project used to hold exactly ONE conversation — upstream's model, where the chat WAS the project, so
 * 1:1 was a tautology rather than a decision. Game projects are long and phase-shaped (spec → plan →
 * execute), and the conversation is UNCACHED and re-sent in full on every turn
 * (`spec/context-budget.md`): by the execute phase you are paying, every turn, to re-send the spec
 * discussion that produced the plan. `HISTORY_WINDOW_TURNS` bounds that bill, but it does so by
 * FORGETTING — so on a mature project you pay to re-send a conversation that has been silently
 * truncated anyway. Starting a new chat is the honest version of the same saving.
 *
 * ## Why nothing is lost
 *
 * The agent's grounding does not come from the conversation. Every turn it is sent the project's files
 * fresh from the WebContainer FS, the project's `CLAUDE.md` as its own instructions block, and the
 * skills index (§4.2.8). A new chat sees the whole game; it just does not see the talking.
 */
import { useStore } from '@nanostores/react';
import { useNavigate } from '@remix-run/react';
import { projectId } from '~/lib/persistence/useChatHistory';
import { setPendingOpenProject } from '~/lib/persistence/pending-remix';

export function NewChatButton() {
  const navigate = useNavigate();
  const pid = useStore(projectId);

  /*
   * No project, no button. On a chat that has not created one yet, "new chat, same game" has no game to
   * be the same as — the sidebar's "Start new chat" is that action, and it already exists.
   */
  if (!pid) {
    return null;
  }

  const startNewChat = () => {
    /*
     * Through the mount baton rather than by resetting state in place. The builder's mount path already
     * knows how to put a project's files in front of an empty chat — it is what a dashboard Open does —
     * and reusing it means this feature cannot drift away from the one that is exercised constantly.
     */
    setPendingOpenProject(pid, 'fresh');
    navigate('/');
  };

  return (
    <button
      onClick={startNewChat}
      className="flex items-center gap-1.5 px-3 py-1.5 text-xs rounded-md border border-bolt-elements-borderColor text-bolt-elements-textPrimary hover:bg-bolt-elements-background-depth-3 transition-colors"
      title="Start a fresh conversation on this same game — your files are untouched"
    >
      <div className="i-ph:chat-teardrop-dots" />
      <span>New chat</span>
    </button>
  );
}
