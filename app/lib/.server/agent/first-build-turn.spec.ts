/**
 * THE FIRST BUILD TURN AND ITS SIX UNPROVEN CONSUMERS (§4.4a, 2026-07-29).
 *
 * `isFirstBuildTurn` (né `isCreationTurn`) is one boolean in `proxy.ts` that drives ten behaviours.
 * Exactly one of them used to be money, and that one is gone — the flat price moved to project
 * REGISTRATION (`project_create`) and the first build bills cost-derived like any other turn. What
 * survives is a bundle of PROTECTIONS, and every one of them fails silently:
 *
 *   - the creation brief's two skills are not inlined  → the model fetches them itself, six tool
 *     rounds, ~29,173 output tokens, the 468s→114s win handed back;
 *   - the sticky carried-skill set is not suppressed   → a remixed conversation's skills ride into the
 *     one prefix that is byte-identical across every user;
 *   - `load_skill` is offered on a turn that already inlined its pair → the exact contradiction that
 *     produced five consecutive `load_skill('bt-design')` calls and an empty answer;
 *   - `requiresAction` is not set                      → a first build that answers with 31,852 chars
 *     of prose and zero `<boltAction>` is billed and the project never gets built;
 *   - the status kind is wrong                         → the liveness panel narrates a creation as an
 *     ordinary edit;
 *   - the client's `creationTurnStore` is wrong        → the premium pill unlocks on a first build,
 *     which on KIE-buffered Fable 5 dies at the gateway timeout before its artifact can flush.
 *
 * None of that throws. Nothing goes red. The bill goes UP or the product quietly gets worse.
 *
 * ## Why this file is shaped like this
 *
 * A verifier broke FIVE of these simultaneously in `proxy.ts` and `pnpm test` stayed green, which is
 * the regression surface this file closes. Each consumer is pinned TWICE and the pair is the point:
 *
 *   1. **Behaviourally**, on the real function, with the flag true AND false. That proves the consumer
 *      still does two different things — a consumer that ignores the flag passes any wiring check.
 *   2. **Structurally**, on the ONE call expression in `proxy.ts` that hands it the flag. There is no
 *      seam that drives `runAgentGeneration` end to end (the proxy specs stop at the prompt, the
 *      billing specs start at `settleGeneration`), so the wiring itself is read from the source — in
 *      the `creation-flat.spec.ts` / `skill-selection.spec.ts` shape: comment-stripped, scoped to a
 *      single call's arguments by brace matching, and guarded by CONTROLS. A scan that silently
 *      matches nothing reports all-clear forever, so every extraction is proven to have found the real
 *      call before anything is asserted about it.
 *
 * Where a consumer had no seam at all, one was made rather than settled for: `carriesCreationBrief`
 * and `statusKindFor` are now exported pure functions in `proxy.ts`, and the client's derivation is
 * `~/lib/chat/creation-turn`. That is the difference between testing the wiring and testing the rule.
 */
import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { CREATION_BRIEF_MARKER } from '~/types/creation';
import { isCreationTurn } from '~/lib/chat/creation-turn';
import { shouldRescueUnproductiveTurn } from './unproductive';

vi.mock('~/lib/.server/skills/store', () => ({
  getSkillStore: () => ({
    getActive: async (name: string) => ({ name, body: `body of ${name}`, bodyBytes: 8, resourcePaths: [] }),
    listActive: async () => [{ name: 'bt-design' }, { name: 'bt-landing' }, { name: 'bt-plan' }],
  }),
}));

const { carriesCreationBrief, statusKindFor } = await import('./proxy');
const { carriedSkillNames, preloadSkills, stickyLoadedSkills } = await import('./preload-skills');
const { createSkillTools } = await import('./tools');

let seq = 0;
const user = (content: string) => ({ id: `m${seq++}`, role: 'user' as const, content });
const BRIEF = `${CREATION_BRIEF_MARKER} Do not re-create it.\n\n**This project**\n- Title: Kart Racer`;
const EDIT = 'make the karts faster and add a boost pad';

