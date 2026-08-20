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
import { phaseAllowsMedia, type CreationPhaseId } from '~/lib/agent/creation-plan';
import {
  type AgentBudgets,
  CREATION_FILE_READ_ROUNDS as SHARED_CREATION_FILE_READ_ROUNDS,
  DEFAULT_AGENT_BUDGETS,
} from './budgets';

/** 1 round of parallel generate_* calls + the ANSWER step + 1 round of slack (the +1 rule, §4.2.8). */
export const CREATION_MEDIA_STEPS = 3;

/**
 * 🔴 THE CREATION TURN'S STEP CAP IS DERIVED FROM THE TOOL BUDGETS, NOT PICKED (Phase 2, 2026-08-08).
 *
 * `gen_msixapaq_i871b6` cost 1,489 credits and shipped no game because the model spent every step it
 * had on tool calls and hit the cap mid-call with the project unwritten — the forced continuation then
 * re-billed the whole prefix at the 2x write rate to deliver 31 tokens of nothing. The lesson recorded
 * then was the `+ 1` rule: **the answer must have a step the tools cannot consume.**
 *
 * That rule is only true if `maxSteps` exceeds the WORST-CASE number of tool rounds, and Phase 2 added
 * a second budget to the creation turn (`load_reference` — the documentation is no longer baked, so the
 * build turn has to be able to ask for it). Worst case is every budgeted call landing in its own step:
 * `MAX_REFERENCE_LOADS` + `MAX_MEDIA_ROUNDS`. Past that both budgets refuse inside `execute`, so the
 * final step has nothing left to spend and can only answer.
 *
 * ⚠️ **Derived deliberately, so it cannot drift.** The old constant was a hand-maintained "1 round +
 * the answer + slack" whose comment described a shape the code did not enforce; raising either budget
 * without re-deriving this is precisely how that 1,489 happened. Both numbers now move together or not
 * at all, and `tool-policy.spec.ts` asserts the relationship rather than the literal.
 *
 * The cost of the extra headroom is small and bounded: an in-generation step re-reads the WARM prefix
 * at 0.1x (~$0.04 on the post-Phase-2 prefix), where the forced continuation it prevents rewrites it
 * at 2x. Slack here is roughly twenty times cheaper than the failure it insures against.
 */
/**
 * 🔴 `read_file` ROUNDS ARE PART OF THIS SUM (2026-08-08, live-caught on the first drive).
 *
 * The manifest replaced the file dump, so the model now READS files instead of being shown them — and
 * every read round is a step. `read_file` was added to the creation toolset and this constant was not
 * re-derived, which reproduced the exact failure the comment above describes, on the very next run:
 *
 *   step 1: read_file x3, load_reference x3
 *   step 2: read_file x8
 *   step 4: read_file x4
 *   WARN  Tool-round cap (3) reached — forcing a final answer with tools disabled
 *   step 5: 655,957ms · 64,000 out · finish=length+forced-continuation
 *   Charged 1175 credits ($3.6450), 74,524 cache tokens WRITTEN (two full prefixes)
 *
 * The saving from the manifest was real (77,699 -> 37,713 written) and the step starvation ate all of
 * it and more. The `+ 1` answer step exists so the model always has somewhere to write; it does not
 * help when the model is still gathering context on the last step it has.
 *
 * Reads are cheap in TOKENS and expensive in STEPS: the model parallelises them (8 in one step above)
 * but discovers what it needs incrementally, so it takes several rounds. Budgeted generously on
 * purpose — an extra in-generation step re-reads the WARM prefix at 0.1x, where the forced
 * continuation it prevents rewrites the whole thing at 2x AND risks a truncated project.
 *
 * ⚠️ Held at 3 so `CREATION_TOOL_ROUNDS + 1` stays at or below `MAX_TOOL_ROUNDS + 1` — a creation must
 * never get MORE rounds than an ordinary turn, which `tool-policy.spec.ts` asserts as a relationship.
 * The live run used exactly 3 read rounds (steps 1, 2 and 4), so this covers the observed shape.
 *
 * 🔴 **The "if it needs to grow, `MAX_TOOL_ROUNDS` grows with it or the invariant breaks" clause is no
 * longer a note for a future reader — it is CODE** (`budgets.ts`, 2026-08-09). The reference budget is
 * configurable now, and an operator raising it is exactly the case that sentence was worrying about; a
 * warning in a comment cannot be executed by a deploy that sets an env var. `maxToolRounds` is derived
 * upward from whatever the budgets resolve to, so the relationship holds by construction rather than by
 * someone reading this paragraph first.
 *
 * Both constants below re-export the SHIPPED defaults. The values a turn runs with arrive on
 * `ToolPolicyInput.budgets`; reading these here would ignore the operator silently.
 */
