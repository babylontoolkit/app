/**
 * 🔴 A CLAIM THIS REPO HAS RETIRED MUST NOT COME BACK, AND A SWEEP CANNOT KEEP IT OUT.
 *
 * `spec/agent-seams.md`'s reference scanner works because it asserts `checked === exists`: a reference
 * cannot be exempted by rephrasing the sentence around it. Nothing did that for PHRASE-level claims,
 * and the cost was measured — one documentation task failed adversarial pass after adversarial pass,
 * every one the same shape: a claim corrected in one document and left standing in its siblings, found
 * each time by a human-written `grep` that missed the copy which had reworded itself.
 *
 * The two claim families below were each stated across many files, copied from one another, and each
 * survived sweep after sweep by moving a word:
 *
 *   - **"we spend all four cache breakpoints / there are none spare".** True when written, then false
 *     when the pre-loaded-skills block made it five (an HTTP 400 and a dead generation on every
 *     `/slash` turn), then false in the OTHER direction for months after the file manifest retired the
 *     two-part split. It evaded sweep after sweep as `all four`, `all four **cache** breakpoints`, and
 *     finally with the number gone entirely — *"would need a fifth breakpoint or the sacrifice of an
 *     existing one"*.
 *   - **"thinking is disabled on the last TWO retries".** True from the day the mitigation shipped
 *     until 2026-08-21, because `retryThinkingMode` read a 0-based attempt index while its only caller
 *     passed a 1-based retry number — and false the moment the units were reconciled. ⚠️ Its
 *     PREDECESSOR was retired here first: *"only the last retry"* was banned as a false claim, and it
 *     is now what the code does. That is the point rather than an embarrassment — **this entry aims at
 *     whichever sentence the code has stopped honouring**, and it has now been aimed in both
 *     directions within one feature. It is also why the remedy is never "reword the claim": the count
 *     belongs in `retry-policy.spec.ts`, which pins the function AND the call site and would have
 *     caught the units bug on the day it shipped.
 *
 * ⚠️ **This scan does not decide what is true — it refuses a form of words that has been WRONG twice
 * and belongs in a test instead.** The remedy for a failure here is to state the fact where it can
 * fail (`cache-breakpoints.spec.ts` owns the breakpoint count) or to write the number nowhere. **Do
 * not add an allow-list entry**, and do not soften a literal to slip past it — that is the exact
 * evasion the `checked === exists` rule exists to prevent, one layer up.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/*
 * ⚠️ WIDE ON PURPOSE. The first version scanned six narrow roots and missed live copies of a retired
 * claim in `app/lib/modules/llm/**` and `app/lib/.server/billing/**` — a scanner whose ROOTS are a
 * hand-written list reproduces the very bug it guards against, one directory up.
 */
const ROOTS = ['SPEC.md', 'CLAUDE.md', 'spec', 'app/lib', 'app/routes', 'supabase'];
const EXTENSIONS = ['.md', '.ts', '.tsx', '.sql'];

/** Every file under the roots, so a claim cannot hide in a document nobody listed. */
function scannedFiles(): string[] {
  const out: string[] = [];

  const walk = (path: string) => {
    const full = join(process.cwd(), path);

    if (statSync(full).isFile()) {
      if (EXTENSIONS.some((e) => path.endsWith(e))) {
        out.push(path);
      }

      return;
    }

    for (const entry of readdirSync(full)) {
      /*
       * ⚠️ `.server` STARTS WITH A DOT. A blanket `startsWith('.')` skip — the obvious way to avoid
       * `.git` — silently excluded the entire server tree, which is where most of these claims live.
       * The reachability control below is what caught it.
       */
      if (entry !== 'node_modules' && entry !== '.git' && entry !== '.cache') {
        walk(join(path, entry));
      }
    }
  };

  ROOTS.forEach(walk);

  return out;
}

/**
 * A retired claim, and the ONE file allowed to discuss it.
 *
 * ⚠️ Newline-tolerant by construction (`\s+` between words), because a sentence is not a line and
 * several misses were phrases wrapped across two of them. ⚠️ But that is not the only way one hides:
 * the last survivor found sat on ONE line and evaded over a single hyphen (`last-resort retry only`
 * against a pattern expecting `last attempt only`). Wrapping is the obvious evasion; a synonym, a
 * wedged word and a punctuation mark are the others, and a pattern is only as good as the spellings
 * somebody thought to admit — which is why the count itself belongs in a test and not in prose.
 */
interface RetiredClaim {
  id: string;
  pattern: RegExp;
  why: string;

  /** Files that may state it — because they RETRACT it, or because they own the fact. */
  allowed: string[];
}

