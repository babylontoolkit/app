/**
 * The four stream annotations, built once for the route AND the managed engine's transcript
 * (`turn-annotations.ts`, managed-agents-engine T9/T10). The legacy engine's annotations are unchanged
 * except for one added fact — `agentMeta.engine: 'legacy'` — and never carry `creationPhasesCompleted`.
 */
import { describe, expect, it } from 'vitest';
import { buildTurnAnnotations, type AnnotatedGeneration, type TurnAnnotationFacts } from './turn-annotations';

const GENERATION: AnnotatedGeneration = {
  generationId: 'gen_1',
  promptVersionId: 'pv_1',
  model: 'claude-sonnet-5-5',
  provider: 'Anthropic',
  tier: 'standard',
  tierReason: 'standard_requested',
  toolContext: { loaded: new Set(['bt-design']), offerLoadSkill: false } as AnnotatedGeneration['toolContext'],
  blocksLoaded: ['react-training'],
  historyStats: { messages: 2, chars: 10, attachments: 0, attachmentTokens: 0, maxTurns: 30 },
};

const FACTS: TurnAnnotationFacts = {
  usage: { promptTokens: 1, completionTokens: 2, totalTokens: 3, cacheReadTokens: 4, cacheCreationTokens: 5 },
  outcome: {
    isFirstBuildTurn: false,
    finishReason: 'stop',
    forcedContinuation: false,
    unproductiveRescue: false,
    completionPassWroteFiles: false,
    wroteFiles: false,
    aborted: false,
    stopReason: 'none',
    lastCheckOk: null,
  },
  workspaceSummary: null,
  settlement: { creditsCharged: 9, balanceAfter: 91, savings: null },
};

describe('buildTurnAnnotations', () => {
  it('LEGACY (no engine on the generation): agentMeta says engine "legacy" and has no creationPhasesCompleted', () => {
    const a = buildTurnAnnotations(GENERATION, FACTS);

    expect(a.agentMeta.value.engine).toBe('legacy');
    expect('creationPhasesCompleted' in a.agentMeta.value).toBe(false);
    expect(Object.keys(a.agentMeta.value)).toEqual([
      'generationId',
      'promptVersionId',
      'model',
      'provider',
      'tier',
      'tierReason',
      'skillsLoaded',
      'blocksLoaded',
      'history',
      'outcome',
      'engine',
    ]);
    expect(a.usage.value).toEqual({
      completionTokens: 2,
      promptTokens: 1,
      totalTokens: 3,
      cacheReadTokens: 4,
      cacheCreationTokens: 5,
    });
    expect(a.agentWorkspace).toBeNull();
    expect(a.credits.value).toEqual({ creditsCharged: 9, balanceAfter: 91, notice: null, savings: null });
  });

  it('MANAGED first build: engine "managed" and the phases it completed', () => {
    const a = buildTurnAnnotations(
      { ...GENERATION, engine: 'managed' },
      { ...FACTS, creationPhasesCompleted: ['design', 'game', 'frontend'] },
    );

    expect(a.agentMeta.value).toMatchObject({
      engine: 'managed',
      creationPhasesCompleted: ['design', 'game', 'frontend'],
    });
  });
});
