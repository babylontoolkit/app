/**
 * Path A prompt seeding (SPEC §4.4a) — decide which `game_registry` entry a typed prompt starts from.
 *
 * Deliberately NOT an LLM call. This runs on the critical path of "user typed a thing and hit enter",
 * where every second is felt; SPEC §4.4a states plainly that keyword/synonym scoring is sufficient for
 * v1 (an LLM classifier is an allowed later refinement — swap `decideSeed`, nothing else).
 *
 * The governing rule this file exists to enforce: **explicit user input > inference > guidance.**
 * A typed prompt is a decision, not a request for a menu. There are exactly three outcomes and only
 * the last one may ever reach the wizard:
 *
 *   matched  — a genre scored → seed it and RUN the prompt immediately.
 *   fallback — specific prompt, no genre → seed Blank Canvas and RUN it anyway. Never block on
 *              ambiguity when intent is clear ("a game where you knit sweaters" is intent).
 *   vague    — nothing to act on at all ("help", "something fun") → OFFER the wizard. Never force it.
 */
import type { GameRegistryEntry } from '~/types/game-registry';

export interface SeedMatch {
  entry: GameRegistryEntry;
  score: number;

  /** The keywords that actually fired — shown in the "Started from" chip's tooltip. */
  matched: string[];
}

export type SeedDecision =
  | ({ kind: 'matched' } & SeedMatch)
  | { kind: 'fallback'; entry: GameRegistryEntry }
  | { kind: 'vague' };

/**
 * Words that carry no intent about WHAT to build. A prompt made of nothing but these is the only
 * automatic route to the wizard, so this list is the vagueness threshold in its entirety — keep it
 * tight. Anything with a discernible subject must fall through to a seed-and-run.
 */
const EMPTY_WORDS = new Set([
  'a',
  'about',
  'an',
  'and',
  'any',
  'anything',
  'app',
  'application',
  'awesome',
  'build',
  'can',
  'cool',
  'could',
  'create',
  'demo',
  'do',
  'dunno',
  'else',
  'for',
  'fun',
  'game',
  'games',
  'good',
  'great',
  'help',
  'hi',
  'hello',
  'i',
  'idea',
  'ideas',
  'idk',
  'im',
  'interesting',
  'just',
  'know',
  'like',
  'love',
  'make',
  'me',
  'my',
  'need',
  'new',
  'nice',
  'of',
  'ok',
  'okay',
  'please',
  'project',
  'really',
  'some',
  'someth',
  'something',
  'sure',
  'thanks',
  'that',
  'the',
  'thing',
  'to',
  'up',
  'want',
  'wanna',
  'what',
  'whatever',
  'with',
  'would',
  'you',
  'your',
]);

/** Lowercase, punctuation → spaces, collapse runs. Keeps digits (a "3d maze" is a subject). */
export function normalize(prompt: string): string {
  return prompt
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .replace(/\s+/g, ' ');
}

/**
 * A prompt is vague only when it names no genre, no mechanic and no subject (§4.4a).
 *
 * "I want to make a game" → vague. "a game about a robot in a maze" → NOT vague (robot, maze), and
 * therefore Path A even if no registry keyword fires.
 */
export function isVague(prompt: string): boolean {
  const words = normalize(prompt).split(' ').filter(Boolean);

  return words.every((word) => EMPTY_WORDS.has(word));
}

/**
 * Score one entry. Multi-word keywords ("first person") outweigh single words because they are far
 * less likely to fire by accident.
 */
function scoreEntry(normalized: string, entry: GameRegistryEntry): SeedMatch {
  const padded = ` ${normalized} `;
  const matched: string[] = [];
  let score = 0;

  for (const keyword of entry.match_keywords) {
    const term = normalize(keyword);

    if (!term) {
      continue;
    }

    // Whole-word/phrase containment — `track` must not fire on `tracking`, nor `car` on `cartoon`.
    if (padded.includes(` ${term} `)) {
      matched.push(keyword);
      score += term.includes(' ') ? 2 : 1;
    }
  }

  return { entry, score, matched };
}

/**
 * Rank every active, non-fallback entry against the prompt. Exported for the "change" affordance on
 * the seed chip, which offers the runners-up.
 */
export function rankEntries(prompt: string, entries: GameRegistryEntry[]): SeedMatch[] {
  const normalized = normalize(prompt);

  return entries
    .filter((entry) => entry.is_active && !entry.is_fallback)
    .map((entry) => scoreEntry(normalized, entry))
    .filter((match) => match.score > 0)
    .sort((a, b) => {
      if (b.score !== a.score) {
        return b.score - a.score;
      }

      // Tie → the entry whose most specific keyword fired wins ("first person" beats "walk").
      const longest = (m: SeedMatch) => Math.max(...m.matched.map((k) => k.length), 0);

      return longest(b) - longest(a);
    });
}

export function findFallbackEntry(entries: GameRegistryEntry[]): GameRegistryEntry | undefined {
  return entries.find((entry) => entry.is_fallback && entry.is_active) ?? entries.find((entry) => entry.is_active);
}

