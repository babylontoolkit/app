/**
 * What a failed media create means for the money (`create-failure.ts`, no-unbilled-usage D9).
 *
 * `refused` / `not-sent` refund; `ambiguous` keeps the debit and is never retried. A misclassification toward
 * `refused` refunds a render the provider may be billing us for (and the queue retries it into a duplicate);
 * toward `ambiguous` it holds a debit an admin can return. These cases pin the wire answers to the class.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { classifyCreateFailure, classifyTransportFailure, MediaCreateError } from './create-failure';
import { classifyKieRejection, KieMediaProvider } from './kie-client';
import { FalMediaProvider } from './fal-client';

describe('classifyCreateFailure', () => {
  it('a timeout is ambiguous and never retryable', () => {
    const timeout = Object.assign(new Error('aborted due to timeout'), { name: 'TimeoutError' });

    expect(classifyCreateFailure(timeout)).toEqual({ outcome: 'ambiguous', retryable: false });
  });

  it('a connection refused before sending is not-sent and retryable', () => {
    const refused = Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNREFUSED' } });

    expect(classifyCreateFailure(refused)).toEqual({ outcome: 'not-sent', retryable: true });
  });

  it('a reset after send is ambiguous (the body may have been accepted)', () => {
    const reset = Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNRESET' } });

    expect(classifyCreateFailure(reset).outcome).toBe('ambiguous');
  });

  it('an untyped HTTP 4xx is a refusal; 429 is the retryable one', () => {
    expect(classifyCreateFailure(new Error('fal refused the request (HTTP 403): no balance'))).toEqual({
      outcome: 'refused',
      retryable: false,
    });
    expect(classifyCreateFailure(new Error('x (HTTP 429): slow down'))).toEqual({
      outcome: 'refused',
      retryable: true,
    });
  });

  it('an untyped HTTP 5xx is ambiguous', () => {
    expect(classifyCreateFailure(new Error('x (HTTP 503): unavailable')).outcome).toBe('ambiguous');
  });

  it('anything it cannot read is AMBIGUOUS — the safe default', () => {
    expect(classifyCreateFailure(new Error('something odd')).outcome).toBe('ambiguous');
    expect(classifyCreateFailure('a string').outcome).toBe('ambiguous');
  });

  it('a typed ambiguous error can never be marked retryable', () => {
    expect(new MediaCreateError('x', 'ambiguous', true).retryable).toBe(false);
  });

  it('classifyTransportFailure names a DNS failure not-sent', () => {
    expect(classifyTransportFailure({ name: 'TypeError', cause: { code: 'ENOTFOUND' } }).outcome).toBe('not-sent');
  });
});

/**
 * workerd (production) — the error shapes MEASURED under miniflare/workerd 1.20251011.0. A refused connection
 * and a body-read-then-dropped connection are identical there, so both MUST stay ambiguous; the opaque DNS
 * failure too. Only Node's coded errors may be classified pre-send.
 */
describe('workerd-shaped fetch errors stay ambiguous (no pre-send signal exists)', () => {
  const workerd = (message: string, props: Record<string, unknown>) => Object.assign(new Error(message), props);

  it('"Network connection lost." (refused OR dropped after send) is ambiguous, never retried', () => {
    const error = workerd('Network connection lost.', { remote: true, retryable: true });

    expect(classifyCreateFailure(error)).toEqual({ outcome: 'ambiguous', retryable: false });
  });

  it('a DNS failure ("internal error; reference = …") is ambiguous', () => {
    const error = workerd('internal error; reference = 2n1ak5f87m9o1npvr65uklju', { remote: true });

    expect(classifyCreateFailure(error)).toEqual({ outcome: 'ambiguous', retryable: false });
  });

  it("workerd's own `retryable: true` does not make a create retryable", () => {
    expect(classifyTransportFailure(workerd('Network connection lost.', { retryable: true })).retryable).toBe(false);
  });

  it('a workerd timeout (DOMException TimeoutError) is ambiguous', () => {
    const error = Object.assign(new Error('The operation was aborted due to timeout'), {
      name: 'TimeoutError',
      code: 23,
    });

    expect(classifyCreateFailure(error).outcome).toBe('ambiguous');
  });
});

