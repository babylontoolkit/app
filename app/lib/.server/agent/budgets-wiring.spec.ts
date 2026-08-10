/**
 * THE BUDGETS ARE OPTIONAL AT EVERY SEAM, SO THE HAND-OFF NEEDS ITS OWN TEST (owner, 2026-08-09).
 *
 * `FileToolContext.budgets`, `ReferenceToolContext.maxLoads` and `ToolPolicyInput.budgets` all default
 * to the shipped constants. That is deliberate — it keeps ~40 existing call sites and specs working and
 * makes an unconfigured platform byte-identical — and it is also the classic silent failure: a proxy
 * that forgets to pass one produces a perfectly healthy generation running on the DEFAULT, so
 * `AGENT_MAX_READ_CHARS=200000` does nothing at all and nothing anywhere says so.
 *
 * The unit tests cannot see this. `resolveAgentBudgets` returns the right numbers whether or not
 * anybody reads them, and `runAgentGeneration` cannot be constructed in a unit test (it boots the
 * prompt store, the ledger and a provider). So this is a source scan — the same instrument as
 * `sandbox-seam.spec.ts` and `skill-selection.spec.ts` — and, like those, it carries CONTROLS, because
 * a scanner whose pattern silently stops matching reports a clean bill of health forever.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const read = (path: string) => readFileSync(join(process.cwd(), path), 'utf8');

/** Comments quote these identifiers constantly; a scan that counts prose proves nothing. */
const codeOnly = (source: string) =>
  source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .filter((line) => !line.trim().startsWith('*') && !line.trim().startsWith('//'))
    .join('\n');

const proxy = () => codeOnly(read('app/lib/.server/agent/proxy.ts'));

describe('the proxy resolves the budgets and passes them to every seam', () => {
  it('resolves them once, from the request context', () => {
    expect(proxy()).toMatch(/const budgets = resolveAgentBudgets\(request\.context\)/);
  });

  /*
   * 🔴 ONCE. These numbers are not independent — `maxToolRounds` is derived from `maxReferenceLoads` —
   * so two resolves is how the policy and the tools end up disagreeing about the same turn.
   */
  it('resolves them exactly once per generation', () => {
    expect(proxy().match(/resolveAgentBudgets\(/g)).toHaveLength(1);
  });

  it('passes them to the tool policy, which derives maxSteps from them', () => {
    const call = proxy().match(/toolPolicyForTurn\(\{[\s\S]*?\}\)/)?.[0] ?? '';

    expect(call, 'toolPolicyForTurn call not found').not.toBe('');
    expect(call).toMatch(/\bbudgets,/);
  });

  it('passes the reference budget to the reference tool', () => {
    const ctx = proxy().match(/const referenceContext: ReferenceToolContext = \{[\s\S]*?\};/)?.[0] ?? '';

    expect(ctx, 'referenceContext not found').not.toBe('');
    expect(ctx).toMatch(/maxLoads: budgets\.maxReferenceLoads/);
  });

  it('passes the budgets AND the plan pool to the file tool', () => {
    const ctx = proxy().match(/const fileToolContext = \{[\s\S]*?\};/)?.[0] ?? '';

    expect(ctx, 'fileToolContext not found').not.toBe('');
    expect(ctx).toMatch(/planCharsThisTurn: \{ total: 0 \}/);
    expect(ctx).toMatch(/\bbudgets,/);
  });

  /*
   * The prompt states the reference budget and the tool enforces it; if the sync stops passing the
   * resolved value the index advertises a number nobody keeps.
   */
  it('builds the reference index with the resolved budget', () => {
    expect(codeOnly(read('app/routes/api.admin.prompt.ts'))).toMatch(
      /maxReferenceLoads: resolveAgentBudgets\(context\)\.maxReferenceLoads/,
    );
  });
});

/**
 * CONTROLS. Every assertion above is a regex against a file that is edited constantly; if one silently
 * stops matching, the suite goes green on a proxy that passes nothing.
 */
describe('CONTROLS — the scanner still reads the file it thinks it does', () => {
  it('finds the proxy, and it is a real module', () => {
    const source = proxy();

    expect(source.length).toBeGreaterThan(10_000);
    expect(source).toContain('runAgentGeneration');
  });

  it('strips comments rather than matching prose', () => {
    const stripped = codeOnly(['/* budgets: budgets */', 'const real = 1;', '// budgets,'].join('\n'));

    expect(stripped).toContain('const real = 1;');
    expect(stripped).not.toContain('budgets: budgets');
    expect(stripped).not.toContain('// budgets');
  });

  /* The call-site matchers must find something for the emptiness guards above to mean anything. */
  it('locates every construct it asserts on', () => {
    const source = proxy();

    expect(source).toMatch(/toolPolicyForTurn\(\{[\s\S]*?\}\)/);
    expect(source).toMatch(/const referenceContext: ReferenceToolContext = \{[\s\S]*?\};/);
    expect(source).toMatch(/const fileToolContext = \{[\s\S]*?\};/);
  });
});
