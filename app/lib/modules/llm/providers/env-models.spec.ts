/**
 * EVERY OPERATOR-CONFIGURED MODEL REACHES THE PROVIDER'S LIST — or it is run as something else.
 *
 * `stream-text.ts` (upstream, the enhancer's path) looks the requested model up in the provider's
 * model list and, on a miss, falls back to **`modelsList[0]`** behind a `logger.warn`. Observed live
 * 2026-08-11, verbatim:
 *
 *     WARN stream-text  MODEL [claude-haiku-4-5-20251001] not found in provider [Comet].
 *                       Falling back to first model. claude-sonnet-5
 *
 * The enhancement RAN on Sonnet 5 and SETTLED at Haiku's rates. Wrong model, wrong price, nothing
 * thrown — and the only visible trace was a warning in a log nobody reads. So the assertions that
 * matter most in this file are not the pure ones: they drive the REAL `CometApiProvider` and
 * `KieProvider` and demand that a configured id is IN the returned list. Reverting either gateway's
 * `getDynamicModels` to `platform ? [platform] : []` must fail here.
 *
 * ⚠️ **THE ENV TRAP, and it is live on this module.** `env-models.ts` is client-importable, so it reads
 * `serverEnv ?? process.env` directly (mirroring `base-provider.ts`), and Vitest loads `.env.local` —
 * which on the owner's machine holds `ENHANCE_PROMPT_MODEL`, `COMET_ENHANCE_PROMPT_MODEL` and
 * `LLM_MODEL`. A first unscrubbed probe of this exact code returned
 * `['claude-haiku-4-5-20251001', 'claude-haiku-4-5']` where the case expected one entry: the developer's
 * real configuration, resolved silently, failing on their machine only with CI green. Every variable in
 * every precedence chain this module touches is scrubbed below, and `the scrub list itself` asserts the
 * clearing actually happened rather than trusting it.
 *
 * ⚠️ `~/lib/modules/llm/manager` is mocked file-wide, and it is not optional: the real import graph is
 * `cometapi -> base-provider -> manager -> registry -> anthropic -> base-provider`, a cycle the bundler
 * tolerates and Vitest does not (`Class extends value undefined`). `anthropic.spec.ts` avoids it by not
 * importing a provider at all; this file MUST import them, because the whole defect lives in a provider
 * method. Pre-existing — do not restructure the providers for it.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { FAMILY_POLICY } from '~/lib/modules/llm/model-families';
import type { ModelInfo } from '~/lib/modules/llm/types';
import { enhancerModelNames, envConfiguredModels, envModelInfo } from './env-models';
import { COMET_MODELS } from './comet-wire';
import { KIE_MODELS } from './kie-wire';
import CometApiProvider from './cometapi';
import KieProvider from './kie';

vi.mock('~/lib/modules/llm/manager', () => ({
  /*
   * `getInstance` is stubbed because `app/utils/constants.ts` calls it at MODULE level, and
   * `~/lib/.server/agent/config` imports it — so the coverage check below cannot load the real
   * `PLATFORM_PROVIDERS` without it. Empty lists are correct: nothing in this file asks the manager
   * anything, it exists only to be a non-`undefined` base class.
   */
  LLMManager: class {
    static getInstance() {
      return {
        getAllProviders: () => [],
        getDefaultProvider: () => ({ name: 'Anthropic', config: {} }),
      };
    }
  },
}));

/**
 * Every variable this module — and the two `*EnvModel` readers beside it — can consult.
 *
 * The per-gateway keys are spelled out rather than derived from `PLATFORM_PROVIDERS` because that
 * constant lives in `~/lib/.server/agent/config`, and a spec for a CLIENT-safe module must not drag the
 * server config graph in to find out what to scrub. `covers every gateway the platform ships` below
 * checks the hand-written list against the real one, so it cannot fall behind a fourth gateway.
 */