describe("KIE's documented rejection codes", () => {
  const cases: Array<[number, unknown, string, boolean]> = [
    [200, { code: 422, msg: 'bad option' }, 'refused', false],
    [200, { code: 401, msg: 'unauthorized' }, 'refused', false],
    [200, { code: 402, msg: 'insufficient credits' }, 'refused', false],
    [200, { code: 501, msg: 'generation failed' }, 'refused', false],
    [200, { code: 505, msg: 'feature disabled' }, 'refused', false],
    [200, { code: 429, msg: 'rate limited' }, 'refused', true],
    [200, { code: 455, msg: 'service unavailable' }, 'refused', true],
    [200, { code: 500, msg: 'server error' }, 'ambiguous', false],
    [200, { code: 200, data: {} }, 'ambiguous', false],
    [400, { msg: 'no code' }, 'refused', false],
    [502, { msg: 'no code' }, 'ambiguous', false],
  ];

  for (const [http, body, outcome, retryable] of cases) {
    it(`HTTP ${http} ${JSON.stringify(body)} → ${outcome}${retryable ? ' (retryable)' : ''}`, () => {
      const error = classifyKieRejection(http, body, 'detail');

      expect(error.outcome).toBe(outcome);
      expect(error.retryable).toBe(retryable);
    });
  }
});

describe('the clients classify on the wire', () => {
  let answer: () => Promise<unknown>;

  beforeEach(() => {
    for (const key of ['FAL_API_KEY', 'KIE_API_KEY', 'MEDIA_PROVIDER']) {
      vi.stubEnv(key, undefined as unknown as string);
    }

    vi.stubGlobal('fetch', async () => answer());
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  const text = (body: string, status = 200) => ({ ok: status < 300, status, text: async () => body });

  async function kieCreate() {
    return new KieMediaProvider('k').create({ endpoint: 'jobs', model: 'nano-banana-2', payload: {} }).catch((e) => e);
  }

  async function falCreate() {
    return new FalMediaProvider('k')
      .create({ endpoint: 'fal-queue', model: 'fal-ai/nano-banana-2', payload: {} })
      .catch((e) => e);
  }

  it('KIE: a timeout is ambiguous', async () => {
    answer = async () => {
      throw Object.assign(new Error('timeout'), { name: 'TimeoutError' });
    };

    expect(await kieCreate()).toMatchObject({ name: 'MediaCreateError', outcome: 'ambiguous' });
  });

  it('KIE: a 200 body with code 422 is a refusal', async () => {
    answer = async () => text(JSON.stringify({ code: 422, msg: 'bad option' }));

    expect(await kieCreate()).toMatchObject({ outcome: 'refused', retryable: false });
  });

  it('KIE: an HTML 502 from a gateway is ambiguous', async () => {
    answer = async () => text('<html>bad gateway</html>', 502);

    expect(await kieCreate()).toMatchObject({ outcome: 'ambiguous' });
  });

  it('fal: a 403 is a refusal', async () => {
    answer = async () => text(JSON.stringify({ detail: 'Exhausted balance' }), 403);

    expect(await falCreate()).toMatchObject({ outcome: 'refused' });
  });

  it('fal: a 503 is ambiguous', async () => {
    answer = async () => text(JSON.stringify({ detail: 'busy' }), 503);

    expect(await falCreate()).toMatchObject({ outcome: 'ambiguous' });
  });

  it('fal: a 2xx with no response_url was ACCEPTED — ambiguous, never refunded', async () => {
    answer = async () => text(JSON.stringify({ request_id: 'r1' }));

    expect(await falCreate()).toMatchObject({ outcome: 'ambiguous' });
  });

  it('fal: another gateway’s endpoint never reached the wire — not-sent', async () => {
    const error = await new FalMediaProvider('k').create({ endpoint: 'jobs', model: 'x', payload: {} }).catch((e) => e);

    expect(error).toMatchObject({ outcome: 'not-sent' });
  });
});