/* ------------------------------------------------------------------ the source scan + its controls */

const REPO = process.cwd();
const proxyRaw = readFileSync(join(REPO, 'app/lib/.server/agent/proxy.ts'), 'utf-8');

/**
 * Comments are documentation, not behaviour — and here the distinction is load-bearing in both
 * directions: the retirement post-mortem in `proxy.ts` quotes the OLD name and describes the
 * behaviours in prose, so an unstripped scan would find every consumer "wired" from the doc comment
 * alone, which is precisely the false all-clear this file exists to prevent.
 */
const proxy = proxyRaw.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

/** The arguments of one call, brace-matched from `name({` to its closing `}` (creation-flat.spec.ts). */
function callArgs(source: string, name: string): string {
  const start = source.indexOf(`${name}({`);

  if (start < 0) {
    return '';
  }

  const open = source.indexOf('{', start);
  let depth = 0;

  for (let i = open; i < source.length; i++) {
    if (source[i] === '{') {
      depth++;
    } else if (source[i] === '}' && --depth === 0) {
      return source.slice(open, i + 1);
    }
  }

  return '';
}

/** One statement, from `const <name> =` to the end of its line — for the non-call wirings. */
function statement(source: string, name: string): string {
  const start = source.indexOf(`const ${name} =`);

  if (start < 0) {
    return '';
  }

  const end = source.indexOf('\n', start);

  return source.slice(start, end < 0 ? source.length : end);
}

describe('CONTROLS — the source scan can still see the code it judges', () => {
  it('reads a real, non-trivial proxy.ts', () => {
    expect(proxy.length).toBeGreaterThan(10_000);
    expect(proxy).toContain('export async function runAgentGeneration');
  });

  it('strips comments, so a post-mortem describing a behaviour is not the behaviour', () => {
    // The rename post-mortem quotes the dead name; the stripped source must not contain it.
    expect(proxyRaw).toContain('isCreationTurn');
    expect(proxy).not.toContain('isCreationTurn');
  });

  it('finds the derivation itself — every assertion below is about this one boolean', () => {
    expect(statement(proxy, 'isFirstBuildTurn')).toContain('carriesCreationBrief(messages0)');
  });

  /*
   * The extractors must FIND things. A silent empty string satisfies any `not.toContain`, and would
   * satisfy the `toContain`s below only by failing them — so each is proven here against a token the
   * call carries for reasons unrelated to the first-build flag.
   *
   * The two consumers asserted with a bare `toContain` on the whole file (`preloadSkills`,
   * `offerLoadSkill`) need no extractor control: they are POSITIVE assertions on a literal call
   * expression, which cannot pass against a source the reader failed to load.
   */
  it('extracts real, non-empty expressions for the consumers that need scoping', () => {
    expect(statement(proxy, 'carriedNames')).toContain('slash?.skillName');
    expect(callArgs(proxy, 'shouldRescueUnproductiveTurn')).toContain('emittedAction');
    expect(callArgs(proxy, 'statusKindFor')).toContain('isRepair');
  });
});

/* ------------------------------------------------------------------------------ the derivation */

describe('carriesCreationBrief — the one boolean, derived', () => {
  it('is TRUE for a turn carrying the creation brief', () => {
    expect(carriesCreationBrief([user(BRIEF)])).toBe(true);
  });

  it('is FALSE for an ordinary edit turn', () => {
    expect(carriesCreationBrief([user(EDIT)])).toBe(false);
  });

  /*
   * The LAST user message decides. A conversation whose first turn was a creation is no longer a
   * creation — reading any user message would keep every protection above latched on for the whole
   * project's life, which is how premium would stay locked forever.
   */
  it('reads the LAST user turn only — a build three turns back is not a first build', () => {
    expect(carriesCreationBrief([user(BRIEF), { role: 'assistant', content: 'done' } as never, user(EDIT)])).toBe(
      false,
    );
  });

  it('is FALSE for an empty conversation', () => {
    expect(carriesCreationBrief([])).toBe(false);
  });
});

