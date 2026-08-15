/**
 * Pre-load the skills a request obviously needs, instead of making the model fetch them (SPEC §4.2, §4.11).
 *
 * ## Why this exists — measured, not theorised
 *
 * Progressive disclosure (model calls `load_skill` when it decides it needs one) is the textbook
 * design, and on this workload it is catastrophic. A real "make me a kart racer" build:
 *
 *   step 1:  28s |  2,570 out | load_skill
 *   step 2:  27s |  2,015 out | read_skill_resource
 *   step 3:  52s |  4,074 out | load_skill
 *   step 4:  51s |  4,275 out | load_skill
 *   step 5:  51s |  4,221 out | read_skill_resource
 *   step 6:  53s |  4,250 out | load_skill
 *   step 7:  86s |  7,768 out | load_skill
 *   step 8: 118s | 13,813 out | ANSWER
 *
 * The ANSWER — the actual game — is 13,813 tokens and about two minutes. The tool steps burned
 * **29,173 output tokens over 350 seconds**: 68% of the bill and 75% of the wall clock. A tool CALL is
 * a JSON argument worth ~50 tokens, so those tens of thousands of tokens are not tool calls. They are
 * the model DRAFTING the game, realising it wants a skill, calling for it, and then throwing the draft
 * away and redrafting. Six times. It loaded exactly ONE distinct skill (`bt-design`) across four
 * `load_skill` calls.
 *
 * So the tool loop is not paying for itself: it costs far more than the context it saves. Handing the
 * model the skill up front, inside the CACHED prefix (cache reads bill at 0.1x), removes the round
 * trips, the redrafts, and the risk of hitting the tool-round cap — which triggers a forced
 * re-answer and doubles the output again.
 *
 * `load_skill` stays, for anything the router does not anticipate. It just stops being the common path.
 */
import { getSkillStore } from '~/lib/.server/skills/store';
import type { SkillVersion } from '~/lib/.server/skills/store';
import { createScopedLogger } from '~/utils/logger';

const logger = createScopedLogger('preload-skills');

/**
 * The two skills the CREATION brief is written against (§4.4b, §4.4c).
 *
 * A constant, not a router, and the distinction is the whole point of the 2026-07-26 rewrite. The
 * creation turn is the one turn whose prompt we WROTE: the brief delegates the landing page + chrome
 * to `bt-landing`, which builds on `bt-design`'s standards. We do not have to infer that — we know it.
 *
 * Everything else is chosen by the MODEL from the skills index, exactly as `load_skill` was always
 * meant to work.
 */
const CREATION_SKILLS = ['bt-landing', 'bt-design'];

/**
 * How many model-chosen skills a CONVERSATION carries forward in its cached prefix (§4.11).
 *
 * Distinct from `MAX_SKILL_LOADS`, which bounds NEW loads in a single response. This bounds the
 * accumulated set, because every carried skill is 15–25KB living in the prefix of every remaining turn
 * — cheap to READ (0.1x) but not free, and each addition costs one 2x cache WRITE on the turn it joins.
 * Three lets a long workflow hold a domain skill, a procedure skill and one more without the prefix
 * growing without limit.
 */
export const MAX_STICKY_SKILLS = 3;

/**
 * The skills the model has ALREADY loaded earlier in this conversation, oldest first.
 *
 * ## Why this exists (2026-07-26) — the last real gap against Claude Code
 *
 * In Claude Code a loaded skill stays in context for the rest of the session: you pay for it once. Our
 * tool loop is server-side and internal (`tools.ts`) — the call and its result never enter the saved
 * conversation — so a skill loaded on turn 1 was simply GONE on turn 2, and a spec -> plan -> execute
 * workflow paid a fresh round trip on every single turn for instructions it had already been given.
 *
 * The fix is to carry them in the CACHED prefix, which makes us cheaper than the thing we are copying:
 * Claude Code re-sends a loaded skill in an uncached conversation, we re-send it at 0.1x.
 *
 * ## Where the list comes from, and why not a database
 *
 * From the conversation itself: `api.agent.ts` writes an `agentMeta` message annotation carrying
 * `skillsLoaded`, the AI SDK posts annotations back with the message history, and the transcript store
 * persists them (the `/context` dot already reads them on reload). So the record of what the model
 * chose travels with the thing it chose for. A `generations` query would add a database round trip to
 * the hot path of every generation to learn something the request already contains.
 *
 * ## The two properties that make it safe to put in the cached prefix
 *
 * **First-seen order, append-only.** The set may only grow, and only at the END. This is the same rule
 * `selectStickyBlocks` documents and for the same reason: a skill inserted at the FRONT shifts every
 * byte behind it and re-writes the whole prefix at 2x. Reordering here is a silent bill, not a bug.
 *
 * **Read from the FULL message list, never the compacted one.** `compactHistory` drops turns outside
 * the window; reading post-compaction would make the carried set SHRINK as a conversation ages, which
 * breaks append-only in the most expensive possible way — the prefix would rewrite itself on the turn
 * the window slides.
 */
