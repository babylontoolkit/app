/**
 * The transport envelope the client wraps every user message in — and how the server gets the user's
 * ACTUAL typed text back out of it (SPEC §4.11 slash invocation, §4.2.8 history).
 *
 * `Chat.client.tsx` posts every user message as upstream bolt.diy built it:
 *
 *     [Model: claude-opus-4-8]\n\n[Provider: KIE]\n\n<boltArtifact …>…</boltArtifact>what the user typed
 *
 * The `[Model:]`/`[Provider:]` pair is upstream's transport for a BYOK model choice, consumed by
 * `stream-text.ts` on the now-fail-closed `/api/chat` path (`MODEL_REGEX`/`PROVIDER_REGEX` in
 * `~/utils/constants`). Our `/api/agent` proxy chooses the model server-side (§4.2a) and never strips
 * it — so on the live path the envelope is pure freight that also reaches the model and rides the
 * UNCACHED history forever.
 *
 * 🔴 **It also silently broke every `/slash` skill invocation.** `parseSlashInvocation` requires the
 * message to START with `/`, and it never did: the first characters are `[Model:`. `resolveSlashInvocation`
 * returned null, the skill was never force-loaded, and — because it returns null *before* the
 * unknown-skill branch — there was not even a warning. The user saw a model that announced "I'll load
 * the bt-spec skill workflow" and then stopped, having no `load_skill` tool (a preloaded turn closes
 * the loop, §4.2.8) and no skill body. A full-price generation that did nothing.
 *
 * The optional leading `<boltArtifact>` is the modified-files sync the client prepends when the user
 * has edited files in the editor. It is REAL CONTENT the model needs — so it is split off and carried
 * through a slash rewrite, never dropped, and never mistaken for the user's typed text.
 *
 * Pure, no I/O, client-safe. The regexes are deliberately local rather than imported from
 * `~/utils/constants`: that module pulls in `LLMManager` → the provider registry, a cycle vitest does
 * not tolerate (`spec/anthropic-models.md` §4). `message-envelope.spec.ts` pins these against a string
 * built exactly the way `Chat.client.tsx` builds it, so producer and consumer cannot drift apart
 * unnoticed.
 */

/** Both anchored: a `[Model: …]` mid-message is prose, not an envelope. */
const MODEL_PREFIX = /^\[Model: (?:.*?)\]\n\n/;
const PROVIDER_PREFIX = /^\[Provider: (?:.*?)\]\n\n/;

/**
 * The modified-files artifact the client prepends. Non-greedy, so a message carrying two artifacts
 * yields the first and leaves the rest with the text (where it is still visible to the model).
 */
const LEADING_ARTIFACT = /^<boltArtifact[\s\S]*?<\/boltArtifact>/;

/**
 * Remove the `[Model:]`/`[Provider:]` transport envelope.
 *
 * Order matters and mirrors how it is built: the provider tag only ever follows the model tag, so it
 * is anchored and stripped second. Anything else is returned BYTE-IDENTICAL — this runs over every
 * user message on every turn, and a stray rewrite of the user's own words is unrecoverable.
 */
export function stripTransportPrefix(text: string): string {
  return text.replace(MODEL_PREFIX, '').replace(PROVIDER_PREFIX, '');
}

/**
 * Split a leading modified-files artifact off the front of an (already prefix-stripped) message.
 *
 * `carried` is content the model must still receive; `text` is what the user actually typed.
 */
export function splitCarriedArtifact(text: string): { carried: string; text: string } {
  const match = LEADING_ARTIFACT.exec(text);

  if (!match) {
    return { carried: '', text };
  }

  return { carried: match[0], text: text.slice(match[0].length) };
}

/**
 * The user's actual typed text — envelope removed, carried artifact removed.
 *
 * This is what command detection (`/bt-spec …`) must look at, and NOT what is sent to the model.
 */
export function userTypedText(content: string): string {
  return splitCarriedArtifact(stripTransportPrefix(content)).text;
}

/**
 * A LOOSE detector for "this still looks enveloped" — deliberately NOT the stripping regex.
 *
 * 🔴 The long-term risk here is not the bug we just fixed, it is **format drift**. `stripTransportPrefix`
 * is strict, and it must be (a loose stripper would eat a user's own `[Model: …]` prose). But that means
 * if upstream ever changes the envelope — one `\n` instead of two, `[Model=x]`, the provider tag first —
 * the strict regex silently stops matching, the envelope rides through again, and every `/slash`
 * invocation breaks exactly as it did before, with no error and no log. **A tripwire built from the same
 * regex as the stripper cannot see that**, because whatever the stripper misses the tripwire misses too.
 *
 * So this matches the SHAPE rather than the format: a message that opens with a bracketed `Model` or
 * `Provider` key. Anything it flags AFTER stripping is a stripper that has fallen behind its producer —
 * which is a loud warning, never a silent pass (`api.agent.ts` reports it to monitoring).
 *
 * It is intentionally allowed to be wrong in the harmless direction: a user who genuinely opens a message
 * with "[Model: …]" trips a warning and nothing else. Nothing is stripped on the strength of this.
 */
const ENVELOPE_SHAPE = /^\s*\[\s*(?:Model|Provider)\b/i;

export function looksLikeUnstrippedEnvelope(text: string): boolean {
  return ENVELOPE_SHAPE.test(text);
}

/** The shape this module needs from an `ai` `Message` — structural, so it needs no `ai` import. */
interface EnvelopeMessage {
  role: string;
  content?: unknown;
  parts?: unknown;
}

/**
 * Strip the transport envelope from every user message, in `content` AND in text `parts`.
 *
 * Both carry it: the client sets `content` and `parts` from the same string, and the AI SDK's
 * `convertToCoreMessages` prefers `parts` when they are present — so stripping only `content` would
 * leave the envelope on the wire to the model.
 *
 * Assistant messages are never touched, and a message that carries no envelope is returned by
 * IDENTITY (not a copy), so this is safe to run unconditionally on every turn.
 */
export function stripTransportEnvelopes<T extends EnvelopeMessage>(messages: T[]): T[] {
  return messages.map((message) => {
    if (message.role !== 'user') {
      return message;
    }

    const content = typeof message.content === 'string' ? stripTransportPrefix(message.content) : message.content;
    const originalParts: unknown[] | undefined = Array.isArray(message.parts) ? message.parts : undefined;

    const parts = originalParts?.map((part) => {
      const typed = part as { type?: string; text?: unknown };

      if (typed?.type !== 'text' || typeof typed.text !== 'string') {
        return part;
      }

      const text = stripTransportPrefix(typed.text);

      // Copy only when something actually changed, so an unenveloped message stays identical.
      return text === typed.text ? part : { ...typed, text };
    });

    const contentChanged = content !== message.content;
    const partsChanged = Boolean(parts?.some((part, i) => part !== originalParts![i]));

    if (!contentChanged && !partsChanged) {
      return message;
    }

    return { ...message, content, ...(parts ? { parts } : {}) } as T;
  });
}

/**
 * How many user messages STILL look enveloped after stripping — the drift tripwire.
 *
 * Non-zero means `stripTransportPrefix` has fallen behind whatever the client now produces. It costs
 * nothing to compute and it is the difference between "we find out from monitoring" and "we find out
 * during a demo".
 */
export function countUnstrippedEnvelopes<T extends EnvelopeMessage>(messages: T[]): number {
  return messages.filter(
    (message) =>
      message.role === 'user' && typeof message.content === 'string' && looksLikeUnstrippedEnvelope(message.content),
  ).length;
}