/* --------------------------------------------------------------- 1. skill preload (proxy.ts:~777) */

describe('consumer 1 — the creation brief inlines bt-landing + bt-design', () => {
  it('FIRES on a first build: both skills are inlined, in brief order', async () => {
    expect((await preloadSkills(undefined, true)).map((s) => s.name)).toEqual(['bt-landing', 'bt-design']);
  });

  it('does NOT fire on an ordinary turn, whatever the user typed', async () => {
    expect(await preloadSkills(undefined, false)).toEqual([]);
    expect(await preloadSkills('bt-plan', false)).toEqual([]);
  });

  it('is wired to the first-build flag', () => {
    expect(proxy).toContain('preloadSkills(slash?.skillName, isFirstBuildTurn)');
  });
});

/* --------------------------------------------------- 2. sticky-skill suppression (proxy.ts:~794) */

describe('consumer 2 — a first build carries NO sticky skills forward', () => {
  const turn = (...names: string[]) => ({
    role: 'assistant',
    annotations: [{ type: 'agentMeta', value: { skillsLoaded: names } }],
  });

  /*
   * `stickyLoadedSkills` itself is flag-blind by design — it answers "what has this conversation
   * loaded", and the SUPPRESSION was an inline ternary in the proxy, which meant this was the ONE
   * protection of the ten with no behavioural test: a scan can prove a ternary is present, never that
   * it decides correctly. `carriedSkillNames` is that ternary, extracted pure (behaviour-preserving),
   * so both branches are now driven rather than read.
   */
  it('has something to suppress — the carried set is non-empty for a real conversation', () => {
    expect(stickyLoadedSkills([turn('bt-plan')] as never)).toEqual(['bt-plan']);
  });

  it('FIRES on a first build: the carried set is EMPTY however much the conversation loaded', () => {
    const conversation = [turn('bt-plan'), turn('bt-spec'), turn('bt-design')] as never;

    expect(carriedSkillNames({ isFirstBuildTurn: true, messages: conversation })).toEqual([]);
  });

  it('does NOT fire on an ordinary turn — the conversation keeps its skills, in first-seen order', () => {
    const conversation = [turn('bt-plan'), turn('bt-design')] as never;

    expect(carriedSkillNames({ isFirstBuildTurn: false, messages: conversation })).toEqual(['bt-plan', 'bt-design']);
  });

  /* The second exclusion, unrelated to the flag: `/bt-plan` already inlines that body verbatim. */
  it('drops the INVOKED skill on an ordinary turn, so its body is never paid for twice', () => {
    const conversation = [turn('bt-plan'), turn('bt-design')] as never;

    expect(carriedSkillNames({ isFirstBuildTurn: false, messages: conversation, invokedSkillName: 'bt-plan' })).toEqual(
      ['bt-design'],
    );
  });

  it('is wired to the first-build flag and to the invoked skill', () => {
    const carried = statement(proxy, 'carriedNames');

    expect(carried).toContain('carriedSkillNames(');
    expect(carried).toMatch(/[{,]\s*isFirstBuildTurn\s*[,}]/);
    expect(carried).toContain('invokedSkillName: slash?.skillName');
  });
});

/* ------------------------------------------------------------ 3. offerLoadSkill (proxy.ts:~1088) */

