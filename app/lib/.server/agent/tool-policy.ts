/**
 * Which tools a turn may call, and how many LLM round trips it gets (SPEC §4.2.8, §4.16).
 *
 * A PURE function, like `decidePremium` / `auto-repair` / `effort-policy`, because both of its failure
 * modes are silent money bugs: opening the loop where it should be closed re-buys the measured
 * pathology-1 (six tool rounds and 29k redrafted output tokens to load ONE skill), and closing it where
 * it should be open makes an advertised capability unreachable — the model is TOLD it has tools it
 * cannot call, and drafts around them.
 *
 * The creation turn is the delicate case. It historically ran `maxSteps: 1, toolChoice: 'none'` — the
 * fix that took a creation from 997k prompt tokens to one step — and that stays the default. But the
 * creation brief now invites the model to generate bespoke design art (§4.16: hero art, splash, chrome)
 * with the built-in media tools, so when those tools EXIST the creation turn gets a media-only loop:
 *
 *  - **`toolset: 'media-only'`** — skill tools are NOT offered, so the six-round skill-loading failure
 *    cannot come back; the routed skills are already in the cached prefix (§4.2.8).
 *  - **A SMALL step cap** (`CREATION_MEDIA_STEPS`), not `MAX_TOOL_ROUNDS`: the brief instructs one
 *    parallel round of generate calls before any files, so this is 1 media round + the answer + one
 *    round of slack. Media tools are async-enqueue (§4.16) — a round returns in seconds, never parks on
 *    a render — and each extra round re-reads the cached prefix at a tenth, so the slack is cheap.
 */
import { MAX_TOOL_ROUNDS } from './tools';

/** 1 round of parallel generate_* calls + the ANSWER step + 1 round of slack (the +1 rule, §4.2.8). */
export const CREATION_MEDIA_STEPS = 3;

/**
 * The same budget for an ORDINARY turn whose only reason to open the loop is media (§4.16).
 *
 * This exists because the original rule — "media tools never force the loop on for ordinary turns; the
 * Media panel covers the rest" — made an ADVERTISED capability unreachable on exactly the turns that
 * ask for it. The skill router fires on words like `design`, `landing`, `art`, `theme`, so "redesign
 * the landing page with new hero art" pre-loads a skill, `preloadedCount > 0` closed the loop, and the
 * model was left with no `generate_image` at all — it then narrated the absence ("Since I don't have
 * access to generation tools this turn…") and drew the art in CSS. Creation worked, every later turn
 * did not, which is precisely how it was reported.
 *
 * The §4.2.8 redrafting pathology cannot come back through this door: the toolset is MEDIA-ONLY, so
 * there is no `load_skill` to thrash on (the routed skills are already in the cached prefix), and the
 * cap is 3, not `MAX_TOOL_ROUNDS`. Media tools are async-enqueue — a round returns in seconds and never
 * parks on a render — and each extra round re-reads the cached prefix at a tenth.
 */
export const MEDIA_TURN_STEPS = CREATION_MEDIA_STEPS;

export interface ToolPolicyInput {
  /** The turn carries `CREATION_BRIEF_MARKER` — the expensive one-shot that writes the whole game. */
  isCreationTurn: boolean;

  /** The project has live MCP relay tools (§4.14) — these force the loop on for non-creation turns. */
  hasMcpTools: boolean;

  /** The platform can render media this turn (§4.16: a KIE key + a project for the bytes to land in). */
  hasMediaTools: boolean;

  /** Skills already routed into the cached prefix — their presence closes the loop (nothing to fetch). */
  preloadedCount: number;

  /** An explicit `/slash` skill invocation — the skill is in the prefix, same as preloaded. */
  isSlash: boolean;

  /**
   * Discussion mode is active this turn (§4.2.9 — already creation-guarded by the caller: it is
   * `discussModeNote(...) !== null`, so it can never be true on a creation turn). A discuss turn is
   * READ-ONLY by guarantee, not just by instruction: media tools DEBIT credits, and MCP tools can
   * mutate the sandbox (a `write_file` MCP tool is ordinary, not exotic) — neither may be offered.
   */
  isDiscussTurn?: boolean;
}

export interface ToolPolicy {
  allowTools: boolean;

  /**
   * `media-only` strips skill + MCP tools from the offered set (creation only: the brief's design
   * phase may buy art, and nothing else may burn a round). `skills-only` strips media + MCP
   * (discussion turns: skill loads are read-only grounding; nothing offered may spend or mutate).
   */
  toolset: 'all' | 'media-only' | 'skills-only';

  /** Passed straight to `streamText` — counts EVERY round trip, so the answer step must fit inside. */
  maxSteps: number;
}

export function toolPolicyForTurn(input: ToolPolicyInput): ToolPolicy {
  if (input.isCreationTurn) {
    return input.hasMediaTools
      ? { allowTools: true, toolset: 'media-only', maxSteps: CREATION_MEDIA_STEPS }
      : { allowTools: false, toolset: 'all', maxSteps: 1 };
  }

  /*
   * Discussion turns (§4.2.9): the loop opens only for skill loading, and MCP tools never force it on
   * (they are not offered, so a forced-open loop would buy rounds nothing can use). The read-only
   * guarantee lives in the TOOLSET — `maxSteps: 1` alone would still offer spending tools on the one
   * step it has.
   */
  if (input.isDiscussTurn) {
    return input.preloadedCount === 0 && !input.isSlash
      ? { allowTools: true, toolset: 'skills-only', maxSteps: MAX_TOOL_ROUNDS + 1 }
      : { allowTools: false, toolset: 'skills-only', maxSteps: 1 };
  }

  const allowTools = input.hasMcpTools || (input.preloadedCount === 0 && !input.isSlash);

  if (allowTools) {
    return { allowTools: true, toolset: 'all', maxSteps: MAX_TOOL_ROUNDS + 1 };
  }

  /*
   * Nothing above wants a full loop — but media generation must stay reachable from the CHAT on every
   * turn, not only on creation and not only on the turns that happen to route no skill (§4.16). A
   * media-only loop with a small cap is the bounded way to do that: see `MEDIA_TURN_STEPS`.
   */
  if (input.hasMediaTools) {
    return { allowTools: true, toolset: 'media-only', maxSteps: MEDIA_TURN_STEPS };
  }

  return { allowTools: false, toolset: 'all', maxSteps: 1 };
}
