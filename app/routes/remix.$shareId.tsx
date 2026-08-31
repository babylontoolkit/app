/**
 * `/remix/:shareId` — clone a shared game into my account and open it (SPEC §4.8).
 *
 * The growth loop's landing point: the "Remix this game" badge on a play page and the Remix button in
 * the gallery both come here. It calls `/api/remix` (which requires a verified user and clones the
 * source snapshot into the caller's account), then hands the new project to the builder.
 *
 * The handoff reuses the builder's existing server-checkpoint resume path (§4.5.5): we stash the new
 * project id and navigate home, and a small loader in the builder mounts that project's files. We do
 * NOT try to mount here — the WebContainer/workbench only exist inside the builder, so the correct
 * place to load a project is where a resume already loads one.
 *
 * The working state is the SAME boot surface creations and resumes get (`BootScreen` reading
 * `bootProgress`), not a private spinner: the clone and the mount are one moment to the user, and the
 * phase atom is module-level, so it survives the `navigate('/')` and the builder's splash continues
 * the same narration seamlessly ("Making your copy…" → "Waking your workspace…" → file counts).
 * Every terminal state here (sign-in, error, unmount) resets the phase — a stale `remixing` on some
 * later open would narrate a clone that is not happening.
 */
import { useEffect, useState } from 'react';
import { useNavigate, useParams } from '@remix-run/react';
import { Header } from '~/components/header/Header';
import BackgroundRays from '~/components/ui/BackgroundRays';
import { BootScreen } from '~/components/chat/BootScreen';
import { bootProgress } from '~/lib/stores/boot-progress';
import { setPendingRemix } from '~/lib/persistence/pending-remix';
import { describeAuthFailure, requestSignIn } from '~/lib/stores/auth-gate';

type State =
  | { kind: 'working' }

  /** Not signed in. The gate is already open over this screen; the copy behind it explains why. */
  | { kind: 'signin' }

  /** Signed in, email unconfirmed — a different problem, and a sign-in form does not solve it. */
  | { kind: 'verify'; message: string }
  | { kind: 'error'; message: string };

export default function RemixRoute() {
  const { shareId } = useParams();
  const navigate = useNavigate();
  const [state, setState] = useState<State>({ kind: 'working' });

  useEffect(() => {
    let cancelled = false;
    let handedOff = false;

    bootProgress.set({ step: 'remixing' });

    (async () => {
      try {
        const response = await fetch('/api/remix', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ shareId }),
        });

        if (cancelled) {
          return;
        }

        const data = (await response.json()) as { projectId?: string; message?: string };

        /*
         * 🔴 `401` AND `403` ARE DIFFERENT ANSWERS AND USED TO SHARE A SCREEN.
         *
         * Both landed on "Sign in to remix" with a link to `/`. For an anonymous visitor that was
         * merely a dead end — the intent was dropped, so signing in returned them to the dashboard and
         * the game they clicked Remix on was gone. For a signed-in user whose email is unconfirmed it
         * was actively wrong: they would sign in again, succeed, and hit the identical refusal, with
         * nothing anywhere naming the real problem.
         *
         * The gate now opens over this screen carrying the remix URL, so finishing sign-in re-enters
         * this route and the clone completes by itself (§4.5.1 — the intent survives auth).
         */
        const failure = describeAuthFailure(response.status, data.message);

        if (failure.kind === 'verify') {
          setState({ kind: 'verify', message: failure.message });
          return;
        }

        if (failure.kind === 'signin') {
          setState({ kind: 'signin' });
          requestSignIn({
            reason: 'Sign in to make your own copy of this game.',
            redirectTo: window.location.pathname + window.location.search,
          });

          return;
        }

        if (response.ok && data.projectId) {
          /*
           * Hand the new project to the builder's resume path. The `remixing` phase rides along —
           * the builder's mount narration overwrites it and its `finally` resets it.
           */
          handedOff = true;
          setPendingRemix(data.projectId);
          navigate('/', { replace: true });

          return;
        }

        setState({ kind: 'error', message: data.message ?? 'Could not remix this game.' });
      } catch {
        if (!cancelled) {
          setState({ kind: 'error', message: 'Could not reach the server. Please try again.' });
        }
      }
    })();

    return () => {
      cancelled = true;

      // A hand-off keeps the phase alive across navigate('/'); every other exit clears it.
      if (!handedOff) {
        bootProgress.set({ step: 'idle' });
      }
    };
  }, [shareId, navigate]);

  useEffect(() => {
    // Terminal states end the narration even while the route stays on screen.
    if (state.kind !== 'working') {
      bootProgress.set({ step: 'idle' });
    }
  }, [state.kind]);

  return (
    <div className="flex flex-col h-full w-full bg-bolt-elements-background-depth-1">
      <BackgroundRays />
      <Header />
      <main className="flex-1 flex items-center justify-center">
        {state.kind === 'working' ? (
          <BootScreen />
        ) : (
          <div className="text-center max-w-md px-6">
            {state.kind === 'signin' && (
              <>
                <h1 className="text-xl font-semibold text-bolt-elements-textPrimary">Sign in to remix</h1>
                <p className="mt-2 text-bolt-elements-textSecondary">
                  Remixing makes your own editable copy of this game. Sign in and we will pick up right here.
                </p>
                <button
                  onClick={() =>
                    requestSignIn({
                      reason: 'Sign in to make your own copy of this game.',
                      redirectTo: window.location.pathname + window.location.search,
                    })
                  }
                  className="inline-block mt-4 px-4 py-2 rounded-lg bg-accent-500 text-white hover:bg-bolt-elements-button-primary-backgroundHover"
                >
                  Sign in
                </button>
              </>
            )}
            {state.kind === 'verify' && (
              <>
                <h1 className="text-xl font-semibold text-bolt-elements-textPrimary">Verify your email first</h1>
                <p className="mt-2 text-bolt-elements-textSecondary">{state.message}</p>
              </>
            )}
            {state.kind === 'error' && (
              <>
                <h1 className="text-xl font-semibold text-bolt-elements-textPrimary">Couldn't remix</h1>
                <p className="mt-2 text-bolt-elements-textSecondary">{state.message}</p>
              </>
            )}
          </div>
        )}
      </main>
    </div>
  );
}