export const CREATION_FILE_READ_ROUNDS = SHARED_CREATION_FILE_READ_ROUNDS;

export const CREATION_TOOL_ROUNDS = DEFAULT_AGENT_BUDGETS.creationToolRounds;

/**
 * 🔴 MEDIA IS OFF THE CREATION TURN (2026-08-08, owner-driven, live evidence below).
 *
 * The `+ 1` answer-step rule above is necessary and was NOT sufficient. It guarantees the model a step
 * the tools cannot consume; it cannot guarantee that step is worth anything. Measured on a real "mario
 * kart racer clone" creation:
 *
 *   step 2: 268,169ms · 25,598 out · 0 chars text · 17,613 chars reasoning · tools: generate_image
 *   WARN  media tool: round budget spent (2/2), call refused   x3
 *   step 3:  11,779ms ·  1,076 out · tools: generate_image, generate_image, generate_image
 *   step 4:  23,597ms ·  3,211 out ·  7,165 chars text · ANSWER
 *
 * The turn never hit `maxSteps` (it had 6, it used 4). It ended because the model spent FOUR AND A HALF
 * MINUTES and 25,598 output tokens reasoning inside a media round, ate three refusals, then wrote a
 * design note, ONE file, the sentence "Writing the full project now." — and stopped. No landing page, no
 * chrome, no game. A step budget cannot fix that: the damage is to the model's own sense of the turn,
 * and the refusal text (an error, mid-plan, three times) is what tells it the turn is going badly.
 *
 * The real defect is structural and is recorded in `FRESH-START.md` §1.4: an async render that takes
 * 20s-4min has no business inside the synchronous loop that also has to write the project. Batching the
 * calls into "ONE parallel round" (the brief's instruction) made media compete with the build for the
 * one resource neither can share — the model's attention on a single turn — and then needed
 * `MAX_MEDIA_ROUNDS` to stop media winning, which is why art gets REFUSED on the turn that designs it.
 *
 * So creation writes the PROJECT and nothing else. Art is requested on any later turn (media tools are
 * in the full toolset and the loop opens for them, §4.16) or from the Media panel. This is strictly the
 * safer direction: the failure mode of "no art yet" is a follow-up turn, and the failure mode of "no
 * game" is the most expensive generation in the product delivering nothing.
 *
 * ⚠️ Do NOT restore media here by raising a budget. The v2 fix is a QUEUE (`FRESH-START.md` §3.5):
 * serialized, spaced, per-image retry, returning paths instantly and never consuming a round at all.
 * Until that exists, off is correct.
 *
 * ---
 *
 * 🔴 **BOTH CONDITIONS THIS COMMENT SET HAVE NOW BEEN MET, so the flat `false` is retired (§4.4e).**
 * Kept above verbatim because it is the evidence, and because it named its own exit criteria:
 *
 *   1. **The queue exists** (`c0fa312`): `MAX_MEDIA_ROUNDS` and its refusal branch are deleted, one
 *      image per call, dispatched serially, spaced 1500ms, 3 attempts per IMAGE. The refusal text
 *      that told the model its turn was going badly cannot be emitted any more.
 *   2. **Media no longer shares a turn with the build.** That was the structural defect — "an async
 *      render has no business inside the synchronous loop that also has to write the project" — and
 *      phases fix it at the root rather than by budget: `art` is its OWN step, so no number of
 *      renders can starve the build, because the build already happened two steps ago.
 *
 * The old rule also had a real cost, which is what forced this: with media off the creation turn
 * ENTIRELY, the model designs a page needing six images and then writes a shopping list it cannot
 * act on — the art simply never happened unless the user went and asked for it.
 *
 * `phaseAllowsMedia` is the replacement and it is TRUE FOR EXACTLY ONE PHASE. A creation with no plan
 * (an older project, or a build that never started) has no phase, so it resolves to `false` and
 * behaves precisely as this constant did.
 */

