/**
 * Anthropic Managed Agents is the ONLY LLM path (owner, 2026-10-03, `_specs/anthropic-only_plan.md` D1–D3:
 * *"Anthropic Managed Agent SHOULD be the Only LLM_PROVIDER PATH… period"*).
 *
 * The legacy `streamText` loop (`agent/proxy.ts`) and the provider-path `streamText` wrapper
 * (`llm/stream-text.ts`) are still on disk — helpers the managed engine imports live beside them — but they
 * are DORMANT: nothing a request reaches may call them. A dormant path comes back by being CALLED, silently,
 * so this is a default-deny scan over every route and every managed-engine module, with controls proving the
 * scanner can fail. Do not silence a failure by adding an exemption: route the new code through Managed Agents.
 */
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { getPlatformProvider, PLATFORM_PROVIDERS } from '~/lib/.server/agent/config';
import { LLM_PRICE_PROVIDERS } from '~/lib/.server/billing/market-price-store';
import { resolveAgentEngine } from './config';

const ROOT = path.resolve(__dirname, '../../../..');

/**
 * Upstream bolt.diy routes that import the provider path but are FAIL-CLOSED: both 404 before any model call
 * (`upstream-routes.spec.ts` pins it). Kept on disk under hide-don't-delete; never extend this list.
 */
const FAIL_CLOSED_UPSTREAM = new Set(['app/routes/api.chat.ts', 'app/routes/api.llmcall.ts']);

/** What reaching the legacy loop or the provider path looks like in code (comments stripped first). */
const FORBIDDEN: Array<[string, RegExp]> = [
  ['calls runAgentGeneration', /\brunAgentGeneration\s*\(/],
  ['imports runAgentGeneration', /import\s+\{[^}]*\brunAgentGeneration\b[^}]*\}\s+from/],
  ['imports the provider-path stream-text', /from\s+['"]~\/lib\/\.server\/llm\/stream-text['"]/],
  [
    'imports streamText/generateText from ai',
    /import\s+\{[^}]*\b(streamText|generateText)\b[^}]*\}\s+from\s+['"]ai['"]/,
  ],
];

function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}

export function violationsIn(source: string): string[] {
  const code = stripComments(source);

  return FORBIDDEN.filter(([, pattern]) => pattern.test(code)).map(([label]) => label);
}

function sources(dir: string): string[] {
  const out: string[] = [];

  for (const entry of fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true })) {
    const rel = `${dir}/${entry.name}`;

    if (entry.isDirectory()) {
      out.push(...sources(rel));
    } else if (/\.(ts|tsx)$/.test(entry.name) && !/\.spec\.tsx?$|\.testkit\.ts$/.test(entry.name)) {
      out.push(rel);
    }
  }

  return out;
}

describe('no request reaches the legacy loop or the provider path', () => {
  const scanned = [...sources('app/routes'), ...sources('app/lib/.server/agent-managed')];

  it('scans a real set of files (it cannot pass by scanning nothing)', () => {
    expect(scanned).toContain('app/routes/api.agent.ts');
    expect(scanned).toContain('app/routes/api.enhancer.ts');
    expect(scanned).toContain('app/lib/.server/agent-managed/engine.ts');
  });

  it('no route or managed-engine module calls the legacy loop or imports the provider path', () => {
    const found = scanned
      .filter((file) => !FAIL_CLOSED_UPSTREAM.has(file))
      .flatMap((file) => violationsIn(fs.readFileSync(path.join(ROOT, file), 'utf8')).map((v) => `${file}: ${v}`));

    expect(found).toEqual([]);
  });

  it('the fail-closed exemptions still exist and still match (a stale exemption is a hole waiting)', () => {
    for (const file of FAIL_CLOSED_UPSTREAM) {
      expect(violationsIn(fs.readFileSync(path.join(ROOT, file), 'utf8')), file).not.toEqual([]);
    }
  });

  describe('CONTROLS — the scanner can fail', () => {
    it('catches a call, a value import, the stream-text wrapper and the ai streamText import', () => {
      expect(violationsIn('const g = await runAgentGeneration(req);')).toEqual(['calls runAgentGeneration']);
      expect(violationsIn("import { runAgentGeneration } from '~/lib/.server/agent/proxy';")).toContain(
        'imports runAgentGeneration',
      );
      expect(violationsIn("import { streamText } from '~/lib/.server/llm/stream-text';")).toEqual([
        'imports the provider-path stream-text',
      ]);
      expect(violationsIn("import { generateText, tool } from 'ai';")).toEqual([
        'imports streamText/generateText from ai',
      ]);
    });

    it('ignores a mention in a comment and a type-only import of the generation shape', () => {
      expect(violationsIn('/* runAgentGeneration(req) was the legacy loop */\n// runAgentGeneration(x)')).toEqual([]);
      expect(violationsIn("import type { AgentGeneration } from '~/lib/.server/agent/proxy';")).toEqual([]);
    });
  });
});

describe('the configuration can only say Anthropic Managed Agents', () => {
  it('the engine is managed whatever AGENT_ENGINE says', () => {
    for (const value of [undefined, '', 'managed', 'legacy', 'LEGACY', 'anything']) {
      expect(resolveAgentEngine({ cloudflare: { env: { AGENT_ENGINE: value } } }), String(value)).toBe('managed');
    }
  });

  it('the only LLM provider is Anthropic, whatever LLM_PROVIDER says', () => {
    expect([...PLATFORM_PROVIDERS]).toEqual(['Anthropic']);

    for (const value of [undefined, 'Anthropic', 'KIE', 'Comet', 'anything']) {
      expect(getPlatformProvider({ cloudflare: { env: { LLM_PROVIDER: value } } }), String(value)).toBe('Anthropic');
    }
  });

  it('only Anthropic prices an LLM turn (KIE and fal price media only)', () => {
    expect([...LLM_PRICE_PROVIDERS]).toEqual(['Anthropic']);
  });
});
