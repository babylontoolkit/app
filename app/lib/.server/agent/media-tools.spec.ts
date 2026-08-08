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
import { createMediaTools } from './media-tools';
import { setMediaDispatcher } from '~/lib/.server/media/dispatch';

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

function toolsWith() {
  const wire = tripwireProvider();

  const tools = createMediaTools({
    userId: 'user-1',
    projectId: 'prj_test',
    provider: wire.provider,
    objectStore: tripwireStore,
    emit: () => undefined,
  });

  return { tools, wire };
}

async function callGenerateImage(tools: ReturnType<typeof toolsWith>['tools']): Promise<string> {
  const generate = (tools as unknown as Record<string, { execute?: (args: unknown, opts: unknown) => Promise<string> }>)
    .generate_image;

  return generate.execute!({ prompt: 'a kart hero image' }, { toolCallId: 'call-1', messages: [] });
}

/*
 * The production dispatcher sleeps on a REAL timer (spacing + retry backoff), so a spec driving a
 * failing provider would pay seconds per call — this file timed out at 5s on its first run. The
 * queue's own behaviour is tested against an injected clock in `media/dispatch.spec.ts`; here it is
 * a pass-through so these tests measure the TOOL, not the queue.
 */
beforeEach(() => setMediaDispatcher((_label, create) => create()));
afterEach(() => setMediaDispatcher(undefined));

describe('there is NO media round budget — a call is never refused (2026-08-08)', () => {
  /*
   * 🔴 The block this replaces asserted `MAX_MEDIA_ROUNDS === 2` and the REFUSED string. That cap, and
   * the "make ALL your generate calls FIRST, in ONE parallel round" instruction it enforced, refused
   * three images a live design had asked for:
   *
   *   WARN  media tool: round budget spent (2/2), call refused   x3
   *
   * The owner had asked more than once for images one at a time, spaced out. The ceiling that remains
   * is `maxSteps` (`MEDIA_IMAGE_ROUNDS`, tool-policy.ts) — it bounds the TURN without ever telling the
   * model no to a call it has already decided to make.
   */
  it('reaches the spend path on every call, however many have already been made', async () => {
    const { tools, wire } = toolsWith();

    // The tripwire store throws once a call passes into `startMediaTask` — proving it got through.
    for (let call = 0; call < 6; call++) {
      const result = await callGenerateImage(tools);
      expect(result, `call ${call + 1} was refused`).not.toContain('REFUSED');
    }

    expect(wire.touched()).toBe(true);
  });

  /*
   * The CONTROL. "Never refuses" passes trivially for a tool that refuses NOTHING ever, including a
   * genuinely bad request — so the empty-prompt guard must still be intact and still be a refusal.
   */
  it('CONTROL: a genuinely invalid call is still refused, without touching the provider', async () => {
    const { tools, wire } = toolsWith();
    const generate = (
      tools as unknown as Record<string, { execute?: (args: unknown, opts: unknown) => Promise<string> }>
    ).generate_image;

    const result = await generate.execute!({ prompt: '   ' }, { toolCallId: 'c', messages: [] });

    expect(result.toLowerCase()).toMatch(/prompt/);
    expect(wire.touched()).toBe(false);
  });
});