describe('consumer 3 — load_skill is not offered on a first build', () => {
  const context = () => ({ loaded: new Set<string>(), loadedThisTurn: new Set<string>() });

  it('offers load_skill on an ordinary turn', () => {
    expect(createSkillTools({ ...context(), offerLoadSkill: true }).load_skill).toBeDefined();
  });

  /*
   * The tool must be ABSENT, not present-and-scolding: a tool the model is told not to use is a trap.
   * `read_skill_resource` stays either way — a pre-loaded skill's bundled files are still out of
   * context, and `bt-design` tells the model to read one before writing code.
   */
  it('withholds load_skill when the turn already inlined its skills — and keeps read_skill_resource', () => {
    const tools = createSkillTools({ ...context(), offerLoadSkill: false });

    expect(tools.load_skill).toBeUndefined();
    expect(tools.read_skill_resource).toBeDefined();
  });

  it('is wired to the NEGATION of the first-build flag', () => {
    expect(proxy).toContain('offerLoadSkill: !isFirstBuildTurn');
  });
});

/* -------------------------------------------------------------- 4. requiresAction (proxy.ts:~1730) */

describe('consumer 4 — a first build that writes nothing gets one corrective pass', () => {
  /** A long, dense, confident prose answer: every OTHER signal reads "productive". */
  const prose = {
    aborted: false,
    alreadyContinued: false,
    emittedAction: false,
    toolCalls: 0,
    textChars: 31_852,
    outTokens: 12_000,
  };

  it('FIRES on a first build: prose with no <boltAction> is unproductive however eloquent', () => {
    expect(shouldRescueUnproductiveTurn({ ...prose, requiresAction: true })).toBe(true);
  });

  it('does NOT fire on an ordinary edit — a prose-only answer is often exactly right', () => {
    expect(shouldRescueUnproductiveTurn({ ...prose, requiresAction: false })).toBe(false);
  });

  /*
   * The wiring carries a second condition and it is not decoration: a plan turn is prose BY GUARANTEE
   * (§4.2.9 makes writing impossible), so demanding an action there spends a corrective pass on work
   * the wall forbids — every time, for free, on the user's credits.
   */
  it('is wired to the first-build flag AND excludes plan turns', () => {
    /*
     * Named `owesFiles` since 2026-08-07, because a SECOND consumer now reads it (`isFailedBuildTurn`,
     * the terminal verdict below). Both halves are asserted: that the rescue receives that variable,
     * and that the variable still means what the inline expression meant. Asserting only the name
     * would pass if someone redefined it as `true`.
     */
    expect(callArgs(proxy, 'shouldRescueUnproductiveTurn')).toContain('requiresAction: owesFiles');
    expect(proxy).toMatch(/const owesFiles = isFirstBuildTurn && !discussNote;/);
  });

  /*
   * THE VERDICT, and it must share the rescue's predicate (2026-08-07, `gen_msixapaq_i871b6`).
   *
   * The rescue is a second chance; `isFailedBuildTurn` is what happens when the second chance is spent.
   * If the two ever disagreed about which turns owe files, a turn could be rescued for not writing and
   * then billed as a success for exactly that — which is the 1,489-credit failure, restored.
   */
  it('the zero-file VERDICT reads the same predicate as the rescue', () => {
    expect(callArgs(proxy, 'isFailedBuildTurn')).toContain('requiresAction: owesFiles');
  });

  /*
   * The verdict needs POSITIVE evidence the model was building, because the creation brief rides on
   * whatever the user types first — so their first message can legitimately be a question, and a prose
   * answer to it writes no files by design.
   *
   * ⚠️ `unproductiveRescue` must NOT appear in that expression: it fires on any first-turn prose, so
   * including it lets our own reaction manufacture the evidence and the question case simply fails one
   * pass later instead. Asserted as an ABSENCE, which is the only way to catch it being added back.
   */
  it('the verdict demands evidence of a build attempt, and never accepts its own rescue as that evidence', () => {
    const args = callArgs(proxy, 'isFailedBuildTurn');

    expect(args).toMatch(/attemptedBuild:\s*emittedArtifact \|\| toolCallCount > 0 \|\| forcedContinuation/);
    expect(args).not.toContain('unproductiveRescue');
  });

  it('the verdict runs AFTER the rescue — it is the outcome, not a competing rescue', () => {
    expect(proxy.indexOf('isFailedBuildTurn(')).toBeGreaterThan(proxy.indexOf('shouldRescueUnproductiveTurn('));
  });
});

