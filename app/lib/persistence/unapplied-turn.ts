/**
 * Was the last PAID generation's work ever applied to this project? (SPEC §4.5.4c, §4.6, §4.12)
 *
 * ## The hole this closes
 *
 * Settlement is server-side and happens when the stream ends. Applying the artifact and checkpointing
 * it are CLIENT work that happens afterwards. A tab that dies in between leaves the user charged for a
 * generation whose files never reached any durable copy — measured at **427 credits** for a
 * `/bt-landing` redesign that came back, on reload, as the project from before the run.
 *
 * The bytes are not actually lost. The artifact IS the work — `<boltAction type="file">` blocks with
 * the bodies inside them — and the server stores the assistant's text (`transcript-recovery.ts`). So
 * the honest remedy is to give the user what they paid for rather than to refund it: re-apply the
 * turn. That also avoids inventing an ack-based refund, which would make killing a tab a way to get
 * free generations.
 *
 * ## Why this is a pure function, and why it mostly ANSWERS "ask the user"
 *
 * Re-applying an artifact WRITES FILES over a project, so a wrong `true` here is the silent-corruption
 * class §4.5.4b deviation 7 records. The rule it must not break is `NO_REPLAY`: a restored transcript
 * never re-runs its actions, because replaying a stale artifact over files that came fresh from the
 * repo overwrites new bodies with old ones.
 *
 * `NO_REPLAY` is correct, and nothing here weakens it. What it rests on is the assumption that the
 * files were ALREADY applied — which is false in exactly one case: the turn that never landed.
 *
 * ⚠️ **And "the mounted copy is older than the last turn" does NOT prove that**, which is the trap in
 * this design. A user who deliberately restored an earlier checkpoint (§4.12 undo) is *also* sitting on
 * a copy older than the last assistant turn, and auto-applying there would silently undo their undo.
 * The two states are indistinguishable from the facts below. So the answer is `offer` — the same
 * posture §4.13 takes for a divergence, where the platform never merges and always asks.
 *
 * `apply` is returned only when there is nothing to destroy: no local copy, no working copy, no repo.
 */
import type { MountSource } from './mount-source';

export interface UnappliedTurnFacts {
  /** Where the project's files were just mounted from. */
  source: MountSource['source'];

  /** Id of the newest assistant message in the restored transcript. */
  lastAssistantMessageId?: string;

  /**
   * Does that message actually contain file actions?
   *
   * A prose answer, a refusal, or a `/context` report is a real assistant turn that writes nothing —
   * offering to "apply" it would be an offer to do nothing, which reads as a broken product.
   */
  hasFileActions: boolean;

  /**
   * The message id recorded on the copy that was mounted (`LocalSnapshot.messageId`, or the server
   * working copy's).
   *
   * Equal to `lastAssistantMessageId` means that turn is already in the files — the ordinary, healthy
   * case after every successful generation, and the one that must never trigger anything.
   */
  mountedMessageId?: string;

  /**
   * The turn the user has ALREADY answered this question for (`resolvedUnappliedTurn`).
   *
   * Without this the dialog is unanswerable: both buttons only cleared the atom, so the next mount
   * re-derived the same facts and asked again — forever, about work the user had explicitly decided
   * to keep or discard. A question that ignores its own answer trains people to dismiss it, which
   * costs exactly the one time it is real.
   */
  resolvedMessageId?: string;
}

/**
 * - `none`  — already applied, nothing written that turn, or not our call to make.
 * - `apply` — safe to write: the project has no files from any source, so nothing can be overwritten.
 * - `offer` — ask. The copy on screen may be an older checkpoint the user deliberately chose.
 */
export type UnappliedTurn =
  | { action: 'none' }
  | { action: 'apply'; messageId: string }
  | { action: 'offer'; messageId: string };

export function detectUnappliedTurn(facts: UnappliedTurnFacts): UnappliedTurn {
  const { lastAssistantMessageId: last } = facts;

  if (!last || !facts.hasFileActions) {
    return { action: 'none' };
  }

  /* The healthy path: the mounted copy already carries this turn. */
  if (facts.mountedMessageId === last) {
    return { action: 'none' };
  }

  /*
   * The user already answered for this exact turn — restored it, or chose to keep the older copy.
   * Checked BEFORE the source rules so it holds no matter where the project mounts from next time.
   */
  if (facts.resolvedMessageId === last) {
    return { action: 'none' };
  }

  /*
   * 🔴 Never against a repo, and never into a divergence.
   *
   * The repo is the user's own committed history and is authoritative about its own contents; writing
   * a local artifact over it is precisely the silent merge §4.13 forbids. A divergence is the case
   * where the platform has already decided it cannot choose — resolving it by writing files would
   * answer the question the two-button dialog exists to ask.
   */
  if (facts.source === 'repo' || facts.source === 'diverged') {
    return { action: 'none' };
  }

  /*
   * Nothing exists from any source, so there is nothing this could overwrite and no earlier state the
   * user could have deliberately chosen. This is the only case where writing without asking is safe.
   */
  if (facts.source === 'empty') {
    return { action: 'apply', messageId: last };
  }

  /*
   * A copy exists and is older than the last turn. Two indistinguishable causes — a crash before the
   * checkpoint, or a deliberate §4.12 restore — with opposite correct actions. Ask.
   */
  return { action: 'offer', messageId: last };
}

/**
 * Where a user's answer to the §4.5.4c dialog is remembered, per project.
 *
 * `localStorage`, not the project record: the question is about what is on THIS device, so the answer
 * belongs to this device too. A user who keeps an older copy here has said nothing about the machine
 * they open the project on next, and a server-side flag would silence the dialog there as well — on a
 * device where the work really is missing.
 */
const RESOLVED_KEY_PREFIX = 'bt_unapplied_resolved:';

/** The turn the user has already answered for, or undefined. Never throws — storage can be blocked. */
export function resolvedUnappliedTurn(projectId: string): string | undefined {
  try {
    return localStorage.getItem(RESOLVED_KEY_PREFIX + projectId) ?? undefined;
  } catch {
    return undefined;
  }
}

/**
 * Remember that the user answered for `messageId` — by restoring it OR by keeping the older copy.
 *
 * BOTH answers are recorded, deliberately. "Leave it" is a decision, and re-asking after it is how the
 * dialog became noise; "Restore" is also final, because the files now contain that turn. Storing the
 * id rather than a boolean means the NEXT paid turn asks again on its own merits.
 */
export function resolveUnappliedTurn(projectId: string, messageId: string): void {
  try {
    localStorage.setItem(RESOLVED_KEY_PREFIX + projectId, messageId);
  } catch {
    /* Storage blocked or full: the dialog may ask again, which is the harmless direction. */
  }
}
