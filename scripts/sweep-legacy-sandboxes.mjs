/**
 * One-shot cutover sweep: reap the sandboxes the per-USER registry left behind (plan T4,
 * `spec/sandbox-codesandbox.md`).
 *
 *   node scripts/sweep-legacy-sandboxes.mjs            # DRY RUN — prints, deletes nothing
 *   node scripts/sweep-legacy-sandboxes.mjs --apply    # actually delete
 *
 * ## Why this exists
 *
 * Before migration 0013 a sandbox belonged to a USER, at `sandboxes/{userId}.json` in object storage.
 * Projects now own their VM (`projects.sandbox_id`), and that migration deleted the registry — which
 * ORPHANS every VM it named: the record is gone, so nothing in the product can address those machines
 * again, and each one keeps billing until someone finds it by hand. That is exactly the "bytes
 * outliving the record that named them" failure the project-delete path exists to prevent, arriving
 * through the cutover instead of through a delete.
 *
 * ## What it considers an orphan
 *
 * Every sandbox in the workspace tagged `btk` (everything this platform creates carries it) that is
 * NOT referenced by `sandbox_id` on a live project row. Legacy `sandboxes/*.json` records are read
 * only to EXPLAIN an orphan ("this was user U's registry VM") and to sweep the prefix afterwards —
 * they are never the source of truth for what to keep, because a legacy record may well point at a
 * VM a project has since adopted.
 *
 * 🔴 Conservative by construction, because the failure direction is destroying a live user's project:
 *
 *   - the project rows must be READABLE. If the store cannot be reached (Supabase misconfigured, no
 *     `.data/projects`), the script REFUSES rather than concluding "no project references anything"
 *     and deleting the entire fleet.
 *   - a sandbox younger than `--min-age-hours` (default 24) is never touched, so a VM created between
 *     the row read and the delete cannot be reaped before its project records it.
 *   - `--apply` is required; there is no `--force`, and nothing here writes a project row.
 */
import fs from 'node:fs';
import path from 'node:path';

const APPLY = process.argv.includes('--apply');
const MIN_AGE_HOURS = readNumberFlag('--min-age-hours', 24);