/* ------------------------------------------------------------------ 5. statusKind (proxy.ts:~1984) */

describe('consumer 5 — the liveness panel calls a first build a creation', () => {
  const base = { isRepair: false, isFirstBuildTurn: false, isDiscussTurn: false };

  it('FIRES on a first build', () => {
    expect(statusKindFor({ ...base, isFirstBuildTurn: true })).toBe('creation');
  });

  it('does NOT fire on an ordinary turn', () => {
    expect(statusKindFor(base)).toBe('edit');
  });

  /*
   * The precedence is the whole content of this function, and it is the half a wiring scan cannot see.
   * A repair is a repair even on a first build (the repair copy is what tells the user their build is
   * being fixed rather than started again), and plan mode outranks an ordinary edit.
   */
  it('keeps the precedence: repair > creation > plan > edit', () => {
    expect(statusKindFor({ isRepair: true, isFirstBuildTurn: true, isDiscussTurn: true })).toBe('repair');
    expect(statusKindFor({ isRepair: false, isFirstBuildTurn: true, isDiscussTurn: true })).toBe('creation');
    expect(statusKindFor({ ...base, isDiscussTurn: true })).toBe('plan');
  });

  /*
   * ⚠️ Asserted as the SHORTHAND property, not as a substring. A bare `toContain('isFirstBuildTurn')`
   * passes against `isFirstBuildTurn: false` — the exact mutation this test exists to catch — because
   * the flag's NAME survives being disconnected from its value. It was written that way first, and it
   * survived its own mutation run; a scan of a call's arguments has to pin the BINDING, not the word.
   */
  it('is wired to the first-build flag itself, not to a constant wearing its name', () => {
    expect(callArgs(proxy, 'statusKindFor')).toMatch(/[{,]\s*isFirstBuildTurn\s*[,}]/);
  });
});

/* ---------------------------------- 7. the four consumers whose RULES were already tested elsewhere */

/**
 * `decideModelTier`, `discussModeNote`, `toolPolicyForTurn` and `mediaProtocolNote` each have paired
 * true/false tests in their own specs — their RULES are proven. What was not proven is that the proxy
 * still HANDS them the flag, and the two are independent failures.
 *
 * Found by a verifier disconnecting all four in `proxy.ts` at once: `pnpm test` stayed fully green
 * (3397/3397). The rule tests cannot see it, because they call the pure functions directly. The most
 * expensive of the four is the TIER decision — disconnected, every paid rung unlocks server-side on a
 * first build, which is the measured KIE-gateway-timeout death (`premium.ts`) that the lock exists to
 * prevent, with nothing red anywhere.
 *
 * ⚠️ Repointed from `decidePremium` to `decideModelTier` with the code it guards (§4.6.1a,
 * 2026-07-31): the proxy resolves a three-rung ladder now. The wiring being asserted is unchanged and
 * the stake is HIGHER, not lower — there are three rungs to unlock by accident instead of one.
 *
 * Shorthand binding, never a substring — see the `statusKindFor` note above for why.
 */
describe('the four rule-tested consumers are still WIRED to the flag', () => {
  it.each(['decideModelTier', 'discussModeNote', 'toolPolicyForTurn', 'mediaProtocolNote'])(
    '%s receives isFirstBuildTurn from the proxy',
    (callee) => {
      expect(callArgs(proxy, callee)).toMatch(/[{,]\s*isFirstBuildTurn\s*[,}]/);
    },
  );
});

/* -------------------------------------------- 6. the client tier lock (Chat.client / ModelTierPill) */

