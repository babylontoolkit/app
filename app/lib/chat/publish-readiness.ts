/**
 * Is the project READY to be built for publish/deploy? (T17, found live 2026-07-28.)
 *
 * The Share button enables as soon as a preview exists — but a creation (or any generation) keeps
 * APPLYING file actions after the stream ends, and nothing stopped a publish from building the tree
 * mid-write. Measured live: Share clicked while `Write src/pages/Home.tsx` was still pending →
 * "Build Completed" over a half-written landing page → the half-written game published successfully.
 * The settle/quiescence work gates the CREATION pipeline only; this is the same idea applied to the
 * user-triggered builds.
 *
 * Pure decision, exhaustively testable: the hooks pass in the two live facts and act on the answer.
 * Refusal beats waiting here — a generation can run for minutes, and a button that silently blocks
 * that long reads as broken; a toast saying WHY reads as the product knowing what it is doing.
 */
export type ActionLikeStatus = 'pending' | 'running' | 'complete' | 'aborted' | 'failed';

export interface ActionLike {
  status: ActionLikeStatus;

  /**
   * The action's type. 🔴 `start` actions are EXCLUDED from the pending check: a dev server's action
   * stays `running` for the whole session BY DESIGN, so counting it makes the guard refuse every
   * publish forever — stuck closed, found live on the first post-guard publish (2026-07-28). Only
   * work that FINISHES (file/edit/shell/build) can hold a publish back.
   */
  type?: string;
}

export interface PublishReadiness {
  ready: boolean;

  /** User-facing, names the reason — never a generic "try again". */
  reason?: string;
}

export function decidePublishReadiness(input: {
  /** The chat is actively streaming a generation (`streamingState`). */
  streaming: boolean;

  /** Every action the current artifact runner knows about. */
  actions: ActionLike[];
}): PublishReadiness {
  if (input.streaming) {
    return {
      ready: false,
      reason: 'Your project is still being built by the assistant. Wait for it to finish, then share.',
    };
  }

  const stillApplying = input.actions.some(
    (action) => action.type !== 'start' && (action.status === 'pending' || action.status === 'running'),
  );

  if (stillApplying) {
    return {
      ready: false,
      reason: 'Your latest changes are still being written to the project. Give it a few seconds, then share.',
    };
  }

  return { ready: true };
}

/**
 * The live-store convenience for the four Deploy buttons and Share: one import, one call at the top
 * of the handler. Reads the same two facts every caller would otherwise assemble by hand.
 */
export async function publishReadinessNow(): Promise<PublishReadiness> {
  const [{ streamingState }, { workbenchStore }] = await Promise.all([
    import('~/lib/stores/streaming'),
    import('~/lib/stores/workbench'),
  ]);

  const actions = workbenchStore.firstArtifact?.runner.actions.get() ?? {};

  return decidePublishReadiness({
    streaming: streamingState.get(),
    actions: Object.values(actions).map((action) => {
      const a = action as { status: ActionLikeStatus; type?: string };

      return { status: a.status, type: a.type };
    }),
  });
}
