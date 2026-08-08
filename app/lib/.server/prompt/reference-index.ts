/**
 * The Agent Reference INDEX — what replaces ~106KB of baked documentation (Phase 2, 2026-08-08).
 *
 * The deliberate twin of `buildSkillsIndex` (`skills/sync.ts`), because the problem is the same one and
 * it has already been solved once here: an index of `id — description` in the cached prompt, a tool to
 * fetch a body, a hard budget on bodies, and one load-bearing sentence telling the model to decide
 * BEFORE it starts writing. Read that function before changing this one; every difference between them
 * should be a difference someone can justify.
 *
 * ## Why an index instead of the documents
 *
 * Measured on the live prompt version (`pv_20260807122138_f1638e7c`): the base prompt was 137,979 chars
 * of which only 27% was the platform's own rules, plus 61.6k tokens of keyword-routed documents on top
 * — and the router matched the platform's HIDDEN creation brief rather than the user's request, so
 * **every creation received the same ten documents**, `racing-system` included, whether it was a kart
 * racer or a chess game. This index is ~2KB and lets the model ask for the two or three documents its
 * actual task needs.
 *
 * ## The properties that make it cheap, each of which fails silently
 *
 *   - **SORTED by id.** This text lands in the base prompt, which is byte-identical for every user on
 *     the platform and is the single most valuable cache entry we have. Declaration order is whatever
 *     order someone happened to type the array in, so reordering the array would rewrite the prefix for
 *     everyone at the 2x cache-WRITE rate. The same reason `buildSkillsIndex` sorts.
 *   - **Whitespace-collapsed descriptions.** A description written across three source lines and one
 *     written on one line must produce identical bytes, or a cosmetic reformat is a platform-wide cache
 *     write.
 *   - **No counts, no dates, no "as of".** Anything that varies without the docs varying is a prefix
 *     rewrite disguised as a nicety.
 */
import type { OnDemandBlock } from './sources';

/*
 * Imported from the tool that enforces it, exactly as `buildSkillsIndex` imports `MAX_SKILL_LOADS`:
 * the number the model is told and the number `execute` enforces must be one constant, or the prompt
 * promises a budget the tool does not keep.
 */
import { MAX_REFERENCE_LOADS } from '~/lib/.server/agent/reference-tools';

export function buildReferenceIndex(blocks: OnDemandBlock[]): string {
  if (blocks.length === 0) {
    /*
     * Never advertise a tool with nothing behind it. An empty index that still said "call
     * load_reference" would be the dangling-instruction failure this whole change exists to remove —
     * which is exactly what the baked router index was doing before `load_reference` existed.
     */
    return '';
  }

  const rows = [...blocks]
    .sort((a, b) => a.id.localeCompare(b.id))
    .map((block) => `- **${block.id}** — ${block.description.replace(/\s+/g, ' ').trim()}`);

  return [
    '# Babylon Toolkit Reference Library (load on demand)',
    '',
    'These are the Agent Reference sub-documents, already synced and pinned on this platform.',
    '`load_reference(id)` returns one in full. They are NOT fetched over the network and cannot fail to',
    'download — the Agent Reference router index above tells you to fetch matching sub-documents, and',
    'this tool is how you do it here. Do not report a failed fetch; call the tool.',
    '',

    /*
     * 🔴 "DECIDE FIRST, THEN WRITE" — the same load-bearing sentence as the skills index, and it is
     * carrying the same measurement. The 29,173-token six-round disaster was NOT the cost of loading
     * (a tool call is ~50 tokens of JSON); it was the model beginning the artifact, realising mid-draft
     * that it wanted something, calling for it, and discarding the draft — at 5x output rate, over and
     * over. Loading is cheap. Interleaving loading with writing is what costs.
     */
    'Decide which references you need and load them BEFORE you begin writing code, files or an artifact.',
    'Loading is cheap; abandoning a half-written answer to load one is not. Do not interleave the two.',
    `You may load at most ${MAX_REFERENCE_LOADS} references in one response, so choose by the`,
    'descriptions below. If a task needs one you have not loaded, load it rather than guessing at an API.',
    '',
    ...rows,
  ].join('\n');
}
