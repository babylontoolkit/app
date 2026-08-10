/**
 * `load_reference(id)` — the tool the baked router index had been telling the model to use for months
 * without it existing (Phase 2, 2026-08-08; SPEC §4.3, §4.2.8).
 *
 * ## What this replaces
 *
 * The Agent Reference's own `reference.md` is baked into every prompt and says, in capitals:
 *
 *   > ALWAYS READ THIS ENTIRE DOCUMENT TO THE END, THEN FETCH THE MATCHING SUB-DOCUMENTS.
 *   > You MUST fetch and read the matching sub-document(s) below BEFORE answering…
 *   > If any fetch fails, STOP immediately and tell the user.
 *
 * The model had no fetch tool. Meanwhile the platform substring-matched some of the same documents
 * behind its back and pasted ~168KB of them into the cached prefix — routing on the platform's own
 * HIDDEN creation brief, so **every creation received the same ten documents** whether it was a kart
 * racer or a chess game (measured 2026-08-07: byte-identical block sets for both prompts).
 *
 * So the architecture was already 90% present and pointing the right way. This is the missing piece.
 *
 * ## Why this is better than the fetch the doc asks for
 *
 * It reads the SAME pinned, versioned, admin-promoted snapshot the baked docs came from
 * (`prompt/store.ts`) — no network, no GitHub at generation time (SPEC §1.3 principle 3), and it
 * cannot fail halfway through a paid generation. The instruction to "STOP immediately if a fetch
 * fails" describes a failure mode that does not exist here.
 *
 * ## Every rule below is copied from `load_skill`, and every one is load-bearing
 *
 * `tools.ts` records what happens when each is missing — six tool rounds, 29,173 output tokens and 350
 * seconds to end up with ONE document; a generation killed by a zod violation AFTER the tokens were
 * spent. Read that file before changing this one.
 */
import { tool } from 'ai';
import { z } from 'zod';
import { createScopedLogger } from '~/utils/logger';
import { getPromptStore } from '~/lib/.server/prompt/store';
import { excludedReferenceReason, resolveReferenceId } from '~/lib/.server/prompt/sources';
import { DEFAULT_MAX_REFERENCE_LOADS } from './budgets';

const logger = createScopedLogger('reference-tools');

/**
 * How many reference BODIES one generation may pull in.
 *
 * Three, where skills get two, and the difference is not taste: a skill is a PROCEDURE (a task spans
 * at most a domain skill and a workflow skill), while a reference is DOMAIN KNOWLEDGE, and a real
 * build genuinely spans a few areas — "a kart racer with a HUD" honestly wants `racing-system`,
 * `ui-design-system` and `script-component`. Ten documents was never the right number; nor is one.
 *
 * 🔴 **Enforced inside `execute`, checked BEFORE the store read** — never as a zod constraint. A schema
 * violation throws `InvalidToolArgumentsError`, which kills the whole generation *after* the tokens are
 * spent; we have watched that happen on a real edit turn. Past the budget this returns a refusal the
 * model can act on, naming what it already has.
 *
 * 🔴 **Never withdraw the tool to control cost — cap the BODIES.** Withdrawing it is what produced the
 * dangling instruction described above, and `spec/skills.md` records the same mistake being made with
 * `load_skill` and having to be undone.
 *
 * ⚠️ This is arithmetic against `maxSteps`, not a preference. A turn must be able to spend its budget
 * AND still have a step left to answer in (`MAX_TOOL_ROUNDS + 1`, `MAX_MEDIA_ROUNDS` + its `+ 1`) — the
 * pairing that `gen_msixapaq_i871b6` cost 1,489 credits to learn. If either number moves, re-derive
 * both.
 */
/**
 * ⚠️ This re-exports the shipped DEFAULT. The value a turn runs with is resolved from config
 * (`budgets.ts`, `AGENT_MAX_REFERENCE_LOADS`) and arrives on the context — and it is resolved TOGETHER
 * with the round ceilings, because raising it alone would let a creation's `maxSteps` exceed an
 * ordinary turn's, silently inverting the one relationship `tool-policy.spec.ts` pins.
 */
export const MAX_REFERENCE_LOADS = DEFAULT_MAX_REFERENCE_LOADS;

export interface ReferenceToolContext {
  /** The prompt version whose blobs this generation reads. Pinned for the whole turn. */
  versionId: string;

