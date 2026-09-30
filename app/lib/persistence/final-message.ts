import type { Message } from 'ai';

/**
 * The conversation as it stands when a generation FINISHES — the sampled store copy with the finished
 * assistant message laid over it (found live, tool-loop plan T9).
 *
 * `checkpointProject` runs from `useChat`'s `onFinish`, which fires synchronously at the end of the
 * stream — BEFORE React re-renders with the final message and before the 50 ms sampler hands it to
 * `storeMessageHistory` (whose `latestMessages` update also waits on an IndexedDB write). So the server
 * transcript was uploaded from a snapshot taken mid-stream: measured, a tool-loop turn's saved message
 * held only its first step's narration (73 of 1,680 chars) and NONE of its annotations — no
 * `agentMeta`, no `agentWorkspace`, no `credits` — and since a reload prefers the server copy, the
 * activity list, the cost badge and the "Build this plan" button all vanished on refresh.
 *
 * `onFinish` hands us the finished message; it replaces the entry with the same id, or is appended
 * when the snapshot never saw it at all. Pure so the rule is tested.
 */
export function withFinalMessage(messages: Message[], finalMessage: Message | undefined): Message[] {
  if (!finalMessage?.id) {
    return messages;
  }

  const index = messages.findIndex((m) => m.id === finalMessage.id);

  if (index === -1) {
    return [...messages, finalMessage];
  }

  return messages.map((m, i) => (i === index ? finalMessage : m));
}
