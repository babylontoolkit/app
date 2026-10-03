import { describe, expect, it, vi } from 'vitest';
import { keepAlive, waitUntilOf } from './keep-alive';

const cfContext = (waitUntil: unknown) => ({ cloudflare: { env: {}, ctx: { waitUntil } } });

describe('keepAlive', () => {
  it('registers the work with the runtime waitUntil when the context carries one', async () => {
    const waitUntil = vi.fn();
    const work = Promise.resolve(42);

    const returned = keepAlive(cfContext(waitUntil), work, 'settlement');

    expect(waitUntil).toHaveBeenCalledTimes(1);
    expect(waitUntil.mock.calls[0][0]).toBeInstanceOf(Promise);
    expect(returned).toBe(work);
    await expect(returned).resolves.toBe(42);
  });

  it('calls waitUntil with the ctx as `this` (workerd binds it to the execution context)', () => {
    const ctx = {
      seen: undefined as unknown,
      waitUntil(this: { seen: unknown }) {
        this.seen = this;
      },
    };

    keepAlive({ cloudflare: { ctx } }, Promise.resolve());

    expect(ctx.seen).toBe(ctx);
  });

  it('runs the work and does not throw when there is no waitUntil (Vite dev / Node)', async () => {
    for (const context of [undefined, null, {}, { cloudflare: {} }, { cloudflare: { ctx: {} } }, cfContext('nope')]) {
      expect(waitUntilOf(context)).toBeUndefined();
      await expect(keepAlive(context, Promise.resolve('ran'))).resolves.toBe('ran');
    }
  });

  it('catches a rejection for the runtime, while the caller still sees it', async () => {
    const waitUntil = vi.fn();
    const failing = Promise.reject(new Error('boom'));

    const returned = keepAlive(cfContext(waitUntil), failing, 'settlement');

    // The copy handed to the runtime never rejects.
    await expect(waitUntil.mock.calls[0][0]).resolves.toBeUndefined();

    // The original is returned untouched — an awaiting caller still sees the failure.
    await expect(returned).rejects.toThrow('boom');
  });

  it('a rejecting, un-awaited promise is not an unhandled rejection', async () => {
    const unhandled = vi.fn();
    process.on('unhandledRejection', unhandled);

    try {
      void keepAlive(undefined, Promise.reject(new Error('ignored')));
      await new Promise((resolve) => setTimeout(resolve, 10));
      expect(unhandled).not.toHaveBeenCalled();
    } finally {
      process.off('unhandledRejection', unhandled);
    }
  });

  it('never throws when waitUntil itself throws (called after the request ended)', async () => {
    const waitUntil = vi.fn(() => {
      throw new Error('context gone');
    });

    await expect(keepAlive(cfContext(waitUntil), Promise.resolve(1))).resolves.toBe(1);
    expect(waitUntil).toHaveBeenCalledTimes(1);
  });
});
