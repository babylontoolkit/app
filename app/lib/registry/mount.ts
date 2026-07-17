/**
 * Writing template files into the WebContainer (SPEC §4.4, `spec/binary-files.md`).
 *
 * Binaries are written here, OUT OF BAND, and never routed through a `boltArtifact`: the artifact is
 * a TEXT protocol — the action runner UTF-8 encodes whatever it is handed, so a PNG round-tripped
 * through it arrives corrupted — and its contents reach the model, which principle 10 forbids.
 */
import type { TemplateFile } from '~/types/template';
import { base64ToBytes } from '~/lib/binary/binary-files';
import { webcontainer } from '~/lib/webcontainer';
import { workbenchStore } from '~/lib/stores/workbench';
import { createScopedLogger } from '~/utils/logger';

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
 * Framework-required runtime assets (SPEC §4.4). The preloader ESM-imports the bundled copies under
 * `src/babylon/assets/`, and ALSO fetches these from `public/` at runtime — so they exist in two
 * places on purpose. The starter ships only the bundled copies; creation makes the `public/` ones.
 *
 * They are the canonical smoke test that the binary layer is honest: they were the observed
 * casualties of the upstream binary bug.
 */
const FRAMEWORK_PUBLIC_ASSETS = ['babylon.png', 'spinner.png'];

/** Write binary template files into the container as real bytes. */
export async function writeBinaryFiles(files: TemplateFile[]): Promise<void> {
  const container = await webcontainer;

  for (const file of files) {
    const dir = file.path.split('/').slice(0, -1).join('/');

    try {
      if (dir) {
        await container.fs.mkdir(dir, { recursive: true });
      }

      await container.fs.writeFile(file.path, base64ToBytes(file.content));
    } catch (error) {
      logger.error(`Failed to write binary file: ${file.path}`, error);
      throw new Error(`Failed to mount template asset "${file.path}" — the project would be missing assets.`);
    }
  }

  logger.info(`Mounted ${files.length} binary asset(s)`);
}

/**
 * Write the project's TEXT files into the container (SPEC §4.2.8).
 *
 * The artifact is a channel to the MODEL that happens to also write files; this is the plain
 * filesystem. Since the agent proxy already shows the model the whole project every turn — built
 * from the file map, which the watcher populates from exactly these writes — inlining the files into
 * the creation artifact as well sent every one of them TWICE, forever, in an assistant message that
 * never leaves the history. So nothing is inlined: the starter lands here, and the artifact carries
 * only `npm install` and `npm run dev`.
 *
 * Awaited BEFORE the artifact is returned, so every file is on disk by the time `npm install` runs.
 */
export async function writeTextFiles(files: TemplateFile[]): Promise<void> {
  if (files.length === 0) {
    return;
  }

  const container = await webcontainer;

  for (const file of files) {
    const dir = file.path.split('/').slice(0, -1).join('/');

    try {
      if (dir) {
        await container.fs.mkdir(dir, { recursive: true });
      }

      await container.fs.writeFile(file.path, file.content);
    } catch (error) {
      logger.error(`Failed to write file: ${file.path}`, error);
      throw new Error(`Failed to mount "${file.path}" — the project would be incomplete.`);
    }
  }

  logger.info(`Mounted ${files.length} text file(s)`);
}

/**
 * Copy `src/babylon/assets/{babylon,spinner}.png` → `public/`, then VERIFY both landed.
 *
 * Verification is the point: a silent failure here produces a project whose preloader 404s, which is
 * exactly the class of bug the binary work exists to make impossible.
 */
export async function ensureFrameworkPublicAssets(files: TemplateFile[]): Promise<void> {
  const container = await webcontainer;

  for (const name of FRAMEWORK_PUBLIC_ASSETS) {
    const target = `public/${name}`;

    if (files.some((file) => file.path === target)) {
      continue;
    }

    const source =
      files.find((file) => file.isBinary && file.path === `src/babylon/assets/${name}`) ??
      files.find((file) => file.isBinary && file.path.endsWith(`/assets/${name}`));

    if (!source) {
      logger.warn(`Framework asset ${name} not found in template — skipping public/ copy`);
      continue;
    }

    await container.fs.mkdir('public', { recursive: true });
    await container.fs.writeFile(target, base64ToBytes(source.content));

    const written = await container.fs.readFile(target).catch(() => null);

    if (!written || written.byteLength === 0) {
      throw new Error(`Framework asset ${target} did not survive the write — the preloader would 404.`);
    }

    logger.info(`Copied ${source.path} -> ${target} (${written.byteLength} bytes)`);
  }
}
