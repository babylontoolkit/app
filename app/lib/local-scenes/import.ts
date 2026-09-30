/**
 * Import a scene from the user's local Unity dev server into the project (D22).
 *
 * Client-side and bridge-independent: the browser fetches the scene straight from `localhost` and
 * writes the bytes into the sandbox under `public/scenes/<name>/` — never through a server route, and
 * never as text (a `Uint8Array` all the way, so the copy is byte-faithful).
 *
 * `createFile` (the default writer) selects each file and schedules the saved-copy refresh itself, so
 * this module does not call `refreshSavedCopiesSoon` again. The bytes arrive as a `Uint8Array`, so a
 * `.gltf` lands in the file map as `isBinary` — correct: it is opaque to the model anyway (D23).
 */
import { workbenchStore } from '~/lib/stores/workbench';
import { WORK_DIR } from '~/utils/constants';
import { planSceneImport, type SceneImportPlan } from './plan';
import { lastPathSegment } from './url';

export interface SceneImportResult {
  ok: boolean;
  written: string[];
  skipped: SceneImportPlan['skipped'];
  message: string;
}

interface ImportDeps {
  fetch?: typeof fetch;
  exists?: (path: string) => boolean;
  write?: (path: string, bytes: Uint8Array) => Promise<boolean>;
}

/** How an import that refused to overwrite begins its message (the UI asks, then retries with overwrite). */
export const FILES_EXIST_PREFIX = 'These files already exist';

const describeError = (error: unknown) => (error instanceof Error ? error.message : String(error));

export async function importLocalScene(
  input: { url: string; overwrite: boolean },
  deps?: ImportDeps,
): Promise<SceneImportResult> {
  const doFetch = deps?.fetch ?? globalThis.fetch.bind(globalThis);
  const exists = deps?.exists ?? ((path: string) => Boolean(workbenchStore.files.get()[path]));
  const write = deps?.write ?? ((path: string, bytes: Uint8Array) => workbenchStore.createFile(path, bytes));

  const { url } = input;
  const written: string[] = [];
  const fail = (message: string, skipped: SceneImportPlan['skipped'] = []): SceneImportResult => ({
    ok: false,
    written: [...written],
    skipped,
    message,
  });

  /*
   * ---- refuse an unsafe scene name BEFORE any network or write ----
   * The planner's containment rules depend only on the URL for the scene file itself, so a URL whose
   * own basename would land outside `public/scenes/<name>/` is refused without fetching anything.
   */
  const preflight = planSceneImport(url, null);

  if (preflight.error) {
    return fail(preflight.error);
  }

  /* ---- the scene itself ---- */

  let sceneBytes: Uint8Array;

  try {
    const response = await doFetch(url, { cache: 'no-store' });

    if (!response.ok) {
      return fail(`The scene server answered ${response.status} for ${url}.`);
    }

    sceneBytes = new Uint8Array(await response.arrayBuffer());
  } catch (error) {
    return fail(`Could not fetch ${url}: ${describeError(error)}`);
  }

  /*
   * A `.gz.gltf` is served with `Content-Encoding: gzip`, so the browser has already decompressed it —
   * these bytes are JSON either way.
   */
  let gltfJson: unknown | null = null;

  if (lastPathSegment(url).toLowerCase().endsWith('.gltf')) {
    try {
      gltfJson = JSON.parse(new TextDecoder().decode(sceneBytes));
    } catch {
      return fail(`${url} is not valid glTF JSON, so its textures and buffers cannot be found.`);
    }
  }

  const plan = planSceneImport(url, gltfJson);

  if (plan.error || plan.files.length === 0) {
    return fail(plan.error ?? `Refusing to import ${url}: nothing safe to write.`, plan.skipped);
  }

  /* ---- never overwrite without the user's say-so ---- */

  const existing = plan.files.filter((file) => exists(`${WORK_DIR}/${file.dest}`)).map((file) => file.dest);

  if (existing.length > 0 && !input.overwrite) {
    return fail(
      `${FILES_EXIST_PREFIX}: ${existing.join(', ')} — confirm with the user, then import again with overwrite.`,
      plan.skipped,
    );
  }

  /* ---- write: the scene first, then everything it references ---- */

  const base = `public/scenes/${plan.name}/`;
  const skipped: SceneImportPlan['skipped'] = [...plan.skipped];

  for (const [index, file] of plan.files.entries()) {
    let bytes: Uint8Array;

    if (index === 0) {
      bytes = sceneBytes;
    } else {
      const uri = file.dest.slice(base.length);

      try {
        const response = await doFetch(file.url, { cache: 'no-store' });

        if (!response.ok) {
          /* A file named only in `extras` metadata may never have been written by the exporter. */
          if (file.optional) {
            skipped.push({ uri, reason: `named in the scene metadata, but the server answered ${response.status}` });
            continue;
          }

          return fail(`Could not fetch ${uri}: ${response.status}`, skipped);
        }

        bytes = new Uint8Array(await response.arrayBuffer());
      } catch (error) {
        if (file.optional) {
          skipped.push({ uri, reason: `named in the scene metadata, but could not be fetched` });
          continue;
        }

        return fail(`Could not fetch ${uri}: ${describeError(error)}`, skipped);
      }
    }

    const ok = await write(`${WORK_DIR}/${file.dest}`, bytes);

    if (!ok) {
      return fail(`Could not write ${file.dest} into the project.`, skipped);
    }

    written.push(file.dest);
  }

  workbenchStore.refreshPreviews();

  const sceneBasename = plan.files[0].dest.slice(base.length);
  let message = `Imported ${written.length} file(s) into public/scenes/${plan.name}/. Point the game at "scenes/${plan.name}/${sceneBasename}".`;

  if (skipped.length > 0) {
    message += ` Skipped: ${skipped.map((entry) => `${entry.uri} (${entry.reason})`).join('; ')}.`;
  }

  return { ok: true, written, skipped, message };
}

/**
 * The client half of the `import_local_scene` tool (D22): run the import the model asked for and post
 * the outcome to `/api/agent/tool-result`, which unblocks the waiting server-side `execute`. A throw is
 * reported as `error`, never swallowed — the model must learn the import did not happen.
 */
export async function handleLocalSceneCall(
  part: { generationId: string; toolCallId: string; url: string; overwrite?: boolean },
  deps?: {
    importScene?: typeof importLocalScene;
    post?: (body: Record<string, unknown>) => Promise<unknown>;
  },
): Promise<void> {
  const importScene = deps?.importScene ?? importLocalScene;
  const post =
    deps?.post ??
    ((body: Record<string, unknown>) =>
      fetch('/api/agent/tool-result', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      }));

  let body: Record<string, unknown>;

  try {
    const r = await importScene({ url: part.url, overwrite: part.overwrite === true });
    body = {
      generationId: part.generationId,
      toolCallId: part.toolCallId,
      result: { message: r.message, ok: r.ok },
    };
  } catch (error) {
    body = { generationId: part.generationId, toolCallId: part.toolCallId, error: describeError(error) };
  }

  await Promise.resolve(post(body)).catch(() => undefined);
}