/**
 * 🔴 HOW MANY IMAGE ROUNDS AN ORDINARY TURN CAN AFFORD (2026-08-08, replacing `MEDIA_TURN_STEPS`).
 *
 * The model now asks for ONE image per call, when the design needs it (`media-note.ts`), because the
 * batching instruction and the `MAX_MEDIA_ROUNDS` cap that enforced it refused three images a live
 * design had asked for. Removing a refusal is only half a fix: one image per round means six images
 * consume six steps, and an ordinary turn had `MAX_TOOL_ROUNDS + 1` = 7 in total — which also has to
 * cover `read_file` rounds, a `load_reference`, and the step that writes the files.
 *
 * ⚠️ **Deleting a budget without raising its ceiling trades a refusal for a STARVED turn**, and a
 * starved turn is worse: the model spends every step on art and never writes the project. That is
 * exactly the bug shipped hours earlier, when `read_file` joined the creation toolset and
 * `CREATION_TOOL_ROUNDS` was not re-derived (74,524 cache tokens written, `finish=length`, 1,175
 * credits). The cap and the ceiling move together or not at all.
 *
 * The headroom is cheap and bounded: an extra in-generation step re-reads the WARM prefix at 0.1x,
 * against a forced continuation that rewrites the whole prefix at 2x and risks truncating the answer.
 * It is a CEILING, never a refusal — the model is never told "no" to a call it has already decided to
 * make; the turn simply cannot run forever.
 *
 * The retired `MEDIA_TURN_STEPS` it replaces was dead code with no reader anywhere (only its own
 * definition and a stale mention in `media-note.ts`), and the reasoning it carried — that media tools
 * may never be WITHHELD from a turn, because the model then narrates the absence and draws the art in
 * CSS — now lives in the ordinary branch of `toolPolicyForTurn`, which always offers the full toolset.
 */
export const MEDIA_IMAGE_ROUNDS = 8;

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
   * Discussion mode is active this turn (§4.2.9). A discuss turn is READ-ONLY by guarantee, not just
   * by instruction: media tools DEBIT credits, and MCP tools can mutate the sandbox (a `write_file`
   * MCP tool is ordinary, not exotic) — neither may be offered.
   *
   * 🔴 **It CAN be true on a first build turn, and this comment used to say the opposite.** It read
   * *"already creation-guarded by the caller… so it can never be true on a creation turn"* — true when
   * written, because `discussModeNote` took `isFirstBuildTurn` and returned `null` for one. The owner
   * removed that exemption on 2026-08-09 so the handoff card's **"Plan my brief"** could be real, and
   * this comment was not updated. It is the sentence that made the resulting bug look impossible: a
   * reader checking whether the branch below could be reached found a comment saying it could not.
   */
  isDiscussTurn?: boolean;

  /**
   * Which phase of the creation plan this is (§4.4e), or `null` for the pre-phase single turn.
   *
   * Read ONLY inside the `isFirstBuildTurn` branch, and the proxy only parses it for such a turn — so
   * it cannot widen an ordinary edit's tool set. `null` reproduces the old behaviour exactly, which is
   * what keeps a project created before phases (and one whose build never started) working unchanged.
   */
  creationPhase?: CreationPhaseId | null;

  /**
   * This turn's resolved round ceilings (`budgets.ts`).
   *
   * 🔴 Optional and defaulting to the shipped values, so every existing caller is byte-identical — but
   * production MUST pass them, because they are DERIVED from the reference budget. An operator raising
   * `AGENT_MAX_REFERENCE_LOADS` without the ceilings moving with it would give a creation more rounds
   * than an ordinary turn, inverting the relationship this file's own spec pins. That derivation lives
   * in `budgets.ts`; this input is how it reaches the decision.
   */
  budgets?: Pick<AgentBudgets, 'maxToolRounds' | 'creationToolRounds'>;
}