/**
 * The CLIENT half. `creationTurnStore` is a nanostore written from one `useEffect` and read by one
 * component, so the rule ("premium is locked while the next turn is a first build") is split across a
 * derivation and a render.
 *
 * The derivation is now a pure module (`~/lib/chat/creation-turn`) and is asserted BEHAVIOURALLY below —
 * that is the part with rules in it. The RENDERED lock lives in `ModelTierPill.spec.tsx`, which mounts
 * the real component and reads the real lock; what remains here is the WIRE between them, asserted by a
 * comment-stripped source scan with controls and scoped to the specific expressions that connect the
 * store to the toggle.
 *
 * ⚠️ This comment previously justified scan-only coverage of the pill by asserting that "this repo
 * has no component-render harness (no jsdom/testing-library in the vitest setup)". That was false —
 * `@testing-library/react` and `jsdom` are dependencies and sibling specs render components — and it is
 * recorded here rather than quietly deleted because it is the `shell-strip.ts` failure again: a false
 * sentence in a doc comment is how a weak assertion survives review, since a comment cannot fail.
 */
describe('consumer 6 — the model pill locks on a first build', () => {
  const chatRaw = readFileSync(join(REPO, 'app/components/chat/Chat.client.tsx'), 'utf-8');
  const toggleRaw = readFileSync(join(REPO, 'app/components/chat/ModelTierPill.tsx'), 'utf-8');
  const strip = (source: string) => source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  const chat = strip(chatRaw);
  const toggle = strip(toggleRaw);

  it('CONTROL — both components were read, and their comments are stripped', () => {
    expect(chat).toContain('export const Chat');
    expect(toggle).toContain('export function ModelTierPill');

    // Both files describe the lock in prose; the prose must not be what satisfies the scans below.
    expect(toggleRaw).toContain('mirroring `decideModelTier`');
    expect(strip(toggleRaw)).not.toContain('mirroring `decideModelTier`');
  });

  it('FIRES on a first build: a conversation whose last user turn carries the brief', () => {
    expect(isCreationTurn({ activeProjectId: 'p1', messages: [user(BRIEF)] })).toBe(true);
  });

  /*
   * And on the landing page, where nothing carries a brief YET — the next send creates the project, so
   * the turn the user is about to send is the first build. Missing this unlocks premium on precisely
   * the generation that cannot flush through KIE's gateway.
   */
  it('FIRES with no project and no messages — the next send creates the project', () => {
    expect(isCreationTurn({ messages: [] })).toBe(true);
  });

  it('does NOT fire on an ordinary edit', () => {
    expect(isCreationTurn({ activeProjectId: 'p1', messages: [user(BRIEF), user(EDIT)] })).toBe(false);
  });

  /*
   * A NEW CHAT on an EXISTING project is the case that makes "no messages" insufficient on its own:
   * it has a project and an empty transcript, and its first message is an EDIT. Premium stays offered.
   */
  it('does NOT fire for a new chat on an existing project', () => {
    expect(isCreationTurn({ activeProjectId: 'p1', messages: [] })).toBe(false);
  });

  /*
   * NEW PROJECT MODE — the window the marker alone cannot see (§4.4a, T13).
   *
   * Under project-first creation the brief is appended AT SEND, so while the user edits the carried
   * prompt there is no message carrying `CREATION_BRIEF_MARKER` yet. That window is the whole of New
   * Project mode, and it is precisely when the next send is the first build: keyed on the marker alone
   * the pill sat unlocked for exactly as long as the user was looking at it, then re-locked on send.
   */
  it('FIRES in New Project mode, before anything carries the brief', () => {
    expect(isCreationTurn({ activeProjectId: 'p1', messages: [], newProjectMode: { projectId: 'p1' } })).toBe(true);
  });

  it('FIRES in New Project mode even with the carried prompt typed but unsent', () => {
    // The transcript at this moment is creation's setup artifact alone — no user message at all.
    const messages = [{ role: 'assistant' as const, content: '<boltArtifact id="project-setup">' }];

    expect(isCreationTurn({ activeProjectId: 'p1', messages, newProjectMode: { projectId: 'p1' } })).toBe(true);
  });

  /*
   * And UNLOCKS after. The mode is cleared on send (`exitNewProjectMode`) while the sent message carries
   * the brief, so the marker takes over with no gap; once the user's first EDIT lands, both are false.
   */
  it('does NOT fire once the mode is cleared and the user has moved on to an edit', () => {
    expect(isCreationTurn({ activeProjectId: 'p1', messages: [user(BRIEF), user(EDIT)], newProjectMode: null })).toBe(
      false,
    );
  });

  /*
   * Scoped to the OPEN project. Module state survives an SPA navigate, so a mode left pointing at a
   * previous project must not lock the premium pill on a project the user has already built.
   */
  it('does NOT fire for a mode belonging to a DIFFERENT project', () => {
    expect(isCreationTurn({ activeProjectId: 'p2', messages: [user(EDIT)], newProjectMode: { projectId: 'p1' } })).toBe(
      false,
    );
  });

  /*
   * The unregistered-project fallback (the WebContainer-only path, where the server could not be
   * reached) has no id to scope by, and belongs to whatever is open. Asserted with the setup artifact
   * present so the empty-conversation branch above cannot be what satisfies it — otherwise this test
   * passes with the mode ignored entirely.
   */
  it('FIRES for an unregistered project whose mode carries no id', () => {
    const messages = [{ role: 'assistant' as const, content: '<boltArtifact id="project-setup">' }];

    expect(isCreationTurn({ messages, newProjectMode: { projectId: '' } })).toBe(true);
    expect(isCreationTurn({ messages })).toBe(false);
  });

  it('is wired: the chat writes the derived value into the store, mode included', () => {
    expect(chat).toContain(
      'creationTurnStore.set(isCreationTurn({ activeProjectId, messages, newProjectMode: openNewProjectMode }))',
    );
    expect(chat).toContain('const openNewProjectMode = useStore(newProjectModeStore)');
  });

  /*
   * ⚠️ INVERTED 2026-08-03 (owner: "remove the First Premium Build Always Run Default Model — we can
   * choose our model as long as we have enough credits and the additional models are enabled"). The
   * pill must NOT consult the first-build store any more: a paid rung on a first build is a choice
   * the user is allowed to make. The scans now pin the ABSENCE of the lock — reintroducing
   * `creationTurn` into the eligibility expression is the regression.
   */
  it('is wired: the pill decides eligibility WITHOUT the first-build store', () => {
    expect(toggle).not.toContain('creationTurnStore');
    expect(toggle).toMatch(/const eligible = selected !== 'standard' && canUseTier\(session, selected\)/);
  });

  /*
   * The PANEL is the second renderer of the same rule, and it must not drift from the pill: neither
   * surface applies a first-build lock. `unserveable` and `below_minimum` remain the only lock
   * reasons — the CONTROL half proving the panel still locks at all.
   */
  it('is wired: the picker panel carries no first-build lock (and still locks on the threshold)', () => {
    const panel = strip(readFileSync(join(REPO, 'app/components/chat/ModelTierPanel.tsx'), 'utf-8'));

    expect(panel).not.toContain('creationTurnStore');
    expect(panel).not.toContain('creation_turn');
    expect(panel).toContain("'below_minimum'");
  });

  /*
   * The store's SECOND consumer, and under project-first creation it is more true than it ever was: the
   * project is cloned, installed and RUNNING before a single token is spent, so a failed first build is
   * unambiguously a failed build of an existing project. The raw provider message ("Server Error", a
   * 402, a dead render) is accurate about the generation and completely wrong about the project, and
   * "my game was never created" is the reasonable reading when nothing says otherwise.
   */
  it('is wired: a failed first build tells the user the project survived', () => {
    expect(chat).toContain('creationTurnStore.get()');
    expect(chat).toMatch(/Your project was still created from the starter template/);
  });
});
