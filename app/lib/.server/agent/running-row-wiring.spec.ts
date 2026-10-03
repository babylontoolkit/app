/**
 * The legacy engine opens its `running` row BEFORE it spends, checkpoints every finished step, and lets the
 * checkpoints drain before it settles (`_specs/no-unbilled-usage_plan.md` D2, T2).
 *
 * A source scan, for `budgets-wiring.spec.ts`'s reason: `runAgentGeneration` cannot be driven end to end
 * without a live provider, and the defect this guards is an ORDERING — a running row written after the
 * first `startStream(` is a turn whose first step a dead process can still lose, and that compiles,
 * type-checks and passes every unit test of the helpers. The helpers' behaviour is pinned in
 * `billing/running-generation.spec.ts`; this pins that the proxy, the managed engine and the enhancer
 * actually call them, in the right place.
 *
 * ⚠️ With CONTROLS, like every scanner here — a pattern that silently stops matching reports a clean bill
 * of health forever.
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
const engine = () => codeOnly(read('app/lib/.server/agent-managed/engine.ts'));
const enhancer = () => codeOnly(read('app/lib/.server/agent-managed/enhance.ts'));

/** The body of the proxy's `run()` generator — where every provider call of a legacy turn happens. */
const runBody = (source: string) => {
  const start = source.indexOf('async function* run(): AsyncGenerator<AgentChunk> {');

  return start < 0 ? '' : source.slice(start);
};

describe('legacy engine (proxy.ts)', () => {
  it('opens the running row before the first provider call', () => {
    const body = runBody(proxy());
    const open = body.indexOf('openRunningGeneration(');
    const firstStream = body.indexOf('startStream(');

    expect(open, 'openRunningGeneration( not found in run()').toBeGreaterThan(-1);
    expect(firstStream, 'startStream( not found in run()').toBeGreaterThan(-1);
    expect(open).toBeLessThan(firstStream);
  });

  it('marks the generation in flight for the sweep before it spends', () => {
    const body = runBody(proxy());

    expect(body.indexOf('trackGeneration(')).toBeGreaterThan(-1);
    expect(body.indexOf('trackGeneration(')).toBeLessThan(body.indexOf('startStream('));
  });

  it('checkpoints cumulative usage from onStepFinish', () => {
    const source = proxy();
    const onStep = source.indexOf('onStepFinish: (step) => {');
    const checkpoint = source.indexOf('checkpointer.checkpoint(', onStep);
    const nextKey = source.indexOf('\n      onChunk', onStep);

    expect(onStep).toBeGreaterThan(-1);
    expect(checkpoint).toBeGreaterThan(onStep);

    if (nextKey > -1) {
      expect(checkpoint).toBeLessThan(nextKey);
    }
  });

  it('drains the checkpoints before settling', () => {
    const body = runBody(proxy());
    const flush = body.indexOf('await checkpointer.flush()');
    const settle = body.indexOf('settleGeneration(');

    expect(flush).toBeGreaterThan(-1);
    expect(flush).toBeLessThan(settle);
  });
});

describe('managed engine (engine.ts)', () => {
  it('opens the running row before the turn sends its first event', () => {
    const source = engine();
    const run = source.indexOf('async function* run(): AsyncGenerator<AgentChunk> {');
    const open = source.indexOf('openRunningGeneration(', run);
    const turn = source.indexOf('runManagedTurn(', run);

    expect(run).toBeGreaterThan(-1);
    expect(open).toBeGreaterThan(run);
    expect(open).toBeLessThan(turn);
  });

  it('marks the chat in flight for the sweep', () => {
    expect(engine()).toContain('trackManagedTurn(');
  });
});

/*
 * The enhancer runs on Managed Agents since 2026-10-03 (`agent-managed/enhance.ts`): the session is created
 * first (no spend — and the row must NAME it, so the sweep can price a dead enhancement), then the row is
 * opened, then the turn sends the message that spends.
 */
describe('prompt enhancer (agent-managed/enhance.ts)', () => {
  it('opens the running row (naming the session) before the turn that spends', () => {
    const source = enhancer();
    const open = source.indexOf('openRunningGeneration(');
    const spend = source.indexOf('runManagedTurn(');

    expect(open).toBeGreaterThan(-1);
    expect(open).toBeLessThan(spend);
    expect(source.slice(open, spend)).toContain('managedSessionId: sessionId');
  });
});

describe('CONTROLS', () => {
  it('reads the real files', () => {
    expect(proxy()).toContain('export async function runAgentGeneration(');
    expect(engine()).toContain('export async function runManagedGeneration(');
    expect(enhancer()).toContain('runManagedTurn(');
  });

  it('finds the run() body and the first provider call inside it', () => {
    expect(runBody(proxy())).toContain("startStream('first'");
  });

  it('strips comments rather than matching prose', () => {
    expect(codeOnly('/* openRunningGeneration( */\nconst x = 1;')).not.toContain('openRunningGeneration(');
  });
});
