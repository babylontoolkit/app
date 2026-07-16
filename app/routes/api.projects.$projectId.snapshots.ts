/**
 * Checkpoints, server side (SPEC §4.5.4b, §4.5.5, §4.12).
 *
 * ## 🔴 The write path is CLOSED (§4.5.4b)
 *
 * This route used to be how every project got stored: the browser POSTed the whole
 * `SerializedFileMap` here after each generation, and the platform kept a copy of every project
 * forever. Repo-primary persistence ends that. The user's game lives in their own repo, and before
 * they save it lives only in their browser (`lib/persistence/local-snapshots.ts`). The platform keeps
 * the project record, the chat, and the repo pointer — **never the code**.
 *
 * So POST refuses. It is not merely uncalled: an uncalled route that stores a whole project on our
 * servers is a door, and the whole point of §4.5.4b is that the door is not there. Someone adding a
 * "back up my work" button in good faith would find this and use it, and the platform would silently
 * be a file host again — no error, no test failure, just the old model back.
 *
 * The READ path stays open, and is narrower than it looks. The only snapshots that still exist server
 * side are **remix seeds**: when a user remixes a shared game, `api.remix` writes a one-time copy so
 * the clone has something to open, precisely because the source project's own repo belongs to someone
 * else and cannot be read. That copy is read once, adopted as the clone's first local checkpoint, and
 * never written to again.
 *
 * The `ObjectStore` seam beneath this is DORMANT, not removed (§4.5.4b) — it stays the fallback if
 * repo-primary ever needs one, and it still serves template pins and play builds under their own
 * prefixes.
 *
 * The payload is a `SerializedFileMap` — the byte-faithful codec from spec/binary-files.md — so a
 * seed→restore round-trip preserves PNGs, GLBs and WASM exactly.
 */
import { json, type ActionFunctionArgs, type LoaderFunctionArgs } from '@remix-run/cloudflare';
import { requireUser } from '~/lib/.server/supabase/auth';
import { requireOwnedProject } from '~/lib/.server/projects/ownership';
import { getSnapshotStore } from '~/lib/.server/projects/store';
import { errorResponse } from '~/lib/.server/http';

/** The version history: metadata only. The payloads are megabytes and the list view needs none of them. */
export async function loader({ request, params, context }: LoaderFunctionArgs) {
  try {
    const user = await requireUser(request, context);
    const project = await requireOwnedProject(user, params.projectId!, context);

    const snapshots = await getSnapshotStore(context).listByProject(project.id);

    return json({
      currentSnapshotId: project.currentSnapshotId ?? null,
      snapshots: snapshots.map((s) => ({
        id: s.id,
        label: s.label,
        messageId: s.messageId,
        createdAt: s.createdAt,
        fileCount: s.fileManifest.length,
        totalBytes: s.fileManifest.reduce((sum, f) => sum + f.size, 0),
      })),
    });
  } catch (error) {
    return errorResponse(error);
  }
}

/**
 * Refused (§4.5.4b). The platform does not store the user's game code.
 *
 * Two walls first, then the refusal — so this cannot be used to probe which project ids exist. An
 * unowned id must 404 here exactly as it does everywhere else (§4.5.3), which it would not if we
 * returned 405 before checking.
 *
 * 405, not 404: unlike the upstream LLM routes (which 404 so they do not advertise a disabled path to
 * the internet), this URL legitimately exists and answers GET. Hiding it would make the read path look
 * broken. The message says where checkpoints actually live, because the person who hits this is a
 * developer of ours reaching for the old behaviour, not an attacker.
 */
export async function action({ request, params, context }: ActionFunctionArgs) {
  try {
    const user = await requireUser(request, context);
    await requireOwnedProject(user, params.projectId!, context);

    return json(
      {
        error: true,
        message:
          'Projects are not stored on the platform (§4.5.4b). Checkpoints live in the browser, and saved work lives in your linked repository.',
      },
      { status: 405 },
    );
  } catch (error) {
    return errorResponse(error);
  }
}