  /**
   * Reference ids in context RIGHT NOW — seeded with what earlier turns loaded (`carriedReferenceIds`)
   * so a re-request returns one sentence instead of a second copy of a 55KB document.
   */
  loaded: Set<string>;

  /**
   * Ids fetched ON THIS TURN — what the budget actually spends.
   *
   * Separate from `loaded` for the reason `load_skill` learned it: charging the budget for documents
   * CARRIED from earlier turns means a conversation holding its cap can never load another, which is
   * "withdraw the tool" returning through the budget instead of the tool set.
   */
  loadedThisTurn: Set<string>;

  /**
   * How many bodies this turn may pull in. Optional, defaulting to the shipped value, so a caller that
   * predates config behaves identically — production resolves it at the proxy doorway.
   */
  maxLoads?: number;
}

export function createReferenceTools(context: ReferenceToolContext) {
  const store = getPromptStore();
  const maxLoads = context.maxLoads ?? DEFAULT_MAX_REFERENCE_LOADS;

  /** The ids this prompt version actually holds — the authority, never the source map. */
  const availableIds = async (): Promise<string[]> => {
    const version = await store.get(context.versionId);

    return version?.onDemandIds ?? [];
  };

  return {
    load_reference: tool({
      description:
        'Load one Babylon Toolkit reference document in full, from the Reference Library index in your ' +
        'context. Call this BEFORE writing code that touches that area — the documents are already ' +
        'synced and pinned on this platform, so there is no network fetch and nothing to fail. ' +
        'Accepts the id, or the raw.githubusercontent.com URL exactly as the Agent Reference docs quote ' +
        'it: when a document tells you to "fetch" or "always reference" another document at a URL, pass ' +
        'that URL here — that IS how you fetch it on this platform.',
      parameters: z.object({
        /*
         * `.optional()`, exactly as `load_skill.name` is, and for the same measured reason: a required
         * field is enforced by the AI SDK before `execute` runs, and a violation throws
         * `InvalidToolArgumentsError`, aborting the stream and killing the generation. We watched a real
         * edit turn die on a literal `load_skill({})` — 45 seconds and ~3,500 output tokens spent, the
         * user's file untouched, a zod dump in the chat. A tool argument the model can plausibly get
         * wrong is validated where a bad value is RECOVERABLE.
         */
        id: z
          .string()
          .optional()
          .describe(
            'The reference id from the Reference Library index — or the raw.githubusercontent.com URL ' +
              'a Babylon Toolkit document told you to fetch. Both work.',
          ),
      }),
      execute: async ({ id: requested }) => {
        if (!requested) {
          return `load_reference needs an "id". Available references: ${(await availableIds()).join(', ')}.`;
        }

        /*
         * 🔴 RESOLVE FIRST — the model is usually quoting a URL out of another document, not reading our
         * index (90 such cross-references across the corpus; see `resolveReferenceId`). Everything below
         * — the already-loaded guard, the budget accounting, the carry-forward — keys on the canonical
         * id, so resolving here is what stops one document being loaded twice under two spellings and
         * billed for both.
         */
        const id = resolveReferenceId(requested);

        if (!id) {
          /*
           * Before reporting "not found", check whether it is a document this platform deliberately does
           * NOT serve. The baked router index names several, so the model is following its instructions
           * when it asks — and a bare refusal reads as a platform fault and invites it to improvise the
           * exact thing the exclusion prevents (UMD code; installing skills that are already here).
           */
          const excluded = excludedReferenceReason(requested);

          if (excluded) {
            logger.info(`load_reference: "${requested}" is excluded on this platform`);
            return `"${requested}" is not available here. ${excluded}`;
          }

          logger.warn(`load_reference: "${requested}" resolved to no known reference`);

          return (
            `No reference matches "${requested}". ` +
            `Available references: ${(await availableIds()).join(', ') || '(none)'}.`
          );
        }

        /*
         * Already in context — a cheap acknowledgement, never a second copy. Models DO re-request what
         * they already hold (observed with `load_skill`: the same 17KB body twice in one turn), and here
         * the bodies run to 55KB.
         */
        if (context.loaded.has(id)) {
          return (
            `The "${id}" reference is already loaded and its contents are in your context. ` +
            `Proceed with the task — do not load it again.`
          );
        }

        /*
         * The budget, checked BEFORE the store read so an over-budget call cannot even pay for a
         * lookup. A refusal the model can act on, not an error: it names what it has and tells it to
         * get on with the task.
         */
        if (context.loadedThisTurn.size >= maxLoads) {
          logger.warn(`load_reference: budget spent (${context.loadedThisTurn.size}/${maxLoads}), refused "${id}"`);

          return (
            `You have already loaded ${context.loadedThisTurn.size} references in this response ` +
            `(${[...context.loaded].join(', ')}), which is the limit. Proceed with the task using those ` +
            `documents — do not call load_reference again.`
          );
        }

        const body = await store.readOnDemand(context.versionId, id);

        if (!body) {
          /*
           * A friendly tool_result, never a throw: an unknown id is a model mistake, and the right
           * response is to let it recover inside the same generation.
           *
           * This is also the branch a STALE PROMPT VERSION lands in. A version built before Phase 2 has
           * only the old on-demand ids, so `react-framework` (baked in that version, on demand in this
           * source map) resolves to nothing. Listing what this version actually holds is what turns
           * that from a mystery into a fact the model can act on — and the operator fix is a doc-sync
           * plus a promote.
           */
          logger.warn(`load_reference: "${id}" not in prompt version ${context.versionId}`);

          return (
            `No reference named "${id}" exists in this prompt version. ` +
            `Available references: ${(await availableIds()).join(', ') || '(none)'}.`
          );
        }

        context.loaded.add(id);
        context.loadedThisTurn.add(id);
        logger.info(`load_reference: ${id} (${body.length} bytes)`);

        return `# Babylon Toolkit Reference: ${id}\n\n${body}`;
      },
    }),
  };
}

