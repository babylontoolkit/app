/**
 * A preview reload must actually reach the iframe (§4.13a, §4.16).
 *
 * Reported 2026-08-22: after switching branches the preview kept showing the branch the user had just
 * left, until they reloaded the whole page. Two faults stacked, and the second is the instructive one:
 * `applyBranchTree` never asked for a reload, AND the mechanism it would have called was already dead
 * — `PreviewsStore.refreshPreview` flips `PreviewInfo.ready`, which nothing in the app reads, on an
 * iframe with no `key` and an unchanged `src`.
 *
 * ⚠️ These are structural assertions, not a rendered `<Preview>`. The dead mechanism was dead *by
 * construction* — a component test would have had to assert "the browser re-fetched", which jsdom
 * cannot observe on an iframe anyway. What can be checked is that the request is raised, that the
 * component answers it, and that the branch path asks at all.
 */
import { describe, expect, it, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { previewReloadRequest, requestPreviewReload, resetPreviewReloadRequests } from './preview-reload';

const read = (p: string) => readFileSync(join(process.cwd(), p), 'utf8');

describe('the preview-reload request', () => {
  beforeEach(() => resetPreviewReloadRequests());

  it('starts at zero, so a preview mounting first has nothing to answer', () => {
    expect(previewReloadRequest.get()).toBe(0);
  });

  /** Two requests in a row must read as two — a boolean would swallow the second. */
  it('advances on every request, never coalescing', () => {
    requestPreviewReload();
    requestPreviewReload();

    expect(previewReloadRequest.get()).toBe(2);
  });

  it('notifies subscribers, or the component never hears it', () => {
    const seen: number[] = [];
    const stop = previewReloadRequest.subscribe((v) => seen.push(v));

    requestPreviewReload();
    stop();

    expect(seen.at(-1)).toBe(1);
  });
});

describe('the dead remount is gone', () => {
  const workbench = read('app/lib/stores/workbench.ts');
  const previews = read('app/lib/stores/previews.ts');

  it('refreshPreviews raises the request', () => {
    const body = workbench.slice(workbench.indexOf('  refreshPreviews() {'));

    expect(body).toContain('requestPreviewReload()');
  });

  /**
   * 🔴 The regression that matters. `refreshPreview(previewId)` flips a field with no readers, so a
   * `refreshPreviews` that calls it is a no-op wearing a working function's name — which is exactly
   * how this shipped and stayed shipped through the §4.16 media work that depended on it.
   */
  it('refreshPreviews no longer drives the ready-flip that nothing reads', () => {
    const from = workbench.indexOf('  refreshPreviews() {');
    const body = workbench.slice(from, workbench.indexOf('\n  }', from));

    expect(body).not.toMatch(/refreshPreview\(previewId\)/);
  });

  /**
   * The premise, asserted rather than remembered: `ready` is written and never read. If someone gives
   * it a reader this test fails and the comments above need revisiting — which is the point.
   */
  it('PREMISE — PreviewInfo.ready is still write-only', () => {
    const writes = previews.match(/\.ready = /g) ?? [];

    expect(writes.length, 'ready stopped being written — the premise moved').toBeGreaterThan(0);

    const app = ['app/components/workbench/Preview.tsx', 'app/components/workbench/Workbench.client.tsx']
      .map(read)
      .join('\n');

    expect(app).not.toMatch(/\breview\.ready\b|\bpreview\.ready\b/);
  });
});

describe('the branch operation asks for one', () => {
  const source = read('app/lib/persistence/apply-branch-tree.ts');

  it('calls refreshPreviews', () => {
    expect(source).toContain('workbenchStore.refreshPreviews()');
  });

  /**
   * ⚠️ AFTER the reinstall/restart, and OUTSIDE its `try`. Before it, the reload lands on a server
   * that is about to go down; inside the `try`, a failed install silently skips it — leaving the old
   * branch's document on screen in the one case the user most needs to see what actually landed.
   */
  it('asks after the restart, not before it', () => {
    expect(source.indexOf('workbenchStore.refreshPreviews()')).toBeGreaterThan(source.indexOf('ensureRunnableNow('));
  });

  it('asks even when the restart failed', () => {
    const at = source.indexOf('workbenchStore.refreshPreviews()');
    const catchAt = source.indexOf('Could not restart the project after');

    expect(catchAt).toBeGreaterThan(-1);
    expect(at, 'the call sits inside the try that the restart failure escapes').toBeGreaterThan(catchAt);
  });
});

describe('the preview answers it', () => {
  const source = read('app/components/workbench/Preview.tsx');

  it('subscribes and reloads', () => {
    expect(source).toContain('useStore(previewReloadRequest)');
    expect(source).toMatch(/lastReloadRequest\.current = reloadRequest;\s*\n\s*reloadPreview\(\);/);
  });

  /**
   * ⚠️ Seeded with the CURRENT value. Seeding with `0` makes every mount that happens after any
   * request fire a reload the user did not ask for — a visible flash on a document that was already
   * fresh, and the sort of thing that reads as flakiness rather than as a bug.
   */
  it('seeds the guard from the current value so a mount is not a request', () => {
    expect(source).toContain('useRef(reloadRequest)');
    expect(source).not.toMatch(/lastReloadRequest\s*=\s*useRef\(0\)/);
  });

  /** CONTROL — a scan that loaded nothing reports every property as satisfied. */
  it('CONTROL — the scanner can fail', () => {
    expect(source.length).toBeGreaterThan(1000);
    expect(source).not.toContain('useStore(somethingThatDoesNotExist)');
  });
});

/**
 * 🔴 THE RELOAD IS DRIVEN BY THE SERVER COMING BACK, NOT BY THE CALLER FINISHING (owner, 2026-08-22).
 *
 * Reported as *"you still have to hit the workspace reload to see the actual preview for the version we
 * just switched to."* The branch doors now genuinely restart the dev server, but the replacement Vite
 * binds the SAME port — `baseUrl` is an identical string, React re-renders an identical `<iframe src>`,
 * and nothing is re-requested.
 *
 * ⚠️ Timing is the whole point. A reload fired when `ensureRunnableNow` resolves can land while the new
 * server is still booting, because that wait can be satisfied by the OUTGOING server's port (it has not
 * deregistered yet) — a reload into a booting server shows a connection error and then nothing further.
 * `onServerReady` is the moment the replacement is actually able to answer.
 */
describe('a dev server that comes back asks for a reload', () => {
  const source = read('app/lib/stores/previews.ts');

  it('requests a reload when a port that has served before serves again', () => {
    const at = source.indexOf('sandbox.onServerReady(');
    const body = source.slice(at, at + 2000);

    expect(body).toContain('this.#everServed.has(port)');
    expect(body).toContain('requestPreviewReload()');
  });

  /**
   * ⚠️ NOT on the first boot. The iframe has not loaded anything to be stale yet, and reloading a
   * document that is still arriving is a visible flash for nothing.
   */
  it('does not request one on a port serving for the first time', () => {
    const at = source.indexOf('sandbox.onServerReady(');
    const body = source.slice(at, at + 2000);

    expect(body).toMatch(/const restarted = this\.#everServed\.has\(port\);\s*\n\s*this\.#everServed\.add\(port\);/);
    expect(body).toMatch(/if \(restarted\) \{\s*\n\s*requestPreviewReload\(\);/);
  });

  /**
   * ⚠️ `#everServed` is never pruned. Keying off the LIVE registration would ask "is a preview
   * registered right now" — and whether a port deregisters on Ctrl-C is a provider detail. If it does,
   * a restart looks like a first boot and no reload is requested, which is the reported bug.
   */
  it('tracks ports that have ever served, not ports serving now', () => {
    expect(source).toMatch(/#everServed = new Set<number>\(\)/);
    expect(source, '#everServed is pruned somewhere — a restart can then read as a first boot').not.toMatch(
      /#everServed\.(delete|clear)\(/,
    );
  });
});
