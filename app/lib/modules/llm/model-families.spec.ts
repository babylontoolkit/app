/**
 * The model-id -> family derivation and the per-family policy table (T1).
 *
 * Every rule here fails SILENTLY and on the wire: a family guessed instead of refused sends an
 * Anthropic `thinking` block to an OpenAI endpoint (a hard 400 before a token), and a wrong
 * `cacheProfile`/`usageNamespace` mis-bills a generation with nothing thrown. The effort maps are
 * asserted EXHAUSTIVELY over `EFFORT_LEVELS` rather than on a sample, so adding a level cannot
 * silently fall through to a default.
 */
import { describe, expect, it } from 'vitest';
import { EFFORT_LEVELS, type EffortLevel } from '~/lib/modules/llm/capabilities';
import {
  codexEffort,
  familyOf,
  geminiThinkingLevel,
  requireFamily,
  FAMILY_POLICY,
  MODEL_FAMILIES,
  type ModelFamily,
} from './model-families';

describe('familyOf', () => {
  it('derives the family from the id prefix', () => {
    expect(familyOf('claude-opus-5')).toBe('claude');
    expect(familyOf('claude-sonnet-5')).toBe('claude');
    expect(familyOf('gpt-5.2-codex')).toBe('codex');
    expect(familyOf('gemini-3-pro')).toBe('gemini');
  });

  it('strips the Bedrock-style `anthropic.` prefix before matching', () => {
    expect(familyOf('anthropic.claude-opus-5')).toBe('claude');
  });

  it('returns undefined for anything no prefix claims', () => {
    expect(familyOf('llama-3')).toBeUndefined();
    expect(familyOf('')).toBeUndefined();
    expect(familyOf(undefined)).toBeUndefined();
    expect(familyOf(null)).toBeUndefined();
    expect(familyOf(42 as unknown as string)).toBeUndefined();
    expect(familyOf({} as unknown as string)).toBeUndefined();
  });
});

describe('requireFamily', () => {
  it('returns the family for a known id', () => {
    expect(requireFamily('gpt-5.2-codex')).toBe('codex');
  });

  it('throws naming the offending id AND all three accepted prefixes', () => {
    let message = '';

    try {
      requireFamily('llama-3');
    } catch (error) {
      message = (error as Error).message;
    }

    expect(message).toContain('llama-3');
    expect(message).toContain('claude-');
    expect(message).toContain('gpt-');
    expect(message).toContain('gemini-');
  });

  it('throws for an absent id', () => {
    expect(() => requireFamily(undefined)).toThrow();
    expect(() => requireFamily('')).toThrow();
  });
});

describe('codexEffort', () => {
  const expected: Record<EffortLevel, string> = {
    medium: 'medium',
    high: 'high',
    xhigh: 'xhigh',
    max: 'xhigh', // clamps DOWN to the wire's ceiling — never up
  };

  it.each(EFFORT_LEVELS)('maps effort %s on an adaptive turn', (effort) => {
    expect(codexEffort('adaptive', effort)).toBe(expected[effort]);
  });

  it.each(EFFORT_LEVELS)('maps effort %s to low when thinking is disabled', (effort) => {
    expect(codexEffort('disabled', effort)).toBe('low');
  });
});

describe('geminiThinkingLevel', () => {
  const expected: Record<EffortLevel, string> = {
    medium: 'low',
    high: 'high',
    xhigh: 'high',
    max: 'high',
  };

  it.each(EFFORT_LEVELS)('maps effort %s on an adaptive turn', (effort) => {
    expect(geminiThinkingLevel('adaptive', effort)).toBe(expected[effort]);
  });

  it.each(EFFORT_LEVELS)('maps effort %s to low when thinking is disabled', (effort) => {
    expect(geminiThinkingLevel('disabled', effort)).toBe('low');
  });
});

describe('FAMILY_POLICY', () => {
  it.each(MODEL_FAMILIES)('covers %s', (family) => {
    expect(FAMILY_POLICY[family]).toBeDefined();
  });

  it('has no entry for a family that is not declared', () => {
    expect(Object.keys(FAMILY_POLICY).sort()).toEqual([...MODEL_FAMILIES].sort());
  });

  it.each([
    ['claude', 'derived', 'anthropic'],
    ['codex', 'explicit-pair', 'openai'],
    ['gemini', 'none', 'google'],
  ] as ReadonlyArray<[ModelFamily, string, string]>)(
    '%s bills cached tokens as %s and reads usage under %s',
    (family, cacheProfile, usageNamespace) => {
      expect(FAMILY_POLICY[family].cacheProfile).toBe(cacheProfile);
      expect(FAMILY_POLICY[family].usageNamespace).toBe(usageNamespace);
    },
  );
});
