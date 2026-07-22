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

/**
 * Start a fresh conversation on the current game.
 *
 * A HOOK rather than a button (2026-07-22): this moved out of the header row and into the ⋯ main menu,
 * and the action is worth having independently of whatever renders it — the header button, the menu
 * item, and the `/clear` slash command (§4.2.9) must all take the SAME path, or "new chat" means three
 * subtly different things depending on how you asked for it.
 *
 * Returns a no-op when there is no project: "new chat, same game" has no game to be the same as, and
 * the sidebar's "Start new chat" is already that action.
 */
export function useStartNewChat(): () => void {
  const navigate = useNavigate();
  const pid = useStore(projectId);

  return () => {
    if (!pid) {
      return;
    }

    /*
     * Through the mount baton rather than by resetting state in place. The builder's mount path already
     * knows how to put a project's files in front of an empty chat — it is what a dashboard Open does —
     * and reusing it means this feature cannot drift away from the one that is exercised constantly.
     */
    setPendingOpenProject(pid, 'fresh');
    navigate('/');
  };
}
