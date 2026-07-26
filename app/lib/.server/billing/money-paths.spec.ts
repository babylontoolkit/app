/**
 * EVERY ledger write is enumerated from disk, and every DEBIT names the machinery that makes its
 * failure loud (`spec/fail-loud.md` Stage B, SPEC §4.6).
 *
 * This is the `outbound-enumerate.spec.ts` shape pointed at money instead of auth, and it exists for
 * the same reason that file does: **both of `spec/spend-holes.md`'s sweeps failed at the ENUMERATION,
 * not at the guard.** The 2026-07-19 pass swept routes named after vendors and missed the ones named
 * after subsystems; the hand-written list then encoded that blind spot AS COVERAGE, 21 green
 * assertions reporting a clean bill of health about a set that never contained the holes.
 *
 * A debit path added next month is therefore covered the moment it lands — not the moment somebody
 * remembers to add it to a list.
 *
 * ⚠️ THE ENUMERATION IS FROM THE LEDGER API'S CALLERS, NEVER FROM A KEYWORD. `spec/fail-loud.md`
 * Stage B says so explicitly, because the first draft of `outbound-enumerate.spec.ts` scanned for
 * `fetch(` and missed two of five routes that reached out through helpers — a detector that decides
 * which call sites matter reproduces the original bug with a regex instead of a person. Here the
 * ledger is the only way credits move, so "calls `.append` on a ledger" is a complete definition of
 * the money path rather than a guess about it.
 *
 * ⚠️ THIS IS A SOURCE SCAN. It proves the machinery is *mentioned*, never that it is reached — a
 * refund whose result is discarded passes here. `media.spec.ts`, `enhancer-settlement.spec.ts`,
 * `money-swallow-alert.spec.ts`, `billing.spec.ts` and `ledger-sql.spec.ts` are the behavioural
 * halves. Complements, neither replacing the other.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

const APP_DIR = join(process.cwd(), 'app');

/** Comments are not code: machinery named in a doc comment must never count as machinery. */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}

/**
 * A write to the credit ledger. Both halves are required: `.append(` alone matches `props.append(` in
 * a React component and `headers.append(` in the Supabase client, and the ledger import alone matches
 * a module that only reads a balance or a type.
 */
const LEDGER_IMPORT = /from\s+'[^']*(?:billing\/ledger|\.\/ledger)'/;
const APPEND_CALL = /\.append\(\s*\{/;

/** The reason on each write — this is what says whether money left the user or arrived. */
const REASON = /reason:\s*'([a-z]+)'/g;

/**
 * The reasons that TAKE credits (`spec/fail-loud.md` §Scope). Anything writing one of these must be
 * able to make its own failure visible. A reason that is not listed in either map fails the "no
 * unclassified reason" test below — which is how a NEW debit reason gets noticed on the day it lands
 * rather than the day someone audits.
 */
const DEBIT_REASONS = new Set(['generation', 'media', 'search', 'license']);

/** The reasons that GIVE credits. A grant has nothing to refund; its risk is duplication, not silence. */
const CREDIT_REASONS = new Set(['grant', 'purchase', 'refund', 'promo', 'adjustment']);

/**
 * What makes a debit's failure loud: a compensating row, or an alert on the swallows that cannot
 * throw (settlement runs inside the proxy's `finally`; a refund is itself the compensating step for an
 * already-failed request, so neither can rethrow its way to loudness).
 *
 * ⚠️ TYPED REFUSALS ARE DELIBERATELY NOT IN HERE, and that is the whole difference between a guard and
 * a decoration. `MediaRefusedError` / `LicenseRefusedError` appear in their modules for the
 * REFUSE-BEFORE-SPEND path, which every debiting module has anyway — so accepting them would make this
 * test pass for any file that can refuse a request, whether or not it can give money back. The first
 * draft included them, and stripping every refund out of `media/service.ts` still went green.
 */
const LOUDNESS = /reason:\s*'refund'|refundGeneration|refundMediaTask|refundLicense|ALERT_SIGNALS\.LEDGER_INTEGRITY/;

/**
 * Debit sites that legitimately have no refund or alert, each with the sentence rule 4 demands.
 *
 * Adding an entry is a decision made in review, in writing — "it seemed harmless" is how every hole in
 * `spec/spend-holes.md` shipped. A reason under 40 characters is refused below.
 */
const NO_LOUDNESS_BY_DESIGN: Record<string, string> = {
  'lib/.server/agent/web-search-tool.ts':
    'The one sanctioned after-the-fact debit (spec/fail-loud.md §Scope, migration 0010). The vendor was ' +
    'already paid and reason "search" may go negative, so a failed debit is logged and the research ' +
    'answer proceeds; there is nothing to refund and nothing the user could act on.',
};

interface Writer {
  file: string;
  source: string;
  reasons: string[];
}

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);

    if (statSync(full).isDirectory()) {
      sourceFiles(full, out);
    } else if (/\.tsx?$/.test(entry) && !entry.includes('.spec.')) {
      out.push(full);
    }
  }

  return out;
}

function ledgerWriters(): Writer[] {
  return sourceFiles(APP_DIR)
    .map((full) => ({ file: relative(APP_DIR, full), source: stripComments(readFileSync(full, 'utf8')) }))
    .filter(({ source }) => LEDGER_IMPORT.test(source) && APPEND_CALL.test(source))
    .map((w) => ({ ...w, reasons: [...w.source.matchAll(REASON)].map((m) => m[1]) }));
}