export interface ToolPolicy {
  allowTools: boolean;

  /**
   * `creation` = media + `load_reference` (+ the repair bounce). It strips SKILL and MCP tools: the
   * brief's two skills are already inlined, and "inlined AND offered" is the exact combination that
   * produced every recorded six-round thrash. `skills-only` strips media + MCP (discussion turns: skill
   * and reference loads are read-only grounding; nothing offered may spend or mutate).
   *
   * ⚠️ Renamed from `media-only` in Phase 2 (2026-08-08), when `load_reference` joined it. The old name
   * had become a false statement about what the set contains, and a comment that lies about a tool set
   * is how someone later "restores" a document to the prefix that was never missing from the turn.
   */
  toolset: 'all' | 'creation' | 'skills-only';

  /**
   * May this turn call the media tools?
   *
   * An EXPLICIT flag rather than something the caller infers from `toolset`, because the answer stopped
   * being a property of the toolset NAME when the art phase arrived: two turns can both be `creation`
   * and differ on this. A predicate the caller has to re-derive is one that drifts from what the tool
   * object actually contains, and this one decides whether a turn can spend credits on renders.
   */
  allowsMedia: boolean;

  /** Passed straight to `streamText` — counts EVERY round trip, so the answer step must fit inside. */
  maxSteps: number;
}