export function stickyLoadedSkills(messages: Array<{ annotations?: unknown }>): string[] {
  const seen: string[] = [];

  for (const message of messages) {
    if (!Array.isArray(message.annotations)) {
      continue;
    }

    for (const annotation of message.annotations) {
      if (!annotation || typeof annotation !== 'object') {
        continue;
      }

      const record = annotation as { type?: unknown; value?: { skillsLoaded?: unknown } };

      if (record.type !== 'agentMeta' || !Array.isArray(record.value?.skillsLoaded)) {
        continue;
      }

      for (const name of record.value.skillsLoaded) {
        if (typeof name === 'string' && name && !seen.includes(name)) {
          seen.push(name);
        }
      }
    }
  }

  return seen.slice(0, MAX_STICKY_SKILLS);
}

/**
 * Which carried skills does THIS turn get? — `stickyLoadedSkills` plus the two exclusions (§4.4a, T13).
 *
 * Extracted from an inline ternary in `proxy.ts` for one reason: the first-build SUPPRESSION was the
 * only one of the ten first-build protections with no behavioural test. `stickyLoadedSkills` is
 * flag-blind by design (it answers "what has this conversation loaded"), so the rule — *a first build
 * carries nothing forward* — lived nowhere a test could call it, and a source scan can only prove that
 * a ternary is present, never that it decides correctly. Pure, so both branches are now assertable.
 *
 * Two exclusions, and they are different in kind:
 *
 *   - **first build** carries NOTHING. It has its own fixed pair (`bt-landing` + `bt-design`) and no
 *     skill tools, and its prefix is the one that is byte-identical across every user — letting a
 *     remixed conversation's skills ride into it is a 2x cache WRITE on the largest turn in the product.
 *   - **the invoked skill** is dropped because `/bt-plan` inlines `bt-plan`'s body already; carrying it
 *     as well pays for the same bytes twice in one prompt.
 */
export function carriedSkillNames(input: {
  isFirstBuildTurn: boolean;
  messages: Array<{ annotations?: unknown }>;
  invokedSkillName?: string;
}): string[] {
  if (input.isFirstBuildTurn) {
    return [];
  }

  return stickyLoadedSkills(input.messages).filter((name) => name !== input.invokedSkillName);
}

/**
 * 🔴 AN INVOKED SKILL'S DECLARED PREREQUISITES COME WITH IT (owner-reported live, 2026-08-14).
 *
 * *"I used bt-landing the last blank canvas build, but it did not pull in bt-design as it should
 * have."* Correct, and the skill had asked for it in as many words: `bt-landing`'s body opens with
 * *"Prerequisite — load bt-design FIRST, before anything else… call `load_skill('bt-design')`"*. The
 * tool was offered. The model did not call it.
 *
 * That is the failure this repo has recorded more times than any other — **prose is not a mechanism**
 * (`protocol-strip`; the six-round thrash where the model called `load_skill` five times against a
 * heading telling it not to). A prerequisite the pipeline can satisfy must not be left as a request.
 *
 * ## Why it took a live report to surface
 *
 * It only ever worked on the CREATION turn, where `CREATION_SKILLS` inlines the pair as a fixed
 * constant. Every re-run — `/bt-landing` on an established project, or on a Blank Canvas project,
 * which since 2026-08-14 owes no build and so is not a first build turn — got `bt-landing` alone and
 * silently produced generic output. The skill's own text says the creation case is "already
 * satisfied", which reads as describing a general mechanism rather than the single exception it was.
 *
 * ## The rules
 *
 * **One level, never recursive.** A dependency's own dependencies are not followed. That bounds the
 * cost at `MAX_SKILL_DEPENDENCIES` bodies and makes a cycle (`a → b → a`) unrepresentable rather than
 * something a visited-set has to catch.
 *
 * **Nothing already in context is re-added.** The invoked skill's body is inlined by
 * `resolveSlashInvocation`, and carried skills (`stickyLoadedSkills`) are inlined beside it — paying
 * for the same 20KB twice in one prompt is the exact waste `carriedSkillNames` drops the invoked skill
 * to avoid.
 */
