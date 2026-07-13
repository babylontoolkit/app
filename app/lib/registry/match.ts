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

/** One keyword is enough. A prompt saying "kart" has told us everything we need to pick a starting point. */
const SEED_THRESHOLD = 1;

export function decideSeed(prompt: string, entries: GameRegistryEntry[]): SeedDecision {
  const [best] = rankEntries(prompt, entries);

  if (best && best.score >= SEED_THRESHOLD) {
    return { kind: 'matched', ...best };
  }

  /*
   * No genre fired. The question is now ONLY whether there is anything to act on at all — and if
   * there is, we seed Blank Canvas and run. The wizard does not get a say.
   */
  if (isVague(prompt)) {
    return { kind: 'vague' };
  }

  const fallback = findFallbackEntry(entries);

  return fallback ? { kind: 'fallback', entry: fallback } : { kind: 'vague' };
}
