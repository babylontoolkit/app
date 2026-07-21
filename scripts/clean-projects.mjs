/**
 * Clear LOCAL-DEV projects, chats, and transcripts — the debris that piles up across dev sessions
 * (half-failed creations, throwaway test chats). LOCAL MODE ONLY, and it NEVER touches the ledger.
 *
 *   pnpm clean:projects            # DRY RUN — shows exactly what would be removed, deletes nothing
 *   pnpm clean:projects --yes      # actually delete (alias: -y)
 *
 * What it removes (explicit allow-list, never a blanket wipe of .data):
 *   .data/projects/*.json                  project records
 *   .data/chats/*.json                     the account chat index (§4.5.6)
 *   .data/storage/messages/<projectId>/    chat transcripts
 *   .data/storage/seeds/<projectId>.json   remix seeds tied to those projects
 *
 * What it NEVER touches — the money path and everything else:
 *   .data/ledger/            🔴 the append-only credit ledger — balance is DERIVED from it (spec/billing.md)
 *   .data/generations/       billing diagnostics (migration 0002)
 *   .data/git-tokens/  .data/entitlements/  .data/prompt/  .data/skills/
 *   .data/storage/templates/ (pinned starters)   .data/storage/media/ (generated media)
 *
 * Guards, because this is destructive and money-adjacent:
 *   - refuses under NODE_ENV=production (the ledger there is Postgres anyway; this is FS-only)
 *   - refuses if Supabase is configured — then real projects live in the DB, not on disk, so this is
 *     both useless and a sign you are NOT in local mode ("ONLY runs in local mode", per the ask)
 *   - snapshots the ledger dir before and after and ABORTS if anything under it changed
 */
import fs from 'node:fs';
import path from 'node:path';

const DATA_DIR = process.env.PLATFORM_DATA_DIR || path.join(process.cwd(), '.data');
const LEDGER_DIR = path.join(DATA_DIR, 'ledger');

const APPLY = process.argv.includes('--yes') || process.argv.includes('-y');

/* ------------------------------------------------------------------ guards */

if (process.env.NODE_ENV === 'production') {
  console.error('✋ Refusing: NODE_ENV=production. This script is local-development only.');
  process.exit(1);
}

/** Resolve a var from process.env, then from .env.local / .env (last file wins, like a real load). */
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

      if (eq <= 0 || line.slice(0, eq).trim() !== name) {
        continue;
      }

      const value = line
        .slice(eq + 1)
        .trim()
        .replace(/^["']|["']$/g, '');

      if (value) {
        return value;
      }
    }
  }

  return undefined;
}

// Local mode = Supabase NOT configured (mirrors getSupabaseConfig: url + anon key). See supabase/client.ts.
if (resolveEnv('SUPABASE_URL') && resolveEnv('SUPABASE_ANON_KEY')) {
  console.error(
    '✋ Refusing: Supabase is configured, so this is NOT local mode.\n' +
      '   Real projects/chats live in Postgres (RLS), not on disk — nothing here would clean them.',
  );
  process.exit(1);
}

if (!fs.existsSync(DATA_DIR)) {
  console.log(`Nothing to clean — no local data dir at ${DATA_DIR}`);
  process.exit(0);
}

/* -------------------------------------------------- ledger integrity probe */

/** A cheap fingerprint of the ledger dir: sorted "relpath:size" lines. Must be identical after we run. */
function ledgerFingerprint() {
  if (!fs.existsSync(LEDGER_DIR)) {
    return '(no ledger dir)';
  }

  const lines = [];

  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);

      if (entry.isDirectory()) {
        walk(full);
      } else {
        lines.push(`${path.relative(LEDGER_DIR, full)}:${fs.statSync(full).size}`);
      }
    }
  };

  walk(LEDGER_DIR);

  return lines.sort().join('\n');
}

const ledgerBefore = ledgerFingerprint();

/* ------------------------------------------------------------- the targets */

/** Count + describe what a target holds, without deleting. */
function inspect(target) {
  if (!fs.existsSync(target.path)) {
    return { ...target, count: 0 };
  }

  const entries = fs.readdirSync(target.path).filter((n) => !n.startsWith('.'));

  return { ...target, count: entries.length };
}

const targets = [
  { label: 'project records', path: path.join(DATA_DIR, 'projects'), mode: 'files' },
  { label: 'chat index rows', path: path.join(DATA_DIR, 'chats'), mode: 'files' },
  { label: 'chat transcripts (by project)', path: path.join(DATA_DIR, 'storage', 'messages'), mode: 'children' },
  { label: 'remix seeds', path: path.join(DATA_DIR, 'storage', 'seeds'), mode: 'children' },
].map(inspect);

console.log(`\nLocal data dir: ${DATA_DIR}`);
console.log(`Mode: ${APPLY ? 'DELETE' : 'DRY RUN (pass --yes to delete)'}\n`);

let total = 0;

for (const t of targets) {
  console.log(`  ${String(t.count).padStart(4)}  ${t.label}`);
  total += t.count;
}

console.log(`\n  🔒 NEVER TOUCHED: ledger, generations, git-tokens, entitlements, prompt, skills, templates, media`);

if (total === 0) {
  console.log('\nNothing to clean. ✨');
  process.exit(0);
}

if (!APPLY) {
  console.log(`\nDry run — nothing deleted. Re-run with --yes to remove the ${total} item(s) above.`);
  process.exit(0);
}

/* ---------------------------------------------------------------- delete it */

let removed = 0;

for (const t of targets) {
  if (!fs.existsSync(t.path)) {
    continue;
  }

  for (const name of fs.readdirSync(t.path)) {
    if (name.startsWith('.')) {
      continue;
    }

    fs.rmSync(path.join(t.path, name), { recursive: true, force: true });
    removed++;
  }
}

/* --------------------------------------------------- prove the ledger is untouched */

const ledgerAfter = ledgerFingerprint();

if (ledgerAfter !== ledgerBefore) {
  console.error('\n🔴 ABORTING INTEGRITY CHECK: the ledger fingerprint CHANGED during cleanup. This is a bug.');
  console.error('   Before:\n' + ledgerBefore + '\n   After:\n' + ledgerAfter);
  process.exit(2);
}

console.log(`\n✅ Removed ${removed} item(s). Ledger untouched (fingerprint verified identical).`);