export function toolPolicyForTurn(input: ToolPolicyInput): ToolPolicy {
  /*
   * The ceilings this turn runs with. `DEFAULT_AGENT_BUDGETS` reproduces the shipped constants
   * exactly, so an absent `budgets` is byte-identical to the behaviour before config existed.
   */
  const maxToolRounds = input.budgets?.maxToolRounds ?? DEFAULT_AGENT_BUDGETS.maxToolRounds;
  const creationToolRounds = input.budgets?.creationToolRounds ?? DEFAULT_AGENT_BUDGETS.creationToolRounds;

  /*
   * 🔴 PLAN MODE OUTRANKS THE FIRST BUILD TURN (owner-reported live, 2026-08-15).
   *
   * *"When you hit `Plan my brief` it should NOT use the three stages card and try the multi stage
   * build — [it should] use a skill, like `/bt-plan`, because they chose the `Plan my brief` button."*
   *
   * The handoff card offers Build and Plan side by side, and BOTH are first build turns — the project
   * still owes its build either way, so `projectOwesBuild` is true for both. Deciding first-build
   * before discuss therefore handed a planning turn the CREATION toolset: `load_skill` withheld,
   * `read_file`/`load_reference` offered, and on the `art` phase **media tools that debit credits** —
   * i.e. a turn the user asked to only think about the project could render art and be billed for it.
   * §4.2.9's read-only guarantee lives in the TOOLSET; the note and the `NO_REPLAY` mark were doing
   * their half while this branch quietly undid it.
   *
   * The ordering is the whole fix, and it is the rule two other consumers already follow —
   * `shouldVerifyCreationCompleteness` is `!isFirstBuildTurn || isDiscussTurn`, and the unproductive
   * rescue is `isFirstBuildTurn && !discussNote`. Two of four consumers agreed that a discuss turn is
   * not a build; this file and `preloadSkills` were the two that did not, and both are money paths.
   */
  if (input.isDiscussTurn) {
    return input.preloadedCount === 0 && !input.isSlash
      ? { allowTools: true, toolset: 'skills-only', allowsMedia: false, maxSteps: maxToolRounds + 1 }
      : { allowTools: false, toolset: 'skills-only', allowsMedia: false, maxSteps: 1 };
  }

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
    /*
     * 🔴 THE CREATION TURN HAS TOOLS NOW EVEN WITHOUT MEDIA — because the docs left the prefix.
     *
     * This branch used to be `{ allowTools: false, maxSteps: 1 }`: the historic one-shot that took a
     * creation from 997k prompt tokens to a single step. That was correct while ~106KB of Babylon
     * Toolkit documentation was welded into every prompt — the model already had everything, so a tool
     * could only cost rounds.
     *
     * Phase 2 unbaked those documents. A creation with no tools at all would now be asked to write a
     * complete game with the platform's rules, the router index, the reference INDEX — and not one line
     * of the API documentation the index describes. That is the §4.2.8 silent failure in its purest
     * form: nothing throws, the token count goes DOWN, and the game is simply worse.
     *
     * `load_reference` is in every toolset for that reason, and the six-round pathology cannot return
     * through it: the budget is on BODIES inside `execute` (`MAX_REFERENCE_LOADS`), the index tells the
     * model to load BEFORE it starts writing, and skills stay INLINED-and-untooled here, which is the
     * one combination ("inlined AND offered") that produced every recorded thrash.
     */
    /*
     * Media is on for EXACTLY ONE phase (`art`), and off entirely for a creation with no plan — which
     * is what makes an older project behave precisely as it did before phases existed.
     *
     * `hasMediaTools` still gates it: it is the platform saying a KIE key and a project exist, so the
     * art phase of a project that cannot render anything does not buy headroom it can never spend.
     */
    const allowsMedia = phaseAllowsMedia(input.creationPhase ?? null) && input.hasMediaTools;

    return {
      allowTools: true,
      toolset: 'creation',
      allowsMedia,

      /*
       * 🔴 DERIVED FROM THE BUDGETS THIS TURN CAN ACTUALLY SPEND — never hand-picked.
       *
       * `maxSteps` is the one number that must stay a true statement about the worst case, and this
       * repo has broken that twice in one day: `read_file` joined the creation toolset without
       * `CREATION_TOOL_ROUNDS` being re-derived (74,524 cache tokens written, `finish=length`, 1,175
       * credits), and the media budget was deleted without its ceiling moving. Both times the sum was
       * a literal that stopped describing the parts.
       *
       * So the art phase's headroom appears here BECAUSE it is the phase that can spend it, not
       * because someone remembered to add it — and the `+ 1` answer step stays outside every budget.
       */
      maxSteps: creationToolRounds + (allowsMedia ? MEDIA_IMAGE_ROUNDS : 0) + 1,
    };
  }

  /*
   * (Discussion turns are handled ABOVE, ahead of the first-build branch — see the comment there for
   * why the order is the fix and not an accident. The rule itself: the loop opens only for skill
   * loading, MCP tools never force it on (they are not offered, so a forced-open loop would buy rounds
   * nothing can use), and the read-only guarantee lives in the TOOLSET — `maxSteps: 1` alone would
   * still offer spending tools on the one step it has.)
   */

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
  /*
   * 🔴 A MEDIA TURN GETS ROOM FOR ITS IMAGES (2026-08-08 — `MEDIA_IMAGE_ROUNDS`).
   *
   * One image per call means an art request needs a step per image ON TOP of the reads, the reference
   * loads and the step that writes the files. Without this, removing `MAX_MEDIA_ROUNDS` would just
   * move the failure: instead of a refusal the model would run out of steps mid-design and hand the
   * answer to a forced continuation, which rewrites the whole prefix at 2x.
   *
   * `hasMediaTools` is the platform saying a KIE key and a project exist, i.e. the tools really are in
   * this turn's set — so the headroom is only bought on turns that can actually spend it.
   */
  return {
    allowTools: true,
    toolset: 'all',
    allowsMedia: input.hasMediaTools,
    maxSteps: maxToolRounds + (input.hasMediaTools ? MEDIA_IMAGE_ROUNDS : 0) + 1,
  };
}