const MODEL_ENV = [
  'ENHANCE_PROMPT_MODEL',
  'COMET_ENHANCE_PROMPT_MODEL',
  'KIE_ENHANCE_PROMPT_MODEL',
  'ANTHROPIC_ENHANCE_PROMPT_MODEL',

  /* `cometEnvModel` / `kieEnvModel`'s own chain — the platform model half of the same list. */
  'LLM_MODEL',
  'KIE_DEFAULT_MODEL',
] as const;

beforeEach(() => {
  for (const key of MODEL_ENV) {
    vi.stubEnv(key, undefined as unknown as string);
  }
});

/** Haiku 4.5 as each gateway spells it. Comet serves ONLY the dated id; KIE only the bare one. */
const HAIKU_BARE = 'claude-haiku-4-5';
const HAIKU_DATED = 'claude-haiku-4-5-20251001';

describe('the scrub list itself', () => {
  /*
   * A CONTROL on the trap, not a formality. The probe that produced this file's motivating output was
   * unscrubbed and returned the developer's `.env.local` values; every case below is meaningless if
   * that can still happen.
   */
  it('actually clears the developer .env.local values these cases depend on', () => {
    expect(process.env.ENHANCE_PROMPT_MODEL).toBeUndefined();
    expect(process.env.COMET_ENHANCE_PROMPT_MODEL).toBeUndefined();
    expect(process.env.KIE_ENHANCE_PROMPT_MODEL).toBeUndefined();
    expect(process.env.LLM_MODEL).toBeUndefined();
  });

  it('covers every gateway the platform ships', async () => {
    const { PLATFORM_PROVIDERS, enhancerModelEnvKeyFor } = await import('~/lib/.server/agent/config');

    for (const provider of PLATFORM_PROVIDERS) {
      expect(MODEL_ENV as readonly string[], `${provider} has a key this file never scrubs`).toContain(
        enhancerModelEnvKeyFor(provider),
      );
    }
  });
});

describe('enhancerModelNames — both names, most specific first', () => {
  /*
   * BOTH are returned, not merely the winner. Listing a name the resolver would not pick costs nothing
   * (`agent/config.ts` refuses an unpriced model before a request is ever made, so an extra name is
   * unreachable rather than mis-billed); listing too few is the `modelsList[0]` swap.
   */
  it('returns the per-gateway name before the cross-provider one', () => {
    expect(
      enhancerModelNames('Comet', { COMET_ENHANCE_PROMPT_MODEL: HAIKU_DATED, ENHANCE_PROMPT_MODEL: HAIKU_BARE }),
    ).toEqual([HAIKU_DATED, HAIKU_BARE]);
  });

  it('returns only the per-gateway name when that is all there is', () => {
    expect(enhancerModelNames('Comet', { COMET_ENHANCE_PROMPT_MODEL: HAIKU_DATED })).toEqual([HAIKU_DATED]);
  });

  it('returns only the cross-provider name when the gateway has no key of its own', () => {
    expect(enhancerModelNames('KIE', { ENHANCE_PROMPT_MODEL: HAIKU_BARE })).toEqual([HAIKU_BARE]);
  });

  it('returns nothing when neither is set', () => {
    expect(enhancerModelNames('KIE', {})).toEqual([]);
  });

  /* The variable is derived from the provider name, so a gateway's key must not leak into another. */
  it("does not read another gateway's key", () => {
    expect(enhancerModelNames('KIE', { COMET_ENHANCE_PROMPT_MODEL: HAIKU_DATED })).toEqual([]);
    expect(enhancerModelNames('Comet', { KIE_ENHANCE_PROMPT_MODEL: HAIKU_BARE })).toEqual([]);
  });

  it('upper-cases the provider name to build the key', () => {
    expect(enhancerModelNames('Anthropic', { ANTHROPIC_ENHANCE_PROMPT_MODEL: HAIKU_BARE })).toEqual([HAIKU_BARE]);
  });

  it('treats a whitespace-only value as unset — a blank line in a .env is not a model name', () => {
    expect(enhancerModelNames('Comet', { COMET_ENHANCE_PROMPT_MODEL: '   ', ENHANCE_PROMPT_MODEL: '  ' })).toEqual([]);
  });

  it('trims a value that has one, rather than listing a name with spaces round it', () => {
    expect(enhancerModelNames('Comet', { COMET_ENHANCE_PROMPT_MODEL: ` ${HAIKU_DATED} ` })).toEqual([HAIKU_DATED]);
  });

  /*
   * ONE VARIABLE, TWO DOORS — the arrangement `kieEnvModel` documents. `serverEnv` is a Cloudflare
   * loader context's bindings and `process.env` is a node deploy's; the module must read both, and
   * prefer the explicit one. If the `process.env` door closed, every server route that resolves a model
   * outside a loader context would silently stop seeing the operator's configuration.
   */
  it('reads process.env when serverEnv does not carry the key', () => {
    vi.stubEnv('COMET_ENHANCE_PROMPT_MODEL', HAIKU_DATED);
    expect(enhancerModelNames('Comet', {})).toEqual([HAIKU_DATED]);
    expect(enhancerModelNames('Comet', undefined)).toEqual([HAIKU_DATED]);
  });

  it('prefers an explicit serverEnv value over process.env', () => {
    vi.stubEnv('COMET_ENHANCE_PROMPT_MODEL', HAIKU_BARE);
    expect(enhancerModelNames('Comet', { COMET_ENHANCE_PROMPT_MODEL: HAIKU_DATED })).toEqual([HAIKU_DATED]);
  });
});