const writers = ledgerWriters();
const debiters = writers.filter((w) => w.reasons.some((r) => DEBIT_REASONS.has(r)));

describe('every ledger-debiting call site can make its own failure loud', () => {
  /*
   * THE CONTROL. A scan that silently stops matching anything reports "all clear" forever — which is
   * exactly how a structural test decays into decoration (`no-server-storage.spec.ts` shipped without
   * one and its clean bill of health meant nothing). If this fails, the scanner is broken and every
   * assertion below is meaningless whatever colour it prints.
   */
  it('CONTROL — the scanner still finds ledger writers, debiters, and reasons', () => {
    expect(writers.length, 'the ledger-writer scan found nothing — the import or call shape changed').toBeGreaterThan(
      5,
    );
    expect(debiters.length, 'no debiting call sites found — DEBIT_REASONS or the reason shape changed').toBeGreaterThan(
      2,
    );
    expect(writers.flatMap((w) => w.reasons).length).toBeGreaterThan(8);
  });

  it('CONTROL — the scanner does not count machinery named only in a comment', () => {
    const commented = stripComments("/* refundGeneration is called elsewhere */\nawait x.append({ reason: 'media' });");

    expect(LOUDNESS.test(commented)).toBe(false);
    expect(APPEND_CALL.test(commented), 'the call itself must still be seen').toBe(true);
  });

  it('CONTROL — the scanner ignores `.append` on things that are not the ledger', () => {
    // `props.append(` in Messages.client.tsx and `headers.append(` in the Supabase client both match APPEND_CALL.
    expect(writers.map((w) => w.file)).not.toContain('components/chat/Messages.client.tsx');
    expect(writers.map((w) => w.file)).not.toContain('lib/.server/supabase/client.ts');
  });

  /*
   * The four money paths `spec/fail-loud.md` §Scope names. Pinned by NAME as well as by the loop
   * below, because their ABSENCE from an enumeration is the defect being guarded against — a rename or
   * a move that drops one out fails here loudly instead of quietly reducing coverage.
   */
  it('the four debiting paths in the spec are all found by the scan', () => {
    expect(debiters.map((w) => w.file)).toEqual(
      expect.arrayContaining([
        'lib/.server/billing/gate.ts',
        'lib/.server/media/service.ts',
        'lib/.server/agent/web-search-tool.ts',
        'lib/.server/licensing/unity-license-service.ts',
      ]),
    );
  });

  it('no ledger write uses a reason outside the declared inventory', () => {
    /*
     * A new `LedgerReason` that nobody classified is a money path with no stated terminal states. This
     * fails on the day it lands — the whole point of Stage B — rather than on the day someone audits.
     */
    for (const { file, reasons } of writers) {
      for (const reason of reasons) {
        expect(
          DEBIT_REASONS.has(reason) || CREDIT_REASONS.has(reason),
          `${file} writes reason '${reason}', which is in neither DEBIT_REASONS nor CREDIT_REASONS — ` +
            'classify it in spec/fail-loud.md before it ships',
        ).toBe(true);
      }
    }
  });

  it('the by-design list has no stale entries', () => {
    // An allow-list entry for a file that no longer debits is a licence nobody is watching.
    const found = new Set(debiters.map((w) => w.file));

    for (const file of Object.keys(NO_LOUDNESS_BY_DESIGN)) {
      expect(found.has(file), `${file} is allow-listed as a debiter but no longer debits`).toBe(true);
    }
  });

  for (const { file, source, reasons } of debiters) {
    const excuse = NO_LOUDNESS_BY_DESIGN[file];
    const debits = [...new Set(reasons.filter((r) => DEBIT_REASONS.has(r)))].join(', ');

    it(`${file} (debits: ${debits}) → ${excuse ? 'silent by design, with a written reason' : 'refunds or reports'}`, () => {
      if (excuse) {
        // A one-word reason is not a reason.
        expect(excuse.length, `${file} needs a real justification for having no loud failure path`).toBeGreaterThan(40);
        return;
      }

      expect(
        LOUDNESS.test(source),
        `${file} debits credits with no refund, no LEDGER_INTEGRITY alert and no typed refusal, and is ` +
          'not in NO_LOUDNESS_BY_DESIGN — see spec/fail-loud.md rule 4',
      ).toBe(true);
    });
  }
});

/**
 * The four terminal states are a DOC-COMMENT contract (§"When you add a paid path": *"name its
 * four-state mapping in the doc comment, before it ships"*).
 *
 * Cheap and load-bearing: it is the one place a reviewer can check what a new debit path claims about
 * itself. The 316-credit promise, the enhancer's missing refund and the orphaned media task were all
 * paths whose behaviour nobody had ever had to write down.
 */
describe('every debiting module states what it does with the money', () => {
  const SPEC_REFERENCE = /spec\/fail-loud\.md|§4\.6|spec\/billing\.md/;

  for (const { file } of debiters) {
    it(`${file} points at the money spec in its header`, () => {
      const header = readFileSync(join(APP_DIR, file), 'utf8').slice(0, 3000);
      expect(SPEC_REFERENCE.test(header), `${file} spends credits without citing the spec that governs it`).toBe(true);
    });
  }
});