/** Resolve a var from process.env, then from .env / .env.local (last file wins, like a real load). */
function resolveEnv(name) {
  if (process.env[name]) {
    return process.env[name];
  }

  for (const file of ['.env', '.env.local']) {
    const full = path.join(process.cwd(), file);

    if (!fs.existsSync(full)) {
      continue;
    }

    for (const raw of fs.readFileSync(full, 'utf8').split('\n')) {
      const line = raw.trim();

      if (!line || line.startsWith('#')) {
        continue;
      }

      const eq = line.indexOf('=');

      if (eq < 0) {
        continue;
      }

      if (line.slice(0, eq).trim() === name) {
        process.env[name] = line
          .slice(eq + 1)
          .trim()
          .replace(/^["']|["']$/g, '');
      }
    }
  }

  return process.env[name];
}

function readNumberFlag(flag, fallback) {
  const index = process.argv.indexOf(flag);

  if (index < 0) {
    return fallback;
  }

  const value = Number(process.argv[index + 1]);

  return Number.isFinite(value) && value >= 0 ? value : fallback;
}

const API_KEY = resolveEnv('CODESANDBOX_API_KEY');

if (!API_KEY) {
  console.error('✋ CODESANDBOX_API_KEY is not set. Nothing to sweep — this is the WebContainer build.');
  process.exit(1);
}

const DATA_DIR = resolveEnv('PLATFORM_DATA_DIR') || path.join(process.cwd(), '.data');

/* ----------------------------------------------------------- project rows */

/**
 * Every sandbox id a live project claims.
 *
 * Returns `null` — not an empty set — when the rows could not be read. The caller REFUSES on null:
 * an unreadable store and a store with no references are indistinguishable by their result and
 * opposite in consequence.
 */
async function referencedSandboxIds() {
  const url = resolveEnv('SUPABASE_URL');
  const serviceKey = resolveEnv('SUPABASE_SERVICE_ROLE_KEY');

  if (url && serviceKey) {
    try {
      const { createClient } = await import('@supabase/supabase-js');
      const db = createClient(url, serviceKey, { auth: { persistSession: false } });
      const { data, error } = await db.from('projects').select('id, user_id, sandbox_id');

      if (error) {
        console.error(`✋ Could not read projects from Supabase: ${error.message}`);
        return null;
      }

      return {
        source: `Supabase (${data.length} project rows)`,
        ids: new Set(data.map((row) => row.sandbox_id).filter(Boolean)),
      };
    } catch (error) {
      console.error(`✋ Could not read projects from Supabase: ${error.message}`);
      return null;
    }
  }

  const dir = path.join(DATA_DIR, 'projects');

  if (!fs.existsSync(dir)) {
    console.error(`✋ No project store found (no Supabase config, and ${dir} does not exist).`);
    return null;
  }

  const ids = new Set();
  let rows = 0;

  for (const name of fs.readdirSync(dir).filter((n) => n.endsWith('.json'))) {
    try {
      const row = JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8'));
      rows++;

      if (row?.sandboxId) {
        ids.add(row.sandboxId);
      }
    } catch {
      console.error(`✋ Project row ${name} could not be parsed — refusing to sweep on partial data.`);
      return null;
    }
  }

  return { source: `local filesystem (${rows} project rows at ${dir})`, ids };
}

/* -------------------------------------------------- legacy registry records */

const LEGACY_PREFIX = 'sandboxes/';

/** The legacy per-user records, as `{ key, userId, sandboxId }`. Explanatory, never authoritative. */
async function legacyRecords() {
  const bucket = resolveEnv('S3_BUCKET');

  if (bucket) {
    const { S3Client, ListObjectsV2Command, GetObjectCommand, DeleteObjectCommand } = await import(
      '@aws-sdk/client-s3'
    );

    const client = new S3Client({
      region: resolveEnv('AWS_REGION') || 'us-east-1',
      ...(resolveEnv('AWS_ACCESS_KEY_ID') && resolveEnv('AWS_SECRET_ACCESS_KEY')
        ? {
            credentials: {
              accessKeyId: resolveEnv('AWS_ACCESS_KEY_ID'),
              secretAccessKey: resolveEnv('AWS_SECRET_ACCESS_KEY'),
            },
          }
        : {}),
    });

    const records = [];
    let token;

    do {
      const page = await client.send(
        new ListObjectsV2Command({ Bucket: bucket, Prefix: LEGACY_PREFIX, ContinuationToken: token }),
      );

      for (const object of page.Contents ?? []) {
        const body = await client.send(new GetObjectCommand({ Bucket: bucket, Key: object.Key }));
        records.push(parseRecord(object.Key, await body.Body.transformToString()));
      }

      token = page.IsTruncated ? page.NextContinuationToken : undefined;
    } while (token);

    return {
      where: `s3://${bucket}/${LEGACY_PREFIX}`,
      records: records.filter(Boolean),
      remove: async (key) => client.send(new DeleteObjectCommand({ Bucket: bucket, Key: key })),
    };
  }

  const dir = path.join(DATA_DIR, 'storage', LEGACY_PREFIX);

  if (!fs.existsSync(dir)) {
    return { where: dir, records: [], remove: async () => {} };
  }

  const records = fs
    .readdirSync(dir)
    .filter((name) => name.endsWith('.json'))
    .map((name) => parseRecord(LEGACY_PREFIX + name, fs.readFileSync(path.join(dir, name), 'utf8')))
    .filter(Boolean);

  return {
    where: dir,
    records,
    remove: async (key) => fs.rmSync(path.join(DATA_DIR, 'storage', key), { force: true }),
  };
}

function parseRecord(key, text) {
  try {
    const parsed = JSON.parse(text);

    return {
      key,
      userId: path.basename(key, '.json'),
      sandboxId: typeof parsed?.sandboxId === 'string' ? parsed.sandboxId : undefined,
    };
  } catch {
    // A record we cannot read still gets swept — it names nothing, so it can only be debris.
    return { key, userId: path.basename(key, '.json'), sandboxId: undefined };
  }
}

/* ------------------------------------------------------------------- sweep */

const referenced = await referencedSandboxIds();

if (!referenced) {
  console.error('   Nothing was deleted. Fix the project-store access and re-run.');
  process.exit(1);
}

const { CodeSandbox } = await import('@codesandbox/sdk');
const sdk = new CodeSandbox(API_KEY);

const listed = [];
let page = 1;

for (;;) {
  /*
   * MEASURED: `pageSize: 100` is REFUSED by the API ("page_size: maximum 100") — their documented
   * maximum is exclusive in practice. 50 is inside it, and the loop below pages regardless, so the
   * only cost of a smaller page is one more request.
   */
  const response = await sdk.sandboxes.list({ tags: ['btk'], pagination: { page, pageSize: 50 } });
  listed.push(...response.sandboxes);

  if (!response.pagination?.nextPage) {
    break;
  }

  page = response.pagination.nextPage;
}

const legacy = await legacyRecords();
const legacyBySandboxId = new Map(legacy.records.filter((r) => r.sandboxId).map((r) => [r.sandboxId, r]));

const cutoff = Date.now() - MIN_AGE_HOURS * 3600_000;

const orphans = [];
const kept = [];
const tooYoung = [];

for (const sandbox of listed) {
  if (referenced.ids.has(sandbox.id)) {
    kept.push(sandbox);
    continue;
  }

  /*
   * 🔴 The age floor does NOT apply to a VM a legacy record names, and that is the whole point of
   * reading those records. The floor exists for ONE hazard: a sandbox forked between this script's
   * row read and its delete, which no project has recorded yet. A legacy-registry VM cannot be that
   * — the registry is deleted, nothing writes those records any more, and the ownership check above
   * has already spared any that a project has since adopted. Applying the floor to it would mean the
   * one machine this script was written to find is the one it silently skips, which is what the
   * first run did.
   */
  const namedByLegacy = legacyBySandboxId.has(sandbox.id);

  if (!namedByLegacy && new Date(sandbox.createdAt).getTime() > cutoff) {
    tooYoung.push(sandbox);
    continue;
  }

  orphans.push(sandbox);
}

console.log(`\n${APPLY ? '🔥 APPLY' : '🔎 DRY RUN'} — legacy sandbox sweep\n`);
console.log(`Project references : ${referenced.ids.size} sandbox id(s) from ${referenced.source}`);
console.log(`Tagged "btk" at the provider : ${listed.length}`);
console.log(`Legacy registry records : ${legacy.records.length} at ${legacy.where}`);
console.log(`Referenced by a live project (KEEP) : ${kept.length}`);
console.log(`Younger than ${MIN_AGE_HOURS}h (SKIP) : ${tooYoung.length}`);
console.log(`Orphans to delete : ${orphans.length}\n`);

for (const sandbox of orphans) {
  const owner = legacyBySandboxId.get(sandbox.id);

  console.log(
    `  ${sandbox.id}  ${sandbox.title ?? '(untitled)'}  created ${new Date(sandbox.createdAt).toISOString()}` +
      (owner ? `  ← legacy registry for user ${owner.userId}` : '  ← no legacy record (unreferenced)'),
  );
}

if (legacy.records.length) {
  console.log(`\nLegacy records to remove from ${legacy.where}:`);

  for (const record of legacy.records) {
    console.log(`  ${record.key}${record.sandboxId ? ` → ${record.sandboxId}` : ' (unparseable)'}`);
  }
}

if (!APPLY) {
  console.log('\nDry run — nothing was deleted. Re-run with --apply to execute.\n');
  process.exit(0);
}

let deleted = 0;
let failed = 0;

for (const sandbox of orphans) {
  try {
    // Shutdown first: MEASURED, deleting a RUNNING VM can fail with "An unexpected error occurred".
    await sdk.sandboxes.shutdown(sandbox.id).catch(() => {});
    await sdk.sandboxes.delete(sandbox.id);
    deleted++;
    console.log(`  deleted ${sandbox.id}`);
  } catch (error) {
    failed++;
    console.error(`  FAILED ${sandbox.id}: ${error.message}`);
  }
}

/*
 * The prefix goes LAST and unconditionally: it is the record that named those VMs, so removing it
 * before the VMs would strand any that failed above with nothing left to find them by.
 */
for (const record of legacy.records) {
  await legacy.remove(record.key);
  console.log(`  removed ${record.key}`);
}

console.log(`\nDone. ${deleted} sandbox(es) deleted, ${failed} failed, ${legacy.records.length} legacy record(s) removed.`);
console.log(failed ? 'Re-run to retry the failures.\n' : 'The sandboxes/ prefix is now empty.\n');