describe('envModelInfo — a name already accounted for is skipped', () => {
  const STATIC: ModelInfo[] = [
    { name: 'claude-sonnet-5', label: 'Sonnet', provider: 'Comet', maxTokenAllowed: 1, maxCompletionTokens: 1 },
  ];

  it('returns undefined for a name the provider already lists statically', () => {
    expect(envModelInfo('claude-sonnet-5', 'Comet', STATIC)).toBeUndefined();
  });

  /*
   * The de-dup that matters in practice: `<PROVIDER>_ENHANCE_PROMPT_MODEL` and `ENHANCE_PROMPT_MODEL`
   * are routinely the same string, and the platform model is often the enhancer's too. A duplicate row
   * is not merely untidy — `stream-text.ts` resolves by `find`, so two rows for one id is two answers.
   */
  it('returns undefined for a name already added by this pass', () => {
    const added = [envModelInfo(HAIKU_DATED, 'Comet', STATIC)!];

    expect(added[0]?.name).toBe(HAIKU_DATED);
    expect(envModelInfo(HAIKU_DATED, 'Comet', STATIC, added)).toBeUndefined();
  });

  it('builds a ModelInfo for a name nothing has claimed', () => {
    expect(envModelInfo(HAIKU_DATED, 'Comet', STATIC)).toEqual({
      name: HAIKU_DATED,
      label: `${HAIKU_DATED} (Comet)`,
      provider: 'Comet',
      maxTokenAllowed: FAMILY_POLICY.claude.maxTokenAllowed,
      maxCompletionTokens: FAMILY_POLICY.claude.maxCompletionTokens,
    });
  });
});

/*
 * 🔴 THE CAPS COME FROM THE MODEL'S FAMILY, NEVER FROM A PAIR OF LITERALS.
 *
 * A `claude-*` assertion alone passes for an implementation that hardcodes Claude's numbers — which is
 * exactly the bug `cometEnvModel`'s comment warns about ("a `grok-*` or `gemini-*` override silently
 * inherits Claude's 1M context window"). So a NON-claude id is asserted here too, and asserted to
 * DIFFER from the Claude numbers, or the family lookup is untested.
 */
