/**
 * The legacy engine bills the step in flight (`_specs/no-unbilled-usage_plan.md` D7, T7).
 *
 * A source scan, for `running-row-wiring.spec.ts`'s reason: `runAgentGeneration` cannot be driven end to end
 * without a live provider. The tap's behaviour — the SDK really drops a broken step, its `response.id` is the
 * key, nothing is counted twice — is pinned against the real AI SDK in `modules/llm/wire-usage.spec.ts`; this
 * pins that the proxy and every Anthropic-wire provider are actually wired to it. Each failure here is silent:
 * an unwired provider bills exactly what it billed before, which reads as nothing having changed.
 *
 * ⚠️ With CONTROLS — a pattern that silently stops matching reports a clean bill of health forever.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const read = (p: string) => readFileSync(join(process.cwd(), p), 'utf8');

const codeOnly = (source: string) =>
  source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .filter((line) => !line.trim().startsWith('//') && !line.trim().startsWith('*'))
    .join('\n');

const proxy = () => codeOnly(read('app/lib/.server/agent/proxy.ts'));

/** Every `getModelInstance({ … })` call's argument text. */
function modelInstanceCalls(source: string): string[] {
  const calls: string[] = [];
  let from = 0;

  for (;;) {
    const at = source.indexOf('getModelInstance({', from);

    if (at < 0) {
      return calls;
    }

    let depth = 0;
    let end = at + 'getModelInstance('.length;

    for (; end < source.length; end++) {
      if (source[end] === '{') {
        depth += 1;
      } else if (source[end] === '}') {
        depth -= 1;

        if (depth === 0) {
          break;
        }
      }
    }

    calls.push(source.slice(at, end + 1));
    from = end;
  }
}

describe('proxy.ts', () => {
  it('hands the generation’s wire recorder to EVERY model instance it builds (the retry’s too)', () => {
    const calls = modelInstanceCalls(proxy());

    expect(calls.length, 'getModelInstance({ calls found').toBeGreaterThanOrEqual(2);

    for (const call of calls) {
      expect(call).toContain('wireUsage');
    }
  });

  it('records the ids of the steps it bills — in the meter path and in the drain', () => {
    const source = proxy();
    const onStep = source.indexOf('onStepFinish: (step) => {');
    const meter = source.indexOf('turnMeter?.onStep(step)', onStep);

    expect(onStep).toBeGreaterThan(-1);
    expect(source.slice(meter, meter + 400)).toContain('reportStep(step)');

    const drain = source.indexOf('async function* drain(');
    const accumulate = source.indexOf('accumulateStepUsage(totals, steps', drain);

    expect(accumulate).toBeGreaterThan(drain);
    expect(source.slice(accumulate, accumulate + 300)).toContain('reportStep');
  });

  it('adds the unreported attempts to the totals BEFORE the usage resolves and before settlement', () => {
    const source = proxy();
    const finallyAt = source.indexOf('resolveUsage(totals);');
    const fold = source.lastIndexOf('unreportedWireUsage(', finallyAt);
    const add = source.lastIndexOf('addUnreportedUsage(totals', finallyAt);
    const settle = source.indexOf('settleGeneration(', finallyAt);

    expect(finallyAt).toBeGreaterThan(-1);
    expect(fold, 'unreportedWireUsage( before resolveUsage(totals)').toBeGreaterThan(-1);
    expect(add).toBeGreaterThan(fold);
    expect(source.slice(fold, finallyAt)).not.toContain('async function');
    expect(settle).toBeGreaterThan(finallyAt);
  });
});

describe('every Anthropic-wire provider taps its fetch', () => {
  it.each([
    ['anthropic.ts', 'app/lib/modules/llm/providers/anthropic.ts'],
    ['kie.ts (Claude branch)', 'app/lib/modules/llm/providers/kie.ts'],
    ['cometapi.ts (Claude branch)', 'app/lib/modules/llm/providers/cometapi.ts'],
  ])('%s', (_name, file) => {
    expect(codeOnly(read(file))).toContain('tapWireUsage(options.wireUsage');
  });

  it('the base provider declares the option, so a provider that ignores it still compiles', () => {
    expect(codeOnly(read('app/lib/modules/llm/base-provider.ts'))).toContain('wireUsage?: WireUsageRecorder');
  });
});

describe('CONTROLS', () => {
  it('finds both model-instance calls in a sample', () => {
    const sample = 'a = p.getModelInstance({ model, x: { y: 1 } }); b = p.getModelInstance({ model, wireUsage });';

    expect(modelInstanceCalls(sample)).toEqual([
      'getModelInstance({ model, x: { y: 1 } })'.slice(0, -1),
      'getModelInstance({ model, wireUsage })'.slice(0, -1),
    ]);
  });

  it('a comment naming the wiring does not count', () => {
    expect(codeOnly('/* tapWireUsage(options.wireUsage */\nconst x = 1;')).not.toContain('tapWireUsage(');
  });
});
