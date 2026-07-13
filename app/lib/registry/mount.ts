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
import { createScopedLogger } from '~/utils/logger';

const logger = createScopedLogger('TemplateMount');

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
