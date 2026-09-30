/**
 * Which part of the CACHED PREFIX a tool-loop step sent — so a prefix that changes mid-generation names
 * itself instead of showing up only as a bill.
 *
 * ## Why this exists (2026-09-30)
 *
 * A real Comet → Sonnet 5.5 build (`gen_muny2a38_eithc2`) re-wrote its whole ~54k-token prefix on
 * three of six steps inside ONE generation — about $0.49 of a $1.71 turn at the 2× write rate. The
 * gateway was cleared the same day with `scripts/cache-probe.mjs`: identical requests, varying tails,
 * a build-sized prefix, 35-second gaps, tools and adaptive thinking all hit ≥ 7/8. And an offline
 * capture of the real `streamText` + `@ai-sdk/anthropic` tool loop sends byte-identical `tools` and
 * `system` on every step. So something only a LIVE build does changes the prefix, and the step log
 * could not say what: it recorded how many tokens were written, never which bytes differed.
 *
 * Each step's `request.body` (the provider's own serialisation) is hashed into the three things that
 * precede the conversation in Anthropic's cache order — `tools`, then each `system` block — and the
 * proxy warns the moment a step's hashes differ from the previous step's.
 *
 * Hashes only, never content: the system blocks hold the whole prompt and the project manifest, and
 * the step log is persisted (`generations.steps`).
 */
import { createHash } from 'node:crypto';

export interface StepPrefixHashes {
  /** Short hash of the serialised `tools` array, or `'none'`. */
  tools: string;

  /** One short hash per `system` block, in order. */
  system: string[];
}

const short = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex').slice(0, 10);

/** Undefined when the body is absent or not a Messages-API JSON body (other families, a stubbed model). */
export function stepPrefixHashes(body: unknown): StepPrefixHashes | undefined {
  if (typeof body !== 'string') {
    return undefined;
  }

  let parsed: { tools?: unknown; system?: unknown };

  try {
    parsed = JSON.parse(body);
  } catch {
    return undefined;
  }

  if (!parsed || typeof parsed !== 'object' || !Array.isArray(parsed.system)) {
    return undefined;
  }

  return {
    tools: parsed.tools === undefined ? 'none' : short(parsed.tools),
    system: parsed.system.map(short),
  };
}

/**
 * What changed between two consecutive steps' prefixes, in cache order — `[]` when nothing did.
 *
 * `tools` first because a tools change invalidates EVERY breakpoint behind it; a `system[i]` change
 * only invalidates from block i on.
 */
export function prefixChanges(previous: StepPrefixHashes | undefined, next: StepPrefixHashes | undefined): string[] {
  if (!previous || !next) {
    return [];
  }

  const changes: string[] = [];

  if (previous.tools !== next.tools) {
    changes.push('tools');
  }

  const blocks = Math.max(previous.system.length, next.system.length);

  for (let i = 0; i < blocks; i++) {
    if (previous.system[i] !== next.system[i]) {
      changes.push(`system[${i}]`);
    }
  }

  return changes;
}
