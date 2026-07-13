/**
 * Snapshot byte-identity and ownership (SPEC §4.5.3, §4.5.5, §4.12, spec/binary-files.md).
 *
 * A snapshot is the ONLY thing standing between a user and a bad generation. Two ways it can betray
 * them, both silent:
 *
 * 1. It corrupts their bytes. A restore that UTF-8s a PNG gives them back a broken game and no way to
 *    tell what happened. This is the exact upstream defect Stage 0 fixed — it must not re-enter
 *    through the persistence layer.
 * 2. It hands them someone else's project (or hands theirs to someone else).
 */
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { bytesToBase64 } from '~/lib/binary/binary-files';
import { FsObjectStore } from '~/lib/.server/storage/store';
import { FsProjectStore, FsSnapshotStore, buildManifest } from './store';
import { NotFoundError, requireOwnedProject } from './ownership';
import { setProjectStore } from './store';
import type { AuthUser } from '~/lib/.server/supabase/auth';
import type { SnapshotPayload } from './types';

let tmp: string;
let projects: FsProjectStore;
let snapshots: FsSnapshotStore;

/** Bytes that are hostile to a text codec: a PNG header, a NUL, a lone 0xFF, a UTF-8 continuation. */
const HOSTILE_BYTES = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0xff, 0xfe, 0x80, 0xc0]);

beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'snapshots-'));
  projects = new FsProjectStore(path.join(tmp, 'projects'));
  snapshots = new FsSnapshotStore(new FsObjectStore(path.join(tmp, 'objects')), path.join(tmp, 'snapshots'));
  setProjectStore(projects);
});

afterEach(async () => {
  setProjectStore(undefined);
  await fs.rm(tmp, { recursive: true, force: true });
});

const user = (id: string): AuthUser => ({
  id,
  email: `${id}@example.com`,
  emailVerified: true,
  displayName: id,
  isAdmin: false,
  isLocal: false,
});

describe('snapshot round-trip', () => {
  it('preserves binary bytes exactly through save and restore', async () => {
    const project = await projects.create({ userId: 'u1', name: 'Kart Racer', templateId: 'kart-racer' });

    const payload: SnapshotPayload = {
      'src/pages/Home.tsx': { type: 'file', content: 'export default function Home() {}', isBinary: false },
      'public/hero.png': {
        type: 'file',
        content: bytesToBase64(HOSTILE_BYTES),
        isBinary: true,
        size: HOSTILE_BYTES.length,
      },
      src: { type: 'folder' },
    };

    const snapshot = await snapshots.create({ projectId: project.id, files: payload, label: 'before physics' });
    const restored = await snapshots.read(snapshot.id);

    const hero = restored!['public/hero.png'];

    expect(hero?.type === 'file' && hero.isBinary).toBe(true);
    expect(hero?.type === 'file' && hero.content).toBe(bytesToBase64(HOSTILE_BYTES));

    // The real assertion: the bytes that come back are byte-for-byte the ones that went in.
    expect(hero?.type === 'file' && hero.size).toBe(HOSTILE_BYTES.length);
  });

  it('preserves text content exactly', async () => {
    const project = await projects.create({ userId: 'u1', name: 'Game', templateId: 'blank-canvas' });
    const source = 'const π = 3.14159;\nconst emoji = "🏎️";\n';

    const snapshot = await snapshots.create({
      projectId: project.id,
      files: { 'src/x.ts': { type: 'file', content: source, isBinary: false } },
    });

    const restored = await snapshots.read(snapshot.id);
    const file = restored!['src/x.ts'];

    expect(file?.type === 'file' && file.content).toBe(source);
  });

  /*
   * The manifest reports the file's REAL byte count, not the length of its base64 encoding (which is
   * ~4/3 larger). A manifest that reports base64 lengths makes every size readout and every integrity
   * check disagree with the bytes on disk.
   */
  it('reports true byte sizes in the manifest, not base64 lengths', () => {
    const manifest = buildManifest({
      'public/hero.png': {
        type: 'file',
        content: bytesToBase64(HOSTILE_BYTES),
        isBinary: true,
        size: HOSTILE_BYTES.length,
      },
    });

    expect(manifest[0].size).toBe(HOSTILE_BYTES.length);
    expect(manifest[0].size).toBeLessThan(bytesToBase64(HOSTILE_BYTES).length);
  });

  it('lists checkpoints oldest-first, so the version history reads forward', async () => {
    const project = await projects.create({ userId: 'u1', name: 'G', templateId: 'blank-canvas' });

    await snapshots.create({ projectId: project.id, files: {}, label: 'first' });
    await snapshots.create({ projectId: project.id, files: {}, label: 'second' });

    const list = await snapshots.listByProject(project.id);

    expect(list.map((s) => s.label)).toEqual(['first', 'second']);
  });

  /* History is append-only (§4.12): restoring never destroys the checkpoints taken after it. */
  it('keeps later checkpoints after an earlier one is restored', async () => {
    const project = await projects.create({ userId: 'u1', name: 'G', templateId: 'blank-canvas' });

    const first = await snapshots.create({ projectId: project.id, files: {}, label: 'good' });
    await snapshots.create({ projectId: project.id, files: {}, label: 'bad' });

    await projects.update(project.id, { currentSnapshotId: first.id });

    expect(await snapshots.listByProject(project.id)).toHaveLength(2);
  });
});

describe('ownership (the second wall)', () => {
  it('returns a project to its owner', async () => {
    const project = await projects.create({ userId: 'u1', name: 'Mine', templateId: 'blank-canvas' });

    expect((await requireOwnedProject(user('u1'), project.id)).id).toBe(project.id);
  });

  /*
   * Someone else's project reports 404, NOT 403. A 403 confirms the id exists, which turns the
   * endpoint into an oracle for enumerating every project id on the platform.
   */
  it("reports another user's project as 404, never 403 — no enumeration oracle", async () => {
    const project = await projects.create({ userId: 'u1', name: 'Theirs', templateId: 'blank-canvas' });

    await expect(requireOwnedProject(user('attacker'), project.id)).rejects.toThrow(NotFoundError);
    await expect(requireOwnedProject(user('attacker'), project.id)).rejects.toMatchObject({ statusCode: 404 });
  });

  it('reports a project that does not exist identically', async () => {
    await expect(requireOwnedProject(user('u1'), 'prj_nonexistent')).rejects.toMatchObject({ statusCode: 404 });
  });

  it('scopes listings to the owner', async () => {
    await projects.create({ userId: 'u1', name: 'A', templateId: 'blank-canvas' });
    await projects.create({ userId: 'u2', name: 'B', templateId: 'blank-canvas' });

    expect(await projects.listByUser('u1')).toHaveLength(1);
    expect(await projects.listByUser('u2')).toHaveLength(1);
  });
});
