import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getMonitor, isMonitoringConfigured, FUNNEL_EVENTS, ALERT_SIGNALS } from './index';

/**
 * Observability is a money/ops path in the §5A sense: a regression here does not throw, it just makes
 * the platform blind. These tests pin the three invariants — config-degraded, never-throws,
 * fire-and-forget shipping — that keep it honest.
 */
describe('monitoring', () => {
  const realFetch = globalThis.fetch;

  beforeEach(() => {
    delete process.env.MONITORING_WEBHOOK_URL;
    delete process.env.ANALYTICS_WEBHOOK_URL;
  });

  afterEach(() => {
    globalThis.fetch = realFetch;
    vi.restoreAllMocks();
    delete process.env.MONITORING_WEBHOOK_URL;
    delete process.env.ANALYTICS_WEBHOOK_URL;
  });

  it('is a no-op transport when nothing is configured (never ships)', () => {
    const spy = vi.fn();
    globalThis.fetch = spy as unknown as typeof fetch;

    const monitor = getMonitor();
    monitor.captureException(new Error('boom'), { scope: 'test' });
    monitor.captureMessage('note', { level: 'warning' });
    monitor.alert(ALERT_SIGNALS.WEBHOOK_FAILURE, 'stripe webhook bad signature');
    monitor.track(FUNNEL_EVENTS.SIGNUP, { userId: 'u1' });

    expect(spy).not.toHaveBeenCalled();
    expect(isMonitoringConfigured()).toEqual({ errors: false, analytics: false });
  });

  it('ships errors + alerts to MONITORING_WEBHOOK_URL when configured', () => {
    process.env.MONITORING_WEBHOOK_URL = 'https://collector.example/errors';

    const spy = vi.fn().mockResolvedValue({ ok: true });
    globalThis.fetch = spy as unknown as typeof fetch;

    const monitor = getMonitor();
    monitor.captureException(new Error('boom'), { scope: 'proxy', userId: 'u1' });
    monitor.alert(ALERT_SIGNALS.GENERATION_FAILURE_RATE, '30% failures', { severity: 'critical' });

    expect(spy).toHaveBeenCalledTimes(2);

    const [url, init] = spy.mock.calls[0];
    expect(url).toBe('https://collector.example/errors');

    const body = JSON.parse((init as RequestInit).body as string);
    expect(body.kind).toBe('exception');
    expect(body.error.message).toBe('boom');
    expect(body.scope).toBe('proxy');
    expect(isMonitoringConfigured().errors).toBe(true);
  });

  it('routes analytics events to ANALYTICS_WEBHOOK_URL, not the errors URL', () => {
    process.env.MONITORING_WEBHOOK_URL = 'https://collector.example/errors';
    process.env.ANALYTICS_WEBHOOK_URL = 'https://collector.example/events';

    const spy = vi.fn().mockResolvedValue({ ok: true });
    globalThis.fetch = spy as unknown as typeof fetch;

    getMonitor().track(FUNNEL_EVENTS.PURCHASE_COMPLETED, { amount: 5000 });

    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy.mock.calls[0][0]).toBe('https://collector.example/events');

    const body = JSON.parse((spy.mock.calls[0][1] as RequestInit).body as string);
    expect(body.kind).toBe('event');
    expect(body.event).toBe('purchase_completed');
  });

  it('does not ship info-level messages to the errors collector (only warning+)', () => {
    process.env.MONITORING_WEBHOOK_URL = 'https://collector.example/errors';

    const spy = vi.fn().mockResolvedValue({ ok: true });
    globalThis.fetch = spy as unknown as typeof fetch;

    getMonitor().captureMessage('routine', { level: 'info' });

    expect(spy).not.toHaveBeenCalled();
  });

  it('never throws, even when the transport itself throws', () => {
    process.env.MONITORING_WEBHOOK_URL = 'https://collector.example/errors';
    globalThis.fetch = (() => {
      throw new Error('network stack exploded');
    }) as unknown as typeof fetch;

    const monitor = getMonitor();

    // A throwing fetch must be swallowed — observability can never break the caller.
    expect(() => monitor.captureException(new Error('boom'), { scope: 'test' })).not.toThrow();
    expect(() => monitor.alert(ALERT_SIGNALS.WEBHOOK_FAILURE, 'x')).not.toThrow();
    expect(() => monitor.track(FUNNEL_EVENTS.SIGNUP)).not.toThrow();
  });

  it('serializes non-Error throwables without losing the payload', () => {
    process.env.MONITORING_WEBHOOK_URL = 'https://collector.example/errors';

    const spy = vi.fn().mockResolvedValue({ ok: true });
    globalThis.fetch = spy as unknown as typeof fetch;

    getMonitor().captureException('a bare string failure', { scope: 'test' });

    const body = JSON.parse((spy.mock.calls[0][1] as RequestInit).body as string);
    expect(body.error.message).toBe('a bare string failure');
  });
});
