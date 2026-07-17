/**
 * Mounting template files into the WebContainer (SPEC §4.4, §4.2.8, `spec/binary-files.md`).
 *
 * The whole starter lands in ONE atomic `container.mount(tree)` — never a `boltArtifact` (that is a
 * TEXT protocol: the action runner UTF-8 encodes whatever it is handed, so a PNG round-tripped
 * through it arrives corrupted, and its contents reach the model, which principle 10 forbids). The
 * atomic mount also replaced 64 sequential awaited `fs.writeFile` calls that raced a cold WebContainer
 * boot — see `mount-tree.ts` for that story. The tree building is pure and lives there; this module
 * performs the mount and the post-mount visibility wait.
 */
import type { TemplateFile } from '~/types/template';
import { webcontainer } from '~/lib/webcontainer';
import { workbenchStore } from '~/lib/stores/workbench';
import { createScopedLogger } from '~/utils/logger';
import { buildFileSystemTree, withFrameworkPublicAssets } from './mount-tree';

const logger = createScopedLogger('TemplateMount');

/**
 * How long to wait for the file WATCHER to report a mount we already wrote (§4.4, §4.2.8).
 *
 * Generous because the cost of giving up early is the bug below; bounded because the New Project
 * button must never hang on a watcher that is never going to fire.
 */
const MOUNT_VISIBLE_TIMEOUT_MS = 15_000;
const MOUNT_POLL_MS = 50;

/**
 * Wait until the files we just wrote are VISIBLE IN THE STORE — not merely on disk (§4.4, §4.2.8).
 *
 * 🔴 **Without this the model builds the game blind, and it cost us nothing to notice for months.**
 *
 * `writeTextFiles` awaits `container.fs.writeFile`, so the bytes are unquestionably on disk when it
 * resolves. But the model never reads the disk: it reads `workbenchStore.files`, which is populated by
 * a WATCHER, asynchronously, some time after the write. Creation fired the generation the moment the
 * writes resolved, so the request went out against a half-filled map.
 *
 * Measured live (2026-07-16), "make me a kart racer where the cars are shopping carts":
 *
 *     agent request fired at  5405ms  →   7 files sent
 *     store filled at         5531ms  →  0 → 78 files
 *
 * **126 milliseconds.** The model was asked to write a racing game having been shown seven files, none
 * of them source: no `src/scripts/KartRacerMode.ts` (the class §4.4b had just scaffolded FOR it), no
 * `src/babylon/classes/` (the demo library it copies from), no `globals.ts`. It said so, in the
 * product, to the owner: *"I did not edit that mode — I can't see its source."* We read that as the
 * model being cautious. It was the model being accurate.
 *
 * This also silently falsified the §4.2.8 invariant that "everything the agent must READ stays fully
 * visible" — on the most expensive generation in the product, the one that writes the whole game.
 *
 * It never threw and never showed up in a token count (a SMALLER context looks like a cheaper turn), so
 * only the output quality suffered. That is the §4.2.8 failure mode exactly: a context regression
 * throws nothing and breaks nothing — it just quietly makes the product worse.
 */
export async function waitForMountVisible(paths: string[], timeoutMs = MOUNT_VISIBLE_TIMEOUT_MS): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  const seen = () => {
    const map = workbenchStore.files.get();
    return paths.every((path) => map[path]?.type === 'file');
  };

  while (!seen()) {
    if (Date.now() > deadline) {
      /*
       * Proceed anyway. A generation with a thin context is bad; a New Project button that never
       * returns is worse, and §1.3 principle 0 says degrade rather than refuse. Loud, because this is
       * the only signal that the model is about to be flown blind.
       */
      logger.error(
        `Mount not visible in the file store after ${timeoutMs}ms — generating with a PARTIAL context. ` +
          `Missing: ${paths.filter((path) => workbenchStore.files.get()[path]?.type !== 'file').join(', ')}`,
      );
      return false;
    }

    await new Promise((resolve) => setTimeout(resolve, MOUNT_POLL_MS));
  }

  return true;
}

/**
 * Mount the WHOLE starter into the container in one atomic operation (SPEC §4.4, §4.2.8).
 *
 * 🔴 **This replaced 64 sequential awaited `fs.writeFile` calls, and the replacement is the bug fix,
 * not a tidy-up.** Per-file writes raced a cold WebContainer boot: on the first project after a page
 * load, the writes and the boot interleaved and `npm install` ran against an empty `/home/project` —
 * ENOENT, silently, on the most expensive path in the product (measured live 2026-07-17). A single
 * `container.mount(tree)` is atomic (it cannot half-apply), faster, and gated on a booted container by
 * construction. The framework `public/` assets (§4.4) are folded into the tree, so their copy is part
 * of the same atomic mount rather than a follow-up write with its own race.
 *
 * Mounted with NO `mountPoint`: `container.mount` resolves relative to the working directory
 * (`/home/project`), the same base `container.fs` uses — so the workdir-relative template paths
 * (`package.json`, `src/main.ts`) land exactly where the old per-file writes put them. Passing the
 * ABSOLUTE workdir as a mountPoint doubles it to `/home/project/home/project` and throws ENOENT
 * (found live 2026-07-17) — do not reintroduce a mountPoint here.
 *
 * VERIFIED after the fact: the original defect was `npm install` on an empty dir that nothing noticed.
 * A mount that did not land must be LOUD (throw → the New Project path surfaces it) rather than a
 * silently broken project. `package.json` at the root is the sentinel every starter has.
 *
 * The tree is NOT inlined into the creation artifact — the agent proxy already shows the model the
 * whole project every turn from the file map, so inlining would send every file TWICE, forever
 * (§4.2.8). The artifact carries only `npm install` and `npm run dev`.
 */
export async function mountTemplate(files: TemplateFile[]): Promise<void> {
  if (files.length === 0) {
    return;
  }

  const container = await webcontainer;
  const tree = buildFileSystemTree(withFrameworkPublicAssets(files));

  try {
    await container.mount(tree);
  } catch (error) {
    logger.error('Failed to mount the starter template', error);
    throw new Error('Failed to mount the starter template — the project would be incomplete.');
  }

  const sentinel = await container.fs.readFile('package.json').catch(() => null);

  if (!sentinel || sentinel.byteLength === 0) {
    throw new Error('The starter template did not mount — the project would be empty.');
  }

  logger.info(`Mounted ${files.length} file(s) atomically`);
}