export function skillDependencyNames(input: {
  /** The skill the user invoked with `/name`, and what its frontmatter says it is built on. */
  invoked?: { name: string; dependencies?: string[] };

  /** Skill names whose bodies are ALREADY in this prompt — the invoked skill and any carried ones. */
  alreadyInContext: string[];
}): string[] {
  if (!input.invoked?.dependencies?.length) {
    return [];
  }

  const excluded = new Set([input.invoked.name, ...input.alreadyInContext]);
  const names: string[] = [];

  for (const name of input.invoked.dependencies) {
    if (excluded.has(name) || names.includes(name)) {
      continue;
    }

    names.push(name);
  }

  return names;
}

/** Load the bodies for an already-decided list of skill names, skipping any that are no longer synced. */
export async function loadSkillBodies(names: string[]): Promise<PreloadedSkill[]> {
  if (names.length === 0) {
    return [];
  }

  const store = getSkillStore();

  const loaded = await Promise.all(
    names.map(async (name): Promise<PreloadedSkill | null> => {
      const skill: SkillVersion | null = await store.getActive(name);

      if (!skill) {
        logger.warn(`Carried skill "${name}" is no longer synced — dropping it from the prefix`);
        return null;
      }

      return { name: skill.name, body: skill.body, resourcePaths: skill.resourcePaths ?? [] };
    }),
  );

  return loaded.filter((s): s is PreloadedSkill => s !== null);
}

export interface PreloadedSkill {
  name: string;
  body: string;

  /**
   * The skill's bundled resources — the paths ONLY, never the bodies.
   *
   * Load-bearing, and its absence caused a two-minute failure. `load_skill`'s return value appends
   * this list, so a model that fetches a skill the normal way learns what else it can ask for. The
   * pre-loaded block used to omit it — and `bt-design`'s instructions say, in as many words, "read
   * `references/3d-hero-scroll.md` BEFORE writing any code". So the model had an instruction to read a
   * file and no idea what files existed. It called `load_skill` five times trying to get the list, then
   * guessed a path called `"placeholder"`.
   *
   * Pre-loading a skill means giving the model everything `load_skill` would have — including this.
   */
  resourcePaths: string[];
}

/**
 * The skills to inline for this request — the CREATION brief's two, and otherwise NOTHING.
 *
 * 🔴 **Only the creation turn pre-loads. Every other turn's skills are chosen by the model** from the
 * index of `name — description` that `buildSkillsIndex` bakes into the cached prompt, using
 * `load_skill`. That is the agentskills.io contract, and it is how Claude Code works.
 *
 * ## Why the keyword router is gone (2026-07-26)
 *
 * It was a `Record<string, string[]>` of substrings, hardcoded HERE, matched against the user's text.
 * Every one of its failures was silent:
 *
 *   - `'ui'` matched as a bare substring, so it fired on "b**ui**ld", "q**ui**ck", "req**ui**rements".
 *     `"why is my build failing"` inlined `bt-design` — 24KB, into the cached prefix, on a debugging
 *     question.
 *   - Three of the ten SYNCED skills had no entry at all and could therefore never load:
 *     `bt-copycat`, `bt-plan`, `bt-execute` — the last two being two-thirds of the product's own
 *     spec → plan → execute workflow.
 *   - The `description` — which `buildSkillsIndex` documents as THE trigger ("a skill that never
 *     auto-fires almost always has a weak description; fix it in the repo and resync") — was never
 *     read by the thing doing the selecting. Rewriting a description changed nothing.
 *   - Skills are authored EXTERNALLY (`babylontoolkit/skills`). A new skill synced, indexed, and shown
 *     to the model still could not load until someone edited a TypeScript constant in this repo, which
 *     breaks the standing "this codebase consumes the skills repo, never edits it" rule.
 *   - The router's input included the INVOKED SKILL'S OWN BODY, so `/bt-spec` inlined `bt-landing`
 *     because bt-spec's SKILL.md contains the word "landing" — and routing was sticky, so the mistake
 *     was then pinned for the rest of the conversation.
 *
 * Together those made the feature a prompt library with extra steps: which instructions the model got
 * was decided by substring accidents in our code rather than by the task in front of it.
 *
 * ## Why this does not re-buy the six-round pathology
 *
 * The measured disaster (6 rounds, 29,173 output tokens, 350s, to end up with ONE distinct skill) is
 * quoted at the top of this file, and it is worth being precise about what it was: a `load_skill` call
 * is ~50 tokens of JSON, so those tens of thousands of tokens were the model DRAFTING the artifact
 * between rounds and discarding each draft — and the repeat calls were it re-requesting instructions it
 * had already been handed. Four things now make that unreachable, none of which existed when it was
 * measured:
 *
 *   1. **`MAX_SKILL_LOADS`** (`tools.ts`) — a hard budget on skill BODIES, enforced inside `execute`.
 *      Past it the tool refuses and tells the model to proceed. Six rounds of skill loading cannot
 *      happen regardless of what the model wants.
 *   2. **The already-loaded guard** — a re-request returns one sentence, not a 17KB body.
 *   3. **Nothing is inlined on an ordinary turn**, so the contradictory state that produced every
 *      recorded thrash (a skill in the prefix under "ALREADY LOADED — do NOT call load_skill" WHILE
 *      the tool was offered) no longer exists. One mechanism per turn, never two.
 *   4. **The index tells the model to load skills BEFORE it starts writing**, which is what stops the
 *      draft-load-redraft cycle that the token count actually measured.
 *
 * The creation turn — the most expensive generation in the product, and the one that produced the
 * 468s → 114s win when its tools were removed — is deliberately UNCHANGED: fixed skills, no tools.
 */
