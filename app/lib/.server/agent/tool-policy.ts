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
 * ⚠️ RETIRED for ordinary turns (2026-07-26) — kept because the reasoning below is still the reason
 * media tools may never be withheld, and because the creation path still uses this budget.
 *
 * Ordinary turns now always get the FULL toolset (see `toolPolicyForTurn`), so there is no longer a
 * "closed loop that media has to prise back open": media, MCP and skill tools are all offered, and the
 * skill-thrash ceiling moved into `MAX_SKILL_LOADS` where it belongs.
 *
 * The historical note:
 *
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
  isFirstBuildTurn: boolean;

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
  if (input.isFirstBuildTurn) {
    /*
     * 🔴 `+ 1` — THE ANSWER STEP IS SEPARATE FROM THE MEDIA BUDGET (2026-08-07, gen_msixapaq_i871b6).
     *
     * `CREATION_MEDIA_STEPS` was documented as "1 round + the answer + 1 slack", but nothing stopped
     * the model spending ALL of them on tool rounds. Measured: a first build turn made generate_image
     * calls on every step (3+1+1 sequential images), hit the cap mid-tool-call with the game unwritten,
     * and the forced-continuation rescue re-billed the whole ~212k prefix at the 2× cache-write rate to
     * deliver 31 tokens of nothing — 1,489 credits, no game. Same rule as `MAX_TOOL_ROUNDS + 1`: the
     * answer must have a step the tools cannot consume. The media-round BUDGET (`MAX_MEDIA_ROUNDS`,
     * enforced inside the tools' execute) is what makes the extra step unspendable on a 3rd render
     * round — policy cap and execute budget work as a pair, and an in-generation answer step re-reads
     * the warm prefix at 0.1× where the forced continuation rewrites it at 2×.
     */
    return input.hasMediaTools
      ? { allowTools: true, toolset: 'media-only', maxSteps: CREATION_MEDIA_STEPS + 1 }
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

  /*
   * 🔴 ORDINARY TURNS ALWAYS GET THE SKILL TOOLS (2026-07-26).
   *
   * This used to be `hasMcpTools || (preloadedCount === 0 && !isSlash)` — i.e. the keyword router
   * decided, and the moment it fired, `load_skill` was withdrawn. That produced a system in which the
   * cached prompt listed ten skills and told the model "Call load_skill(name) to load one of these",
   * while the tool was not in the tool set. A dangling instruction, which is the exact failure this
   * file's own header warns about ("the model is TOLD it has tools it cannot call, and drafts around
   * them") — and it meant a wrong routing decision could never be corrected, on any turn, ever.
   *
   * Now: nothing is inlined on an ordinary turn, so the model chooses its own skills, exactly as
   * agentskills.io (and Claude Code) intend. The six-round pathology is bounded by `MAX_SKILL_LOADS`
   * inside the tool rather than by taking the tool away — see `preload-skills.ts` for why the two are
   * not the same trade, and why the recorded thrash always required a skill to be inlined AND the tool
   * offered at the same time. That contradictory state no longer exists.
   *
   * A `/slash` turn keeps its tools too: the invoked skill is inlined, but its instructions routinely
   * name a SIBLING (`bt-spec` → "Use bt-hero to create…"), and the composability the skill descriptions
   * advertise is only real if the model can act on it. Re-requesting the inlined skill costs one cheap
   * round and returns a single sentence (the already-loaded guard), not its body.
   */
  return { allowTools: true, toolset: 'all', maxSteps: MAX_TOOL_ROUNDS + 1 };
}
