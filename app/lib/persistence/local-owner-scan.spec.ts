/**
 * Default-deny: every read of the browser's chat store must be scoped to the signed-in account.
 *
 * 🔴 **This exists because the leak was not one bug, it was one MISSING RULE with four doors.** The
 * sidebar, the `/chat/:id` open path, the Projects dashboard's chat index, and Settings → Data's
 * "Export all your chats" each read the shared IndexedDB independently, and each was written by
 * someone reasonably assuming the store belonged to the person looking at it. Fixing the four I found
 * fixes exactly the four I found — and this codebase has already paid for that lesson twice: the
 * outbound-auth sweep enumerated routes named after vendors and left five named after subsystems
 * anonymous behind 21 green assertions, and the boot-splash gate was a list of the doors somebody had
 * thought of until a third door walked past both versions of it.
 *
 * So the rule is asserted structurally instead: a file that reads the store unscoped fails unless it
 * is listed here with a written reason. A new read path is guilty until someone writes down why not.
 *
 * ⚠️ Do NOT silence a failure by adding an allow-list entry. The scanner cannot tell a considered
 * exception from a forgotten filter — that is what the reason string is for, and it is the only part
 * of this test a human reads.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

const APP_DIR = join(process.cwd(), 'app');

/** Comments describe the rule all over this repo. Documentation is not a read — strip it first. */
function sourceWithoutComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules') {
      continue;
    }

    const abs = join(dir, entry);

    if (statSync(abs).isDirectory()) {
      walk(abs, out);
    } else if (/\.tsx?$/.test(abs)) {
      out.push(abs);
    }
  }

  return out;
}

/**
 * Excluded by exact path, never by a `*.spec.ts` pattern: this file names the needles as DATA, but a
 * pattern would also blind the scan to a real regression inside some other test — which is exactly
 * how `sandbox-seam.spec.ts` records a `@webcontainer/api` import sitting unnoticed in a spec.
 */
const SELF = join(APP_DIR, 'lib/persistence/local-owner-scan.spec.ts');

const SOURCE_FILES = walk(APP_DIR).filter((abs) => abs !== SELF);

/**
 * Reads the whole `chats` store: the unscoped `getAll(db)` from `db.ts`, or the raw object store.
 *
 * ⚠️ **The granularity is the FILE, not the read site, and that limit is deliberate — state it rather
 * than let a reader assume more.** A file that mentions the ownership filter anywhere passes, so this
 * cannot catch a module that scopes one of its two reads. Proximity matching was tried and is worse
 * in both directions: `Menu.client.tsx` filters inside the `.then()` (a few characters away) while
 * `ProjectsDashboard.client.tsx` filters several statements later, so any window tight enough to
 * catch a real miss also fails the dashboard, and the fix for THAT is an exemption — which is how a
 * detector ends up certifying the thing it was meant to find.
 *
 * What it does guarantee is the regression that actually happened four times: a NEW surface that
 * lists the browser's chats and has never heard of ownership cannot ship silently.
 */
function readsChatStoreUnscoped(source: string): boolean {
  const stripped = sourceWithoutComments(source);

  const readsEveryChat = /\bgetAll\s*\(\s*db\s*\)/.test(stripped) || /objectStore\(\s*\[?'chats'/.test(stripped);

  if (!readsEveryChat) {
    return false;
  }

  // Scoped if the result goes through the ownership filter, or the file only handles ONE record.
  return !/filterOwnedRecords|ownsLocalRecord|claimForImport/.test(stripped);
}

/**
 * Files that read every chat without filtering, each with the reason it is not a leak.
 *
 * Keep this list short and keep the reasons specific. "It is fine" is not a reason.
 */
const ALLOWED: Record<string, string> = {
  'app/lib/persistence/db.ts':
    'Defines the unscoped primitive. `getAll` is the raw store read every scoped caller is built ' +
    'from, and `stampChatOwners` is what ASSIGNS ownership — it must see unowned records by ' +
    'definition. Nothing here renders or exports anything.',

  'app/lib/persistence/local-owner-sync.ts':
    'Runs the adoption pass, whose entire job is to find unowned legacy records and attribute them ' +
    'to the account the SERVER confirms owns them. It reads nothing to the screen.',

  /*
   * Specs are in scope on purpose — `sandbox-seam.spec.ts` records a real regression that sat inside a
   * test file precisely because a `*.spec.ts` pattern was skipping it. Both entries below are the
   * whole population today; if that grows into noise, the answer is a narrower needle, never a
   * blanket exclusion.
   */
  'app/lib/persistence/local-owner-db.spec.ts':
    'Tests the stamping primitives themselves, which means asserting on records BEFORE they have an ' +
    'owner. A scoped read here could not observe the behaviour under test.',

  'app/lib/persistence/chat-visibility.spec.ts':
    'Predates ownership and models the sidebar as `urlId && description`. Its subject is whether a ' +
    'restored chat is addressable and unique, not who may see it; the ownership half is covered by ' +
    'the specs beside this one.',
};

describe('every read of the local chat store is scoped to the signed-in account', () => {
  it('has no unscoped reader that is not written down', () => {
    const offenders = SOURCE_FILES.filter((abs) => readsChatStoreUnscoped(readFileSync(abs, 'utf-8')))
      .map((abs) => relative(process.cwd(), abs).replace(/\\/g, '/'))
      .filter((path) => !(path in ALLOWED));

    expect(offenders).toEqual([]);
  });

  it('has a reason recorded for every allowance, and no stale entries', () => {
    for (const [path, reason] of Object.entries(ALLOWED)) {
      expect(reason.length, `${path} needs a real reason`).toBeGreaterThan(60);

      /*
       * A stale allowance is not harmless: it is a written claim that a file was reviewed, standing
       * over a file that may since have been rewritten — or renamed, leaving the next unscoped reader
       * to inherit the exemption by coincidence.
       */
      expect(
        readsChatStoreUnscoped(readFileSync(join(process.cwd(), path), 'utf-8')),
        `${path} no longer reads the store unscoped — drop its allowance`,
      ).toBe(true);
    }
  });

  /*
   * 🔴 CONTROLS. A scanner that silently matches nothing reports a clean bill of health forever, and
   * this repo has shipped exactly that: the outbound-route detector scanned for a literal `fetch(`
   * and missed two of the five routes it existed to find. These prove the needle still bites and that
   * the filter is what makes the difference — not some accident of formatting.
   */
  describe('CONTROL — the detector still works', () => {
    it('flags a new surface that lists the browser’s chats', () => {
      expect(readsChatStoreUnscoped(`const all = await getAll(db); render(all);`)).toBe(true);
    });

    it('flags a raw object-store read', () => {
      expect(readsChatStoreUnscoped(`db.transaction(['chats']).objectStore('chats').getAll();`)).toBe(true);
    });

    it('clears the same code once it filters', () => {
      expect(readsChatStoreUnscoped(`const all = filterOwnedRecords(await getAll(db), localViewer());`)).toBe(false);
    });

    it('is not fooled by a mention in a comment', () => {
      expect(readsChatStoreUnscoped(`// this used to be getAll(db) before ownership existed`)).toBe(false);
      expect(readsChatStoreUnscoped(`/* objectStore('chats').getAll() — see the post-mortem */`)).toBe(false);
    });

    it('ignores a file that reads a single chat by id', () => {
      // `getMessages`/`getSnapshot` take an id; the `mixedId` branch is what guards those.
      expect(readsChatStoreUnscoped(`const one = await getMessages(db, id);`)).toBe(false);
    });
  });
});