export async function preloadSkills(slashSkill?: string, isCreation = false): Promise<PreloadedSkill[]> {
  /*
   * The creation brief is machine-written and delegates to two named skills, so there is nothing to
   * infer. (It is also why the old router could not be trusted here even in its own terms: the brief's
   * incidental vocabulary — "created", "starter", "scaffold" — keyword-matched skills the model had no
   * use for, and we watched it drag in `bt-prototype` for a project that was already scaffolded.)
   *
   * A skill named here but missing from the synced snapshot is skipped with a warning below; the
   * brief's fallback sentence routes the model to the baked hard-constraints sections instead, so
   * creation never fails on its absence.
   */
  const wanted = isCreation ? CREATION_SKILLS.filter((name) => name !== slashSkill) : [];

  if (wanted.length === 0) {
    return [];
  }

  const store = getSkillStore();

  const loaded = await Promise.all(
    wanted.map(async (name): Promise<PreloadedSkill | null> => {
      const skill: SkillVersion | null = await store.getActive(name);

      /*
       * A skill named here but missing from the synced snapshot is not an error worth failing a
       * generation over — the model still has `load_skill`, and the doc-sync log is where a missing
       * skill should be noticed.
       */
      if (!skill) {
        logger.warn(`Pre-load skipped: no active skill named "${name}"`);
        return null;
      }

      return { name: skill.name, body: skill.body, resourcePaths: skill.resourcePaths ?? [] };
    }),
  );

  const result = loaded.filter((s): s is PreloadedSkill => s !== null);

  if (result.length > 0) {
    logger.info(`Pre-loaded skills (no tool round needed): ${result.map((s) => s.name).join(', ')}`);
  }

  return result;
}

/**
 * The system block carrying the skills that are already in context.
 *
 * Two callers, and the difference matters:
 *
 *   - **Creation** — the brief's two skills, on a turn with NO skill tools. This block is everything
 *     the model gets, so it must not name bundled resource paths: naming a file the model has no tool
 *     to open is not information, it is a dangling instruction, and that is what caused the measured
 *     160-second thrash (paths listed, `read_skill_resource` available, six rounds spent pulling in
 *     101KB of hero-scroll templates to change a button's colour, then an empty response).
 *
 *   - **Carried** (`stickyLoadedSkills`) — skills the model itself loaded earlier in the conversation,
 *     on a turn where the tools ARE offered. Here the resource paths are honest information: the model
 *     can open them, and withholding them would recreate `bt-design`'s "read `references/…` before
 *     writing code" as an unfollowable instruction.
 *
 * `withResources` therefore tracks whether the tools exist, and nothing else decides it.
 */
export function buildPreloadedSkillBlock(skills: PreloadedSkill[], withResources = false): string {
  const names = skills.map((s) => s.name).join(', ');

  /*
   * The wording is deliberately "you already have these", never "do NOT call load_skill".
   *
   * The old text was an order the tool set contradicted, and we watched the model spend six rounds and
   * ~11,000 output tokens calling `load_skill('bt-design')` five times against a heading that said not
   * to. The guard that actually stops that lives in `execute` (a one-sentence already-loaded reply that
   * costs no budget); prose only has to make the state clear.
   */
  const header =
    `# Skills — already in context\n\n` +
    `You have the full instructions for these skills below: ${names}. ` +
    `There is no need to load them again — a repeat request just costs a round trip.\n\n`;

  return (
    header +
    skills
      .map((skill) => {
        const resources =
          withResources && skill.resourcePaths.length
            ? `\n\nBundled resources (read with read_skill_resource):\n${skill.resourcePaths
                .map((p) => `- ${p}`)
                .join('\n')}`
            : '';

        return `## Skill: ${skill.name}\n\n${skill.body}${resources}`;
      })
      .join('\n\n---\n\n')
  );
}
