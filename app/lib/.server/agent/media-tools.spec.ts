/**
 * The media ROUND budget (`MAX_MEDIA_ROUNDS`) — the one-parallel-round rule as code, not prose.
 *
 * Born from gen_msixapaq_i871b6 (2026-08-07): a first build turn made generate_image calls on every
 * step it had (3 parallel, then 1, then 1 — the brief says ONE round), spent the whole media-turn
 * step budget, and ended with the game unwritten; the forced-continuation rescue re-billed a ~212k
 * prefix at the 2× cache-write rate and delivered 31 tokens of nothing. 1,489 credits, no game.
 *
 * The budget lives in the tools' `execute`, BEFORE any debit (the `MAX_SKILL_LOADS` pattern —
 * `spec/skills.md`: cap the spend inside the tool, never withdraw the tool). These tests pin the
 * three properties that matter, each of which fails SILENTLY as a bigger bill:
 *
 *   - a call past the budget is refused INSTANTLY and touches neither the ledger nor the provider;
 *   - the refusal text tells the model what to do instead (write the game NOW) — it fires mid-thrash;
 *   - an unwired tracker (tests, older callers) means unlimited — the cap only binds where the proxy
 *     wires it, so nothing else changes behaviour by accident.
 */
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ObjectStore } from '~/lib/.server/storage';
import type { MediaProvider } from '~/lib/.server/media/kie-client';
import { FsLedger, setLedger } from '~/lib/.server/billing/ledger';
import { setGenerationStore, type GenerationStore, type GenerationUpsert } from '~/lib/.server/billing/generations';
import { createMediaTools, MAX_MEDIA_ROUNDS } from './media-tools';

/*
 * ⚠️ The allowed-path tests reach `startMediaTask`, whose ledger/store seams FALL BACK to the real
 * `.data` directory when unset (the `env()`/`FsChatIndex` trap — a seam that looks empty resolves to
 * the developer's real data). Both are pinned to throwaways here; the first draft of this file
 * deposited two real `med_*` records in `.data/generations`.
 */
let tmp: string;

beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'media-tools-'));
  setLedger(new FsLedger(tmp));
  setGenerationStore({
    upsert: async (_row: GenerationUpsert) => undefined,
    list: async () => [],
  } as unknown as GenerationStore);
});

afterEach(async () => {
  setLedger(undefined);
  setGenerationStore(undefined);
  await fs.rm(tmp, { recursive: true, force: true });
});

/** A provider that PROVES it was reached by throwing — a refused call must never get this far. */
function tripwireProvider(): { provider: MediaProvider; touched: () => boolean } {
  let reached = false;

  const provider = new Proxy(
    {},
    {
      get: () => {
        reached = true;
        throw new Error('provider reached — the budget did not refuse before the spend path');
      },
    },
  ) as unknown as MediaProvider;

  return { provider, touched: () => reached };
}

const tripwireStore = new Proxy(
  {},
  {
    get: () => {
      throw new Error('object store reached — the budget did not refuse before the spend path');
    },
  },
) as unknown as ObjectStore;

function toolsWith(rounds?: { used: number }) {
  const wire = tripwireProvider();

  const tools = createMediaTools({
    userId: 'user-1',
    projectId: 'prj_test',
    provider: wire.provider,
    objectStore: tripwireStore,
    emit: () => undefined,
    rounds,
  });

  return { tools, wire };
}

async function callGenerateImage(tools: ReturnType<typeof toolsWith>['tools']): Promise<string> {
  const generate = (tools as unknown as Record<string, { execute?: (args: unknown, opts: unknown) => Promise<string> }>)
    .generate_image;

  return generate.execute!({ prompt: 'a kart hero image' }, { toolCallId: 'call-1', messages: [] });
}

describe('the media round budget', () => {
  it('refuses a call past the budget BEFORE any debit or provider contact, and says what to do instead', async () => {
    const { tools, wire } = toolsWith({ used: MAX_MEDIA_ROUNDS });

    const result = await callGenerateImage(tools);

    expect(result).toContain('REFUSED');
    expect(result).toContain('nothing was charged');

    // The recovery instruction — the model reading this is mid-thrash with the project unwritten.
    expect(result).toContain('NOW');
    expect(wire.touched()).toBe(false);
  });

  it('allows calls while the budget has rounds left (the spend path is then reached)', async () => {
    const { tools, wire } = toolsWith({ used: MAX_MEDIA_ROUNDS - 1 });

    // The tripwire throws once the call passes the budget — proving the gate let it through.
    const result = await callGenerateImage(tools);

    expect(result).not.toContain('REFUSED —');
    expect(wire.touched()).toBe(true);
  });

  it('an unwired tracker means unlimited — the cap binds only where the proxy wires it', async () => {
    const { tools, wire } = toolsWith(undefined);

    await callGenerateImage(tools);

    expect(wire.touched()).toBe(true);
  });

  it('the budget is one intended round plus one retry round — not a knob to quietly widen', () => {
    /*
     * 2 is load-bearing arithmetic, not taste: with `maxSteps = CREATION_MEDIA_STEPS + 1`, allowing a
     * 3rd round would let tool calls consume the reserved answer step again — the exact failure this
     * budget exists to prevent. Widen it only together with the step cap, deliberately.
     */
    expect(MAX_MEDIA_ROUNDS).toBe(2);
  });
});