/**
 * 🔴 A REFERENCE THE MODEL LOADED STAYS LOADED FOR THE CONVERSATION — the `stickyLoadedSkills` rule,
 * applied to documents (`preload-skills.ts` carries the full post-mortem).
 *
 * The tool loop is server-side and internal, so its call and its result never enter the saved
 * conversation: a document fetched on turn 1 is GONE on turn 2, and a build → refine → fix workflow
 * would pay a fresh round trip every turn for a document it had already been handed. Carrying them in
 * the CACHED prefix makes this cheaper than the thing it copies — Claude Code re-sends a loaded skill
 * inside an uncached conversation; we re-send at 0.1x.
 *
 * Measured for skills (2026-07-26): the turn that loaded `bt-plan` ran 2 steps and 528 credits; the
 * follow-ups that CARRIED it ran 1 step, 276 and 274 credits, `toolRounds: 0` — the round trip is gone,
 * not merely cheaper.
 *
 * Three properties, each of which fails as a bigger bill rather than an error:
 *
 *   - **append-only in FIRST-SEEN order** — an id inserted at the front rewrites the whole prefix
 *     behind it at the 2x cache-write rate;
 *   - **the cap TRUNCATES, never rotates** — rotation makes the set change without growing, which is
 *     the same rewrite wearing a different hat;
 *   - **read from the FULL message list, never the compacted one** — the window would make the set
 *     SHRINK as a conversation ages, breaking append-only on the turn it slides.
 */
export const MAX_STICKY_REFERENCES = 4;

export function carriedReferenceIds(messages: Array<{ annotations?: unknown }>): string[] {
  const seen: string[] = [];

  for (const message of messages) {
    if (!Array.isArray(message.annotations)) {
      continue;
    }

    for (const annotation of message.annotations) {
      if (!annotation || typeof annotation !== 'object') {
        continue;
      }

      /*
       * `blocksLoaded`, not a new field: the annotation has carried the doc-block ids since the keyword
       * router existed, the AI SDK already posts annotations back, and the transcript store already
       * persists them. Reusing the wire means carry-forward works on conversations that started before
       * this change — and it is one fact with one name rather than two that can disagree.
       */
      const record = annotation as { type?: unknown; value?: { blocksLoaded?: unknown } };

      if (record.type !== 'agentMeta' || !Array.isArray(record.value?.blocksLoaded)) {
        continue;
      }

      for (const id of record.value.blocksLoaded) {
        if (typeof id === 'string' && id && !seen.includes(id)) {
          seen.push(id);
        }
      }
    }
  }

  return seen.slice(0, MAX_STICKY_REFERENCES);
}
