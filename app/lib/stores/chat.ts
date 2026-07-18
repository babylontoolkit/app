import { atom, map } from 'nanostores';

export const chatStore = map({
  started: false,
  aborted: false,
  showChat: true,
});

/**
 * TRUE while the conversation's last user turn is the hidden creation brief (§4.4) — i.e. the turn
 * being generated (or retried) is the CREATION. Derived from the messages in `Chat.client.tsx`, so a
 * restored or retried conversation gets it right too. The premium pill reads it: creations always run
 * the standard streaming model regardless of the premium preference (`decidePremium`
 * `reason: 'creation_turn'` — KIE-buffered Fable 5 cannot flush a creation-sized artifact before the
 * gateway timeout), and the pill must not claim otherwise.
 */
export const creationTurnStore = atom(false);
