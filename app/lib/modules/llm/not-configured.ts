/**
 * "This provider has no credentials" is an EXPECTED state, not an error (SPEC §4.2a, §4.6.1).
 *
 * ## Why this exists
 *
 * The platform ships credits-only (`PRO_FEATURES_ENABLED=false`): one configured provider, no BYOK, no
 * model picker. But upstream's `LLMManager` registers all ~24 providers and asks every one of them for
 * its dynamic model list on each page load. Twenty-odd of them have no key, throw, and were logged at
 * ERROR:
 *
 *     ERROR LLMManager Error getting dynamic models Google : Missing Api Key configuration for Google provider
 *     ERROR LLMManager Error getting dynamic models Groq : Missing Api Key configuration for Groq provider
 *     ...
 *
 * Nothing is broken — that is the product working as designed. The cost is that a real provider failure
 * (a revoked key, a 500 from KIE, a DNS failure) arrives in a wall of identical red lines and reads as
 * more of the same. **Log noise is not a cosmetic problem: it is how a real error hides.** The live
 * session that prompted this had ~30 of these per page load, and a genuine `Pitcher fs/readFile timed
 * out` storm scrolled past underneath them unnoticed.
 *
 * ## Why a predicate and not a `logger.debug` at the throw site
 *
 * The throw sites are ~24 upstream provider files (pull compatibility — extend, never rewrite). One
 * classifier at the two places that LOG keeps the change additive and keeps the rule in one place.
 *
 * ⚠️ **Providers throw two different shapes.** Some `throw new Error('Missing Api Key configuration…')`
 * and some `throw 'Missing Api Key configuration…'` — a bare string, which has no `.message`. That is
 * visible in the raw logs (`Z.ai : Error: Missing…` next to `OpenAI : Missing…`) and a classifier that
 * only reads `error.message` silently fails to match half of them — leaving exactly the noise it was
 * written to remove, on a rotating subset of providers.
 *
 * Deliberately NARROW: it matches "not configured" and nothing else. An auth REJECTION (401, invalid
 * key) is a real error — the key is present and wrong, which the operator must see — and must keep
 * shouting.
 */

/** Both phrasings upstream uses, plus the bare-string form. Anchored on "missing … configuration". */
const NOT_CONFIGURED = /missing\s+(api\s*key\s+)?configuration\s+for\b/i;

export function messageOf(error: unknown): string {
  if (typeof error === 'string') {
    return error;
  }

  if (error instanceof Error) {
    return error.message;
  }

  return String((error as { message?: unknown })?.message ?? error ?? '');
}

/**
 * Is this "no credentials for a provider nobody asked for", rather than a failure?
 *
 * `true` means the message belongs at debug level. Anything unrecognised returns `false` and stays an
 * error — the safe direction, since an unclassified failure that goes quiet is the bug this file is
 * about, one level down.
 */
export function isNotConfiguredError(error: unknown): boolean {
  return NOT_CONFIGURED.test(messageOf(error));
}
