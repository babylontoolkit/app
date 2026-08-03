/**
 * `/git?url=<repo>` — the second clone door, and the one `StarterTemplates` links to.
 *
 * It runs the SAME operation as the "Clone a repo" button (`~/lib/git/import-repository`), which is the
 * whole point: these were two independent implementations of one thing and they had drifted in five
 * ways, each invisible. This route's own three:
 *
 *   1. **The guard did not match its own effect.** `if (!gitReady && !historyReady) return` — `&&`,
 *      where the effect that calls it guards on `||`. The weaker one lets an import start before
 *      history is ready, so the chat it is about to be written into may not exist yet.
 *   2. **`projectId` was discarded.** The metadata was `{ gitUrl }` only, so a `/git?url=` import was
 *      never bound to the project its files had just been written into — the reloaded chat has no
 *      project to boot a sandbox for, and the imported code sits on a VM nothing points at.
 *   3. **A fixed `toast.error('Failed to import repository')`**, thrown away in favour of the server's
 *      own sentence: "connect GitHub and try again", "over the 256MB import limit", "that repository
 *      stores 12 file(s) in Git-LFS" are three different actions, and the generic string is
 *      indistinguishable from a page that did nothing.
 *
 * `StarterTemplates` needs no change of its own: it passes a URL and NO branch, which is exactly what
 * `getDefaultBranch` exists for — a link to a `master` repository used to produce "branch not found",
 * which reads to a user as "that template does not exist".
 *
 * The bespoke `LoadingOverlay` is gone too. The wait is narrated by the shared boot surface, through the
 * `cloning` → `files` → `settling` phases the module drives (§4.4a: every door that puts files in the
 * workspace is covered by the same surface, and this was the fourth one still drawing its own spinner).
 */
import { useSearchParams } from '@remix-run/react';
import { useEffect, useRef } from 'react';
import { ClientOnly } from 'remix-utils/client-only';
import { BaseChat } from '~/components/chat/BaseChat';
import { Chat } from '~/components/chat/Chat.client';
import { useChatHistory } from '~/lib/persistence';
import { importRepositoryIntoWorkspace } from '~/lib/git/import-repository';
import { toast } from 'react-toastify';

export function GitUrlImport() {
  const [searchParams] = useSearchParams();
  const { ready: historyReady, importChat } = useChatHistory();

  /*
   * A REF, not state: this must be set synchronously so a second run of the effect (React strict mode,
   * or a `searchParams` reference changing on hydration) cannot start a second import. A `useState`
   * flag is only observable on the NEXT render, which is exactly one render too late — the same class
   * of double-run that made a page load mount its project twice (§4.4a `mountedThisLoad`).
   */
  const started = useRef(false);

  useEffect(() => {
    if (!historyReady || !importChat || started.current) {
      return;
    }

    const url = searchParams.get('url');

    if (!url) {
      window.location.href = '/';
      return;
    }

    started.current = true;

    /*
     * No branch: a repository URL says nothing about whether its trunk is `main`, `master` or
     * `develop`, and the server resolves it (`getDefaultBranch`). Guessing is not a fallback here, it
     * is a wrong answer that surfaces as "repository not found".
     */
    importRepositoryIntoWorkspace({ repo: url, importChat }).then((result) => {
      if (result.ok) {
        // The hand-off navigates; there is nothing left for this page to do.
        return;
      }

      /*
       * The failure surface (`reportBootFailure`) already carries the reason and a retry, so this page
       * does NOT bounce to `/` any more — that used to throw away the only explanation the user got, a
       * fraction of a second after it appeared, and left them on a landing page wondering what happened.
       */
      toast.error(result.message ?? 'The repository could not be imported.');
    });
  }, [searchParams, historyReady, importChat]);

  return <ClientOnly fallback={<BaseChat />}>{() => <Chat />}</ClientOnly>;
}