/** Lead-ins that carry no title ("make me a kart racer" is a kart racer; so is "I want a kart racer"). */
const LEAD_IN =
  /^(?:please\s+)?(?:can you\s+|could you\s+)?(?:(?:i\s+(?:want|need)|i'?d\s+like|id\s+like)\s+(?:to\s+(?:make|build|create)\s+)?|(?:make|build|create|generate|design|code|write|give)\s+)(?:me\s+)?/i;

const ARTICLE = /^(?:a|an|the)\s+/i;

/** "a game about a robot" — the subject is the robot, not the game. */
const GAME_OF = /^game\s+(?:about|where|with|that|of|featuring)\s+/i;

/** Where the title stops — what follows is elaboration, not the name of the thing. */
const CLAUSE_BREAK =
  /\b(?:where|which|with|that|featuring|so|but|and|about|using|in|on|at|for|through|from)\b|[,.;:!?]/i;

/** Never the last word of a title. */
const TRAILING_NOISE = new Set(['a', 'an', 'the', 'of', 'in', 'on', 'at', 'to', 'for', 'through', 'with', 'game']);

/**
 * A project title from the user's own words — deterministic, no LLM call.
 *
 * It feeds `deriveClassName`, so it decides what the project's GameMode is CALLED. Upstream spent an
 * LLM round-trip on this; on the critical path of "typed a thing, hit enter" that is a second of
 * latency to name a file.
 *
 * "make me a kart racer where the cars are shopping carts" → "Kart Racer"
 */
export function deriveProjectTitle(prompt: string, fallback = 'My Game'): string {
  const subject = prompt.trim().replace(LEAD_IN, '').replace(ARTICLE, '').replace(GAME_OF, '').replace(ARTICLE, '');

  const head = subject.split(CLAUSE_BREAK)[0] ?? '';

  const words = head
    .split(/[^a-zA-Z0-9]+/)
    .filter(Boolean)
    .slice(0, 4);

  while (words.length > 0 && TRAILING_NOISE.has(words[words.length - 1].toLowerCase())) {
    words.pop();
  }

  if (words.length === 0) {
    return fallback;
  }

  return words.map((word) => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase()).join(' ');
}

/**
 * 🔴 A TYPED PROMPT IS NEVER GENRE-GUESSED (owner directive, 2026-08-04).
 *
 * This function used to rank the prompt against `match_keywords` and seed whichever demo entry
 * scored — and on a real creation, "top down twin stick shooter" matched the single word `shooter`
 * (owned by First-Person Explorer) and mounted the wrong starter with the wrong camera class. That
 * was the THIRD keyword-table failure in this codebase (`'ui'` matching b-**ui**-ld in the skills
 * router; the landing-pass keyword idea rejected in §4.4a), and the owner's rule is now uniform:
 * *"don't interfere or restrict the prompt — let the model do its thing."*
 *
 * So every typed prompt with anything in it to act on seeds the FALLBACK entry (Blank Canvas — a
 * generic shell whose scaffolded `<Title>Mode` keeps the play contract wired), and the MODEL decides
 * what to build from the request on the first build turn, with the creation brief pointing it at the
 * `src/babylon/classes/` demos, the Agent Reference, and the pinned asset library for material. The
 * genre CARDS and the wizard are untouched — those are explicit choices, not inference, and they
 * still pass their entry directly to `startProject` without ever calling this.
 *
 * `rankEntries`/`scoreEntry` survive exported (the seed chip's runner-up affordance reads them, and
 * hide-don't-delete is the standing rule) but no longer decide anything.
 */
export function decideSeed(prompt: string, entries: GameRegistryEntry[]): SeedDecision {
  /*
   * The ONLY automatic route to the wizard: a prompt with nothing in it to act on at all. Anything
   * with a discernible subject runs immediately — never block on ambiguity when intent is clear.
   */
  if (isVague(prompt)) {
    return { kind: 'vague' };
  }

  const fallback = findFallbackEntry(entries);

  return fallback ? { kind: 'fallback', entry: fallback } : { kind: 'vague' };
}

/**
 * 🔴 DID THE USER ASK FOR AN EMPTY SCENE, OR IS THIS JUST WHERE A TYPED PROMPT LANDED? (owner, 2026-08-14)
 *
 * *"If we are using the BLANK CANVAS options DO NOT AUTO create front end and artwork… all operations
 * from that point are just regular prompt turns. I can then use bt-landing when I want to create the
 * frontend."*
 *
 * ⚠️ **THE OBVIOUS TEST IS WRONG AND WOULD DISABLE PHASES FOR EVERY BUILD.** `is_fallback` alone looks
 * like the answer — the Blank Canvas row IS the fallback row — but since genre inference was retired
 * (`decideSeed`, §4.4a/§4.4d) **every typed prompt seeds that same row**. "build me a mario kart clone"
 * and "start me an empty scene" arrive at an identical entry, so a check on the entry alone would have
 * silently turned off the front-end and art phases for the exact builds they were made mandatory for,
 * on the day after they were made mandatory, with nothing failing.
 *
 * The discriminator is `seedSource`, which exists precisely to separate *chosen* from *landed on*
 * (`ProjectSeed.seedSource`, added 2026-08-04 when the same conflation made the chip report "Started
 * from: Blank Canvas" on a twin-stick-shooter prompt). BOTH halves are required: explicit says the user
 * picked it, fallback says what they picked was the empty one.
 *
 * ⚠️ `seedSource` defaults to `'explicit'` at the call site, so an omitted value reads as chosen. That
 * is the right default for the CHIP (do not attribute an inference to the user) and it means this
 * predicate must never be handed a partial seed — it takes both fields explicitly for that reason.
 */
export function isBlankCanvasStart(input: {
  isFallbackEntry: boolean;
  seedSource: 'explicit' | 'inferred' | undefined;
}): boolean {
  return input.isFallbackEntry && input.seedSource === 'explicit';
}
