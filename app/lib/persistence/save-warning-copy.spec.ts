/**
 * A warning that can be disproved gets ignored (SPEC §4.5.4b).
 *
 * The nudges claimed "it exists ONLY in this browser tab" on every runtime. On a server-backed sandbox
 * the files live on a remote disk and survive a cleared cache — so the user disproves the warning by
 * accident and learns to dismiss the next one, which is the one that matters. Every test below pins
 * either an honest reason or the fact that the ACTION never softens.
 */
import { describe, expect, it } from 'vitest';
import { saveWarningCopy, toastText } from './save-warning-copy';

const ephemeralCopy = saveWarningCopy({ sandboxOutlivesSession: false });
const durableCopy = saveWarningCopy({ sandboxOutlivesSession: true });

const ephemeral = { toast: toastText(ephemeralCopy), banner: ephemeralCopy.banner };
const durable = { toast: toastText(durableCopy), banner: durableCopy.banner };

describe('saveWarningCopy', () => {
  it('claims browser-locality ONLY where it is true', () => {
    expect(ephemeral.toast).toMatch(/only in this browser tab/i);
    expect(ephemeral.banner).toMatch(/only in this browser/i);

    // The bug, directly: a remote filesystem does not live in the tab.
    expect(durable.toast).not.toMatch(/browser/i);
    expect(durable.banner).not.toMatch(/browser/i);
  });

  /**
   * The specific disprovable claim. A server sandbox survives cleared browsing data, so promising the
   * game is "gone" is a lie the user will catch.
   */
  it('does not promise the work disappears with browsing data on a durable sandbox', () => {
    expect(durable.toast).not.toMatch(/clear your browsing data/i);
    expect(durable.banner).not.toMatch(/clear your browsing data/i);
    expect(ephemeral.toast).toMatch(/clear your browsing data/i);
  });

  /** The reason changes; the risk does not. A durable sandbox is still not a backup. */
  it('names the real risk on a durable sandbox — temporary, and not kept by us', () => {
    expect(durable.toast).toMatch(/temporary/i);
    expect(durable.toast).toMatch(/do not keep a copy/i);
    expect(durable.banner).toMatch(/temporary/i);
  });

  /**
   * 🔴 The invariant that must survive every future copy edit: an unsaved project is equally unsafe on
   * both runtimes, so neither branch may lose the ask or go quiet about not being saved.
   */
  it('never softens the action or the status, on either runtime', () => {
    for (const copy of [ephemeral, durable]) {
      expect(copy.toast).toMatch(/not saved yet/i);
      expect(copy.toast).toMatch(/GitHub account/);
      expect(copy.banner).toMatch(/GitHub account/);
    }
  });

  /**
   * The headline is split from the detail in this module because the component BOLDS it. Doing that
   * with `text.split('.')[0]` at the call site makes a full stop load-bearing — the first sentence to
   * contain an abbreviation would silently render a truncated headline.
   */
  it('splits the toast so the component never has to parse punctuation', () => {
    for (const copy of [ephemeralCopy, durableCopy]) {
      expect(copy.toastHeadline).toBe('Save your work — this game is not saved yet.');
      expect(copy.toastDetail).not.toBe('');
      expect(toastText(copy)).toBe(`${copy.toastHeadline} ${copy.toastDetail}`);
    }
  });
});
