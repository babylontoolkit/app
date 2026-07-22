/**
 * Re-apply the FILES from a paid turn that never landed (SPEC §4.5.4c, §4.6).
 *
 * ## Why this exists at all
 *
 * `transcriptParser` (§4.5.4b) deliberately renders a restored message and executes nothing, because
 * replaying a stale artifact over files that came fresh from a repo overwrites new bodies with old
 * ones. That rule is correct and this does not weaken it: `detectUnappliedTurn` is what decides a turn
 * was never applied, and it answers `offer` — i.e. asks the user — in every case where "older copy"
 * might instead mean "deliberately restored". This module is only the hands.
 *
 * ## FILES ONLY — never shell actions
 *
 * A recovery must not re-run `npm install`, a dev server, or anything else the model asked for the
 * first time round. Those are not the user's work, they are steps toward running it, and the mount
 * path already does that (`prepareMountedProject`). Re-running them here would at best duplicate work
 * and at worst execute a command against a project in a state it was never written for. The bytes are
 * the thing that was paid for and lost; the bytes are all this restores.
 */
import type { Message } from 'ai';
import { StreamingMessageParser } from '~/lib/runtime/message-parser';
import { workbenchStore } from '~/lib/stores/workbench';
import { createScopedLogger } from '~/utils/logger';

const logger = createScopedLogger('apply-artifact');

/**
 * Write every file action in `message` into the project.
 *
 * Returns how many files were applied — 0 means the message had no file actions, which the caller
 * should treat as "nothing to recover" rather than as success.
 */
export async function applyTranscriptArtifact(message: Message): Promise<number> {
  if (typeof message.content !== 'string') {
    return 0;
  }

  let applied = 0;

  const parser = new StreamingMessageParser({
    callbacks: {
      onArtifactOpen: (data) => {
        workbenchStore.showWorkbench.set(true);
        workbenchStore.addArtifact(data);
      },
      onArtifactClose: (data) => {
        workbenchStore.updateArtifact(data, { closed: true });
      },
      onActionOpen: (data) => {
        if (data.action.type === 'file') {
          workbenchStore.addAction(data);
        }
      },
      onActionClose: (data) => {
        /*
         * The whole point: file actions are applied, everything else is registered for display and
         * never run. `runAction` is called for `file` ONLY — see the module note.
         */
        if (data.action.type !== 'file') {
          workbenchStore.addAction(data);
          return;
        }

        applied += 1;
        workbenchStore.runAction(data);
      },
    },
  });

  parser.parse(message.id, message.content);

  logger.info(`Re-applied ${applied} file(s) from message ${message.id}`);

  return applied;
}