const RETIRED: RetiredClaim[] = [
  {
    id: 'breakpoints-all-spent',
    pattern: /(spend|spends|spent)\s+all\s+(four|4)\b|all\s+(four|4)\s+(\w+\s+){0,2}breakpoints\s+(are|sit)/i,
    why: 'The assembly does not spend all four. The count belongs to cache-breakpoints.spec.ts, which can fail.',
    allowed: [
      /* Each of these quotes the claim in order to record that it was wrong. */
      'CLAUDE.md',
      'spec/context-budget.md',
      'app/lib/.server/agent/proxy.ts',
      'app/lib/.server/agent/cache-breakpoints.spec.ts',
      'app/lib/.server/agent/retired-claims.spec.ts',
    ],
  },
  {
    id: 'breakpoints-none-spare',
    pattern: /there\s+are\s+none\s+spare|need\s+a\s+fifth\s+breakpoint|sacrifice\s+of\s+an\s+existing\s+one/i,
    why: 'One breakpoint is currently unused. Stating it in prose has been wrong in both directions.',
    allowed: [
      'CLAUDE.md',
      'spec/context-budget.md',
      'app/lib/.server/agent/proxy.ts',
      'app/lib/.server/agent/cache-breakpoints.spec.ts',
      'app/lib/.server/agent/retired-claims.spec.ts',
    ],
  },
  {
    id: 'retry-thinking-last-two',

    /*
     * 🔴 THE CLAIM ITSELF, not only its corollary — the lesson kept from the version this replaces.
     * The first attempt at this rule matched `attempts 1 and 2 are identical`, the CONSEQUENCE, and
     * could not match the sentence being retired. A pattern named for a claim it cannot match is the
     * vacuous assertion this whole file exists to end, so both the English and the mode SEQUENCE are
     * matched here.
     */
    pattern: /(last|final)[\s-]?(two|2)\s+(retries|attempts)\b|adaptive\s*,\s*disabled\s*,\s*disabled/i,
    why: 'Thinking is disabled on the final retry only (fixed 2026-08-21). The sequence lives in retry-policy.spec.ts.',
    allowed: [
      /* The files that RECORD the units defect rather than asserting its behaviour as current. */
      'CLAUDE.md',
      'spec/anthropic-models.md',
      'app/lib/.server/agent/retry-policy.ts',
      'app/lib/.server/agent/retry-policy.spec.ts',
      'app/lib/.server/agent/proxy.ts',
      'app/lib/.server/agent/retired-claims.spec.ts',
    ],
  },
];

describe('a claim this repo has retired does not come back', () => {
  const files = scannedFiles();

  it.each(RETIRED.map((c) => [c.id, c] as const))('%s', (_id, claim) => {
    const offenders = files
      .filter((path) => !claim.allowed.includes(path))
      .filter((path) => claim.pattern.test(readFileSync(join(process.cwd(), path), 'utf8')));

    expect(offenders, `${claim.why} Do NOT allow-list a new file — state the fact where it can fail.`).toEqual([]);
  });
});

/**
 * CONTROLS. A scanner that silently stops matching reports a clean bill of health forever — and this
 * one has a second failure mode the others do not: an allow-list that grows until it is the file list.
 */
describe('CONTROLS — the scanner still reads what it thinks it does', () => {
  it('walks a realistic number of files, including all four extensions', () => {
    const files = scannedFiles();

    /*
     * ⚠️ A FLOOR NEAR THE REAL NUMBER. The first version asserted `> 80` against a corpus of 148, so
     * ~46% of the files could vanish silently — and one root genuinely did, because `.server` starts
     * with a dot and a blanket dotfile skip excluded the whole server tree. A floor far below the
     * truth is a control that cannot fail.
     */
    expect(files.length).toBeGreaterThan(700);
    expect(files.some((f) => f.endsWith('.md'))).toBe(true);
    expect(files.some((f) => f.endsWith('.ts'))).toBe(true);
    expect(files.some((f) => f.endsWith('.sql'))).toBe(true);
    expect(files).toContain('SPEC.md');
    expect(files).toContain('CLAUDE.md');
  });

  /* Every pattern must still match the sentence it was written for, wrapped across lines. */
  it.each(RETIRED.map((c) => [c.id, c] as const))('%s still matches its retired sentence', (id, claim) => {
    const samples: Record<string, string> = {
      'breakpoints-all-spent': 'Budget: Anthropic allows 4 breakpoints. We spend all 4 — base prompt,\nrouted blocks.',
      'breakpoints-none-spare':
        'a real restructure, and one that would need a fifth\nbreakpoint or the sacrifice of an existing one.',
      'retry-thinking-last-two':
        'the call site indexes it so that the last two retries run\nwith thinking disabled (adaptive, disabled, disabled).',
    };

    expect(claim.pattern.test(samples[id]), 'this pattern no longer matches the claim it retired').toBe(true);
  });

  /*
   * 🔴 THE CONTROL THE FIRST VERSION LACKED. Its patterns were only ever tested against synthetic
   * strings, so one of them could not match the claim it was named for and nothing said so. A pattern
   * must be able to find its claim in a REAL file — the allow-listed retractions are exactly that.
   */
  it('every pattern still finds its claim in a real, allow-listed file', () => {
    const files = scannedFiles();

    for (const claim of RETIRED) {
      const found = claim.allowed.filter(
        (path) => files.includes(path) && claim.pattern.test(readFileSync(join(process.cwd(), path), 'utf8')),
      );

      expect(
        found.length,
        `${claim.id}'s pattern matches nothing real — it may no longer match its claim`,
      ).toBeGreaterThan(0);
    }
  });

  it('does not match innocent prose', () => {
    for (const claim of RETIRED) {
      expect(claim.pattern.test('The four horsemen spend all day riding, and none are spare parts.')).toBe(false);
    }
  });

  /* An allow-list that grows is the failure this file is a second line of defence against. */
  it('keeps every allow-list small, and every entry a real file', () => {
    const files = scannedFiles();

    for (const claim of RETIRED) {
      expect(claim.allowed.length, `${claim.id}'s allow-list is becoming the file list`).toBeLessThan(7);

      for (const path of claim.allowed) {
        expect(files, `${claim.id} allow-lists ${path}, which the scan does not even read`).toContain(path);
      }
    }
  });
});