describe('envModelInfo — the family decides the caps', () => {
  it('gives a claude id the claude family caps', () => {
    const info = envModelInfo('claude-haiku-9', 'Comet', [])!;

    expect(info.maxTokenAllowed).toBe(1_000_000);
    expect(info.maxCompletionTokens).toBe(128_000);
  });

  it('gives a chat-family id the CHAT caps, not the claude ones', () => {
    const info = envModelInfo('grok-4.5', 'Comet', [])!;

    /* Literal spot-check — a derived assertion alone passes for any consistent-but-wrong lookup. */
    expect(info.maxTokenAllowed).toBe(128_000);
    expect(info.maxCompletionTokens).toBe(32_000);

    expect(info.maxTokenAllowed).toBe(FAMILY_POLICY.chat.maxTokenAllowed);
    expect(info.maxCompletionTokens).toBe(FAMILY_POLICY.chat.maxCompletionTokens);

    /* The CONTROL that makes the two above mean something. */
    expect(info.maxTokenAllowed, 'a hardcoded Claude window would pass every other assertion here').not.toBe(
      FAMILY_POLICY.claude.maxTokenAllowed,
    );
  });

  /*
   * An UNKNOWN family still gets a row, deliberately. Refusing here would surface the operator's error
   * as "your model silently is not in the list" — which IS the `modelsList[0]` mis-bill. `requireFamily`
   * refuses it loudly at the moment of use instead, naming the id.
   */
  it('still lists an id no family claims, falling back to the claude caps', () => {
    const info = envModelInfo('mistral-large', 'Comet', []);

    expect(info, 'an unplaceable id must be LISTED and refused at use, never silently swapped').toBeDefined();
    expect(info!.maxTokenAllowed).toBe(FAMILY_POLICY.claude.maxTokenAllowed);
  });
});

describe('envConfiguredModels — the platform model and the enhancer', () => {
  const platform: ModelInfo = {
    name: 'claude-opus-9',
    label: 'platform',
    provider: 'Comet',
    maxTokenAllowed: 1,
    maxCompletionTokens: 1,
  };

  it('returns both, platform first', () => {
    const models = envConfiguredModels('Comet', COMET_MODELS, platform, { COMET_ENHANCE_PROMPT_MODEL: HAIKU_DATED });

    expect(models.map((m) => m.name)).toEqual(['claude-opus-9', HAIKU_DATED]);
  });

  it('returns just the enhancer model when no platform model is configured', () => {
    const models = envConfiguredModels('Comet', COMET_MODELS, undefined, { COMET_ENHANCE_PROMPT_MODEL: HAIKU_DATED });

    expect(models.map((m) => m.name)).toEqual([HAIKU_DATED]);
  });

  it('returns nothing when nothing is configured', () => {
    expect(envConfiguredModels('Comet', COMET_MODELS, undefined, {})).toEqual([]);
  });

  it('drops an enhancer name that is already a static row', () => {
    const models = envConfiguredModels('Comet', COMET_MODELS, undefined, {
      COMET_ENHANCE_PROMPT_MODEL: 'claude-sonnet-5',
    });

    expect(
      COMET_MODELS.some((m) => m.name === 'claude-sonnet-5'),
      'precondition',
    ).toBe(true);
    expect(models).toEqual([]);
  });

  it('de-duplicates the per-gateway and cross-provider names when they are the same string', () => {
    const models = envConfiguredModels('Comet', COMET_MODELS, undefined, {
      COMET_ENHANCE_PROMPT_MODEL: HAIKU_DATED,
      ENHANCE_PROMPT_MODEL: HAIKU_DATED,
    });

    expect(models.map((m) => m.name)).toEqual([HAIKU_DATED]);
  });

  it('de-duplicates an enhancer name that equals the platform model', () => {
    const models = envConfiguredModels('Comet', COMET_MODELS, platform, {
      COMET_ENHANCE_PROMPT_MODEL: 'claude-opus-9',
    });

    expect(models.map((m) => m.name)).toEqual(['claude-opus-9']);
  });

  it('lists BOTH names when the two variables disagree — the resolver picks, this does not', () => {
    const models = envConfiguredModels('KIE', KIE_MODELS, undefined, {
      KIE_ENHANCE_PROMPT_MODEL: 'claude-haiku-9',
      ENHANCE_PROMPT_MODEL: 'claude-haiku-8',
    });

    expect(models.map((m) => m.name)).toEqual(['claude-haiku-9', 'claude-haiku-8']);
  });
});

/**
 * 🔴 THE REGRESSION, against the REAL providers.
 *
 * Everything above is pure and would stay green if a gateway simply stopped calling it. This is the
 * assertion that fails when `getDynamicModels` is reverted to `platform ? [platform] : []` — the state
 * it shipped in, and the state that let a configured enhancer model get swapped for `modelsList[0]`.
 */
describe('🔴 a configured enhancer model reaches the provider model list', () => {
  it('Comet lists COMET_ENHANCE_PROMPT_MODEL', async () => {
    const models = await new CometApiProvider().getDynamicModels(undefined, undefined, {
      COMET_ENHANCE_PROMPT_MODEL: HAIKU_DATED,
    });

    expect(
      models.map((m) => m.name),
      'unlisted means stream-text runs modelsList[0] and settles at the configured model rates',
    ).toContain(HAIKU_DATED);
  });

  /*
   * KIE lists `claude-haiku-4-5` statically, so the shipped default is covered there by LUCK. A
   * non-static id is what actually exercises the path — asserting the bare one would pass against the
   * reverted implementation, i.e. be no test at all.
   */
  it('KIE lists KIE_ENHANCE_PROMPT_MODEL when it is not already a static row', async () => {
    expect(
      KIE_MODELS.some((m) => m.name === 'claude-haiku-9'),
      'precondition: not static',
    ).toBe(false);

    const models = await new KieProvider().getDynamicModels(undefined, undefined, {
      KIE_ENHANCE_PROMPT_MODEL: 'claude-haiku-9',
    });

    expect(models.map((m) => m.name)).toContain('claude-haiku-9');
  });

  it('and the cross-provider ENHANCE_PROMPT_MODEL reaches both gateways too', async () => {
    const comet = await new CometApiProvider().getDynamicModels(undefined, undefined, {
      ENHANCE_PROMPT_MODEL: 'claude-haiku-9',
    });
    const kie = await new KieProvider().getDynamicModels(undefined, undefined, {
      ENHANCE_PROMPT_MODEL: 'claude-haiku-9',
    });

    expect(comet.map((m) => m.name)).toContain('claude-haiku-9');
    expect(kie.map((m) => m.name)).toContain('claude-haiku-9');
  });

  /* The platform model must still be listed — the enhancer's is ADDITIVE, never a replacement. */
  it('keeps listing the platform model alongside the enhancer one', async () => {
    const models = await new CometApiProvider().getDynamicModels(undefined, undefined, {
      LLM_MODEL: 'claude-opus-9',
      COMET_ENHANCE_PROMPT_MODEL: HAIKU_DATED,
    });

    expect(models.map((m) => m.name)).toEqual(['claude-opus-9', HAIKU_DATED]);
  });

  /*
   * CONTROL. With no enhancer variables the list is exactly what it was before this module existed:
   * the platform model, or nothing. Without this, every case above passes for an implementation that
   * dumps a pile of speculative ids into the provider — which would make `stream-text.ts` "find" models
   * the gateway cannot serve.
   */
  it('CONTROL: with no enhancer variables set, the list is the platform model alone', async () => {
    expect(await new CometApiProvider().getDynamicModels(undefined, undefined, {})).toEqual([]);
    expect(await new KieProvider().getDynamicModels(undefined, undefined, {})).toEqual([]);

    const withPlatform = await new CometApiProvider().getDynamicModels(undefined, undefined, {
      LLM_MODEL: 'claude-opus-9',
    });

    expect(withPlatform.map((m) => m.name)).toEqual(['claude-opus-9']);
  });
});
